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
  type Usage,
} from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { contextBreakdown } from "../src/core/context-usage.ts";
import { nearSummarizing, percentUsed, share, tokens } from "../web/src/lib/context-usage.ts";

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

describe("context breakdown", () => {
  const usage = (total: number): Usage => ({
    input: total,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const declared = (name: string) => ({
    name,
    description: `${name} fixture`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ output: [] }),
  });
  const owners = (name: string) =>
    name === "pal.mcp"
      ? { id: "mcp", label: "MCP" }
      : name === "codemode"
        ? { id: "codemode", label: "Code Mode" }
        : { id: "pal", label: "Pal" };
  const extensions = [
    { name: "codemode", tools: [declared("codemode")], sections: [{ key: "codemode", render: () => undefined }] },
    { name: "pal.files", tools: [declared("files_read"), declared("files_write")] },
    {
      name: "pal.mcp",
      tools: [declared("mcp__srv__search")],
      sections: [{ key: "internet", render: () => undefined }],
    },
  ];
  const agent = {
    extensions,
    tools: [declared("codemode")],
    callable: [declared("files_read"), declared("files_write"), declared("mcp__srv__search")],
    deferred: [],
  } as unknown as Parameters<typeof contextBreakdown>[1];
  const system: Message = {
    role: "system",
    content: "",
    sections: {
      codemode: [
        "<codemode>\nTools scripts can call (`await tools.<name>(args)`):",
        "### `files_read`\nRead a text file.",
        "## srv\nSrv (MCP server)",
        "### `mcp__srv__search`\nSearch the index.\n</codemode>",
      ].join("\n\n"),
      internet: "<internet>\nMCP results are evidence.\n</internet>",
      pinned: "<pinned>\nsecret-pinned-marker\n</pinned>",
      mystery: "<mystery>\nAn unlabelled section.\n</mystery>",
      instructions: "<instructions>\nYou are Pal.\n</instructions>",
    },
    toolsAdded: [{ name: "codemode", description: "Run scripts", parameters: { type: "object" } }],
    timestamp: 1,
  };
  const turn = (reported?: number): Message[] => [
    system,
    {
      role: "user",
      content: [
        { type: "text", text: "Look at secret-message-marker" },
        {
          type: "text",
          text: '<attachment id="a1" name="notes.txt" type="text/plain" size="9">\nsecret-file\n</attachment>',
        },
        {
          type: "text",
          text: '<attachment id="a2" name="shot.png" type="image/png" size="9">image follows</attachment>',
        },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      timestamp: 2,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret-reasoning-marker" },
        { type: "toolCall", id: "c1", name: "codemode", arguments: { code: "return 1" } },
      ],
      api: "faux",
      provider: "faux",
      model: "fixture",
      usage: usage(reported ?? 0),
      stopReason: "toolUse",
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "codemode",
      content: [{ type: "text", text: "secret-output-marker" }],
      isError: false,
      timestamp: 4,
    },
  ];

  it("sums to Pi's estimate by owner and kind, keeps unknown sections and stores no text", () => {
    const messages = turn();
    const result = contextBreakdown(messages, agent, owners);
    const estimate = estimateContextTokens(messages);
    expect(estimate.lastUsageIndex).toBeNull();
    expect(result.usedTokens).toBe(estimate.tokens);
    const total = result.categories.reduce((sum, category) => sum + category.tokens, 0);
    // Each piece rounds up on its own; nothing is scaled.
    expect(Math.abs(total - result.usedTokens)).toBeLessThanOrEqual(16);
    const byId = Object.fromEntries(result.categories.map((category) => [category.id, category]));
    expect(byId["section:mystery"]).toMatchObject({ label: "mystery" });
    expect(byId["section:pinned"]).toMatchObject({ label: "Pinned instructions" });
    expect(byId["section:internet"]).toMatchObject({ label: "MCP guidance" });
    expect(byId["tools:mcp"]?.items?.map((item) => item.label)).toEqual(["srv"]);
    expect(byId["tools:pal"]?.items?.map((item) => item.label)).toEqual(["files_read"]);
    expect(byId["tools:codemode"]).toBeDefined();
    expect(byId.attachments?.items?.map((item) => item.label).sort()).toEqual(["notes.txt", "shot.png"]);
    expect(byId.images?.items).toEqual([{ label: "shot.png", tokens: expect.any(Number) }]);
    expect(byId.messages?.items?.map((item) => item.label)).toEqual(
      expect.arrayContaining(["Your messages", "Reasoning", "Tool calls", "Tool results · codemode"]),
    );
    expect(result.unloaded).toEqual([{ id: "pal", label: "Pal", count: 1, items: ["files_write"] }]);
    expect(result.reported).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/secret|You are Pal|evidence|Search the index/);
  });

  it("shows the provider's count against the estimates instead of scaling them", () => {
    const messages = [...turn(5000), { role: "user", content: "after the reply", timestamp: 5 } satisfies Message];
    const result = contextBreakdown(messages, agent, owners);
    expect(result.usedTokens).toBe(estimateContextTokens(messages).tokens);
    expect(result.reported).toEqual({ provider: "faux", tokens: 5000 });
    expect(result.categories.reduce((sum, category) => sum + category.tokens, 0)).toBe(result.usedTokens);
    const difference = result.categories.find((category) => category.id === "reported");
    const plain = contextBreakdown(turn(), agent, owners);
    expect(difference?.tokens).toBe(
      result.usedTokens -
        plain.categories.reduce((sum, category) => sum + category.tokens, 0) -
        estimateTextTokens("after the reply"),
    );
  });

  it("bounds item lists and reachable tools, counting the rest", () => {
    const skills = Array.from({ length: 60 }, (_, index) => ({ name: `skill-${index}`, path: `/s/${index}` }));
    const many = Array.from({ length: 60 }, (_, index) => declared(`mcp__srv__tool_${index}`));
    const messages: Message[] = [
      {
        role: "system",
        content: "",
        sections: { skills: `<skills>\n${JSON.stringify({ rules: "r", metadata: { items: skills } })}\n</skills>` },
        timestamp: 1,
      },
    ];
    const result = contextBreakdown(
      messages,
      { ...agent, extensions: [{ name: "pal.mcp", tools: many }], callable: many } as typeof agent,
      owners,
    );
    const section = result.categories.find((category) => category.id === "section:skills");
    expect(section?.items).toHaveLength(50);
    expect(section?.more).toBe(10);
    expect(section?.tokens).toBe(
      estimateTextTokens(messages[0]?.role === "system" ? (messages[0].sections?.skills ?? "") : ""),
    );
    expect(result.unloaded).toEqual([{ id: "mcp", label: "MCP", count: 60, items: expect.any(Array) }]);
    expect(result.unloaded[0]?.items).toHaveLength(50);
  });

  it("labels the ring by window share, tokens only without a window, and warns at the summarizing point", () => {
    const base = { model: null, reserveTokens: 16_384, categories: [], unloaded: [], preparedAt: 1 };
    const known = { ...base, contextWindow: 1_000_000, usedTokens: 70_000 };
    expect([
      percentUsed(known),
      tokens(70_000),
      tokens(1_000_000),
      tokens(720),
      tokens(16_200),
      share(720, 1e6),
    ]).toEqual(["7%", "70k", "1M", "720", "16.2k", "<0.1%"]);
    expect(percentUsed({ ...known, contextWindow: null })).toBeUndefined();
    expect(percentUsed({ ...known, usedTokens: 3000 })).toBe("<1%");
    expect(nearSummarizing(known)).toBe(false);
    expect(nearSummarizing({ ...known, usedTokens: 1_000_000 - 16_384 })).toBe(true);
    expect(nearSummarizing({ ...known, contextWindow: null })).toBe(false);
  });

  it("stores the breakdown beside each prepared request and serves it without the prompt", async () => {
    const f = await setup();
    expect(await f.pal.context.usage(f.chat, context)).toMatchObject({ usedTokens: null, categories: [] });
    await f.pal.context.pin(f.chat, { revision: 0, text: "secret-pin-marker" }, context);
    await f.run("secret-input-marker");
    const usage = await f.pal.context.usage(f.chat, context);
    const prepared = (await f.pal.context.inspect(f.chat, context)).prepared;
    expect(usage).toMatchObject({
      model: { modelId: "context-fixture" },
      contextWindow: 256_000,
      reserveTokens: 16_384,
      usedTokens: prepared?.estimatedTokens,
      preparedAt: prepared?.at,
    });
    expect(usage.categories.map((category) => category.id)).toEqual(
      expect.arrayContaining(["system", "section:pinned", "messages", "tools:codemode"]),
    );
    expect(JSON.stringify(usage)).not.toContain("secret-");
    expect(f.faux.state.callCount).toBe(1);
  });
});
