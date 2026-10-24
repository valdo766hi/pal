import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { IPty } from "node-pty";
import { createApi } from "../src/core/api.ts";
import { openPal } from "../src/core/app.ts";
import { startServer } from "../src/core/server.ts";
import { terminalHome } from "./fixtures/terminal-home.ts";

const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => vi.stubEnv("SHELL", process.env.PAL_BASH ?? "/bin/bash"));
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});
async function setup(publicOrigin?: string) {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-terminal-test-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  for (const [key, value] of Object.entries(await terminalHome(join(dataRoot, "host-home")))) vi.stubEnv(key, value);
  const pal = await openPal({ dataRoot, installRoot: "/nonexistent" }, context);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("terminal-project", { name: "Terminal" });
  const token = await pal.owner.setup(pal.owner.setupToken, "correct horse battery");
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    version: "test",
    publicOrigin,
    api: createApi(pal, publicOrigin),
    upgrade: (req, socket, head) => pal.terminals.upgrade(req, socket, head, publicOrigin),
  });
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`${base}/api/${path}`, {
      method,
      headers: { cookie: `pal_session=${token}`, origin: base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = () => pal.terminals.create(project.id, { cols: 80, rows: 24 });
  function socket(id: string, headers: Record<string, string> = {}) {
    const ws = new WebSocket(`${base.replace("http:", "ws:")}/api/terminals/${id}/socket`, {
      headers: { origin: base, cookie: `pal_session=${token}`, ...headers },
    });
    const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");
    const screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    cleanups.push(async () => screen.dispose());
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if ((message.type === "snapshot" || message.type === "output") && typeof message.data === "string") {
        if (message.type === "snapshot") screen.reset();
        screen.write(message.data);
      }
      messages.push(message);
      if (messages.length > 512) messages.shift();
    });
    ws.on("error", () => {});
    cleanups.push(async () => {
      if (ws.readyState !== WebSocket.CLOSED) {
        const closed = once(ws, "close");
        ws.terminate();
        await closed;
      }
    });
    return {
      ws,
      messages,
      send: (message: unknown) => ws.send(JSON.stringify(message)),
      last: (type: string) => messages.findLast((message) => message.type === type),
      line: () =>
        screen.buffer.active
          .getLine(screen.buffer.active.baseY + screen.buffer.active.cursorY)
          ?.translateToString(true),
      output: () =>
        messages
          .filter((message) => message.type === "output")
          .map((message) => message.data)
          .join(""),
    };
  }
  async function connect(id: string, headers: Record<string, string> = {}) {
    const client = socket(id, headers);
    await once(client.ws, "open");
    await expect.poll(() => client.last("state")).toBeDefined();
    return client;
  }
  return { pal, project, token, dataRoot, request, create, socket, connect };
}

