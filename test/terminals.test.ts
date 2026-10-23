import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApi } from "../src/core/api.ts";
import { openPal } from "../src/core/app.ts";
import { startServer } from "../src/core/server.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(publicOrigin?: string) {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-terminal-test-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
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
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
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
    expect(environment).toContain("HISTFILE=/dev/null");
    // The prompt is colored by the shell itself, not by sourcing any profile or rc file.
    await expect
      .poll(() => client.output().replaceAll("\x01", "").replaceAll("\x02", ""))
      .toContain("\x1b[2mpal\x1b[0m \x1b[36m");
    expect(environment).toContain("PROMPT_DIRTRIM=2");
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
    let start = client.output().length;
    send("\x1b[5~");
    await expect.poll(() => client.output().slice(start)).toContain(command);
    expect(await readFile(join(project.root, "recalled.txt"), "utf8")).toBe("once");
    start = client.output().length;
    send("\x1b[5~");
    await expect.poll(() => client.output().slice(start)).toContain("older.txt");
    start = client.output().length;
    send("\x1b[6~");
    await expect.poll(() => client.output().slice(start)).toContain("recalled.txt");
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

  it("bounds memory-only history per shell and discards it with the private terminal home", async () => {
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
    expect(entries).toHaveLength(500);
    expect(entries[0]).toMatch(/printf 'entry-%s\\n' 102$/);
    expect(entries.at(-2)).toMatch(/printf 'entry-%s\\n' 600$/);
    expect(entries.at(-1)).toContain("history > history-window.txt");
    const homePath = join(project.root, "history-home.txt");
    await expect.poll(() => readFile(homePath, "utf8")).toContain("pal-terminal-");
    const home = await readFile(homePath, "utf8");
    await expect(access(join(home, ".bash_history"))).rejects.toThrow();
    const other = await create();
    const isolated = await connect(other.id);
    isolated.send({ type: "input", epoch: isolated.last("state")?.epoch, data: "history > isolated-history.txt\r" });
    const history = join(project.root, "isolated-history.txt");
    await expect.poll(() => readFile(history, "utf8")).toContain("isolated-history.txt");
    expect(await readFile(history, "utf8")).not.toContain("entry-");
    await pal.terminals.remove(project.id, terminal.id);
    await expect(access(home)).rejects.toThrow();
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
