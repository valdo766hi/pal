import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  getSystemMessageText,
  type Message,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-context-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const options = { dataRoot: root, installRoot: "/nonexistent-install" };
  let pal = await openPal(options, context);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("context-project", { name: "Context fixture" });
  const chat = await pal.chats.createChat("context-chat", { projectId: project.id }, context);
  // Room for the large inputs below automatic compaction, so only the test's explicit compaction summarizes.
  const faux = fauxProvider({ models: [{ id: "context-fixture", input: ["text", "image"], contextWindow: 256_000 }] });
  const requests: (readonly Message[])[] = [];
  let sequence = 0;
  const conversation = async () => {
    const value = await pal.harness.conversation(chat.conversationId, context);
    if (value === undefined) throw new Error("missing context conversation");
    return value;
  };
  const run = async (text = "fixture input", attachments: string[] = []) => {
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const convo = await conversation();
    const model = faux.getModel();
    await convo.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    faux.setResponses([
      (request) => {
        requests.push(request.messages);
        return fauxAssistantMessage("fixture answer");
      },
    ]);
    await pal.chats.submit(chat.id, `context-input-${++sequence}`, { text, attachments }, context);
    await convo.waitForIdle(context);
    return await pal.context.inspect(chat, context);
  };
  return {
    project,
    chat,
    faux,
    requests,
    conversation,
    run,
    get pal() {
      return pal;
    },
    reopen: async () => {
      await pal.close();
      pal = await openPal(options, context);
    },
  };
}

