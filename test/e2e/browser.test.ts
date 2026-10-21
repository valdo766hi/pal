// The owner's sandboxed browser with the packaged runtime: sandbox and egress isolation, owner-only control, tabs,
// input, dialogs, profile persistence and limits. Run via `nix build .#checks.<system>.e2e`, which provides it.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApi } from "../../src/core/api.ts";
import { openPal, type Pal } from "../../src/core/app.ts";
import { type BrowserRuntime, browserRuntime, sandboxArgs } from "../../src/core/browser.ts";
import { BrowserOwnerNeeded, BrowserPage } from "../../src/core/browser-page.ts";
import { startServer } from "../../src/core/server.ts";
import { privateBrowserPages } from "../fixtures/private-browser-pages.ts";

const packaged = browserRuntime();
// Nix builders lack a user manager. The separate host run exercises the same tests with real resource scopes.
const runtime: BrowserRuntime | undefined =
  process.env.PAL_TEST_USER_SCOPE === "1"
    ? packaged
    : packaged === undefined
      ? undefined
      : { ...packaged, scope: null };
const cleanups: (() => unknown)[] = [];
const requests: { path: string; cookie: string }[] = [];
let site: number;

beforeAll(async () => {
  if (runtime === undefined)
    throw new Error("run via nix build .#checks.<system>.e2e, which provides the browser runtime");
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push({ path, cookie: request.headers.cookie ?? "" });
    if (path.startsWith("/external-effect/")) return;
    response.setHeader("content-type", "text/html");
    if (path === "/login") response.setHeader("set-cookie", "session=fixture; Max-Age=3600; Path=/; HttpOnly");
    if (path === "/slow") setTimeout(() => response.end("<title>Slow fixture</title>"), 1500);
    else if (path === "/alert") response.end("<title>Alert</title><script>alert('hi from the page')</script>");
    else if (/^\/crash-page\/crash-\d+$/.test(path))
      response.end(
        `<button onclick="fetch('/external-effect/${path.split("/").at(-1)}'); const until = performance.now() + 10000; while (performance.now() < until) {}">External effect</button>` +
          '<script>document.title="Crash fixture"</script>',
      );
    else if (path.startsWith("/agent"))
      response.end(
        "<title>Public fixture</title><p>Visible fixture text</p><p hidden>hidden-canary</p>" +
          "<button onclick=\"fetch('/agent-clicked')\">Public action</button>" +
          '<input name="query" value="input-canary"><textarea name="note">textarea-canary</textarea>' +
          '<script>String.prototype.slice = () => "prototype-canary"; fetch("/agent-ready")</script>',
      );
    else if (path === "/embedded") response.end('<input type="password" value="protected-canary">');
    else if (path.startsWith("/private-ready")) response.end("ready");
    else if (path.startsWith("/private-page")) {
      const id = URL.parse(path, "http://fixture.invalid")?.searchParams.get("case");
      const fixture = privateBrowserPages.find((fixture) => fixture.id === id);
      response.end(
        "<title>private-title-canary</title><p>private-text-canary</p>" +
          (fixture?.html.replaceAll("https://embedded.invalid/login", `http://localhost:${site}/embedded`) ??
            (path.endsWith("otp")
              ? '<input autocomplete="one-time-code" value="otp-canary">'
              : '<input type="password" value="password-canary">')) +
          `<script>addEventListener("load",()=>fetch(${JSON.stringify(`/private-ready${path.slice("/private-page".length)}`)}))</script>`,
      );
    } else
      response.end(
        `<title>Fixture ${path}</title><style>body{margin:0}</style>` +
          `<button style="position:absolute;left:0;top:0;width:200px;height:100px" onclick="location='/clicked'">go</button>` +
          `<form action="/submit" style="position:absolute;top:150px"><input name="q" onfocus="fetch('/focused')"></form>` +
          `<script>fetch('/ready' + location.pathname)</script>`,
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  site = (server.address() as AddressInfo).port;
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
});
let checkpoint: number;
beforeEach(() => {
  checkpoint = cleanups.length;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(checkpoint).reverse()) await cleanup();
});
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(read: () => T, done: (value: T) => boolean, what: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 500)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function start(options: { runtime?: BrowserRuntime; egress?: boolean } = {}) {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-browser-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const pal: Pal = await openPal(
    {
      dataRoot,
      installRoot: "/nonexistent-install",
      browser: {
        runtime: options.runtime ?? runtime,
        ...(options.egress === false ? {} : { egress: { allowPrivate: true, ports: new Set([site]) } }),
      },
    },
    context,
  );
  cleanups.push(() => pal.close());
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    version: "test",
    api: createApi(pal),
    upgrade: (request, socket, head) => pal.upgrade(request, socket, head),
  });
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = await pal.owner.setup(pal.owner.setupToken, "correct horse battery");
  const project = await pal.projects.create(`browser-project-${Date.now()}`, { name: "Browser" });
  return { pal, base, token, project, dataRoot };
}

