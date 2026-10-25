import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionStopped,
  type Barrier,
  ChatNotFound,
  chatConfiguration,
  ChatService,
  MAX_INPUT_CHARS,
  ProjectUnavailable,
} from "../src/core/chats.ts";
import { InvalidRequest, RequestConflict } from "../src/core/requests.ts";
import { openStore } from "../src/storage/store.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pal-chats-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function open(dataRoot: string, barrier?: (point: Barrier) => void | Promise<void>) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage(fauxText("ok"))));
  const model = faux.getModel();
  const store = await openStore(dataRoot);
  const harness = await Harness.open(store.storage, { models, registry: createRegistry() }, context);
  cleanups.push(() => harness.close(context).catch(() => {}));
  const chats = await ChatService.open(
    {
      database: store.database,
      harness,
      agentFor: async (projectId: string) =>
        projectId === "project-1" ? { model: { provider: model.provider, modelId: model.id } } : undefined,
      ...(barrier === undefined ? {} : { barrier }),
    },
    context,
  );
  const userMessages = async (conversationId: Parameters<typeof harness.conversation>[0]) => {
    await harness.waitForIdle(context);
    const { messages } = (await (await harness.conversation(conversationId, context))?.context(context)) ?? {
      messages: [],
    };
    return messages.filter((message) => message.role === "user").length;
  };
  return { store, harness, chats, userMessages, faux };
}

/** Make the next write that needs a new database page fail with SQLITE_FULL. */
async function fillDisk(database: Awaited<ReturnType<typeof openStore>>["database"]): Promise<void> {
  const pages = await database.get<{ page_count: number }>("PRAGMA page_count");
  await database.exec(`PRAGMA max_page_count = ${pages?.page_count}`);
}