describe("pinned instructions and native prompt inspection", () => {
  it("pins only explicit owner text, freezes prepared context and survives compaction/reopen", async () => {
    const f = await setup();
    expect((await f.pal.context.inspect(f.chat, context)).prepared).toBeNull();
    await expect(f.pal.context.prompt(f.chat, { offset: 0 }, context)).rejects.toMatchObject({
      code: "context_missing",
    });
    await f.pal.context.pin(f.chat, { revision: 0, text: "Prefer small changes." }, context);
    expect(f.faux.state.callCount).toBe(0);
    await f.run("a".repeat(90_000));
    await f.run("b".repeat(90_000));
    const info = await f.run("inspect this preparation");
    expect(info.pinned).toMatchObject({ text: "Prefer small changes.", revision: 1 });
    expect(info.prepared?.model.modelId).toBe("context-fixture");
    expect(info.prepared?.messages).toBe(f.requests.at(-1)?.length);
    expect(
      f.requests.at(-1)?.some((m) => m.role === "system" && getSystemMessageText(m).includes("Prefer small changes.")),
    ).toBe(true);
    const before = await f.pal.context.prompt(f.chat, { offset: 0 }, context);
    expect(before.sections.find((section) => section.name === "pinned")?.text).toContain("Prefer small changes.");
    expect(before.previews.some((m) => m.text.includes("inspect this preparation"))).toBe(true);
    await f.pal.context.pin(f.chat, { revision: 1, text: "A later owner preference." }, context);
    expect((await f.pal.context.prompt(f.chat, { offset: 0 }, context)).request).toEqual(before.request);
    expect(f.faux.state.callCount).toBe(3);
    f.faux.setResponses([fauxAssistantMessage("Earlier context summarized.")]);
    const task = await (await f.conversation()).compact(undefined, context);
    await f.pal.harness.waitForTask(task, context);
    expect((await f.pal.context.inspect(f.chat, context)).head).not.toBeNull();
    expect((await f.pal.context.prompt(f.chat, { offset: 0 }, context)).previews).toEqual(before.previews);
    await f.reopen();
    expect((await f.pal.context.prompt(f.chat, { offset: 0 }, context)).request).toEqual(before.request);
    expect((await f.pal.context.inspect(f.chat, context)).pinned.text).toBe("A later owner preference.");
    await f.run();
    await expect(
      f.pal.context.prompt(f.chat, { offset: 0, request: before.request.digest }, context),
    ).rejects.toMatchObject({ code: "context_stale" });
  });

  it("bounds estimated tokens and UTF-8 bytes independently, without changing core policy or another chat", async () => {
    const f = await setup();
    const core = (await f.pal.context.inspect(f.chat, context)).instructions;
    await f.pal.context.pin(f.chat, { revision: 0, text: "x".repeat(5250) }, context);
    expect((await f.pal.context.inspect(f.chat, context)).pinned.estimatedTokens).toBe(1500);
    await expect(f.pal.context.pin(f.chat, { revision: 1, text: "x".repeat(5251) }, context)).rejects.toMatchObject({
      code: "context_budget",
    });
    await f.pal.context.pin(f.chat, { revision: 1, text: "界".repeat(2048) }, context);
    expect((await f.pal.context.inspect(f.chat, context)).pinned.bytes).toBe(6144);
    await expect(f.pal.context.pin(f.chat, { revision: 2, text: "界".repeat(2049) }, context)).rejects.toMatchObject({
      code: "context_budget",
    });
    await expect(f.pal.context.pin(f.chat, { revision: 1, text: "stale overwrite" }, context)).rejects.toMatchObject({
      code: "context_stale",
    });
    await expect(f.pal.context.pin(f.chat, { revision: 2, text: "valid", extra: true }, context)).rejects.toThrow();
    await f.pal.context.pin(f.chat, { revision: 2, text: "" }, context);
    const other = await f.pal.chats.createChat("other-context-chat", { projectId: f.project.id }, context);
    expect((await f.pal.context.inspect(other, context)).pinned).toMatchObject({ revision: 0, text: "" });
    expect((await f.pal.context.inspect(f.chat, context)).instructions).toBe(core);
    expect(f.faux.state.callCount).toBe(0);
  });

  it("lists recent attachment labels without image bodies or opaque reasoning/signatures", async () => {
    const f = await setup();
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    const upload = await f.pal.uploads.admit(f.project.id, {
      name: "fixture.png",
      size: bytes.length,
      type: "image/png",
    });
    await f.pal.uploads.receive(upload.id, Readable.from([bytes]));
    const convo = await f.conversation();
    await convo.submit(
      {
        type: "write",
        entry: {
          kind: "fixture.reasoning",
          model: [
            fauxAssistantMessage([
              { type: "thinking", thinking: "hidden fixture reasoning", thinkingSignature: "opaque-fixture-signature" },
            ]),
          ],
        },
      },
      context,
    );
    const info = await f.run("inspect the attachment", [upload.id]);
    expect(info.attachments).toMatchObject([
      { id: upload.id, name: "fixture.png", mediaType: "image/png", size: bytes.length },
    ]);
    const prompt = await f.pal.context.prompt(f.chat, { offset: 0 }, context);
    const shown = JSON.stringify(prompt.previews);
    expect(shown).toContain("Image body omitted");
    expect(shown).toContain("Reasoning body/signature omitted");
    expect(shown).not.toContain(bytes.toString("base64"));
    expect(shown).not.toContain("opaque-fixture-signature");
    expect(shown).not.toContain("hidden fixture reasoning");
  });

  it("pages bounded UTF-8 previews without changing model work or returning truncated images as text", async () => {
    const f = await setup();
    const convo = await f.conversation();
    for (let i = 0; i < 35; i++)
      await convo.submit(
        {
          type: "write",
          entry: {
            kind: "fixture.message",
            model: [{ role: "user", content: `${i}: ${"界".repeat(2000)}`, timestamp: Date.now() }],
          },
        },
        context,
      );
    await f.run();
    let offset = 0;
    const indexes: number[] = [];
    do {
      const page = await f.pal.context.prompt(f.chat, { offset }, context);
      expect(page.previews.length).toBeLessThanOrEqual(20);
      expect(
        [...page.previews, ...page.sections].reduce((n, m) => n + Buffer.byteLength(m.text), 0),
      ).toBeLessThanOrEqual(65536);
      for (const preview of page.previews) {
        expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(4096);
        expect(preview.text).not.toContain("\uFFFD");
        indexes.push(preview.index);
      }
      if (page.next === null) break;
      expect(page.next).toBeGreaterThan(offset);
      offset = page.next;
    } while (offset < 100);
    expect(indexes).toEqual(Array.from({ length: f.requests[0]?.length ?? 0 }, (_, i) => i));
    expect(f.faux.state.callCount).toBe(1);
    await expect(f.pal.context.prompt(f.chat, { offset: -1 }, context)).rejects.toThrow();
  });

  it("refuses a mismatched historical reconstruction instead of presenting a guessed prompt", async () => {
    const f = await setup();
    await f.run();
    const convo = await f.conversation();
    vi.spyOn(f.pal.harness, "conversation").mockResolvedValue({
      ...convo,
      context: async (...args) => {
        const view = await convo.context(...args);
        return {
          ...view,
          messages: [...view.messages, { role: "user", content: "wrong boundary", timestamp: Date.now() }],
        };
      },
    });
    await expect(f.pal.context.prompt(f.chat, { offset: 0 }, context)).rejects.toMatchObject({
      code: "context_changed",
    });
    expect(f.faux.state.callCount).toBe(1);
  });

  it("bounds concurrent prompt reads and withholds data after a late project removal", async () => {
    const f = await setup();
    await f.run();
    const convo = await f.conversation();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let reads = 0;
    vi.spyOn(f.pal.harness, "conversation").mockResolvedValue({
      ...convo,
      context: async (...args) => {
        if (++reads === 2) entered.resolve(undefined);
        await release.promise;
        return convo.context(...args);
      },
    });
    const first = f.pal.context.prompt(f.chat, { offset: 0 }, context);
    const second = f.pal.context.prompt(f.chat, { offset: 0 }, context);
    try {
      await entered.promise;
      await expect(f.pal.context.prompt(f.chat, { offset: 0 }, context)).rejects.toMatchObject({
        code: "context_busy",
      });
      await f.pal.projects.remove(f.project.id);
    } finally {
      release.resolve(undefined);
    }
    await expect(first).rejects.toMatchObject({ code: "not_found" });
    await expect(second).rejects.toMatchObject({ code: "not_found" });
    await expect(f.pal.context.pin(f.chat, { revision: 0, text: "not authorized" }, context)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