type State = {
  epoch: number;
  session: string;
  mode: "paused" | "human" | "private-login" | "agent";
  busy: boolean;
  agent: { chat: string; expires: number; remaining: number } | null;
  control: boolean;
  tabs: { id: string; url: string; active: boolean }[];
  dialog: unknown;
};
async function viewer(base: string, projectId: string, token: string | undefined, origin = base) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/projects/${projectId}/browser/socket`, {
    headers: { origin, ...(token === undefined ? {} : { cookie: `pal_session=${token}` }) },
  });
  cleanups.push(() => ws.terminate());
  const states: State[] = [];
  const frames: Buffer[] = [];
  const errors: string[] = [];
  ws.on("message", (data, binary) => {
    if (binary) frames.push(data as Buffer);
    else {
      const message = JSON.parse(String(data)) as ({ type: "state" } & State) | { type: "error"; message: string };
      if (message.type === "state") states.push(message);
      else if (message.type === "error") errors.push(message.message);
    }
  });
  const opened = await new Promise<boolean>((resolve) => {
    ws.once("open", () => resolve(true));
    ws.once("error", () => resolve(false));
    ws.once("unexpected-response", async (_request, response) => {
      let body = "";
      for await (const chunk of response) body += String(chunk);
      errors.push(body);
      resolve(false);
    });
  });
  return {
    ws,
    opened,
    states,
    frames,
    errors,
    state: () => states.at(-1),
    send: (message: Record<string, unknown>) =>
      ws.send(JSON.stringify(message.type === "take" ? message : { ...message, epoch: states.at(-1)?.epoch })),
  };
}
const seen = (path: string) => requests.some((request) => request.path === path);

async function agentFixture() {
  const fixture = await start();
  const { pal, base, project, token } = fixture;
  const chat = await pal.chats.createChat("browser-agent-chat", { projectId: project.id }, context);
  const client = await viewer(base, project.id, token);
  await until(client.state, (state) => state?.control === true, "owner control");
  const visit = async (path = "/agent") => {
    const url = `http://127.0.0.1:${site}${path}`;
    const before = requests.length;
    client.send({ type: "navigate", url });
    await until(() => requests.slice(before).some((request) => request.path === path), Boolean, "fixture visit");
    await until(
      client.state,
      (state) => state?.tabs.some((tab) => tab.active && tab.url === url) === true,
      "active URL",
    );
    if (path.startsWith("/agent"))
      await until(
        () => requests.slice(before).some((request) => request.path === "/agent-ready"),
        Boolean,
        "parsed fixture",
      );
    if (path.startsWith("/private-page"))
      await until(
        () =>
          requests
            .slice(before)
            .some((request) => request.path === `/private-ready${path.slice("/private-page".length)}`),
        Boolean,
        "parsed private fixture",
      );
    return url;
  };
  const handoff = async () => {
    const url = client.state()?.tabs.find((tab) => tab.active)?.url;
    client.send({ type: "handoff", chat: chat.id, url });
    await until(client.state, (state) => state?.mode === "agent", "agent handoff");
  };
  const conversation = await pal.harness.conversation(chat.conversationId, context);
  if (conversation === undefined) throw new Error("missing conversation");
  let inputs = 0;
  const run = async (code: string) => {
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const model = faux.getModel();
    await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    await pal.chats.submit(chat.id, `browser-input-${++inputs}`, { text: "run fixture" }, context);
  };
  const results = async () => {
    await conversation.waitForIdle(context);
    return JSON.stringify((await conversation.context(context)).messages);
  };
  const waiting = async () => {
    for (let i = 0; i < 400; i++) {
      const pending = (await pal.approvals.view(chat.id)).approvals.find((item) => item.state === "pending");
      if (pending !== undefined) return pending;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no browser approval: ${JSON.stringify((await conversation.context(context)).messages)}`);
  };
  await visit();
  return { ...fixture, chat, client, visit, handoff, run, results, waiting, conversation };
}

describe("agent browser", () => {
  it("requires explicit per-chat control and excludes owner inputs, hidden text and page prototypes", async () => {
    const { pal, project, chat, client, handoff, conversation } = await agentFixture();
    const other = await pal.chats.createChat("browser-other-chat", { projectId: project.id }, context);
    expect((await conversation.agent(context)).tools.map((tool) => tool.name)).toEqual(["codemode"]);
    expect(pal.browsers.allows(chat.conversationId)).toBe(false);
    await expect(pal.browsers.observe(chat.conversationId)).rejects.toMatchObject({ code: "browser_not_granted" });
    client.send({ type: "mode", mode: "private-login" });
    await until(client.state, (state) => state?.mode === "private-login" && state.control, "private owner control");
    await handoff();
    await expect(pal.browsers.observe(other.conversationId)).rejects.toMatchObject({ code: "browser_not_granted" });
    const observation = await pal.browsers.observe(chat.conversationId);
    expect(observation.text).toContain("Visible fixture text");
    expect(observation.targets).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Public action" })]));
    expect(JSON.stringify(observation)).not.toMatch(/hidden-canary|input-canary|textarea-canary|prototype-canary/);
    const epoch = observation.epoch;
    client.send({ type: "take" });
    await until(client.state, (state) => state?.mode === "human" && state.control, "revocation");
    expect(client.state()?.epoch).toBeGreaterThan(epoch);
    expect(() => pal.browsers.assertEpoch(chat.conversationId, observation.session, epoch)).toThrow(
      /authority changed/,
    );
    client.ws.send(JSON.stringify({ type: "mode", mode: "paused", epoch }));
    await until(
      () => client.errors,
      (errors) => errors.some((error) => /changed|stale/.test(error)),
      "stale epoch refusal",
    );
    expect(client.state()?.mode).toBe("human");
  });

  it("never exposes login content, even when handed to the agent", async () => {
    const { pal, chat, client, visit, handoff } = await agentFixture();
    for (const path of [
      "/private-page",
      "/private-page?otp",
      ...privateBrowserPages.map(({ id }) => `/private-page?case=${id}`),
    ]) {
      await visit(path);
      await handoff();
      let failure: unknown;
      try {
        await pal.browsers.observe(chat.conversationId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "browser_owner_needed" });
      expect(String(failure)).not.toContain("canary");
      await until(client.state, (state) => state?.mode === "private-login" && !state.control, "private handback");
      expect(pal.browsers.allows(chat.conversationId)).toBe(false);
      client.send({ type: "take" });
      await until(client.state, (state) => state?.control === true, "owner retakes");
    }
  });

  it("revokes the agent lease when the last page-action guard requires owner control", async () => {
    const { pal, chat, client, handoff } = await agentFixture();
    await handoff();
    const observed = await pal.browsers.observe(chat.conversationId);
    const target = observed.targets.find((target) => target.label === "Public action");
    if (target === undefined) throw new Error("missing public target");
    const before = requests.length;
    const dispatch = vi.spyOn(BrowserPage.prototype, "act").mockRejectedValueOnce(new BrowserOwnerNeeded());
    try {
      await expect(
        pal.browsers.act(chat.conversationId, {
          session: observed.session,
          epoch: observed.epoch,
          observation: observed.observation,
          action: { type: "click", target: target.id },
        }),
      ).rejects.toMatchObject({ code: "browser_owner_needed" });
      await until(client.state, (state) => state?.mode === "private-login" && !state.control, "private handback");
      expect(pal.browsers.allows(chat.conversationId)).toBe(false);
      expect(requests.slice(before).some((request) => request.path === "/agent-clicked")).toBe(false);
      await expect(pal.browsers.observe(chat.conversationId)).rejects.toMatchObject({ code: "browser_not_granted" });
    } finally {
      dispatch.mockRestore();
    }
  });

  it("uses native Code Mode and asks for the exact action even in Full access", async () => {
    const { pal, chat, client, handoff, run, results, waiting } = await agentFixture();
    await handoff();
    await pal.approvals.setMode(chat.id, "full");
    const before = requests.length;
    const code =
      'const page = await tools.browser_observe({}); const target = page.targets.find(t => t.label === "Public action"); return await tools.browser_act({session:page.session,epoch:page.epoch,observation:page.observation,action:{type:"click",target:target.id}});';
    await run(code);
    const pending = await waiting();
    expect(pending).toMatchObject({ tool: "browser_act", state: "pending", cwd: `http://127.0.0.1:${site}/agent` });
    expect(JSON.parse(pending.command)).toMatchObject({
      action: { type: "click", target: expect.stringMatching(/^t\d+$/) },
    });
    expect(requests.slice(before).some((request) => request.path === "/agent-clicked")).toBe(false);
    await expect(pal.approvals.decide(chat.id, pending.id, "approve", "0".repeat(64))).rejects.toMatchObject({
      code: "approval_stale",
    });
    await pal.approvals.decide(chat.id, pending.id, "approve", pending.digest);
    const output = await results();
    await until(
      () => requests.slice(before).filter((request) => request.path === "/agent-clicked").length,
      (count) => count === 1,
      "approved click",
    );
    expect(output).not.toMatch(/hidden-canary|input-canary|textarea-canary|prototype-canary/);
    expect(client.state()?.mode).toBe("agent");
  });

  it("denies and stops pending actions, and revalidates authority after approval", async () => {
    const { pal, chat, client, handoff, run, results, waiting, conversation } = await agentFixture();
    await handoff();
    const before = requests.length;
    const code =
      'const page = await tools.browser_observe({}); return await tools.browser_act({session:page.session,epoch:page.epoch,observation:page.observation,action:{type:"click",target:page.targets[0].id}});';
    await run(code);
    const denied = await waiting();
    await pal.approvals.decide(chat.id, denied.id, "deny", denied.digest);
    expect(await results()).toContain("owner denied");
    await run(code);
    const stopped = await waiting();
    await conversation.abort(context);
    await results();
    await expect(pal.approvals.decide(chat.id, stopped.id, "approve", stopped.digest)).rejects.toMatchObject({
      code: "approval_stale",
    });
    await run(code);
    const revoked = await waiting();
    client.send({ type: "take" });
    await until(client.state, (state) => state?.mode === "human" && state.control, "owner takeover");
    await pal.approvals.decide(chat.id, revoked.id, "approve", revoked.digest);
    expect(await results()).toContain("authority changed while waiting");
    expect(requests.slice(before).some((request) => request.path === "/agent-clicked")).toBe(false);
  });

  it("revokes an in-flight action before owner input or model delivery", async () => {
    const { pal, chat, client, handoff } = await agentFixture();
    await handoff();
    const page = await pal.browsers.observe(chat.conversationId);
    const controller = new AbortController();
    const path = `/external-effect/revocation-${Date.now()}`;
    const work = pal.browsers
      .act(
        chat.conversationId,
        {
          session: page.session,
          epoch: page.epoch,
          observation: page.observation,
          action: { type: "navigate", url: `http://127.0.0.1:${site}${path}` },
        },
        controller.signal,
      )
      .then(
        () => "delivered",
        (error: unknown) => String(error),
      );
    await until(() => seen(path), Boolean, "external effect before receipt");
    client.send({ type: "take" });
    await until(client.state, (state) => state?.mode === "human" && state.busy && !state.control, "busy handback");
    client.send({ type: "text", text: "owner-private-canary" });
    await until(
      () => client.errors,
      (errors) => errors.some((error) => error.includes("Control changed")),
      "private input held",
    );
    controller.abort();
    expect(await work).not.toBe("delivered");
    expect(requests.filter((request) => request.path === path)).toHaveLength(1);
    expect(pal.browsers.allows(chat.conversationId)).toBe(false);
  });

  it("does not replay an externally completed action after SIGKILL or restore its grant", async () => {
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-browser-kill-")));
    cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
    const path = `/external-effect/crash-${Date.now()}`;
    const child = spawn(
      process.execPath,
      [...process.execArgv, join(import.meta.dirname, "../fixtures/browser-child.ts"), dataRoot, String(site), path],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    const lines = createInterface({ input: child.stdout });
    const [line] = await Promise.race([
      once(lines, "line"),
      once(child, "exit").then(() => {
        throw new Error("browser fixture exited before ready");
      }),
    ]);
    const ready = JSON.parse(String(line)) as { chat: string; project: string };
    await until(() => seen(path), Boolean, "committed external effect");
    child.kill("SIGKILL");
    await once(child, "exit");
    lines.close();
    const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
    cleanups.push(() => pal.close());
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("done")]);
    await pal.harness.waitForIdle(context);
    const chat = await pal.chats.get(ready.chat);
    if (chat === undefined) throw new Error("chat lost after crash");
    const conversation = await pal.harness.conversation(chat.conversationId, context);
    const output = JSON.stringify((await conversation?.context(context))?.messages);
    expect(output).toMatch(/interrupted|unknown/i);
    expect(requests.filter((request) => request.path === path)).toHaveLength(1);
    expect(pal.browsers.allows(chat.conversationId)).toBe(false);
    expect((await pal.browsers.status(ready.project)).running).toBe(false);
  });

  it("bounds handoffs by call count and expiry, and never automatically restores a grant", async () => {
    const { pal, project, chat, client, handoff } = await agentFixture();
    await handoff();
    for (let i = 0; i < 40; i++) {
      const result = await pal.browsers.observe(chat.conversationId);
      expect(result.remaining).toBe(39 - i);
      pal.browsers.assertEpoch(chat.conversationId, result.session, result.epoch);
    }
    expect(pal.browsers.allows(chat.conversationId)).toBe(false);
    await expect(pal.browsers.observe(chat.conversationId)).rejects.toMatchObject({ code: "browser_not_granted" });
    client.send({ type: "take" });
    await until(client.state, (state) => state?.control === true, "retake control");
    await handoff();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 301_000);
    try {
      expect(pal.browsers.allows(chat.conversationId)).toBe(false);
      await expect(pal.browsers.observe(chat.conversationId)).rejects.toMatchObject({ code: "browser_not_granted" });
    } finally {
      clock.mockRestore();
    }
    await pal.browsers.stop(project.id);
    expect(pal.browsers.allows(chat.conversationId)).toBe(false);
  });
});