describe("human host terminals", () => {
  it.each(["zsh", "fish"] as const)(
    "loads the host's %s startup files, prompt and persistent history without modifying them",
    async (name) => {
      const shell = process.env[`PAL_TEST_${name.toUpperCase()}`];
      if (shell === undefined) throw new Error(`missing native ${name} fixture`);
      const { pal, project, create, connect } = await setup();
      const hostHome = process.env.HOME;
      if (hostHome === undefined) throw new Error("missing terminal home fixture");
      const config = join(hostHome, name === "zsh" ? ".zshrc" : ".config/fish/config.fish");
      const original = await readFile(config, "utf8");
      const previous = process.env.SHELL;
      let terminal;
      try {
        process.env.SHELL = shell;
        terminal = await create();
      } finally {
        if (previous === undefined) delete process.env.SHELL;
        else process.env.SHELL = previous;
      }
      const client = await connect(terminal.id);
      const epoch = client.last("state")?.epoch;
      while (!`${client.last("snapshot")?.data ?? ""}${client.output()}`.includes("$")) {
        expect(client.last("state")).toMatchObject({ ended: false });
        await once(client.ws, "message");
      }
      const send = (data: string) => client.send({ type: "input", epoch, data });
      const version = name === "zsh" ? "$ZSH_VERSION" : "$version";
      send(
        `printf '%s\\n' "${version}" > shell-version; printf '%s' "$HOME" > shell-home; printf %s "$PAL_TEST_PROFILE" > shell-profile\r`,
      );
      await expect.poll(() => readFile(join(project.root, "shell-version"), "utf8")).toMatch(/^\d+\./);
      const home = await readFile(join(project.root, "shell-home"), "utf8");
      expect(home).toBe(hostHome);
      expect(await readFile(join(project.root, "shell-profile"), "utf8")).toBe("loaded");
      expect(`${client.last("snapshot")?.data ?? ""}${client.output()}`).toContain("fixture");
      send("echo x >> native-history\r");
      const result = join(project.root, "native-history");
      await expect.poll(() => readFile(result, "utf8")).toBe("x\n");
      const start = client.output().length;
      send("\x1b[5~");
      await expect.poll(() => client.output().length).toBeGreaterThan(start);
      expect(await readFile(result, "utf8")).toBe("x\n");
      send("\r");
      await expect.poll(() => readFile(result, "utf8")).toBe("x\nx\n");
      client.ws.close();
      await once(client.ws, "close");
      const next = await connect(terminal.id);
      next.send({ type: "input", epoch: next.last("state")?.epoch, data: "\x1b[5~\r" });
      await expect.poll(() => readFile(result, "utf8")).toBe("x\nx\nx\n");
      const nextEpoch = next.last("state")?.epoch;
      const sendNext = (data: string) => next.send({ type: "input", epoch: nextEpoch, data });
      for (let start = 0; start < 600; start += 10) {
        sendNext(
          Array.from({ length: 10 }, (_, i) => {
            const n = start + i + 1;
            return `printf 'entry-%s\\n' ${n}; printf %s ${n} > native-progress\r`;
          }).join(""),
        );
        await expect.poll(() => readFile(join(project.root, "native-progress"), "utf8")).toBe(String(start + 10));
      }
      sendNext(name === "fish" ? "builtin history search --null > native-window\r" : "fc -ln 1 > native-window\r");
      const window = join(project.root, "native-window");
      await expect.poll(() => readFile(window, "utf8")).toContain("600");
      const entries = (await readFile(window, "utf8"))
        .trim()
        .split(name === "fish" ? "\0" : "\n")
        .filter(Boolean);
      expect(entries.length).toBeGreaterThan(600);
      expect(entries.some((entry) => entry.includes("entry-%s\\n' 1;"))).toBe(true);
      expect(entries.some((entry) => entry.includes("entry-%s\\n' 600;"))).toBe(true);
      await pal.terminals.remove(project.id, terminal.id);
      expect(await readFile(config, "utf8")).toBe(original);
      const history = join(home, name === "zsh" ? ".zsh_history" : ".local/share/fish/fish_history");
      await expect.poll(() => readFile(history, "utf8")).toContain("600");
      await access(home);
    },
  );

  it.each(["on", "off"])("runs a clean real PTY and restores its screen with bracketed paste %s", async (paste) => {
    const { pal, project, request, create, connect } = await setup();
    expect(await pal.terminals.list(project.id)).toEqual([]);
    expect((await request(`projects/${project.id}/terminals`, "POST", { cols: 80, rows: 24 })).status).toBe(400);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-key-must-not-leak";
    let terminal;
    try {
      terminal = await create();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
    const client = await connect(terminal.id);
    const epoch = client.last("state")?.epoch;
    await expect.poll(() => `${client.last("snapshot")?.data ?? ""}${client.output()}`).toContain("$");
    client.send({
      type: "input",
      epoch,
      data: `bind 'set enable-bracketed-paste ${paste}'; printf 'PASTE-READY\\n'\r`,
    });
    await expect.poll(() => client.output().split("PASTE-READY\r\n")[1]).toContain("$");
    client.send({
      type: "input",
      epoch,
      data: "env > environment.txt; pwd > cwd.txt; test -t 0 && printf 'PTY-OK\\n'\r",
    });
    await expect.poll(client.output).toContain("PTY-OK\r\n");
    const environment = await readFile(join(project.root, "environment.txt"), "utf8");
    expect(environment).not.toMatch(/OPENAI|CHATGPT|MCP|BASH_ENV|ambient-key/);
    expect(environment).toContain(`HOME=${process.env.HOME}\n`);
    expect(environment).toContain(`HISTFILE=${process.env.HOME}/.bash_history`);
    expect(environment).toContain("PAL_TEST_PROFILE=loaded");
    await expect.poll(client.output).toContain("\x1b[35mfixture\x1b[0m");
    expect((await readFile(join(project.root, "cwd.txt"), "utf8")).trim()).toBe(project.root);
    client.send({ type: "input", epoch, data: "printf '\\033[2J\\033[HOLD\\rNEW\\r\\n'\r" });
    await expect.poll(client.output).toContain("\x1b[2J\x1b[HOLD\rNEW");
    client.ws.close();
    await once(client.ws, "close");
    const next = await connect(terminal.id);
    expect(next.last("snapshot")?.data).toContain("NEW");
    expect(next.last("snapshot")?.data).not.toContain("OLD");
    expect((await pal.terminals.list(project.id))[0]?.id).toBe(terminal.id);
  });

  it("recalls commands with Page Up/Down without executing them and retains history through reconnect", async () => {
    const { project, create, connect } = await setup();
    const terminal = await create();
    const client = await connect(terminal.id);
    const epoch = client.last("state")?.epoch;
    await expect.poll(() => `${client.last("snapshot")?.data ?? ""}${client.output()}`).toContain("$");
    const send = (data: string) => client.send({ type: "input", epoch, data });
    const run = async (command: string) => {
      const start = client.output().length;
      send(command + "\r");
      await expect.poll(() => client.output().slice(start)).toContain("$");
    };
    await run("printf older > older.txt");
    const command = "printf once >> recalled.txt";
    await run(command);
    const start = client.output().length;
    send("\x1b[5~");
    await expect.poll(() => client.output().slice(start)).toContain(command);
    expect(await readFile(join(project.root, "recalled.txt"), "utf8")).toBe("once");
    send("\x1b[5~");
    await expect.poll(client.line).toContain("printf older > older.txt");
    send("\x1b[6~");
    await expect.poll(client.line).toContain("printf once >> recalled.txt");
    await run("");
    expect(await readFile(join(project.root, "recalled.txt"), "utf8")).toBe("onceonce");
    client.ws.close();
    await once(client.ws, "close");
    const next = await connect(terminal.id);
    next.send({ type: "input", epoch: next.last("state")?.epoch, data: "\x1b[5~" });
    await expect.poll(next.output).toContain(command);
    expect(await readFile(join(project.root, "recalled.txt"), "utf8")).toBe("onceonce");
    next.send({ type: "input", epoch: next.last("state")?.epoch, data: "\r" });
    await expect.poll(() => readFile(join(project.root, "recalled.txt"), "utf8")).toBe("onceonceonce");
  });

  it("preserves Unicode input, output and files through resize and reconnect", async () => {
    const { pal, project, create, connect } = await setup();
    const terminal = await create();
    const client = await connect(terminal.id);
    await expect.poll(() => `${client.last("snapshot")?.data ?? ""}${client.output()}`).toContain("$");
    const value = "猫 café e\u0301 🌍";
    const path = join(project.root, "résumé-猫.txt");
    const epoch = client.last("state")?.epoch;
    client.send({
      type: "input",
      epoch,
      data: `printf '%s' '${value}' > 'résumé-猫.txt'; printf '\\033[2J\\033[H%s\\n' '${value}'\r`,
    });
    await expect.poll(() => readFile(path, "utf8")).toBe(value);
    await expect.poll(client.output).toContain(`\x1b[2J\x1b[H${value}`);
    client.send({ type: "resize", epoch, cols: 60, rows: 10 });
    await expect.poll(async () => (await pal.terminals.list(project.id))[0]).toMatchObject({ cols: 60, rows: 10 });
    client.ws.close();
    await once(client.ws, "close");
    const next = await connect(terminal.id);
    expect(next.last("snapshot")?.data).toContain(value);
    expect(next.last("snapshot")?.data).not.toContain("\uFFFD");
    next.send({
      type: "input",
      epoch: next.last("state")?.epoch,
      data: `printf '%s' '${value}' >> 'résumé-猫.txt'\r`,
    });
    await expect.poll(() => readFile(path, "utf8")).toBe(value + value);
  });

  it("uses the host's history policy and preserves its home when closing a terminal", async () => {
    const { pal, project, create, connect } = await setup();
    const terminal = await create();
    const client = await connect(terminal.id);
    await expect.poll(() => `${client.last("snapshot")?.data ?? ""}${client.output()}`).toContain("$");
    const epoch = client.last("state")?.epoch;
    const send = (data: string) => client.send({ type: "input", epoch, data });
    // Observer-log eviction must not discard the live controller's epoch.
    client.messages.length = 0;
    for (let start = 0; start < 600; start += 20) {
      send(Array.from({ length: 20 }, (_, index) => `printf 'entry-%s\\n' ${start + index + 1}\r`).join(""));
      await expect.poll(client.output).toContain(`entry-${start + 20}\r\n`);
    }
    send('history > history-window.txt; printf %s "$HOME" > history-home.txt\r');
    const window = join(project.root, "history-window.txt");
    await expect.poll(() => readFile(window, "utf8")).toContain("printf 'entry-%s\\n' 600");
    const entries = (await readFile(window, "utf8")).trim().split("\n");
    expect(entries).toHaveLength(601);
    expect(entries[0]).toMatch(/printf 'entry-%s\\n' 1$/);
    expect(entries.at(-2)).toMatch(/printf 'entry-%s\\n' 600$/);
    expect(entries.at(-1)).toContain("history > history-window.txt");
    const homePath = join(project.root, "history-home.txt");
    await expect.poll(() => readFile(homePath, "utf8")).toBe(process.env.HOME);
    const home = await readFile(homePath, "utf8");
    const config = await readFile(join(home, ".bashrc"), "utf8");
    await pal.terminals.remove(project.id, terminal.id);
    expect(await readFile(join(home, ".bashrc"), "utf8")).toBe(config);
    expect(await readFile(join(home, ".bash_history"), "utf8")).toContain("entry-");
    const other = await create();
    const resumed = await connect(other.id);
    resumed.send({ type: "input", epoch: resumed.last("state")?.epoch, data: "history > resumed-history.txt\r" });
    const history = join(project.root, "resumed-history.txt");
    await expect.poll(() => readFile(history, "utf8")).toContain("resumed-history.txt");
    expect(await readFile(history, "utf8")).toContain("entry-");
  });

  it("rejects unauthenticated, wrong Host/Origin and missing-Origin upgrades", async () => {
    const { create, socket } = await setup();
    const terminal = await create();
    for (const headers of [
      { cookie: "" },
      { origin: "https://evil.example" },
      { host: "evil.example" },
      { origin: "" },
    ]) {
      const client = socket(terminal.id, headers);
      await expect(once(client.ws, "open")).rejects.toThrow();
      expect(client.messages).toEqual([]);
    }
  });

  it.each(["http://100.64.0.10:7337", "https://pal.example"])(
    "accepts only the exact configured external WS origin %s",
    async (publicOrigin) => {
      const { project, create, socket } = await setup(publicOrigin);
      const terminal = await create();
      const host = new URL(publicOrigin).host;
      const client = socket(terminal.id, { host, origin: publicOrigin });
      await once(client.ws, "open");
      await expect.poll(() => client.last("state")?.control).toBe(true);
      client.send({ type: "input", epoch: client.last("state")?.epoch, data: "printf external > external.txt\r" });
      await expect.poll(() => readFile(join(project.root, "external.txt"), "utf8")).toBe("external");
      const wrong = socket(terminal.id, { host, origin: publicOrigin + "/" });
      await expect(once(wrong.ws, "open")).rejects.toThrow();
    },
  );

  it("has one controller and rejects stale input/resize epochs after takeover", async () => {
    const { pal, project, create, connect } = await setup();
    const terminal = await create();
    const one = await connect(terminal.id),
      two = await connect(terminal.id);
    expect(one.last("state")?.control).toBe(true);
    expect(two.last("state")?.control).toBe(false);
    const old = one.last("state")?.epoch;
    two.send({ type: "take" });
    await expect.poll(() => two.last("state")?.control).toBe(true);
    const epoch = two.last("state")?.epoch;
    one.send({ type: "input", epoch: old, data: "echo stale > stale.txt\r" });
    await expect.poll(() => one.last("error")?.message).toMatch(/Control changed/);
    await expect(access(join(project.root, "stale.txt"))).rejects.toThrow();
    two.send({ type: "resize", epoch, cols: 60, rows: 10 });
    await expect.poll(() => one.last("resize")?.cols).toBe(60);
    one.send({ type: "resize", epoch: old, cols: 100, rows: 40 });
    await expect.poll(async () => (await pal.terminals.list(project.id))[0]?.cols).toBe(60);
    two.ws.close();
    await once(two.ws, "close");
    await expect.poll(() => one.last("state")?.control).toBe(false);
    one.send({ type: "take" });
    await expect.poll(() => one.last("state")?.control).toBe(true);
  });

  it("revokes signed-out sockets immediately and expires idle observers", async () => {
    const { pal, token, request, create, connect } = await setup();
    const terminal = await create();
    const client = await connect(terminal.id);
    const closed = once(client.ws, "close");
    expect((await request("sign-out", "POST")).status).toBe(200);
    await closed;
    expect(client.ws.readyState).toBe(WebSocket.CLOSED);
    const nextToken = await pal.owner.signIn("correct horse battery");
    // Expiry is read at upgrade; even a silent observer must be disconnected on time.
    await pal.store.database.run(
      "UPDATE pal_sessions SET expires_at = ? WHERE token_hash = ?",
      Date.now() + 800,
      createHash("sha256").update(nextToken).digest("hex"),
    );
    const expiring = await connect(terminal.id, { cookie: `pal_session=${nextToken}` });
    await once(expiring.ws, "close");
    const serverToken = await pal.owner.authenticate(token);
    expect(serverToken).toBe(false);
  });

  it("bounds sessions, message sizes and floods, and closes shells on project removal", async () => {
    const { pal, project, request, create, connect } = await setup();
    const terminals = await Promise.all([create(), create(), create(), create()]);
    await expect(create()).rejects.toMatchObject({ status: 409 });
    await expect(pal.terminals.create(project.id, { cols: 10000, rows: 10 })).rejects.toThrow();
    const terminal = terminals[0];
    if (terminal === undefined) throw new Error("missing terminal");
    const client = await connect(terminal.id);
    // Linux PTYs deliver big chunks, so a burst exceeds the 1 MiB/s flood rate. macOS delivers 1 KiB chunks that
    // per-chunk backpressure holds near 0.75 MiB/s, below that rate, so there the 16 MiB lifetime cap ends it.
    const darwin = process.platform === "darwin";
    client.send({
      type: "input",
      epoch: client.last("state")?.epoch,
      data: `head -c ${darwin ? 17 * 1048576 : 4194304} /dev/zero | tr '\\0' x\r`,
    });
    await expect
      .poll(async () => (await pal.terminals.list(project.id)).find((value) => value.id === terminal.id)?.reason, {
        timeout: darwin ? 40_000 : 10_000,
      })
      .toMatch(darwin ? /Session output limit reached \(16 MiB\)/ : /flood/);
    const second = terminals[1];
    if (second === undefined) throw new Error("missing terminal");
    const bad = await connect(second.id);
    const closed = once(bad.ws, "close");
    bad.send({ type: "input", epoch: bad.last("state")?.epoch, data: "x".repeat(33 * 1024) });
    await closed;
    expect((await request(`projects/${project.id}`, "DELETE")).status).toBe(200);
    expect(
      await pal.store.database.get("SELECT root FROM pal_projects WHERE id = ? AND removed_at IS NULL", project.id),
    ).toBeUndefined();
    await expect(pal.terminals.list(project.id)).rejects.toMatchObject({ status: 404 });
  }, 60_000);

  it("caps concurrent observers and shares one shutdown for an active shell", async () => {
    const { pal, project, create, socket, connect } = await setup();
    const terminal = await create();
    const attempts = Array.from({ length: 8 }, () => socket(terminal.id));
    const results = await Promise.allSettled(attempts.map((client) => once(client.ws, "open")));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    for (const client of attempts)
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close();
        await once(client.ws, "close");
      }
    const client = await connect(terminal.id);
    client.send({ type: "input", epoch: client.last("state")?.epoch, data: "sleep 30 & echo $! > background.pid\r" });
    await expect.poll(() => readFile(join(project.root, "background.pid"), "utf8")).toMatch(/^\d+/);
    const pid = Number(await readFile(join(project.root, "background.pid"), "utf8"));
    const closing = pal.terminals.close();
    expect(pal.terminals.close()).toBe(closing);
    await closing;
    await expect
      .poll(async () => {
        try {
          process.kill(pid, 0);
          return process.platform !== "linux" || !/^\d+ \(.*\) [ZX]/.test(await readFile(`/proc/${pid}/stat`, "utf8"));
        } catch (error) {
          if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
          throw error;
        }
      })
      .toBe(false);
  });

  it("lets the shell finish its hangup cleanup without a second signal", async () => {
    const { pal, project, create, connect } = await setup();
    const terminal = await create();
    const client = await connect(terminal.id);
    client.send({
      type: "input",
      epoch: client.last("state")?.epoch,
      // Isolate host signal delivery from Readline's own signal handling.
      data:
        `set +o emacs; set +o vi; trap 'trap "exit" HUP; printf seen > hup-seen; sleep 0.2; kill "$child"; wait "$child"; printf complete > hup-complete; exit' HUP; ` +
        `sleep 30 & child=$!; printf '%s %s\\n' $$ "$child" > shell.pids\r`,
    });
    const pids = join(project.root, "shell.pids");
    await expect.poll(() => readFile(pids, "utf8")).toMatch(/^\d+ \d+\n$/);
    const [shell, child] = (await readFile(pids, "utf8")).trim().split(" ").map(Number);
    if (shell === undefined || child === undefined) throw new Error("missing shell PIDs");
    const complete = join(project.root, "hup-complete");
    const kill = process.kill.bind(process);
    cleanups.push(async () => {
      if (!existsSync(complete))
        try {
          kill(child, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
    });
    let hangups = 0;
    const signal = vi.spyOn(process, "kill").mockImplementation((pid, value) => {
      const result = kill(pid, value);
      if (Math.abs(pid) === shell && value === "SIGHUP" && ++hangups === 1) {
        // Let Bash run before Pal resumes, as it can after the signaling thread is descheduled.
        const deadline = performance.now() + 1000;
        const pause = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(join(project.root, "hup-seen")) && performance.now() < deadline)
          Atomics.wait(pause, 0, 0, 2);
      }
      return result;
    });
    try {
      const closing = pal.terminals.close();
      expect(pal.terminals.close()).toBe(closing);
      await closing;
      expect(await readFile(complete, "utf8")).toBe("complete");
      expect(hangups).toBe(1);
    } finally {
      signal.mockRestore();
    }
  });

  it("drains a paused real PTY during shutdown before its screen callback completes", async () => {
    const { pal, project, create } = await setup();
    const require = createRequire(import.meta.url);
    const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
    const { UnixTerminal } = require("node-pty/lib/unixTerminal") as { UnixTerminal: { prototype: IPty } };
    const resumeScreen = Promise.withResolvers<undefined>();
    const write = Terminal.prototype.write;
    let held = false;
    const paused = vi.spyOn(UnixTerminal.prototype, "pause");
    const screen = vi.spyOn(Terminal.prototype, "write").mockImplementation(function (
      this: import("@xterm/headless").Terminal,
      data,
      callback,
    ) {
      write.call(this, data, () => {
        if (!held && typeof data === "string" && data.includes("$") && callback !== undefined) {
          held = true;
          void resumeScreen.promise.then(callback);
        } else callback?.();
      });
    });
    let closing: Promise<void> | undefined;
    let pty: IPty | undefined;
    try {
      const terminal = await create();
      await expect.poll(() => held).toBe(true);
      pty = paused.mock.contexts[0] as IPty | undefined;
      if (pty === undefined) throw new Error("missing paused native PTY");
      let exited = false;
      pty.onExit(() => (exited = true));
      let closed = false;
      closing = pal.terminals.remove(project.id, terminal.id).then(() => {
        closed = true;
      });
      await expect.poll(() => closed).toBe(true);
      expect(exited).toBe(true);
      expect(pal.terminals.releaseBusy).toBe(false);
    } finally {
      resumeScreen.resolve(undefined);
      pty?.resume();
      await closing;
      screen.mockRestore();
      paused.mockRestore();
    }
  });

  it("does not resurrect ended shells, saved PIDs or keystrokes on restart", async () => {
    const { pal, project, dataRoot, create, connect } = await setup();
    const terminal = await create();
    const client = await connect(terminal.id);
    client.send({ type: "input", epoch: client.last("state")?.epoch, data: "printf once > marker; exit\r" });
    await expect.poll(async () => (await pal.terminals.list(project.id))[0]?.ended).toBe(true);
    await pal.close();
    const next = await openPal({ dataRoot, installRoot: "/nonexistent" }, context);
    cleanups.push(() => next.close());
    expect(await next.terminals.list(project.id)).toEqual([]);
    expect(await readFile(join(project.root, "marker"), "utf8")).toBe("once");
  });
});