describe("chats", () => {
  it("creates one chat per request ID and rejects that ID with another body", async () => {
    const { store, chats } = await open(await tempDir());
    const chat = await chats.createChat("chat-request-1", { projectId: "project-1", title: "A" }, context);
    expect(await chats.createChat("chat-request-1", { projectId: "project-1", title: "A" }, context)).toEqual(chat);
    await expect(
      chats.createChat("chat-request-1", { projectId: "project-1", title: "B" }, context),
    ).rejects.toBeInstanceOf(RequestConflict);
    expect((await chats.createChat("chat-request-2", { projectId: "project-1" }, context)).id).not.toBe(chat.id);

    await expect(chats.createChat("short", { projectId: "project-1" }, context)).rejects.toBeInstanceOf(InvalidRequest);
    await expect(chats.createChat("chat-request-3", { title: "" }, context)).rejects.toBeInstanceOf(InvalidRequest);
    await expect(
      chats.createChat("chat-request-3", { projectId: "project-1", other: 1 }, context),
    ).rejects.toBeInstanceOf(InvalidRequest);
    await expect(chats.createChat("chat-request-3", { projectId: "elsewhere" }, context)).rejects.toBeInstanceOf(
      ProjectUnavailable,
    );
    expect((await store.storage.scanConversations({}, 100, undefined, context)).items).toHaveLength(2);
  });

  it("persists explicit names without changing identity/history or letting stale updates stop admission", async () => {
    const dataRoot = await tempDir();
    const { chats, harness, store, userMessages } = await open(dataRoot);
    const chat = await chats.createChat("rename-chat-request", { projectId: "project-1" }, context);
    expect(await chats.rename(chat.id, { title: "  Review name  ", expectedTitle: null })).toMatchObject({
      ...chat,
      title: "Review name",
    });
    expect(await userMessages(chat.conversationId)).toBe(0);
    expect((await store.storage.scanConversations({}, 100, undefined, context)).items).toHaveLength(1);
    await expect(chats.rename(chat.id, { title: "Outdated", expectedTitle: null })).rejects.toBeInstanceOf(
      RequestConflict,
    );
    await expect(chats.rename(chat.id, { title: " ", expectedTitle: "Review name" })).rejects.toBeInstanceOf(
      InvalidRequest,
    );
    expect(chats.stopped).toBe(false);
    await chats.submit(chat.id, "rename-input-request", { text: "first input should not replace the name" }, context);
    expect(await userMessages(chat.conversationId)).toBe(1);
    expect((await chats.get(chat.id))?.title).toBe("Review name");
    expect(await chats.createChat("rename-chat-request", { projectId: "project-1" }, context)).toEqual(chat);
    await harness.close(context);
    const again = await open(dataRoot);
    expect(await again.chats.get(chat.id)).toMatchObject({ ...chat, title: "Review name" });
    const outcomes = await Promise.allSettled([
      again.chats.rename(chat.id, { title: "One", expectedTitle: "Review name" }),
      again.chats.rename(chat.id, { title: "Two", expectedTitle: "Review name" }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(again.chats.stopped).toBe(false);
    await again.chats.remove(chat.id, context);
    await expect(again.chats.rename(chat.id, { title: "Removed", expectedTitle: "One" })).rejects.toBeInstanceOf(
      ChatNotFound,
    );
    expect(again.chats.stopped).toBe(false);
  });

  it("admits an input once per request ID and body, whatever the key order or defaults", async () => {
    const { harness, chats, userMessages } = await open(await tempDir());
    const chat = await chats.createChat("chat-request-1", { projectId: "project-1" }, context);
    const admission = await chats.submit(chat.id, "input-request-1", { text: "hi" }, context);
    // Acknowledged only once Pi has admitted it.
    expect(await harness.submission(admission.submissionId, context)).toBeDefined();
    expect(await chats.submit(chat.id, "input-request-1", { whenBusy: "followUp", text: "hi" }, context)).toEqual(
      admission,
    );
    for (const body of [{ text: "hi", whenBusy: "steer" }, { text: "hi!" }]) {
      await expect(chats.submit(chat.id, "input-request-1", body, context)).rejects.toBeInstanceOf(RequestConflict);
    }
    expect(await userMessages(chat.conversationId)).toBe(1);
    // The first input names an untitled chat; listing shows it.
    expect(await chats.list("project-1")).toEqual([
      expect.objectContaining({ id: chat.id, title: "hi", conversationId: chat.conversationId }),
    ]);

    await expect(chats.submit("no-such-chat", "input-request-2", { text: "hi" }, context)).rejects.toBeInstanceOf(
      ChatNotFound,
    );
    const tooLong = { text: "x".repeat(MAX_INPUT_CHARS + 1) };
    await expect(chats.submit(chat.id, "input-request-2", tooLong, context)).rejects.toBeInstanceOf(InvalidRequest);
  });

  it("rejects stale settings and concurrent configuration changes without recording an input", async () => {
    const { chats, harness, store } = await open(await tempDir());
    const chat = await chats.createChat("config-chat-request", { projectId: "project-1" }, context);
    const conversation = await harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing chat");
    const before = chatConfiguration(await conversation.agent(context));
    const outcomes = await Promise.allSettled([
      chats.configure(
        chat.id,
        { model: { provider: "first", modelId: "one" }, thinkingLevel: "off", expected: before },
        context,
      ),
      chats.configure(
        chat.id,
        { model: { provider: "second", modelId: "two" }, thinkingLevel: "off", expected: before },
        context,
      ),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
    expect(outcomes[1]).toMatchObject({ reason: { status: 409, code: "configuration_stale" } });
    await expect(
      chats.submit(chat.id, "stale-input-request", { text: "private history", configuration: before }, context),
    ).rejects.toMatchObject({ status: 409, code: "configuration_stale" });
    expect(await store.database.all("SELECT * FROM pal_admissions")).toEqual([]);
    expect(chats.stopped).toBe(false);
  });

  it("serializes configuration with admission and keeps active and queued inputs on their destination", async () => {
    const recorded = Promise.withResolvers<undefined>();
    const admit = Promise.withResolvers<undefined>();
    const requested = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const { chats, harness, faux, userMessages } = await open(await tempDir(), async (point) => {
      if (point === "input-recorded") {
        recorded.resolve(undefined);
        await admit.promise;
      }
    });
    const destinations: string[] = [];
    faux.setResponses([
      async (_context, _options, _state, model) => {
        destinations.push(model.provider);
        requested.resolve(undefined);
        await finish.promise;
        return fauxAssistantMessage("first");
      },
      (_context, _options, _state, model) => {
        destinations.push(model.provider);
        return fauxAssistantMessage("second");
      },
    ]);
    const chat = await chats.createChat("pinned-chat-request", { projectId: "project-1" }, context);
    const conversation = await harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing chat");
    const configuration = chatConfiguration(await conversation.agent(context));
    try {
      const first = chats.submit(chat.id, "pinned-input-first", { text: "first", configuration }, context);
      await recorded.promise;
      const change = chats.configure(
        chat.id,
        { model: { provider: "other", modelId: "other" }, thinkingLevel: "off", expected: configuration },
        context,
      );
      const rejected = expect(change).rejects.toMatchObject({ status: 409, code: "configuration_busy" });
      admit.resolve(undefined);
      await first;
      await rejected;
      await requested.promise;
      await chats.submit(chat.id, "pinned-input-second", { text: "second", configuration }, context);
      await expect(
        chats.configure(chat.id, { model: { provider: "other", modelId: "other" }, thinkingLevel: "off" }, context),
      ).rejects.toMatchObject({ status: 409, code: "configuration_busy" });
      finish.resolve(undefined);
      expect(await userMessages(chat.conversationId)).toBe(2);
      expect(destinations).toEqual([faux.getModel().provider, faux.getModel().provider]);
      expect(chats.stopped).toBe(false);
    } finally {
      admit.resolve(undefined);
      finish.resolve(undefined);
    }
  });

  it("deduplicates a confirmed input even after settings change and binds its key to the original configuration", async () => {
    const { chats, harness, userMessages } = await open(await tempDir());
    const chat = await chats.createChat("retry-config-chat", { projectId: "project-1" }, context);
    const conversation = await harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing chat");
    const configuration = chatConfiguration(await conversation.agent(context));
    const body = { text: "one input", configuration };
    const first = await chats.submit(chat.id, "retry-config-input", body, context);
    expect(await userMessages(chat.conversationId)).toBe(1);
    const updated = await chats.configure(
      chat.id,
      { model: { provider: "other", modelId: "other" }, thinkingLevel: "off" },
      context,
    );
    expect(await chats.submit(chat.id, "retry-config-input", body, context)).toEqual(first);
    await expect(
      chats.submit(chat.id, "retry-config-input", { ...body, configuration: updated }, context),
    ).rejects.toBeInstanceOf(RequestConflict);
    expect(await userMessages(chat.conversationId)).toBe(1);
  });

  it.each(["retry", "reopen"])("fails closed on a corrupt saved input during %s", async (mode) => {
    const root = await tempDir();
    const { chats, harness, store, userMessages } = await open(root);
    const chat = await chats.createChat("corrupt-chat-request", { projectId: "project-1" }, context);
    await chats.submit(chat.id, "corrupt-input-request", { text: "one input" }, context);
    expect(await userMessages(chat.conversationId)).toBe(1);
    await store.database.run("UPDATE pal_admissions SET intent = '{', state = 'admitting', submission_id = NULL");
    if (mode === "retry") {
      await expect(chats.submit(chat.id, "corrupt-input-request", { text: "one input" }, context)).rejects.toThrow(
        "a saved input is corrupt",
      );
      expect(chats.stopped).toBe(true);
    } else {
      await harness.close(context);
      await expect(open(root)).rejects.toThrow("a saved input is corrupt");
    }
  });

  it.each(["input-recorded", "input-submitted"] as const)(
    "deletion during %s cannot revive a chat on restart",
    async (point) => {
      const root = await tempDir();
      let remove = async () => {};
      const { chats, harness } = await open(root, async (barrier) => {
        if (barrier === point) await remove();
      });
      const chat = await chats.createChat("delete-chat-request", { projectId: "project-1" }, context);
      remove = () => chats.remove(chat.id, context);
      await expect(chats.submit(chat.id, "delete-input-request", { text: "hi" }, context)).rejects.toBeInstanceOf(
        ChatNotFound,
      );
      expect(chats.stopped).toBe(false);
      await expect(chats.createChat("delete-chat-request", { projectId: "project-1" }, context)).rejects.toBeInstanceOf(
        ChatNotFound,
      );
      await harness.close(context);
      const again = await open(root);
      expect(await again.chats.get(chat.id)).toBeUndefined();
      expect(await again.chats.list("project-1")).toEqual([]);
      await again.harness.waitForIdle(context);
    },
  );

  it("stops admission when Pal's write fails, before anything reaches Pi", async () => {
    const { store, chats, userMessages } = await open(await tempDir());
    const chat = await chats.createChat("chat-request-1", { projectId: "project-1" }, context);
    await fillDisk(store.database);
    const failed = chats.submit(chat.id, "input-request-1", { text: "x".repeat(50_000) }, context);
    await expect(failed).rejects.toBeInstanceOf(AdmissionStopped);
    // SQLite rolls back a transaction that hits SQLITE_FULL itself, so the facade reports its own rollback failing too.
    const cause = await failed.catch((error: AdmissionStopped) => error.cause);
    expect(cause instanceof AggregateError ? cause.errors[0] : cause).toHaveProperty("errcode", 13);
    expect(await userMessages(chat.conversationId)).toBe(0);

    // Space returning does not resume admission: the process must restart and reconcile first.
    await store.database.exec("PRAGMA max_page_count = 1073741823");
    expect(chats.stopped).toBe(true);
    await expect(chats.submit(chat.id, "input-request-2", { text: "hi" }, context)).rejects.toBeInstanceOf(
      AdmissionStopped,
    );
  });

  it("stops admission when Pi's commit fails, and completes the input after a restart", async () => {
    const dataRoot = await tempDir();
    let failPi = false;
    const first = await open(dataRoot, async (point) => {
      if (failPi && point === "input-recorded") await fillDisk(first.store.database);
    });
    const chat = await first.chats.createChat("chat-request-1", { projectId: "project-1" }, context);
    failPi = true;
    const body = { text: "x".repeat(50_000) };
    await expect(first.chats.submit(chat.id, "input-request-1", body, context)).rejects.toBeInstanceOf(
      AdmissionStopped,
    );
    expect(await first.harness.closed).toMatchObject({ reason: "failed" });

    const second = await open(dataRoot);
    expect(await second.userMessages(chat.conversationId)).toBe(1);
    expect(await second.store.database.all("SELECT state FROM pal_admissions")).toEqual([{ state: "admitted" }]);
    const admission = await second.chats.submit(chat.id, "input-request-1", body, context);
    expect(await second.harness.submission(admission.submissionId, context)).toBeDefined();
    expect(await second.userMessages(chat.conversationId)).toBe(1);
  });
});
