import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";

const SECRET = "planted-pal-secret-value";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Seen = { pid: number; mode: string; request: boolean; cwd: string; env: string[]; leaked: boolean };

async function setup(config: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-claude-code-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const claude = join(root, "bin", "claude");

  await mkdir(join(root, "bin"));
  await copyFile(join(import.meta.dirname, "fixtures/fake-claude.mjs"), claude);
  await chmod(claude, 0o755);
  const configure = (next: Record<string, unknown>) =>
    writeFile(join(root, "bin", "fake-claude.json"), JSON.stringify({ secret: SECRET, ...next }));
  await configure(config);
  // Planted where a careless child environment would carry them along.
  vi.stubEnv("PAL_TEST_SECRET", SECRET);
  vi.stubEnv("ANTHROPIC_API_KEY", SECRET);
  const pal = await openPal({ dataRoot: join(root, "data"), installRoot: "/nonexistent-install" }, context);
  cleanups.push(() => pal.close());
  const plugin = (method: string, path: string, body?: unknown) =>
    pal.capabilities.request(
      "claude-code",
      { method, path: [path], query: new URLSearchParams(), body },
      context,
    ) as Promise<Record<string, unknown>>;
  await plugin("PUT", "settings", { command: claude, configDir: null, allowUsageCredits: false });
  const seen = async (): Promise<Seen[]> =>
    (await readFile(join(root, "bin", "fake-claude.log"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Seen);
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
  return { pal, root, claude, configure, plugin, seen, chat, conversation, send };
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

    const second = await f.send("call-tool");
    const result = second.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    expect(JSON.stringify(result)).toContain("tool ran");
    expect(second.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });

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
});
