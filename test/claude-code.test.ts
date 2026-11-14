import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { cachedClaudeProcessCount } from "../plugins/claude-code/vendor/claude-cli.ts";
import { installFakeClaude, startFakeAnthropic } from "./fixtures/claude.ts";

const SECRET = "planted-pal-secret-value";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Logged = {
  pid: number;
  mode?: string;
  request?: boolean;
  cwd?: string;
  env?: string[];
  leaked?: boolean;
  mcp?: string;
  tools?: string[];
  attempts?: { status: number; body: string }[];
  toolCall?: string;
  denied?: boolean;
  text?: string;
};
const INERT_INVENTORY = join(import.meta.dirname, "../plugins/claude-code/vendor/inert-mcp.mjs");

async function setup(config: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-claude-code-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const claude = join(root, "bin", "claude");
  const anthropic = await startFakeAnthropic();
  cleanups.push(() => anthropic.close());

  await mkdir(join(root, "bin"));
  await installFakeClaude(claude);
  const configure = (next: Record<string, unknown>) =>
    writeFile(join(root, "bin", "fake-claude.json"), JSON.stringify({ secret: SECRET, ...next }));
  await configure(config);
  // Planted where a careless child environment would carry them along.
  vi.stubEnv("PAL_TEST_SECRET", SECRET);
  vi.stubEnv("ANTHROPIC_API_KEY", SECRET);
  const pal = await openPal(
    { dataRoot: join(root, "data"), installRoot: "/nonexistent-install", providerOrigin: anthropic.origin },
    context,
  );
  cleanups.push(() => pal.close());
  const plugin = (method: string, path: string, body?: unknown) =>
    pal.capabilities.request(
      "claude-code",
      { method, path: [path], query: new URLSearchParams(), body },
      context,
    ) as Promise<Record<string, unknown>>;
  await plugin("PUT", "settings", { command: claude, configDir: null, allowUsageCredits: false });
  const logged = async (): Promise<Logged[]> =>
    (await readFile(join(root, "bin", "fake-claude.log"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Logged);
  // One entry per Claude Code process start.
  const seen = async () => (await logged()).filter(({ mode }) => mode !== undefined);
  const project = await pal.projects.create("claude-project", { name: "Claude" });
  const chat = await pal.chats.createChat("claude-chat", { projectId: project.id }, context);
  const conversation = await pal.harness.conversation(chat.conversationId, context);
  if (conversation === undefined) throw new Error("missing conversation");
  let inputs = 0;
  const send = async (text: string) => {
    await pal.chats.submit(chat.id, `claude-input-${++inputs}`, { text }, context);
    await conversation.waitForIdle(context);
    return (await conversation.context(context)).messages;
  };
  return { pal, root, claude, anthropic, configure, plugin, logged, seen, chat, conversation, send };
}

describe("Claude subscription provider plugin", () => {
  it("stays off and starts nothing until the owner asks, then reports Claude Code's state", async () => {
    const f = await setup();
    const listed = (await f.pal.providers.list()).find((provider) => provider.id === "claude-code");
    expect(listed).toMatchObject({ plugin: "claude-code", enabled: false, hasKey: false, models: [] });
    expect(listed?.billing).toContain("plan's limits");
    expect(await f.pal.providers.usable("claude-code")).toBe(false);
    expect(await f.seen()).toEqual([]);

    expect(await f.pal.providers.check("claude-code")).toEqual({
      ok: true,
      detail: "Logged in with a Claude max subscription.",
    });
    expect(await f.plugin("POST", "status")).toMatchObject({
      installed: true,
      loggedIn: true,
      version: "2.1.0 (Claude Code)",
    });
    await f.configure({ auth: { loggedIn: false } });
    expect((await f.pal.providers.check("claude-code")).ok).toBe(false);
    await expect(f.pal.providers.setEnabled("claude-code", true)).rejects.toThrow(/not logged in/);
    await f.configure({ auth: { loggedIn: true, authMethod: "api_key" } });
    expect(await f.pal.providers.check("claude-code")).toEqual({
      ok: false,
      detail: "Claude Code is logged in with api_key, not a Claude subscription.",
    });
    await f.plugin("PUT", "settings", { command: join(f.root, "missing"), configDir: null, allowUsageCredits: false });
    expect((await f.pal.providers.check("claude-code")).detail).toMatch(/isn't installed/);
    await expect(
      f.plugin("PUT", "settings", { command: "claude --evil", configDir: null, allowUsageCredits: false }),
    ).rejects.toMatchObject({ status: 400 });
    // Every process saw only the allowlist plus Claude Code's own settings, never Pal's planted secret.
    for (const process_ of await f.seen()) {
      expect(process_.leaked).toBe(false);
      expect(process_.env).not.toContain("PAL_TEST_SECRET");
      expect(process_.env).not.toContain("ANTHROPIC_API_KEY");
    }
  });

  it("streams reasoning and text, hands tool calls to Pal, stops on usage credits and leaves no process", async () => {
    const f = await setup();
    await f.pal.providers.setEnabled("claude-code", true);
    const models = (await f.pal.providers.list()).find((provider) => provider.id === "claude-code")?.models ?? [];
    // The account's models, as Claude Code discovered them, not the built-in list.
    expect(models.map(({ name }) => name)).toEqual(["Claude Sonnet 4.5 (latest)"]);
    const [model] = models;
    if (model === undefined) throw new Error("no Claude Code model listed");
    await f.conversation.configure({ model: { provider: "claude-code", modelId: model.id } }, context);

    const first = await f.send("hello");
    const reply = first.findLast((message) => message.role === "assistant");
    expect(reply?.role === "assistant" && reply.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thinking", thinking: "Fixture reasoning" }),
        expect.objectContaining({ type: "text", text: "Hello from Claude Code" }),
      ]),
    );
    // Claude Code reached Anthropic once, through Pal's relay, with its own login, Pal's history and Pal's tools.
    expect(
      reply?.role === "assistant" && reply.diagnostics?.find(({ type }) => type === "claude-code.turn-relay"),
    ).toMatchObject({ details: { upstreamRequests: 1, blockedRequests: 0 } });
    expect(f.anthropic.requests).toHaveLength(1);
    const [request] = f.anthropic.requests;
    expect(request?.headers.authorization).toBe("Bearer fake-claude-code-login");
    expect(JSON.stringify(request?.body.messages)).toContain("hello");
    expect(JSON.stringify(request?.body.messages)).not.toContain("fixture reminder");
    const inventory = (await f.logged()).find(({ tools }) => tools !== undefined);
    expect(inventory?.mcp).toBe(INERT_INVENTORY);
    expect(inventory?.tools).toContain("codemode");
    expect(request?.body.tools?.map(({ name }) => name)).toEqual(
      expect.arrayContaining((inventory?.tools ?? []).map((name) => `mcp__pi__${name}`)),
    );

    const second = await f.send("call-tool");
    const result = second.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    expect(JSON.stringify(result)).toContain("tool ran");
    expect(second.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    // Claude Code's own call reached only the inert inventory; Pal's real result went upstream with the next request.
    expect((await f.logged()).find(({ toolCall }) => toolCall !== undefined)).toMatchObject({
      toolCall: "mcp__pi__codemode",
      denied: true,
      text: expect.stringContaining("inert"),
    });
    expect(f.anthropic.requests).toHaveLength(3);
    expect(JSON.stringify(f.anthropic.requests.at(-1)?.body.messages.at(-1))).toContain("tool ran");

    await f.configure({ overage: true });
    const before = (await f.seen()).filter(({ mode }) => mode === "stream").length;
    const third = await f.send("one more");
    // The charged reply is not kept, the run fails with the billing reason, and nothing retries it.
    expect(third.at(-1)).toMatchObject({ role: "user" });
    const live = await f.pal.harness.snapshot(LiveDoc, f.chat.conversationId, context);
    expect(live?.runFailure).toMatchObject({
      reason: "model_error",
      detail: expect.stringMatching(/Claude Code billing/),
    });
    expect((await f.seen()).filter(({ mode }) => mode === "stream").length - before).toBeLessThanOrEqual(1);

    const streams = (await f.seen()).filter(({ mode }) => mode === "stream");
    expect(streams.length).toBeGreaterThan(0);
    expect(streams.some(({ request }) => request)).toBe(true);
    for (const process_ of streams) {
      expect(process_.leaked).toBe(false);
      // Model requests run in the plugin's empty folder, never Pal's own working directory.
      if (process_.request) expect(process_.cwd).toMatch(/pal-claude-code-/);
    }
    await f.pal.close();
    for (const { pid } of await f.seen())
      expect(() => process.kill(pid, 0), `Claude Code process ${pid} outlived Pal`).toThrow();
  }, 60_000);

  it("refuses an account that is no longer a subscription and ends its process when disabled", async () => {
    const f = await setup();
    await f.pal.providers.setEnabled("claude-code", true);
    const [model] = (await f.pal.providers.list()).find((provider) => provider.id === "claude-code")?.models ?? [];
    if (model === undefined) throw new Error("no Claude Code model listed");
    await f.conversation.configure({ model: { provider: "claude-code", modelId: model.id } }, context);
    expect((await f.send("hello")).at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(cachedClaudeProcessCount()).toBe(1);

    // The owner points the enabled provider at another config directory, whose login is an API key.
    await f.configure({ auth: { loggedIn: true, authMethod: "api_key" } });
    await f.plugin("PUT", "settings", {
      command: f.claude,
      configDir: join(f.root, "api-account"),
      allowUsageCredits: false,
    });
    expect(cachedClaudeProcessCount()).toBe(0);
    const before = (await f.seen()).filter(({ request }) => request).length;
    expect((await f.send("after the switch")).at(-1)).toMatchObject({ role: "user" });
    const live = await f.pal.harness.snapshot(LiveDoc, f.chat.conversationId, context);
    expect(live?.runFailure?.detail).toMatch(/not a Claude subscription/);
    expect((await f.seen()).filter(({ request }) => request).length).toBe(before);

    await f.configure({});
    await f.plugin("PUT", "settings", { command: f.claude, configDir: null, allowUsageCredits: false });
    expect((await f.send("back on the plan")).at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    const warm = (await f.seen()).filter(({ request }) => request).at(-1)?.pid;
    if (warm === undefined) throw new Error("no Claude Code request process");
    expect(cachedClaudeProcessCount()).toBe(1);
    await f.pal.providers.setEnabled("claude-code", false);
    expect(cachedClaudeProcessCount()).toBe(0);
    expect(() => process.kill(warm, 0), "the warm process outlived disabling").toThrow();
  }, 60_000);

  it("lets each Claude Code request reach Anthropic once and cuts it on Stop", async () => {
    const f = await setup();
    await f.pal.providers.setEnabled("claude-code", true);
    const [model] = (await f.pal.providers.list()).find((provider) => provider.id === "claude-code")?.models ?? [];
    if (model === undefined) throw new Error("no Claude Code model listed");
    await f.conversation.configure({ model: { provider: "claude-code", modelId: model.id } }, context);

    await f.send("overloaded-once");
    const attempts = (await f.logged()).flatMap(({ attempts }) => (attempts === undefined ? [] : [attempts]));
    // The relay refuses Claude Code's own retry after the 529, so each request reaches Anthropic at most once.
    expect(attempts[0]).toEqual([
      { status: 529, body: "" },
      { status: 400, body: expect.stringContaining("PI_CLAUDE_CODE_TURN_RELAY_CONSUMED") },
    ]);
    expect(f.anthropic.requests).toHaveLength(attempts.length);

    const before = f.anthropic.requests.length;
    await f.pal.chats.submit(f.chat.id, "claude-input-hold", { text: "hold" }, context);
    await vi.waitFor(() => expect(f.anthropic.requests).toHaveLength(before + 1), { timeout: 20_000 });
    const held = (await f.seen()).filter(({ request }) => request).at(-1)?.pid;
    if (held === undefined) throw new Error("no Claude Code request process");
    await f.conversation.abort(context);
    await f.conversation.waitForIdle(context);
    await vi.waitFor(() => expect(f.anthropic.requests.at(-1)?.cut).toBe(true));
    expect(cachedClaudeProcessCount()).toBe(0);
    expect(() => process.kill(held, 0), "the stopped Claude Code process lived on").toThrow();
  }, 60_000);
});
