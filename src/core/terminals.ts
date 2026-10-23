import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { Terminal as Screen } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { IPty } from "node-pty";
import { Type } from "typebox";
import type { WebSocket, WebSocketServer } from "ws";
import { cookie, HttpError, isOwnHost, isOwnOrigin } from "./http.ts";
import { Owner, SESSION_COOKIE } from "./owner.ts";
import type { Projects } from "./projects.ts";
import { validate } from "./requests.ts";
import type { Workspaces } from "./workspaces.ts";

/** A color code inside readline's non-printing markers, so line editing measures the prompt correctly; a bash
 * without readline passes the markers through and terminals ignore them. */
const sgr = (code: string) => `\x01\x1b[${code}m\x02`;

const Cols = Type.Integer({ minimum: 20, maximum: 240 });
const Rows = Type.Integer({ minimum: 5, maximum: 80 });
export const TerminalSize = Type.Object({ cols: Cols, rows: Rows }, { additionalProperties: false });
const Message = Type.Union([
  Type.Object({ type: Type.Literal("take") }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal("input"), epoch: Type.Integer(), data: Type.String({ maxLength: 16 * 1024 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("resize"), epoch: Type.Integer(), cols: Cols, rows: Rows },
    { additionalProperties: false },
  ),
]);
const OUTPUT_LIMIT = 256 * 1024;
export type TerminalInfo = {
  id: string;
  projectId: string;
  cwd: string;
  ended: boolean;
  reason: string | null;
  cols: number;
  rows: number;
};
type Client = {
  ws: WebSocket;
  token: string;
  ready: boolean;
  queue: string[];
  pending: number;
  draining: boolean;
  messages: number;
  window: number;
};
type Session = {
  info: TerminalInfo;
  pty: IPty;
  screen: Screen;
  serializer: SerializeAddon;
  home: string;
  clients: Set<Client>;
  controller: Client | undefined;
  epoch: number;
  pending: number;
  totalOutput: number;
  outputBytes: number;
  outputWindow: number;
  inputBytes: number;
  disposed: boolean;
  removing: Promise<void> | undefined;
  exited: Promise<void>;
  stop: () => void;
};

/** Human-owned host shells, never callable by the model. No saved PIDs or input replay. */
export class Terminals {
  readonly #projects: Projects;
  readonly #owner: Owner;
  readonly #capture: (root: string) => Promise<void>;
  readonly #workspaces: Workspaces | undefined;
  readonly #sessions = new Map<string, Session>();
  #creating = 0;
  #upgrades = 0;
  #closed = false;
  #closing: Promise<void> | undefined;
  #wss: WebSocketServer | undefined;

  get releaseBusy(): boolean {
    return this.#creating > 0 || this.#upgrades > 0 || this.#sessions.size > 0;
  }

  constructor(projects: Projects, owner: Owner, capture: (root: string) => Promise<void>, workspaces?: Workspaces) {
    this.#projects = projects;
    this.#owner = owner;
    this.#capture = capture;
    this.#workspaces = workspaces;
  }
  async #project(id: string) {
    const project = await this.#projects.get(id);
    if (project?.state !== "ready") throw new HttpError(404, "not_found", "no such ready project");
    return project;
  }
  async list(projectId: string): Promise<TerminalInfo[]> {
    await this.#project(projectId);
    return [...this.#sessions.values()].flatMap((session) =>
      session.info.projectId === projectId ? [{ ...session.info }] : [],
    );
  }
  async create(projectId: string, size: { cols: number; rows: number }, workspaceId?: string): Promise<TerminalInfo> {
    validate(TerminalSize, size);
    if (this.#closed || this.#sessions.size + this.#creating >= 4)
      throw new HttpError(409, "terminal_limit", "close an existing terminal first (at most four sessions)");
    this.#creating++;
    let home: string | undefined;
    try {
      const project = await this.#project(projectId);
      const lease = workspaceId === undefined ? undefined : await this.#workspaces?.lease(projectId, workspaceId);
      if (workspaceId !== undefined && lease === undefined) throw new HttpError(404, "not_found", "no such workspace");
      const cwd = lease?.root ?? (await realpath(project.root));
      await this.#capture(cwd);
      const { spawn } = await import("node-pty");
      const require = createRequire(import.meta.url);
      const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
      const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
      home = await mkdtemp(join(tmpdir(), "pal-terminal-"));
      const inputrc = join(home, "inputrc");
      await writeFile(inputrc, '"\\e[5~": previous-history\n"\\e[6~": next-history\n', { mode: 0o600, flag: "wx" });
      await this.#project(projectId);
      await lease?.check();
      if (this.#closed) throw new HttpError(503, "closing", "Pal is closing");
      const screen = new Terminal({ ...size, scrollback: 200, allowProposedApi: true });
      const serializer = new SerializeAddon();
      screen.loadAddon(serializer);
      let pty: IPty;
      try {
        pty = spawn(process.env.PAL_BASH ?? "bash", ["--noprofile", "--norc", "-i"], {
          cwd,
          ...size,
          name: "xterm-256color",
          env: {
            PATH: process.env.PATH ?? "/run/current-system/sw/bin:/usr/bin:/bin",
            HOME: home,
            TMPDIR: home,
            LANG: "C.UTF-8",
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            HISTFILE: "/dev/null",
            HISTSIZE: "500",
            INPUTRC: inputrc,
            // A dim "pal" marks Pal's clean host shell; the last two folders keep long workspace paths readable.
            PS1: `${sgr("2")}pal${sgr("0")} ${sgr("36")}\\w${sgr("0")} ${sgr("1;34")}\\$${sgr("0")} `,
            PROMPT_DIRTRIM: "2",
          },
        });
      } catch (error) {
        screen.dispose();
        throw error;
      }
      const exit = Promise.withResolvers<undefined>();
      const info: TerminalInfo = { id: randomUUID(), projectId, cwd, ended: false, reason: null, ...size };
      const session: Session = {
        info,
        pty,
        screen,
        serializer,
        home,
        clients: new Set(),
        controller: undefined,
        epoch: 0,
        pending: 0,
        totalOutput: 0,
        outputBytes: 0,
        outputWindow: Date.now(),
        inputBytes: 0,
        disposed: false,
        removing: undefined,
        exited: exit.promise,
        stop: () => {
          // A second SIGHUP can interrupt Bash's cleanup of its background jobs.
          try {
            process.kill(-pty.pid, "SIGHUP");
          } catch {
            /* already ended */
          }
        },
      };
      this.#sessions.set(info.id, session);
      pty.onData((data) => {
        if (session.disposed) return;
        if (Date.now() - session.outputWindow > 1000) {
          session.outputWindow = Date.now();
          session.outputBytes = 0;
        }
        const bytes = Buffer.byteLength(data);
        session.outputBytes += bytes;
        session.totalOutput += bytes;
        if (session.totalOutput > 16 * 1024 * 1024) {
          this.#end(session, "Session output limit reached (16 MiB); start a new terminal.");
          return;
        }
        session.pending += bytes;
        if (session.pending > OUTPUT_LIMIT || session.outputBytes > 1024 * 1024) {
          this.#end(session, "Output flood limit reached; start a new terminal.");
          return;
        }
        pty.pause();
        screen.write(data, () => {
          session.pending -= bytes;
          if (session.disposed) return;
          for (const client of session.clients) if (client.ready) this.#send(client, { type: "output", data });
          if (!info.ended) pty.resume();
        });
      });
      pty.onExit(({ exitCode, signal }) => {
        info.ended = true;
        info.reason ??= signal ? `Signal ${signal}` : `Exit ${exitCode}`;
        screen.write("", () => {
          if (!session.disposed) this.#state(session);
        });
        exit.resolve(undefined);
      });
      return { ...info };
    } catch (error) {
      if (home !== undefined) await rm(home, { recursive: true, force: true });
      throw error;
    } finally {
      this.#creating--;
    }
  }
  #end(session: Session, reason: string) {
    if (session.info.ended) return;
    session.info.ended = true;
    session.info.reason = reason;
    session.stop();
    const kill = setTimeout(() => session.pty.kill("SIGKILL"), 1000);
    kill.unref();
    void session.exited.then(() => clearTimeout(kill));
    this.#state(session);
  }
  #send(client: Client, data: unknown, limit = OUTPUT_LIMIT) {
    if (client.ws.readyState !== client.ws.OPEN) return;
    const text = JSON.stringify(data);
    if (client.ws.bufferedAmount + Buffer.byteLength(text) > limit) {
      client.ws.terminate();
      return;
    }
    client.ws.send(text, (error) => {
      if (error) client.ws.terminate();
    });
  }
  #state(session: Session) {
    for (const client of session.clients)
      if (client.ready)
        this.#send(client, {
          type: "state",
          ...session.info,
          epoch: session.epoch,
          control: client === session.controller && !session.info.ended,
        });
  }
  revoke(token: string | undefined) {
    for (const session of this.#sessions.values())
      for (const client of session.clients) if (client.token === token) client.ws.terminate();
  }
  async remove(projectId: string, id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (session?.info.projectId !== projectId) throw new HttpError(404, "not_found", "no such terminal");
    return (session.removing ??= (async () => {
      session.disposed = true;
      for (const client of session.clients) client.ws.terminate();
      this.#end(session, "Closed");
      await session.exited;
      session.screen.dispose();
      await rm(session.home, { recursive: true, force: true });
      this.#sessions.delete(id);
    })());
  }
  async removeProject(id: string): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].flatMap((session) =>
        session.info.projectId === id ? [this.remove(id, session.info.id)] : [],
      ),
    );
  }
  close(): Promise<void> {
    this.#closed = true;
    return (this.#closing ??= (async () => {
      await Promise.all(
        [...this.#sessions.values()].map((session) => this.remove(session.info.projectId, session.info.id)),
      );
      this.#wss?.close();
    })());
  }

  /** Upgrade bypasses the HTTP listener: repeat Host, exact Origin and owner checks before accepting it. */
  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, publicOrigin?: string): Promise<void> {
    const external = publicOrigin === undefined ? undefined : new URL(publicOrigin);
    const path = URL.parse(request.url ?? "", "http://pal.invalid")?.pathname.split("/");
    const token = cookie(request, SESSION_COOKIE);
    if (
      this.#closed ||
      this.#upgrades >= 8 ||
      request.method !== "GET" ||
      !isOwnHost(request, external) ||
      !isOwnOrigin(request, external) ||
      path?.length !== 5 ||
      path[1] !== "api" ||
      path[2] !== "terminals" ||
      path[4] !== "socket"
    ) {
      socket.destroy();
      return;
    }
    const session = this.#sessions.get(path[3] ?? "");
    if (session === undefined || session.clients.size >= 3 || token === undefined) {
      socket.destroy();
      return;
    }
    this.#upgrades++;
    try {
      const expiry = await this.#owner.sessionExpiry(token);
      if (expiry === undefined) {
        socket.destroy();
        return;
      }
      await this.#project(session.info.projectId);
      if (this.#wss === undefined) {
        const { WebSocketServer } = await import("ws");
        this.#wss ??= new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 32 * 1024 });
      }
      const authenticated = await this.#owner.authenticate(token);
      if (session.disposed || this.#closed || session.clients.size >= 3 || !authenticated) {
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        const client: Client = {
          ws,
          token,
          ready: false,
          queue: [],
          pending: 0,
          draining: false,
          messages: 0,
          window: Date.now(),
        };
        session.clients.add(client);
        const expiryTimer = setTimeout(() => ws.terminate(), Math.min(expiry - Date.now(), 2 ** 31 - 1));
        expiryTimer.unref();
        ws.on("error", () => ws.terminate());
        ws.on("close", () => {
          clearTimeout(expiryTimer);
          client.ready = false;
          client.queue = [];
          client.pending = 0;
          session.clients.delete(client);
          if (session.controller === client) {
            session.controller = undefined;
            session.epoch++;
            this.#state(session);
          }
        });
        ws.on("message", (raw, binary) => {
          const text = raw.toString();
          client.pending += Buffer.byteLength(text);
          if (binary || client.pending > 32 * 1024 || client.queue.length >= 32) {
            ws.terminate();
            return;
          }
          client.queue.push(text);
          if (!client.draining) void this.#drain(session, client);
        });
        session.screen.write("", () => {
          if (session.disposed || ws.readyState !== ws.OPEN) return;
          const full = session.serializer.serialize({ scrollback: 200 });
          const trimmed = Buffer.byteLength(full) > OUTPUT_LIMIT;
          this.#send(
            client,
            {
              type: "snapshot",
              ...session.info,
              trimmed,
              data: trimmed ? session.serializer.serialize({ scrollback: 0 }) : full,
            },
            1024 * 1024,
          );
          client.ready = true;
          if (session.controller === undefined) {
            session.controller = client;
            session.epoch++;
          }
          this.#state(session);
        });
      });
    } finally {
      this.#upgrades--;
    }
  }
  async #drain(session: Session, client: Client): Promise<void> {
    client.draining = true;
    try {
      while (client.queue.length > 0) {
        const raw = client.queue.shift();
        if (raw === undefined) break;
        client.pending -= Buffer.byteLength(raw);
        if (Date.now() - client.window > 1000) {
          client.window = Date.now();
          client.messages = 0;
        }
        if (++client.messages > 100 || !(await this.#owner.authenticate(client.token))) {
          client.ws.terminate();
          return;
        }
        await this.#project(session.info.projectId);
        if (!client.ready || session.disposed || client.ws.readyState !== client.ws.OPEN) return;
        const message = validate(Message, JSON.parse(raw));
        if (message.type === "take") {
          session.controller = client;
          session.epoch++;
          this.#state(session);
          continue;
        }
        if (session.info.ended || session.controller !== client || message.epoch !== session.epoch) {
          this.#send(client, {
            type: "error",
            message: "Control changed or session ended; take control before typing.",
          });
          continue;
        }
        if (message.type === "resize") {
          session.pty.resize(message.cols, message.rows);
          session.screen.resize(message.cols, message.rows);
          session.info.cols = message.cols;
          session.info.rows = message.rows;
          for (const observer of session.clients)
            if (observer.ready) this.#send(observer, { type: "resize", cols: message.cols, rows: message.rows });
        } else {
          const bytes = Buffer.byteLength(message.data);
          session.inputBytes += bytes;
          // node-pty exposes no write-queue size: a lifetime cap also bounds a child that never reads stdin.
          if (bytes > 16 * 1024 || session.inputBytes > 1024 * 1024) {
            this.#end(session, "Session input limit reached (1 MiB); start a new terminal.");
            return;
          }
          session.pty.write(message.data);
        }
      }
    } catch {
      client.ws.terminate();
    } finally {
      client.draining = false;
    }
  }
}
