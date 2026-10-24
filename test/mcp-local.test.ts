import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { StdioPrograms, type StdioAuth } from "../src/pi/mcp-stdio.ts";
import { mcpToolName } from "../src/pi/mcp-tools.ts";
import { STDIO_FIXTURE } from "./fixtures/stdio-server.ts";
import { startOpenAIFixture } from "./fixtures/openai-server.ts";
import { processCwd, running } from "./fixtures/process.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
async function setup(auth: StdioAuth = { kind: "none" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-local-mcp-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "program-cwd"),
    dataRoot = join(root, "data"),
    marker = join(cwd, "starts");
  await mkdir(cwd);
  let pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("local-project", { name: "Local MCP" });
  const code = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "start\\n");\n${STDIO_FIXTURE}`;
  const input = {
    transport: "stdio" as const,
    name: "Local fixture",
    command: process.execPath,
    args: ["-e", code],
    cwd,
    auth,
  };
  const server = await pal.mcp.add(input);
  let sequence = 0;
  const agent = async (projectId = project.id) => {
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const chat = await pal.chats.createChat(`local-chat-${++sequence}`, { projectId }, context);
    const conversation = await pal.harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("fixture conversation missing");
    const model = faux.getModel();
    await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    const start = async (code: string) => {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      await pal.chats.submit(chat.id, `local-input-${sequence}`, { text: "exercise the approved local tool" }, context);
    };
    const result = async () => {
      await conversation.waitForIdle(context);
      const history = await conversation.context(context);
      const text = history.messages
        .flatMap((message) =>
          message.role === "toolResult"
            ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
            : [],
        )
        .join("\n");
      return { text, history };
    };
    return { chat, conversation, start, result };
  };
  const approve = async () => {
    const view = await pal.mcp.get(server.id);
    if (view.stdio === null) throw new Error("fixture local program missing");
    return pal.mcp.approveProgram(server.id, view.stdio.digest, true);
  };
  const enable = async () => {
    await approve();
    await pal.mcp.test(server.id);
    await pal.mcp.approve(server.id, ["inspect"], (await pal.mcp.get(server.id)).catalog);
    return pal.mcp.setEnabled(server.id, true);
  };
  return {
    root,
    cwd,
    dataRoot,
    marker,
    project,
    input,
    server,
    agent,
    approve,
    enable,
    get pal() {
      return pal;
    },
    reopen: async () => {
      await pal.close();
      pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
      return pal;
    },
  };
}

describe("local MCP owner consent and durable tool policy", () => {
  it("saves without starting code, requires an exact approval, and keeps program/tool/project grants separate", async () => {
    const fixture = await setup();
    const { pal, server, marker } = fixture;
    expect(server).toMatchObject({ enabled: false, state: "approval_required", stdio: { approved: false } });
    await expect(access(marker)).rejects.toThrow();
    expect(await pal.mcp.test(server.id)).toMatchObject({ state: "approval_required" });
    await expect(access(marker)).rejects.toThrow();
    await expect(pal.mcp.setEnabled(server.id, true)).rejects.toThrow(/approve/);
    await expect(pal.mcp.approveProgram(server.id, "0".repeat(64), true)).rejects.toThrow(/changed/);
    const allowed = await fixture.approve();
    await expect(access(marker)).rejects.toThrow();
    expect(await fixture.approve()).toEqual(allowed);
    const tested = await pal.mcp.test(server.id);
    expect(tested).toMatchObject({ state: "ready", tools: [{ name: "inspect", approved: false }] });
    expect(await readFile(marker, "utf8")).toBe("start\n");
    await pal.mcp.approve(server.id, ["inspect"], (await pal.mcp.get(server.id)).catalog);
    await pal.mcp.setEnabled(server.id, true);
    const tool = mcpToolName(server.id, "inspect");
    const agent = await fixture.agent();
    await agent.start(`return await tools.${tool}({});`);
    expect((await agent.result()).text).toContain(fixture.cwd);
    expect(await readFile(marker, "utf8")).toBe("start\nstart\n");
    const other = await pal.projects.create("other-local-project", { name: "Other" });
    const grants = await pal.mcp.grants.view(other.id);
    const grant = grants.servers.find((grant) => grant.id === server.id);
    if (grant === undefined) throw new Error("fixture grant missing");
    await pal.mcp.grants.set(other.id, server.id, { revision: grant.revision, mode: "subset", tools: [] });
    const denied = await fixture.agent(other.id);
    await denied.start(`return await tools.${tool}({});`);
    expect((await denied.result()).text).not.toContain(fixture.cwd);
    expect(await readFile(marker, "utf8")).toBe("start\nstart\n");
    expect(allowed.stdio?.digest).toHaveLength(64);
  });

  it("injects only its encrypted key, redacts results/history and does not restart programs just by reopening Pal", async () => {
    const fixture = await setup({ kind: "env", variable: "LOCAL_TOKEN" });
    const key = "fixture-local-encrypted-key";
    await fixture.pal.mcp.setKey(fixture.server.id, key);
    await fixture.enable();
    const agent = await fixture.agent();
    await agent.start(`return await tools.${mcpToolName(fixture.server.id, "inspect")}({});`);
    const { text, history } = await agent.result();
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(key);
    expect(JSON.stringify(history)).not.toContain(key);
    expect(JSON.stringify(await fixture.pal.mcp.list())).not.toContain(key);
    const before = await readFile(fixture.marker, "utf8");
    const reopened = await fixture.reopen();
    expect(await reopened.mcp.get(fixture.server.id)).toMatchObject({
      enabled: true,
      keyConfigured: true,
      stdio: { approved: true },
    });
    expect(await readFile(fixture.marker, "utf8")).toBe(before);
  });

  it("invalidates execution, tool approvals and the old recipient's key when command/args/cwd/auth change", async () => {
    const fixture = await setup({ kind: "env", variable: "LOCAL_TOKEN" });
    await fixture.pal.mcp.setKey(fixture.server.id, "fixture-old-recipient-key");
    const enabled = await fixture.enable();
    const before = await readFile(fixture.marker, "utf8");
    const next = await fixture.pal.mcp.update(fixture.server.id, {
      ...fixture.input,
      args: [...fixture.input.args, "new-argument"],
    });
    expect(next).toMatchObject({ enabled: false, keyConfigured: false, stdio: { approved: false }, tools: [] });
    expect(next.stdio?.digest).not.toBe(enabled.stdio?.digest);
    await expect(fixture.pal.mcp.approveProgram(fixture.server.id, enabled.stdio?.digest ?? "", true)).rejects.toThrow(
      /changed/,
    );
    await fixture.pal.mcp.test(fixture.server.id);
    expect(await readFile(fixture.marker, "utf8")).toBe(before);
    const reopened = await fixture.reopen();
    expect(await reopened.mcp.get(fixture.server.id)).toMatchObject({
      enabled: false,
      keyConfigured: false,
      stdio: { approved: false },
    });
  });

  it("revokes a pending connection before native process dispatch, including owner discovery", async () => {
    const fixture = await setup();
    const allowed = await fixture.approve();
    const original = StdioPrograms.prototype.transport;
    vi.spyOn(StdioPrograms.prototype, "transport").mockImplementationOnce(async function (
      this: StdioPrograms,
      ...args
    ) {
      const transport = await original.apply(this, args);
      await fixture.pal.mcp.approveProgram(fixture.server.id, allowed.stdio?.digest ?? "", false);
      return transport;
    });
    expect(await fixture.pal.mcp.test(fixture.server.id)).toMatchObject({
      state: "approval_required",
      stdio: { approved: false },
    });
    await expect(access(fixture.marker)).rejects.toThrow();
  });

  it("disables in-flight tool waits, kills the child group, and refuses future calls without replaying the effect", async () => {
    const fixture = await setup();
    await fixture.enable();
    const agent = await fixture.agent();
    const tool = mcpToolName(fixture.server.id, "inspect");
    await agent.start(`return await tools.${tool}({mode:"hold"});`);
    const pidFile = join(fixture.cwd, "hold.pid");
    await expect.poll(() => readFile(pidFile, "utf8"), { timeout: 5000 }).toMatch(/^\d+$/);
    const pid = Number(await readFile(pidFile, "utf8"));
    await fixture.pal.mcp.setEnabled(fixture.server.id, false);
    const outcome = await agent.result();
    expect(outcome.text).toMatch(/changed|aborted|not granted/);
    await expect.poll(() => running(pid), { timeout: 3000 }).toBe(false);
    const before = await readFile(fixture.marker, "utf8");
    const denied = await fixture.agent();
    await denied.start(`return await tools.${tool}({});`);
    await denied.result();
    expect(await readFile(fixture.marker, "utf8")).toBe(before);
  });

  it("does not replay an unknown local mutation after SIGKILL and independently expires its orphan", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-local-recovery-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const fixture = await startOpenAIFixture();
    cleanups.push(fixture.close);
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        join(import.meta.dirname, "fixtures/mcp-local-child.ts"),
        root,
        JSON.stringify(fixture.endpoints),
      ],
      { stdio: ["ignore", "pipe", "inherit", "ipc"] },
    );
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    if (child.stdout === null) throw new Error("missing fixture stdout");
    const lines = createInterface({ input: child.stdout });
    const [line] = await Promise.race([
      once(lines, "line"),
      once(child, "exit").then(() => {
        throw new Error("local fixture exited before ready");
      }),
    ]);
    lines.close();
    const ready = JSON.parse(String(line)) as { cwd: string; serverId: string; chatId: string };
    fixture.behavior.responses = "script";
    fixture.behavior.script = `try { return await tools.${mcpToolName(ready.serverId, "inspect")}({mode:"orphan"}); } catch (e) { return "unknown: " + String(e); }`;
    child.send("go");
    const orphanFile = join(ready.cwd, "orphan.json");
    await expect.poll(() => readFile(orphanFile, "utf8"), { timeout: 5000 }).toMatch(/"pid":\d+/);
    const orphan = JSON.parse(await readFile(orphanFile, "utf8")) as { pid: number; group: number };
    cleanups.push(async () => {
      if ((await processCwd(orphan.pid)) === ready.cwd) {
        try {
          process.kill(-orphan.group, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    });
    child.kill("SIGKILL");
    await once(child, "exit");
    expect(await processCwd(orphan.pid)).toBe(ready.cwd);
    fixture.behavior.responses = "ok";
    const reopened = await openPal(
      { dataRoot: join(root, "data"), installRoot: "/nonexistent-install", endpoints: fixture.endpoints },
      context,
    );
    cleanups.push(() => reopened.close());
    await reopened.harness.waitForIdle(context);
    expect(await readFile(join(ready.cwd, "starts"), "utf8")).toBe("start\nstart\n");
    const chat = await reopened.chats.get(ready.chatId);
    if (chat === undefined) throw new Error("missing recovered chat");
    const history = await (await reopened.harness.conversation(chat.conversationId, context))?.context(context);
    expect(JSON.stringify(history?.messages)).toMatch(/unknown:.*interrupted/i);
    const pid = orphan.pid;
    await expect.poll(() => running(pid), { timeout: 95_000, interval: 500 }).toBe(false);
    expect(await readFile(join(ready.cwd, "starts"), "utf8")).toBe("start\nstart\n");
  }, 120_000);

  it("refuses replaced cwd even with a saved approval, but lets the owner revoke unavailable configurations", async () => {
    const fixture = await setup();
    const allowed = await fixture.enable();
    const before = await readFile(fixture.marker, "utf8");
    await rename(fixture.cwd, join(fixture.root, "old-cwd"));
    await mkdir(fixture.cwd);
    expect(await fixture.pal.mcp.test(fixture.server.id)).toMatchObject({
      state: "error",
      detail: expect.stringContaining("replaced"),
    });
    await expect(access(fixture.marker)).rejects.toThrow();
    await fixture.pal.mcp.approveProgram(fixture.server.id, allowed.stdio?.digest ?? "", false);
    expect(await fixture.pal.mcp.get(fixture.server.id)).toMatchObject({ enabled: false, state: "approval_required" });
    expect(await readFile(join(fixture.root, "old-cwd", "starts"), "utf8")).toBe(before);
  });
});
