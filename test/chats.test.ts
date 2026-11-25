import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { configure, createRegistry, Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionStopped,
  type Barrier,
  ChatNotFound,
  chatConfiguration,
  ChatService,
  DESTINATION_CHANGED,
  InputBlocked,
  InputHeld,
  ProjectUnavailable,
} from "../src/core/chats.ts";
import { FileAccessError } from "../src/core/files.ts";
import { MAX_INPUT_CHARS } from "../src/protocol/limits.ts";
import { InvalidRequest, RequestConflict } from "../src/core/requests.ts";
import { Uploads } from "../src/core/uploads.ts";
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
  const uploads = await Uploads.open(store.database, dataRoot);
  const chats = await ChatService.open(
    {
      database: store.database,
      harness,
      agentFor: async (projectId: string) =>
        projectId === "project-1" ? { model: { provider: model.provider, modelId: model.id } } : undefined,
      attachments: uploads,
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
  return { store, harness, chats, userMessages, faux, uploads };
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
      // No unfinished input is left: Pi's receipt is kept exactly once, an input Pi never took is settled unsent.
      const rows = await again.store.database.all<{ state: string; submission_id: number | null }>(
        "SELECT state, submission_id FROM pal_admissions",
      );
      expect(rows).toEqual([
        point === "input-submitted"
          ? { state: "admitted", submission_id: expect.any(Number) }
          : { state: "withdrawn", submission_id: null },
      ]);
      const submissions = await again.store.database.get<{ n: number }>("SELECT count(*) AS n FROM pi_submissions");
      expect(submissions?.n).toBe(point === "input-submitted" ? 1 : 0);
    },
  );

  it.each(["chat", "project"] as const)(
    "settles a blocked input when its %s is deleted, so nothing unfinished is left",
    async (removed) => {
      const root = await tempDir();
      const { store, chats, uploads, harness } = await open(root);
      const chat = await chats.createChat("blocked-delete-chat", { projectId: "project-1" }, context);
      const upload = await uploads.admit("project-1", { name: "gone.txt", size: 5, type: "text/plain" });
      await uploads.receive(upload.id, Readable.from([Buffer.from("bytes")]));
      await rm(join(root, "uploads"), { recursive: true, force: true });
      await expect(
        chats.submit(chat.id, "blocked-delete-input", { text: "hi", attachments: [upload.id] }, context),
      ).rejects.toThrow();
      if (removed === "chat") await chats.remove(chat.id, context);
      else {
        await store.database.run("UPDATE pal_chats SET deleted_at = ? WHERE project_id = 'project-1'", Date.now());
        await chats.abortDeleted(context);
      }
      await harness.waitForIdle(context);
      const settled = await store.database.all("SELECT state FROM pal_admissions");
      expect(settled).toEqual([{ state: "withdrawn" }]);
      await harness.close(context);
      const again = await open(root);
      await again.harness.waitForIdle(context);
      expect(await again.store.database.all("SELECT state FROM pal_admissions")).toEqual([{ state: "withdrawn" }]);
      expect(await again.chats.get(chat.id)).toBeUndefined();
    },
  );

  it.each(["chat", "project"] as const)(
    "settles an input whose attachment read fails after its %s was deleted mid-admission",
    async (removed) => {
      const root = await tempDir();
      const { store, chats, uploads, harness } = await open(root);
      const chat = await chats.createChat("held-delete-chat", { projectId: "project-1" }, context);
      const upload = await uploads.admit("project-1", { name: "late.txt", size: 5, type: "text/plain" });
      await uploads.receive(upload.id, Readable.from([Buffer.from("bytes")]));
      const reading = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const content = uploads.content.bind(uploads);
      uploads.content = async (...args) => {
        reading.resolve(undefined);
        await release.promise;
        return content(...args);
      };
      const sending = chats.submit(chat.id, "held-delete-input", { text: "hi", attachments: [upload.id] }, context);
      sending.catch(() => {});
      await reading.promise;
      await rm(join(root, "uploads"), { recursive: true, force: true });
      if (removed === "chat") await chats.remove(chat.id, context);
      else {
        await store.database.run("UPDATE pal_chats SET deleted_at = ? WHERE project_id = 'project-1'", Date.now());
        await chats.abortDeleted(context);
      }
      release.resolve(undefined);
      await expect(sending).rejects.toThrow();
      await harness.waitForIdle(context);
      expect(await store.database.all("SELECT state, blocked FROM pal_admissions")).toEqual([
        { state: "withdrawn", blocked: null },
      ]);
      expect(chats.stopped).toBe(false);
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
    expect(await first.harness.closed).toMatchObject({ kind: "failed" });

    const second = await open(dataRoot);
    expect(await second.userMessages(chat.conversationId)).toBe(1);
    expect(await second.store.database.all("SELECT state FROM pal_admissions")).toEqual([{ state: "admitted" }]);
    const admission = await second.chats.submit(chat.id, "input-request-1", body, context);
    expect(await second.harness.submission(admission.submissionId, context)).toBeDefined();
    expect(await second.userMessages(chat.conversationId)).toBe(1);
  });

  async function attach(uploads: Uploads, dataRoot: string) {
    const bytes = Buffer.from("notes\n");
    const upload = await uploads.admit("project-1", { name: "notes.txt", size: bytes.length, type: "text/plain" });
    await uploads.receive(upload.id, Readable.from([bytes]));
    return { id: upload.id, payload: join(dataRoot, "uploads", "project-1", upload.id, "data") };
  }

  it.each(["missing", "damaged"])(
    "blocks only its own chat, before and after restart, when an attachment is %s",
    async (damage) => {
      const dataRoot = await tempDir();
      const first = await open(dataRoot);
      const blocked = await first.chats.createChat("blocked-chat-request", { projectId: "project-1" }, context);
      const other = await first.chats.createChat("other-chat-request", { projectId: "project-1" }, context);
      const { id, payload } = await attach(first.uploads, dataRoot);
      if (damage === "missing") await rm(payload);
      else await writeFile(payload, "NOTES\n");
      const body = { text: "read the notes", attachments: [id] };
      const refused = async (chats: ChatService) => {
        await expect(chats.submit(blocked.id, "blocked-input", body, context)).rejects.toBeInstanceOf(InputBlocked);
        await expect(chats.submit(blocked.id, "later-input", { text: "and then" }, context)).rejects.toBeInstanceOf(
          InputHeld,
        );
        expect((await chats.get(blocked.id))?.blocked).toEqual({
          requestId: "blocked-input",
          text: "read the notes",
          reason: expect.stringMatching(/notes\.txt is missing or damaged/),
        });
        expect((await chats.get(other.id))?.blocked).toBeNull();
      };

      await refused(first.chats);
      await first.chats.submit(other.id, "other-input-1", { text: "hello" }, context);
      expect(first.chats.stopped).toBe(false);
      await first.harness.close(context);

      const second = await open(dataRoot);
      await refused(second.chats);
      await second.chats.submit(other.id, "other-input-2", { text: "again" }, context);
      expect(second.chats.stopped).toBe(false);
      // Nothing reached Pi in place of the unreadable input.
      expect(await second.userMessages(blocked.conversationId)).toBe(0);
      expect(await second.userMessages(other.conversationId)).toBe(2);
    },
  );

  it("adopts an input Pi admitted before its acknowledgement was lost, after its payload is gone", async () => {
    const dataRoot = await tempDir();
    const lost = new Error("acknowledgement lost");
    const first = await open(dataRoot, (point) => {
      if (point === "input-submitted") throw lost;
    });
    const chat = await first.chats.createChat("ack-chat-request", { projectId: "project-1" }, context);
    const { id, payload } = await attach(first.uploads, dataRoot);
    const body = { text: "read the notes", attachments: [id] };
    await expect(first.chats.submit(chat.id, "ack-input", body, context)).rejects.toBe(lost);
    await first.harness.close(context);
    await rm(payload);

    const second = await open(dataRoot);
    expect(await second.store.database.all("SELECT state FROM pal_admissions")).toEqual([{ state: "admitted" }]);
    const admission = await second.chats.submit(chat.id, "ack-input", body, context);
    expect(await second.harness.submission(admission.submissionId, context)).toBeDefined();
    expect(await second.userMessages(chat.conversationId)).toBe(1);
  });

  it("retries a blocked input with its recorded body, or withdraws it so the chat's later inputs proceed", async () => {
    const dataRoot = await tempDir();
    const first = await open(dataRoot);
    const chat = await first.chats.createChat("retry-chat-request", { projectId: "project-1" }, context);
    const { id, payload } = await attach(first.uploads, dataRoot);
    const body = { text: "read the notes", attachments: [id] };
    await rm(payload);
    await expect(first.chats.submit(chat.id, "retry-input", body, context)).rejects.toBeInstanceOf(InputBlocked);
    await expect(first.chats.retry(chat.id, "retry-input", context)).rejects.toBeInstanceOf(InputBlocked);
    await writeFile(payload, "notes\n");
    const admission = await first.chats.retry(chat.id, "retry-input", context);
    expect(await first.chats.retry(chat.id, "retry-input", context)).toEqual(admission);
    expect((await first.chats.get(chat.id))?.blocked).toBeNull();
    await expect(first.chats.withdraw(chat.id, "retry-input", context)).rejects.toBeInstanceOf(RequestConflict);

    // Withdrawn: never sent, never admitted again under its ID, and later inputs go ahead.
    await rm(payload);
    await expect(first.chats.submit(chat.id, "withdraw-input", body, context)).rejects.toBeInstanceOf(InputBlocked);
    await first.chats.withdraw(chat.id, "withdraw-input", context);
    await first.chats.withdraw(chat.id, "withdraw-input", context);
    expect((await first.chats.get(chat.id))?.blocked).toBeNull();
    await first.chats.submit(chat.id, "after-withdraw", { text: "next" }, context);
    await first.harness.close(context);

    const second = await open(dataRoot);
    await expect(second.chats.submit(chat.id, "withdraw-input", body, context)).rejects.toBeInstanceOf(RequestConflict);
    await expect(second.chats.retry(chat.id, "withdraw-input", context)).rejects.toBeInstanceOf(RequestConflict);
    expect(await second.userMessages(chat.conversationId)).toBe(2);
  });

  it.each(["retry", "withdraw"])(
    "lets only one of a concurrent retry and withdraw win when %s is first",
    async (lead) => {
      const dataRoot = await tempDir();
      const pal = await open(dataRoot);
      const chat = await pal.chats.createChat("race-chat-request", { projectId: "project-1" }, context);
      const { id, payload } = await attach(pal.uploads, dataRoot);
      await rm(payload);
      const body = { text: "read the notes", attachments: [id] };
      await expect(pal.chats.submit(chat.id, "race-input", body, context)).rejects.toBeInstanceOf(InputBlocked);
      await writeFile(payload, "notes\n");
      const retry = () => pal.chats.retry(chat.id, "race-input", context);
      const withdraw = () => pal.chats.withdraw(chat.id, "race-input", context);
      const [won, lost] = await Promise.allSettled(lead === "retry" ? [retry(), withdraw()] : [withdraw(), retry()]);
      expect([won?.status, lost?.status]).toEqual(["fulfilled", "rejected"]);
      expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(RequestConflict);
      expect(await pal.store.database.all("SELECT state FROM pal_admissions")).toEqual([
        { state: lead === "retry" ? "admitted" : "withdrawn" },
      ]);
      expect(await pal.userMessages(chat.conversationId)).toBe(lead === "retry" ? 1 : 0);
    },
  );

  it("keeps a held input on the destination it was recorded for, through retry and restart", async () => {
    const dataRoot = await tempDir();
    const first = await open(dataRoot);
    const chat = await first.chats.createChat("destination-chat-request", { projectId: "project-1" }, context);
    const conversation = await first.harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing conversation");
    const agent = await conversation.agent(context);
    if (agent.model === undefined) throw new Error("missing model");
    const recorded = { model: agent.model, thinkingLevel: agent.thinkingLevel };
    const { id, payload } = await attach(first.uploads, dataRoot);
    await rm(payload);
    const body = { text: "read the notes", attachments: [id], configuration: chatConfiguration(recorded) };
    await expect(first.chats.submit(chat.id, "held-input", body, context)).rejects.toBeInstanceOf(InputBlocked);
    // The owner can't move a chat to another destination while it holds an input.
    await expect(
      first.chats.configure(chat.id, { model: recorded.model, thinkingLevel: "high" }, context),
    ).rejects.toMatchObject({ status: 409, code: "configuration_busy" });

    // A chat whose destination changed anyway (as before this rule) holds the input instead of sending it there.
    await conversation.commit((tx) => configure(tx, conversation.id, { ...recorded, thinkingLevel: "high" }), context);
    await writeFile(payload, "notes\n");
    await expect(first.chats.retry(chat.id, "held-input", context)).rejects.toBeInstanceOf(InputBlocked);
    expect((await first.chats.get(chat.id))?.blocked?.reason).toBe(DESTINATION_CHANGED);
    expect(await first.userMessages(chat.conversationId)).toBe(0);
    await first.harness.close(context);

    // Startup recovery holds it the same way, without failing to start.
    const second = await open(dataRoot);
    expect((await second.chats.get(chat.id))?.blocked?.reason).toBe(DESTINATION_CHANGED);
    expect(await second.userMessages(chat.conversationId)).toBe(0);
    const reopened = await second.harness.conversation(chat.conversationId, context);
    if (reopened === undefined) throw new Error("missing conversation");
    await reopened.commit((tx) => configure(tx, reopened.id, recorded), context);
    await second.chats.retry(chat.id, "held-input", context);
    expect((await second.chats.get(chat.id))?.blocked).toBeNull();
    expect(await second.userMessages(chat.conversationId)).toBe(1);
  });

  it("keeps an input Pi already admitted instead of withdrawing it", async () => {
    const dataRoot = await tempDir();
    let lose = true;
    const lost = new Error("acknowledgement lost");
    const pal = await open(dataRoot, (point) => {
      if (point !== "input-submitted" || !lose) return;
      lose = false;
      throw lost;
    });
    const chat = await pal.chats.createChat("kept-chat-request", { projectId: "project-1" }, context);
    const { id, payload } = await attach(pal.uploads, dataRoot);
    await expect(pal.chats.submit(chat.id, "kept-input", { text: "read", attachments: [id] }, context)).rejects.toBe(
      lost,
    );
    await rm(payload);
    await expect(pal.chats.withdraw(chat.id, "kept-input", context)).rejects.toBeInstanceOf(RequestConflict);
    expect(await pal.store.database.all("SELECT state FROM pal_admissions")).toEqual([{ state: "admitted" }]);
    expect(await pal.userMessages(chat.conversationId)).toBe(1);
  });

  it("lists chats with command mode, workspace validation, equal-timestamp ordering and unavailable-workspace null", async () => {
    const dataRoot = await tempDir();
    const { store, chats } = await open(dataRoot);
    const db = store.database;
    await db.run(
      "INSERT INTO pal_projects (id, request_id, digest, name, mode, state, root, created_at) VALUES ('p-ready', 'rp-1', 'd', 'Ready', 'managed', 'ready', '/tmp/p-ready', 100)",
    );
    await db.run(
      "INSERT INTO pal_projects (id, request_id, digest, name, mode, state, root, created_at) VALUES ('p-failed', 'rp-2', 'd', 'Failed', 'managed', 'failed', '/tmp/p-failed', 101)",
    );
    const insertChat =
      "INSERT INTO pal_chats (id, request_id, digest, intent, state, conversation_id, created_at, project_id, title, deleted_at, command_mode) VALUES (?, ?, 'd', '{}', ?, ?, ?, ?, ?, ?, ?)";
    await db.run(insertChat, "c-old", "rc-1", "ready", 1, 500, "p-ready", "Old", null, "ask");
    await db.run(insertChat, "c-tie-1", "rc-2", "ready", 2, 600, "p-ready", "Tie 1", null, "auto");
    await db.run(insertChat, "c-tie-2", "rc-3", "ready", 3, 600, "p-ready", "Tie 2", null, "full");
    await db.run(insertChat, "c-deleted", "rc-4", "ready", 4, 700, "p-ready", "Deleted", 750, "ask");
    await db.run(insertChat, "c-prov", "rc-5", "provisioning", null, 800, "p-ready", "Prov", null, "ask");
    await db.run(insertChat, "c-failed", "rc-6", "ready", 5, 600, "p-failed", "Failed proj", null, "full");

    await db.run(
      "INSERT INTO pal_admissions (seq, chat_id, request_id, digest, intent, state, submission_id, created_at, blocked) VALUES (1, 'c-tie-1', 'ra-1', 'd', '{\"text\":\"retry me\"}', 'admitting', NULL, 610, 'missing file')",
    );
    const plan = JSON.stringify({
      source: "/tmp/p-ready",
      sourceIdentity: "id-s",
      common: "/tmp/p-ready/.git",
      commonIdentity: "id-c",
      base: "a".repeat(40),
      submodules: 2,
    });
    await db.run(
      "INSERT INTO pal_workspaces (id, project_id, chat_id, mode, root, source, plan, identity, nonce, state, error) VALUES ('ws-wt', 'p-ready', 'c-tie-2', 'worktree', '/tmp/wt', '/tmp/p-ready', ?, 'id-w', 'n1', 'ready', NULL)",
      plan,
    );
    await db.run(
      "INSERT INTO pal_workspaces (id, project_id, chat_id, mode, root, source, plan, identity, nonce, state, error) VALUES ('ws-local', 'p-ready', 'c-tie-1', 'local', '/tmp/p-ready', '/tmp/p-ready', NULL, 'id-l', 'n2', 'ready', NULL)",
    );
    // Unavailable project with a corrupt plan must still return workspace: null rather than failing.
    await db.run(
      "INSERT INTO pal_workspaces (id, project_id, chat_id, mode, root, source, plan, identity, nonce, state, error) VALUES ('ws-failed', 'p-failed', 'c-failed', 'worktree', '/tmp/wt-f', '/tmp/p-failed', '{bad', NULL, 'n3', 'failed', 'broken')",
    );

    const ready = await chats.list("p-ready");
    expect(ready.map((c) => c.id)).toEqual(["c-tie-2", "c-tie-1", "c-old"]);
    expect(ready[0]).toMatchObject({
      id: "c-tie-2",
      commandMode: "full",
      blocked: null,
      workspace: {
        id: "ws-wt",
        projectId: "p-ready",
        chatId: "c-tie-2",
        mode: "worktree",
        root: "/tmp/wt",
        source: "/tmp/p-ready",
        base: "a".repeat(40),
        state: "ready",
        submodules: 2,
        error: null,
      },
    });
    expect(ready[1]).toMatchObject({
      id: "c-tie-1",
      commandMode: "auto",
      blocked: { requestId: "ra-1", text: "retry me", reason: "missing file" },
      workspace: { id: "ws-local", mode: "local", base: null, submodules: 0, state: "ready" },
    });
    expect(ready[2]).toMatchObject({ id: "c-old", commandMode: "ask", workspace: null, blocked: null });

    const failed = await chats.list("p-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: "c-failed", commandMode: "full", workspace: null });

    // A corrupt stored worktree plan on a ready project fails closed without stopping admission.
    await db.run("UPDATE pal_workspaces SET plan = '{corrupt' WHERE id = 'ws-wt'");
    await expect(chats.list("p-ready")).rejects.toBeInstanceOf(FileAccessError);
    expect(chats.stopped).toBe(false);
  });

  it("stops admission when listing chats hits a storage error", async () => {
    const dataRoot = await tempDir();
    const { store, harness } = await open(dataRoot);
    let stopped = 0;
    const chats = await ChatService.open(
      {
        database: store.database,
        harness,
        agentFor: async () => undefined,
        onStopped: () => {
          stopped++;
        },
      },
      context,
    );
    await store.close();
    await expect(chats.list("project-1")).rejects.toBeInstanceOf(AdmissionStopped);
    expect(chats.stopped).toBe(true);
    expect(stopped).toBe(1);
  });
});