describe("owner browser", () => {
  it("runs in a sandbox with no network and no view of Pal data", async () => {
    if (runtime === undefined) throw new Error("no runtime");
    const dir = await realpath(await mkdtemp(join(tmpdir(), "pal-sandbox-")));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const [profile, run, data] = [join(dir, "profile"), join(dir, "run"), join(dir, "data")];
    await Promise.all([mkdir(profile), mkdir(run), mkdir(data)]);
    await writeFile(join(data, "pal.sqlite"), "secret");
    const inside = (command: string) => {
      const [program = "", ...args] = sandboxArgs(runtime, profile, run);
      return spawnSync(program, [...args, runtime.bash, "-c", command], { encoding: "utf8" });
    };
    const written = inside("echo ok > $0/written && cat $0/written".replaceAll("$0", profile));
    expect(written.status, written.stderr).toBe(0);
    expect(written.stdout.trim()).toBe("ok");
    expect(inside(`cat ${join(data, "pal.sqlite")}`).status).not.toBe(0);
    expect(inside(`(exec 3<>/dev/tcp/127.0.0.1/${site})`).status).not.toBe(0);
    expect(inside("touch /nix/store/pal-escape").status).not.toBe(0);
    expect(inside("echo -n $OPENAI_API_KEY$PAL_CHROMIUM").stdout).toBe("");
  });

  it.skipIf(process.env.PAL_TEST_USER_SCOPE !== "1")(
    "enforces real resource caps and keeps debugging and network private",
    async () => {
      const { base, token, project, dataRoot } = await start();
      const client = await viewer(base, project.id, token);
      expect(client.opened, client.errors.join("\n")).toBe(true);
      let pid: string | undefined;
      for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const args = (await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "")).split("\0");
        if (
          !args[0]?.includes("chrome-headless-shell") ||
          !args.includes(`--user-data-dir=${join(dataRoot, "browser", project.id, "profile")}`)
        )
          continue;
        expect(args).toContain("--remote-debugging-pipe");
        expect(args.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(false);
        pid = entry;
        break;
      }
      expect(pid, "Chromium main process").toBeDefined();
      const membership = await readFile(`/proc/${pid}/cgroup`, "utf8");
      const group = /^0::(.+)$/m.exec(membership)?.[1];
      expect(group).toMatch(/\.scope$/);
      const cap = (name: string) => readFile(join("/sys/fs/cgroup", group ?? "", name), "utf8");
      expect((await cap("memory.max")).trim()).toBe("2147483648");
      expect((await cap("pids.max")).trim()).toBe("512");
      const [quota, period] = (await cap("cpu.max")).trim().split(" ").map(Number);
      expect(quota).toBe(period);
      expect(await readlink(`/proc/${pid}/ns/net`)).not.toBe(await readlink("/proc/self/ns/net"));
    },
  );

  it("does not start without its resource scope", async () => {
    if (runtime === undefined) throw new Error("no runtime");
    const { base, token, project } = await start({ runtime: { ...runtime, scope: "/nonexistent/systemd-run" } });
    const client = await viewer(base, project.id, token);
    expect(client.opened).toBe(false);
  });

  it("serves only the owner, from Pal's own page, with one controller", async () => {
    const { base, token, project } = await start();
    expect((await viewer(base, project.id, undefined)).opened).toBe(false);
    expect((await viewer(base, project.id, token, "http://evil.example")).opened).toBe(false);
    expect((await viewer(base, project.id, "forged-session")).opened).toBe(false);

    const owner = await viewer(base, project.id, token);
    expect(owner.opened, owner.errors.join("\n")).toBe(true);
    await until(owner.state, (state) => state?.control === true && state.tabs.length === 1, "control");
    const navigation = requests.length;
    owner.send({ type: "navigate", url: `http://127.0.0.1:${site}/` });
    await until(() => requests.slice(navigation).some((request) => request.path === "/ready/"), Boolean, "page parsed");
    await until(
      () => owner.frames.at(-1),
      (frame) => frame?.[0] === 0xff && frame[1] === 0xd8,
      "a JPEG frame",
    );

    owner.send({ type: "mouse", action: "click", x: 50, y: 40 });
    await until(() => seen("/clicked"), Boolean, "the click");
    const before = requests.length;
    owner.send({ type: "navigate", url: `http://127.0.0.1:${site}/` });
    await until(
      () => requests.slice(before).some((request) => request.path === "/ready/"),
      Boolean,
      "second page parsed",
    );
    owner.send({ type: "mouse", action: "click", x: 20, y: 160 });
    await until(() => seen("/focused"), Boolean, "input focus");
    owner.send({ type: "text", text: "hello" });
    owner.send({ type: "key", key: "Enter" });
    await until(() => seen("/submit?q=hello"), Boolean, "typed form submit");

    owner.send({ type: "navigate", url: "file:///etc/passwd" });
    await until(
      () => owner.errors,
      (errors) => errors.some((error) => error.includes("only http and https")),
      "refusal",
    );

    owner.send({ type: "newTab" });
    const two = await until(owner.state, (state) => state?.tabs.length === 2, "second tab");
    owner.send({ type: "closeTab", id: two?.tabs.find((tab) => tab.active)?.id });
    await until(owner.state, (state) => state?.tabs.length === 1, "tab closed");

    owner.send({ type: "navigate", url: `http://127.0.0.1:${site}/alert` });
    await until(owner.state, (state) => state?.dialog !== null && state?.dialog !== undefined, "dialog");
    owner.send({ type: "dialog", accept: true });
    await until(owner.state, (state) => state?.dialog === null, "dialog answered");

    const watcher = await viewer(base, project.id, token);
    await until(watcher.state, (state) => state !== undefined && !state.control, "view-only state");
    watcher.send({ type: "reload" });
    await until(
      () => watcher.errors,
      (errors) => errors.some((error) => error.includes("take control")),
      "view-only refusal",
    );
    watcher.send({ type: "take" });
    await until(watcher.state, (state) => state?.control === true, "taken control");
    owner.send({ type: "reload" });
    await until(
      () => owner.errors,
      (errors) => errors.some((error) => error.includes("take control")),
      "stale controller",
    );
    expect((await viewer(base, project.id, token)).opened).toBe(true);
    expect((await viewer(base, project.id, token)).opened).toBe(false);
  });

  it("keeps site logins in the project profile across browser restarts until cleared", async () => {
    const { pal, base, token, project } = await start();
    const visit = async (path: string) => {
      const client = await viewer(base, project.id, token);
      expect(client.opened, client.errors.join("\n")).toBe(true);
      await until(client.state, (state) => state?.control === true, "control");
      const before = requests.length;
      client.send({ type: "navigate", url: `http://127.0.0.1:${site}${path}` });
      await until(() => requests.slice(before).find((request) => request.path === path), Boolean, path);
      return requests.slice(before).find((request) => request.path === path)?.cookie;
    };
    await visit("/login");
    await pal.browsers.stop(project.id);
    expect(await visit("/whoami")).toContain("session=fixture");
    await pal.browsers.clear(project.id);
    expect(await visit("/whoami")).not.toContain("session=fixture");
  });

  it("admits only public destinations by default", async () => {
    const { base, token, project } = await start({ egress: false });
    const client = await viewer(base, project.id, token);
    expect(client.opened, client.errors.join("\n")).toBe(true);
    await until(client.state, (state) => state?.control === true, "control");
    const before = requests.length;
    client.send({ type: "navigate", url: `http://127.0.0.1:${site}/private` });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(requests.slice(before)).toEqual([]);
  });

  it("revokes observation and queued input immediately on owner sign-out", async () => {
    const { base, token, project } = await start();
    const client = await viewer(base, project.id, token);
    expect(client.opened, client.errors.join("\n")).toBe(true);
    const closed = once(client.ws, "close").then(() => true);
    const response = await fetch(`${base}/api/sign-out`, {
      method: "POST",
      headers: { origin: base, cookie: `pal_session=${token}` },
    });
    expect(response.status).toBe(200);
    expect(await Promise.race([closed, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))])).toBe(
      true,
    );
    expect((await viewer(base, project.id, token)).opened).toBe(false);
  });

  it("refuses linked profile directories without touching their target", async () => {
    const { pal, base, token, project, dataRoot } = await start();
    const foreign = join(dataRoot, "foreign");
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, "keep"), "untouched");
    await mkdir(join(dataRoot, "browser"), { mode: 0o700 });
    await symlink(foreign, join(dataRoot, "browser", project.id));
    expect((await viewer(base, project.id, token)).opened).toBe(false);
    await expect(pal.browsers.clear(project.id)).rejects.toThrow("owner-only directories");
    expect(await readFile(join(foreign, "keep"), "utf8")).toBe("untouched");
  });

  it("bounds concurrent viewers and tabs, including simultaneous connection attempts", async () => {
    const { base, token, project } = await start();
    const viewers = await Promise.all(Array.from({ length: 6 }, () => viewer(base, project.id, token)));
    expect(viewers.filter((client) => client.opened)).toHaveLength(3);
    const owner = viewers.find((client) => client.state()?.control);
    if (owner === undefined) throw new Error("missing controller");
    for (let i = 0; i < 12; i++) owner.send({ type: "newTab" });
    await until(
      () => owner.errors,
      (errors) => errors.some((error) => error.includes("8 tabs")),
      "tab limit",
    );
    expect(owner.state()?.tabs).toHaveLength(8);
  });

  it("revokes queued input when another viewer takes control", async () => {
    const { base, token, project } = await start();
    const owner = await viewer(base, project.id, token);
    const watcher = await viewer(base, project.id, token);
    await until(owner.state, (state) => state?.control === true, "owner control");
    owner.send({ type: "navigate", url: `http://127.0.0.1:${site}/slow` });
    await until(() => seen("/slow"), Boolean, "slow request started");
    owner.send({ type: "navigate", url: `http://127.0.0.1:${site}/stale-input` });
    watcher.send({ type: "take" });
    await until(watcher.state, (state) => state?.control === true, "new control");
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(seen("/stale-input")).toBe(false);
  });

  it("runs at most two project browsers at once", async () => {
    const { pal, base, token } = await start();
    const projects = await Promise.all(
      ["one", "two", "three"].map((name) => pal.projects.create(`limit-${name}-${Date.now()}`, { name })),
    );
    const [first, second, third] = projects;
    if (first === undefined || second === undefined || third === undefined) throw new Error("missing projects");
    expect((await viewer(base, first.id, token)).opened).toBe(true);
    expect((await viewer(base, second.id, token)).opened).toBe(true);
    expect((await viewer(base, third.id, token)).opened).toBe(false);
    await pal.browsers.stop(first.id);
    expect((await viewer(base, third.id, token)).opened).toBe(true);
  });
});
