import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { BrowserContext, Dialog, Page } from "playwright-core";
import type { ConversationId } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import type { WebSocket, WebSocketServer } from "ws";
import { EgressBroker } from "./browser-egress.ts";
import { BrowserActionBody, type BrowserActionInput, BrowserOwnerNeeded, BrowserPage } from "./browser-page.ts";
import { cookie, HttpError, isOwnHost, isOwnOrigin } from "./http.ts";
import { type Owner, SESSION_COOKIE } from "./owner.ts";
import type { Projects } from "./projects.ts";
import { validate } from "./requests.ts";

/** Programs of the sandboxed browser; the package sets them, and a build without them has no browser. */
export type BrowserRuntime = {
  readonly chromium: string;
  readonly bwrap: string;
  readonly socat: string;
  readonly bash: string;
  /** `systemd-run` for the resource-capped user scope; null only where a caller explicitly runs without one. */
  readonly scope: string | null;
  /** Directory of coreutils for the relay's wait loop; the sandbox has no other PATH. */
  readonly coreutils: string;
  readonly fontconfig?: string;
  /** Host user-manager address, never inherited by Chromium inside the namespace. */
  readonly runtimeDir?: string;
};

export function browserRuntime(env: NodeJS.ProcessEnv = process.env): BrowserRuntime | undefined {
  const { PAL_CHROMIUM: chromium, PAL_BWRAP: bwrap, PAL_SOCAT: socat, PAL_BASH: bash, PAL_COREUTILS: coreutils } = env;
  if (!chromium || !bwrap || !socat || !bash || !coreutils) return undefined;
  return {
    chromium,
    bwrap,
    socat,
    bash,
    coreutils,
    scope: env.PAL_SYSTEMD_RUN ?? "systemd-run",
    ...(env.XDG_RUNTIME_DIR ? { runtimeDir: env.XDG_RUNTIME_DIR } : {}),
    ...(env.PAL_FONTCONFIG ? { fontconfig: env.PAL_FONTCONFIG } : {}),
  };
}

/** Caps for the whole browser process tree; Chromium's threads count as tasks. */
const SCOPE_LIMITS = ["MemoryMax=2G", "TasksMax=512", "CPUQuota=100%"];
const MAX_BROWSERS = 2;
const MAX_VIEWERS = 3;
const MAX_TABS = 8;
const MAX_INPUTS = 32;
const AGENT_MS = 5 * 60_000;
const AGENT_CALLS = 40;
export type BrowserMode = "paused" | "human" | "private-login" | "agent";
const IDLE_MS = 10 * 60_000;
const DIALOG_MS = 60_000;
const PROXY_PORT = 3128;
const FRAME_BACKLOG = 2 * 1024 * 1024;
const VIEWPORT = { width: 1280, height: 800 };

const Point = { x: Type.Number({ minimum: 0, maximum: 4096 }), y: Type.Number({ minimum: 0, maximum: 4096 }) };
const Message = Type.Union([
  Type.Object({ type: Type.Literal("take") }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal("mode"), epoch: Type.Integer(), mode: Type.Enum(["paused", "human", "private-login"]) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("handoff"),
      epoch: Type.Integer(),
      chat: Type.String({ maxLength: 64 }),
      url: Type.String({ maxLength: 4096 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("navigate"), epoch: Type.Integer(), url: Type.String({ maxLength: 4096 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Enum(["back", "forward", "reload", "newTab"]), epoch: Type.Integer() },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Enum(["selectTab", "closeTab"]), epoch: Type.Integer(), id: Type.String({ maxLength: 64 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("mouse"),
      epoch: Type.Integer(),
      action: Type.Enum(["move", "down", "up", "click"]),
      button: Type.Optional(Type.Enum(["left", "middle", "right"])),
      ...Point,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("wheel"),
      epoch: Type.Integer(),
      dx: Type.Number({ minimum: -10_000, maximum: 10_000 }),
      dy: Type.Number({ minimum: -10_000, maximum: 10_000 }),
      ...Point,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("key"), epoch: Type.Integer(), key: Type.String({ minLength: 1, maxLength: 32 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("text"), epoch: Type.Integer(), text: Type.String({ minLength: 1, maxLength: 4096 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("viewport"),
      epoch: Type.Integer(),
      width: Type.Integer({ minimum: 320, maximum: 1920 }),
      height: Type.Integer({ minimum: 320, maximum: 1440 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("dialog"),
      epoch: Type.Integer(),
      accept: Type.Boolean(),
      text: Type.Optional(Type.String({ maxLength: 4096 })),
    },
    { additionalProperties: false },
  ),
]);
type Input = Static<typeof Message>;

type Viewer = { ws: WebSocket; token: string; expiry: number; ready: boolean; messages: number; window: number };
type Tab = { id: string; page: Page; model: BrowserPage };
type Lease = {
  conversation: ConversationId;
  chat: string;
  token: string;
  expires: number;
  left: number;
  timer: NodeJS.Timeout;
};
type Instance = {
  projectId: string;
  id: string;
  mode: BrowserMode;
  lease: Lease | undefined;
  modelBusy: boolean;
  context: BrowserContext;
  broker: EgressBroker;
  run: string;
  tabs: Tab[];
  active: Tab | undefined;
  viewport: { width: number; height: number };
  viewers: Set<Viewer>;
  controller: Viewer | undefined;
  epoch: number;
  dialog: { tab: Tab; dialog: Dialog; timer: NodeJS.Timeout } | undefined;
  frame: Buffer | undefined;
  stopFrames: (() => Promise<void>) | undefined;
  idle: NodeJS.Timeout | undefined;
  inputs: Promise<void>;
  pending: number;
  activation: Promise<void>;
  frameEpoch: number;
  titlesPending: boolean;
  closing: Promise<void> | undefined;
};

/** A navigation target the owner may open: http(s) or a blank page. A bare host becomes https. */
export function browsable(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "about:blank") return trimmed;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new HttpError(400, "invalid_url", "enter a web address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new HttpError(400, "invalid_url", "only http and https pages can be opened");
  return url.href;
}

/**
 * The owner's per-project browsers. Chromium runs with its own sandbox inside rootless bubblewrap namespaces that
 * share no network and no Pal data: only the project's dedicated profile, the read-only Nix store and a Unix socket
 * to the host's egress broker, which admits public destinations only. A transient user scope caps memory, tasks and
 * CPU; without one the browser does not start. Frames live in memory only: no screenshots, traces, HAR or input logs.
 * Model access requires an explicit, expiring per-chat handoff and native durable tools. Private login never enters it.
 */
export class ProjectBrowsers {
  readonly #dataRoot: string;
  readonly #projects: Projects;
  readonly #owner: Owner;
  readonly #chat: ((id: string) => Promise<{ project: string; conversation: ConversationId } | undefined>) | undefined;
  readonly #ownOrigins = new Set<string>();
  readonly #runtime: BrowserRuntime | undefined;
  readonly #egress: Parameters<typeof EgressBroker.listen>[1];
  readonly #instances = new Map<string, Instance>();
  readonly #starting = new Map<string, Promise<Instance>>();
  readonly #retiring = new Map<string, Promise<void>>();
  #wss: WebSocketServer | undefined;
  #closed = false;

  get releaseBusy(): boolean {
    return this.#instances.size > 0 || this.#starting.size > 0 || this.#retiring.size > 0;
  }

  constructor(options: {
    dataRoot: string;
    projects: Projects;
    owner: Owner;
    runtime: BrowserRuntime | undefined;
    chat?: (id: string) => Promise<{ project: string; conversation: ConversationId } | undefined>;
    /** Tests admit a loopback fixture; production uses the public-only policy. */
    egress?: Parameters<typeof EgressBroker.listen>[1];
  }) {
    this.#dataRoot = options.dataRoot;
    this.#projects = options.projects;
    this.#owner = options.owner;
    this.#chat = options.chat;
    this.#runtime = options.runtime;
    this.#egress = options.egress;
  }

  async status(projectId: string): Promise<{ available: boolean; running: boolean }> {
    await this.#project(projectId);
    return { available: this.#runtime !== undefined, running: this.#instances.has(projectId) };
  }

  allows(conversation: ConversationId): boolean {
    return [...this.#instances.values()].some(
      (instance) =>
        !this.#closed &&
        !this.#retiring.has(instance.projectId) &&
        instance.closing === undefined &&
        instance.mode === "agent" &&
        instance.lease?.conversation === conversation &&
        instance.lease.expires > Date.now() &&
        instance.lease.left > 0,
    );
  }

  #lease(conversation: ConversationId) {
    const instance = [...this.#instances.values()].find((item) => item.lease?.conversation === conversation);
    if (instance === undefined || !this.allows(conversation) || instance.active === undefined)
      throw new HttpError(409, "browser_not_granted", "Open Browser and explicitly hand control to this chat first.");
    return { instance, tab: instance.active, lease: instance.lease as Lease };
  }

  /** Exact action/page/epoch description used by the durable pre-dispatch approval, never owner input. */
  async approval(conversation: ConversationId, input: unknown) {
    const args = validate(BrowserActionBody, input);
    const { instance, tab } = this.#lease(conversation);
    await this.#project(instance.projectId);
    this.#actionCurrent(instance, tab, conversation, args);
    if (args.action.type === "navigate") this.#modelUrl(args.action.url);
    return { command: JSON.stringify(args), cwd: this.#publicUrl(tab.page.url()), timeout: 10 };
  }

  async observe(conversation: ConversationId, signal?: AbortSignal) {
    return this.#model(conversation, signal, async (instance, tab, guard) => {
      const result = await tab.model.observe(guard);
      guard();
      if (result.login || result.truncated) {
        this.#mode(instance, "private-login");
        throw new HttpError(
          409,
          "browser_owner_needed",
          "Sign-in or a complex page needs the owner; no page content was shared.",
        );
      }
      return {
        ...result,
        session: instance.id,
        epoch: instance.epoch,
        url: this.#publicUrl(tab.page.url()),
        remaining: instance.lease?.left ?? 0,
      };
    });
  }

  async act(conversation: ConversationId, input: BrowserActionInput, signal?: AbortSignal) {
    return this.#model(conversation, signal, async (instance, tab, guard) => {
      this.#actionCurrent(instance, tab, conversation, input);
      if (input.action.type === "navigate")
        input = { ...input, action: { ...input.action, url: this.#modelUrl(input.action.url) } };
      if (await tab.model.privatePage(guard)) {
        this.#mode(instance, "private-login");
        throw new HttpError(409, "browser_owner_needed", "This private or unsupported page needs owner control.");
      }
      guard();
      await tab.model.act(input, guard);
      guard();
      return {
        session: instance.id,
        epoch: instance.epoch,
        action: input.action.type,
        url: this.#publicUrl(tab.page.url()),
        remaining: instance.lease?.left ?? 0,
      };
    });
  }

  assertEpoch(conversation: ConversationId, session: string, epoch: number): void {
    const instance = [...this.#instances.values()].find((item) => item.id === session);
    if (
      this.#closed ||
      instance?.mode !== "agent" ||
      instance.lease?.conversation !== conversation ||
      instance.lease.expires <= Date.now() ||
      instance.epoch !== epoch ||
      instance.closing !== undefined ||
      this.#retiring.has(instance.projectId)
    )
      throw new HttpError(
        409,
        "browser_revoked",
        "Browser authority changed before delivery; inspect before retrying.",
      );
  }

  #actionCurrent(instance: Instance, tab: Tab, conversation: ConversationId, input: BrowserActionInput): void {
    if (
      instance.lease?.conversation !== conversation ||
      instance.mode !== "agent" ||
      instance.lease.expires <= Date.now() ||
      instance.active !== tab ||
      input.session !== instance.id ||
      input.epoch !== instance.epoch
    )
      throw new HttpError(409, "browser_stale", "Browser control or page changed; inspect again.");
    tab.model.current(input.observation);
  }

  async #model<T>(
    conversation: ConversationId,
    signal: AbortSignal | undefined,
    work: (instance: Instance, tab: Tab, guard: () => void) => Promise<T>,
  ): Promise<T> {
    const { instance, tab, lease } = this.#lease(conversation),
      epoch = instance.epoch;
    if (instance.modelBusy || instance.pending > 0)
      throw new HttpError(409, "browser_busy", "The browser is busy; wait for its current action.");
    instance.modelBusy = true;
    lease.left--;
    const guard = () => {
      signal?.throwIfAborted();
      if (
        this.#closed ||
        instance.closing !== undefined ||
        this.#retiring.has(instance.projectId) ||
        instance.lease !== lease ||
        instance.mode !== "agent" ||
        instance.epoch !== epoch ||
        instance.active !== tab ||
        lease.expires <= Date.now()
      )
        throw new HttpError(
          409,
          "browser_revoked",
          "Browser control changed. An action may have completed; inspect before retrying.",
        );
    };
    this.#broadcast(instance);
    const cancel = () => {
      this.#mode(instance, "paused");
      void instance.context.close().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const deadline = setTimeout(cancel, 12_000);
    deadline.unref();
    try {
      await this.#project(instance.projectId);
      await instance.activation;
      guard();
      this.#modelUrl(tab.page.url());
      return await work(instance, tab, guard);
    } catch (error) {
      if (error instanceof BrowserOwnerNeeded) {
        if (instance.mode === "agent") this.#mode(instance, "private-login");
        throw new HttpError(409, "browser_owner_needed", "This private or unsupported page needs owner control.");
      }
      if (instance.mode === "agent") this.#mode(instance, "paused");
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        409,
        "browser_interrupted",
        "Browser action failed or was interrupted. It may have completed; inspect before retrying.",
      );
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      instance.modelBusy = false;
      this.#broadcast(instance);
    }
  }

  #modelUrl(input: string): string {
    const url = URL.parse(browsable(input));
    if (
      url === null ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      [...this.#ownOrigins].some((origin) => URL.parse(origin)?.host === url.host)
    )
      throw new HttpError(
        403,
        "browser_url_forbidden",
        "Pal itself, credentials in URLs and non-web pages are off limits to browser tools.",
      );
    return url.href;
  }

  #publicUrl(input: string): string {
    const url = URL.parse(input);
    return url === null ? "" : `${url.origin}${url.pathname}`.slice(0, 2000);
  }

  #mode(instance: Instance, mode: Exclude<BrowserMode, "agent">, viewer?: Viewer): void {
    if (instance.lease !== undefined) clearTimeout(instance.lease.timer);
    instance.lease = undefined;
    instance.mode = mode;
    instance.epoch++;
    instance.controller = mode === "paused" ? undefined : viewer;
    this.#broadcast(instance);
  }

  /** Sign-out revokes this session's observation, input and agent handoff, not the browser itself. */
  revoke(token: string | undefined): void {
    for (const instance of this.#instances.values()) {
      if (instance.lease?.token === token) this.#mode(instance, "paused");
      for (const viewer of instance.viewers) {
        if (viewer.token !== token) continue;
        viewer.ready = false;
        if (instance.controller === viewer) {
          instance.controller = undefined;
          instance.epoch++;
        }
        viewer.ws.terminate();
      }
      this.#broadcast(instance);
    }
  }

  /** Close the project's browser; its profile, and so its site logins, stay for the next start. */
  stop(projectId: string): Promise<void> {
    return this.#retire(projectId, false);
  }

  /** Delete the project's profile: cookies, logins and site data. The browser is closed first. */
  clear(projectId: string): Promise<void> {
    return this.#retire(projectId, true);
  }

  async #retire(projectId: string, clear: boolean): Promise<void> {
    const dir = this.#dir(projectId);
    const previous = this.#retiring.get(projectId) ?? Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        const instance =
          (await this.#starting.get(projectId)?.catch(() => undefined)) ?? this.#instances.get(projectId);
        if (instance !== undefined) await this.#shutdown(instance);
        if (
          clear &&
          (await privateDirectory(join(this.#dataRoot, "browser"), "existing")) &&
          (await privateDirectory(dir, "existing"))
        )
          await rm(dir, { recursive: true, force: true });
      });
    this.#retiring.set(projectId, work);
    try {
      await work;
    } finally {
      if (this.#retiring.get(projectId) === work) this.#retiring.delete(projectId);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#starting.values());
    await Promise.all([...this.#instances.values()].map((instance) => this.#shutdown(instance)));
    await Promise.allSettled(this.#retiring.values());
    this.#wss?.close();
  }

  /** `/api/projects/:id/browser/socket`; repeats the Host, exact Origin and owner checks the HTTP API makes. */
  handles(request: IncomingMessage): boolean {
    const path = URL.parse(request.url ?? "", "http://pal.invalid")?.pathname.split("/");
    return (
      path?.length === 6 && path[1] === "api" && path[2] === "projects" && path[4] === "browser" && path[5] === "socket"
    );
  }

  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, publicOrigin?: string): Promise<void> {
    const external = publicOrigin === undefined ? undefined : (URL.parse(publicOrigin) ?? undefined);
    if (publicOrigin !== undefined && external === undefined) {
      socket.destroy();
      return;
    }
    const [, , , projectId = ""] = URL.parse(request.url ?? "", "http://pal.invalid")?.pathname.split("/") ?? [];
    const token = cookie(request, SESSION_COOKIE);
    if (
      this.#closed ||
      this.#runtime === undefined ||
      request.method !== "GET" ||
      !isOwnHost(request, external) ||
      !isOwnOrigin(request, external) ||
      token === undefined
    ) {
      socket.destroy();
      return;
    }
    if (request.headers.origin !== undefined) this.#ownOrigins.add(request.headers.origin);
    const expiry = await this.#owner.sessionExpiry(token);
    if (expiry === undefined || (this.#instances.get(projectId)?.viewers.size ?? 0) >= MAX_VIEWERS) {
      socket.destroy();
      return;
    }
    let instance: Instance;
    try {
      await this.#project(projectId);
      instance = await this.#start(projectId);
    } catch (error) {
      socket.end(`HTTP/1.1 503 Unavailable\r\ncontent-type: text/plain\r\n\r\n${(error as Error).message}`);
      return;
    }
    if (this.#wss === undefined) {
      const { WebSocketServer } = await import("ws");
      this.#wss ??= new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 8 * 1024 });
    }
    if (
      !(await this.#owner.authenticate(token)) ||
      this.#closed ||
      this.#retiring.has(projectId) ||
      instance.closing !== undefined ||
      instance.viewers.size >= MAX_VIEWERS ||
      socket.destroyed
    ) {
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(request, socket, head, (ws) => this.#attach(instance, ws, token, expiry));
  }

  #attach(instance: Instance, ws: WebSocket, token: string, expiry: number): void {
    const viewer: Viewer = { ws, token, expiry, ready: true, messages: 0, window: Date.now() };
    instance.viewers.add(viewer);
    if (instance.idle !== undefined) clearTimeout(instance.idle);
    instance.idle = undefined;
    const expiryTimer = setTimeout(() => ws.terminate(), Math.min(expiry - Date.now(), 2 ** 31 - 1));
    expiryTimer.unref();
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      clearTimeout(expiryTimer);
      viewer.ready = false;
      instance.viewers.delete(viewer);
      if (instance.controller === viewer) {
        instance.controller = undefined;
        instance.epoch++;
      }
      this.#broadcast(instance);
      if (instance.viewers.size === 0 && instance.closing === undefined) {
        instance.idle = setTimeout(() => void this.#shutdown(instance), IDLE_MS);
        instance.idle.unref();
      }
    });
    ws.on("message", (raw, binary) => {
      if (Date.now() - viewer.window > 1000) {
        viewer.window = Date.now();
        viewer.messages = 0;
      }
      if (binary || ++viewer.messages > 120 || instance.pending >= MAX_INPUTS) {
        ws.terminate();
        return;
      }
      let message: Input;
      try {
        message = validate(Message, JSON.parse(raw.toString()));
      } catch {
        this.#send(viewer, { type: "error", message: "Invalid browser input." });
        return;
      }
      instance.pending++;
      const run = () => this.#handle(instance, viewer, message).finally(() => instance.pending--);
      // Revocation must overtake a slow page action; queued input still binds its original epoch.
      if (message.type === "take" || message.type === "mode") void run();
      else instance.inputs = instance.inputs.then(run);
    });
    if (instance.controller === undefined && (instance.mode === "human" || instance.mode === "private-login")) {
      instance.controller = viewer;
      instance.epoch++;
    }
    this.#broadcast(instance);
    if (instance.frame !== undefined) this.#frame(viewer, instance.frame);
  }

  async #handle(instance: Instance, viewer: Viewer, message: Input): Promise<void> {
    try {
      if (!(await this.#owner.authenticate(viewer.token))) {
        viewer.ws.terminate();
        return;
      }
      await this.#project(instance.projectId);
      if (!viewer.ready || this.#closed || this.#retiring.has(instance.projectId) || instance.closing !== undefined)
        return;
      if (message.type === "take") {
        this.#mode(instance, "human", viewer);
        return;
      }
      if (message.type === "mode") {
        if (message.epoch !== instance.epoch) throw new HttpError(409, "browser_stale", "Control changed; try again.");
        this.#mode(instance, message.mode, viewer);
        return;
      }
      if (instance.controller !== viewer || message.epoch !== instance.epoch) {
        this.#send(viewer, { type: "error", message: "Control changed; take control before using the browser." });
        return;
      }
      if (message.type === "handoff") {
        const chat = await this.#chat?.(message.chat);
        if (
          chat?.project !== instance.projectId ||
          !viewer.ready ||
          instance.controller !== viewer ||
          message.epoch !== instance.epoch ||
          instance.modelBusy ||
          message.url !== instance.active?.page.url()
        )
          throw new HttpError(409, "browser_stale", "The chat, page or control changed; review the handoff again.");
        this.#modelUrl(message.url);
        this.#mode(instance, "paused");
        const expires = Math.min(Date.now() + AGENT_MS, viewer.expiry);
        const timer = setTimeout(() => this.#mode(instance, "paused"), Math.max(0, expires - Date.now()));
        timer.unref();
        instance.mode = "agent";
        instance.lease = {
          conversation: chat.conversation,
          chat: message.chat,
          token: viewer.token,
          expires,
          left: AGENT_CALLS,
          timer,
        };
        this.#broadcast(instance);
        return;
      }
      const control = () => {
        if (
          !viewer.ready ||
          instance.modelBusy ||
          (instance.mode !== "human" && instance.mode !== "private-login") ||
          instance.closing !== undefined ||
          instance.controller !== viewer ||
          message.epoch !== instance.epoch
        )
          throw new HttpError(
            409,
            "browser_control_changed",
            "Control changed; take control before using the browser.",
          );
      };
      await this.#apply(instance, message, control);
    } catch (error) {
      if (error instanceof HttpError && error.code === "not_found") {
        viewer.ws.terminate();
        return;
      }
      this.#send(viewer, {
        type: "error",
        message:
          error instanceof HttpError
            ? error.message
            : "Page action failed or was interrupted. Check the page before trying again.",
      });
    }
  }

  async #apply(
    instance: Instance,
    message: Exclude<Input, { type: "take" | "mode" | "handoff" }>,
    control: () => void,
  ): Promise<void> {
    control();
    const page = instance.active?.page;
    switch (message.type) {
      case "newTab":
        if (instance.tabs.length >= MAX_TABS)
          throw new HttpError(409, "browser_tab_limit", `at most ${MAX_TABS} tabs may be open; close one first`);
        await instance.context.newPage();
        return;
      case "selectTab":
      case "closeTab": {
        const tab = instance.tabs.find((candidate) => candidate.id === message.id);
        if (tab === undefined) throw new Error("that tab is gone");
        if (message.type === "closeTab") await tab.page.close();
        else await this.#activate(instance, tab);
        return;
      }
      case "viewport":
        instance.viewport = { width: message.width, height: message.height };
        await Promise.all(instance.tabs.map((tab) => tab.page.setViewportSize(instance.viewport)));
        if (instance.active !== undefined) await this.#activate(instance, instance.active);
        return;
      case "dialog": {
        const pending = instance.dialog;
        if (pending === undefined) return;
        instance.dialog = undefined;
        clearTimeout(pending.timer);
        await (message.accept ? pending.dialog.accept(message.text) : pending.dialog.dismiss());
        this.#broadcast(instance);
        return;
      }
      default:
        break;
    }
    if (page === undefined) throw new Error("open a tab first");
    switch (message.type) {
      case "navigate":
        await page.goto(browsable(message.url), { waitUntil: "commit", timeout: 30_000 });
        break;
      case "back":
        await page.goBack({ waitUntil: "commit", timeout: 30_000 });
        break;
      case "forward":
        await page.goForward({ waitUntil: "commit", timeout: 30_000 });
        break;
      case "reload":
        await page.reload({ waitUntil: "commit", timeout: 30_000 });
        break;
      case "mouse":
        if (message.action === "move") await page.mouse.move(message.x, message.y);
        else if (message.action === "click")
          await page.mouse.click(message.x, message.y, { button: message.button ?? "left" });
        else {
          await page.mouse.move(message.x, message.y);
          control();
          await page.mouse[message.action]({ button: message.button ?? "left" });
        }
        return;
      case "wheel":
        await page.mouse.move(message.x, message.y);
        control();
        await page.mouse.wheel(message.dx, message.dy);
        return;
      case "key":
        await page.keyboard.press(message.key);
        return;
      case "text":
        await page.keyboard.insertText(message.text);
        return;
      default:
        throw new Error("unsupported browser input");
    }
    this.#broadcast(instance);
  }

  #start(projectId: string): Promise<Instance> {
    if (this.#closed || this.#retiring.has(projectId)) return Promise.reject(new Error("the browser is closing"));
    const running = this.#instances.get(projectId);
    if (running !== undefined && running.closing === undefined) return Promise.resolve(running);
    const starting = this.#starting.get(projectId);
    if (starting !== undefined) return starting;
    if (this.#instances.size + this.#starting.size >= MAX_BROWSERS)
      return Promise.reject(new Error(`at most ${MAX_BROWSERS} project browsers may run at once; close one first`));
    const launch = this.#launch(projectId).finally(() => this.#starting.delete(projectId));
    this.#starting.set(projectId, launch);
    return launch;
  }

  async #launch(projectId: string): Promise<Instance> {
    const runtime = this.#runtime;
    if (runtime === undefined) throw new Error("this Pal build has no browser runtime");
    const dir = this.#dir(projectId);
    const profile = join(dir, "profile");
    for (const path of [join(this.#dataRoot, "browser"), dir, profile]) await privateDirectory(path);
    // Unix socket paths are limited to 108 bytes on Linux; project data paths may be much longer.
    const run = await mkdtemp(join(tmpdir(), "pal-browser-"));
    let broker: EgressBroker | undefined;
    let context: BrowserContext | undefined;
    try {
      broker = await EgressBroker.listen(join(run, "egress.sock"), this.#egress);
      const launcher = join(run, "chromium.sh");
      await writeFile(launcher, script(runtime, profile, run), { mode: 0o700 });
      const { chromium } = await import("playwright-core");
      context = await chromium.launchPersistentContext(profile, {
        executablePath: launcher,
        headless: true,
        chromiumSandbox: true,
        // Every destination, loopback included, goes to the broker; the sandbox has no other network.
        proxy: { server: `http://127.0.0.1:${PROXY_PORT}`, bypass: "<-loopback>" },
        viewport: VIEWPORT,
        acceptDownloads: false,
        env: runtime.scope === null ? {} : { XDG_RUNTIME_DIR: runtime.runtimeDir ?? `/run/user/${process.getuid?.()}` },
        timeout: 30_000,
      });
      const instance: Instance = {
        projectId,
        id: randomUUID(),
        mode: "human",
        lease: undefined,
        modelBusy: false,
        context,
        broker,
        run,
        tabs: [],
        active: undefined,
        viewport: { ...VIEWPORT },
        viewers: new Set(),
        controller: undefined,
        epoch: 0,
        dialog: undefined,
        frame: undefined,
        stopFrames: undefined,
        idle: undefined,
        inputs: Promise.resolve(),
        pending: 0,
        activation: Promise.resolve(),
        frameEpoch: 0,
        titlesPending: false,
        closing: undefined,
      };
      this.#instances.set(projectId, instance);
      context.on("page", (page) => void this.#adopt(instance, page, true).catch(() => page.close().catch(() => {})));
      context.on("close", () => void this.#shutdown(instance));
      for (const page of context.pages()) await this.#adopt(instance, page, instance.active === undefined);
      if (instance.tabs.length === 0) await context.newPage();
      if (this.#closed) await this.#shutdown(instance);
      else {
        instance.idle = setTimeout(() => void this.#shutdown(instance), IDLE_MS);
        instance.idle.unref();
      }
      return instance;
    } catch (error) {
      await context?.close().catch(() => {});
      await broker?.close();
      await rm(run, { recursive: true, force: true });
      throw new Error(`the browser could not start: ${(error as Error).message.split("\n")[0]}`, { cause: error });
    }
  }

  async #adopt(instance: Instance, page: Page, activate: boolean): Promise<void> {
    if (instance.tabs.some((tab) => tab.page === page)) return;
    if (instance.closing !== undefined || instance.tabs.length >= MAX_TABS) {
      await page.close();
      return;
    }
    const tab: Tab = { id: randomUUID(), page, model: new BrowserPage(page) };
    instance.tabs.push(tab);
    const changed = () => this.#broadcast(instance);
    page.on("framenavigated", (frame) => frame === page.mainFrame() && changed());
    page.on("load", changed);
    page.on("dialog", (dialog) => {
      if (instance.mode === "agent") this.#mode(instance, "paused");
      if (instance.dialog !== undefined) {
        void dialog.dismiss().catch(() => {});
        return;
      }
      const timer = setTimeout(() => {
        if (instance.dialog?.dialog !== dialog) return;
        instance.dialog = undefined;
        void dialog.dismiss().catch(() => {});
        changed();
      }, DIALOG_MS);
      timer.unref();
      instance.dialog = { tab, dialog, timer };
      changed();
    });
    page.on("close", () => {
      instance.tabs = instance.tabs.filter((candidate) => candidate !== tab);
      if (instance.dialog?.tab === tab) {
        clearTimeout(instance.dialog.timer);
        instance.dialog = undefined;
      }
      if (instance.active === tab) {
        instance.active = undefined;
        instance.frame = undefined;
        const next = instance.tabs.at(-1);
        if (next !== undefined) void this.#activate(instance, next).catch(() => {});
      }
      changed();
    });
    if (activate || instance.active === undefined) await this.#activate(instance, tab);
    else changed();
  }

  #activate(instance: Instance, tab: Tab): Promise<void> {
    const epoch = ++instance.frameEpoch;
    instance.active = tab;
    instance.frame = undefined;
    this.#broadcast(instance);
    const current = () => epoch === instance.frameEpoch && instance.closing === undefined && !tab.page.isClosed();
    instance.activation = instance.activation
      .catch(() => {})
      .then(async () => {
        await instance.stopFrames?.().catch(() => {});
        instance.stopFrames = undefined;
        if (!current()) return;
        await tab.page.setViewportSize(instance.viewport);
        await tab.page.bringToFront();
        if (!current()) return;
        await tab.page.screencast.start({
          size: instance.viewport,
          quality: 70,
          onFrame: ({ data }) => {
            if (!current()) return;
            instance.frame = data;
            for (const viewer of instance.viewers) this.#frame(viewer, data);
          },
        });
        instance.stopFrames = () => tab.page.screencast.stop();
      });
    return instance.activation;
  }

  async #shutdown(instance: Instance): Promise<void> {
    instance.closing ??= (async () => {
      this.#mode(instance, "paused");
      instance.controller = undefined;
      instance.epoch++;
      instance.frameEpoch++;
      instance.frame = undefined;
      if (instance.idle !== undefined) clearTimeout(instance.idle);
      if (instance.dialog !== undefined) clearTimeout(instance.dialog.timer);
      for (const viewer of instance.viewers) {
        viewer.ready = false;
        viewer.ws.terminate();
      }
      await instance.context.close().catch(() => {});
      await instance.broker.close().catch(() => {});
      await rm(instance.run, { recursive: true, force: true });
      if (this.#instances.get(instance.projectId) === instance) this.#instances.delete(instance.projectId);
    })();
    return instance.closing;
  }

  #broadcast(instance: Instance): void {
    const state = {
      type: "state",
      session: instance.id,
      mode: instance.mode,
      busy: instance.modelBusy,
      agent:
        instance.lease === undefined
          ? null
          : { chat: instance.lease.chat, expires: instance.lease.expires, remaining: instance.lease.left },
      epoch: instance.epoch,
      viewport: instance.viewport,
      tabs: instance.tabs.map((tab) => ({
        id: tab.id,
        url: tab.page.url(),
        active: tab === instance.active,
      })),
      dialog:
        instance.dialog === undefined
          ? null
          : {
              type: instance.dialog.dialog.type(),
              message: instance.dialog.dialog.message().slice(0, 2000),
              defaultValue: instance.dialog.dialog.defaultValue().slice(0, 2000),
            },
    };
    for (const viewer of instance.viewers)
      this.#send(viewer, {
        ...state,
        control:
          viewer === instance.controller &&
          !instance.modelBusy &&
          (instance.mode === "human" || instance.mode === "private-login"),
      });
    if (!instance.titlesPending && instance.viewers.size > 0 && instance.closing === undefined)
      void this.#titles(instance);
  }

  /** Titles need a page round trip; they follow the state they belong to. */
  async #titles(instance: Instance): Promise<void> {
    instance.titlesPending = true;
    try {
      const titles = await Promise.all(
        instance.tabs.map(async (tab) => ({
          id: tab.id,
          title: (await tab.page.title().catch(() => "")).slice(0, 200),
        })),
      );
      for (const viewer of instance.viewers) this.#send(viewer, { type: "titles", titles });
    } finally {
      instance.titlesPending = false;
    }
  }

  #send(viewer: Viewer, data: unknown): void {
    if (!viewer.ready || viewer.ws.readyState !== viewer.ws.OPEN) return;
    if (viewer.ws.bufferedAmount > FRAME_BACKLOG) {
      viewer.ws.terminate();
      return;
    }
    viewer.ws.send(JSON.stringify(data), (error) => error && viewer.ws.terminate());
  }

  /** Frames are dropped, never queued, while a viewer is behind; the next one replaces them. */
  #frame(viewer: Viewer, data: Buffer): void {
    if (!viewer.ready || viewer.ws.readyState !== viewer.ws.OPEN || viewer.ws.bufferedAmount > FRAME_BACKLOG) return;
    viewer.ws.send(data, { binary: true }, (error) => error && viewer.ws.terminate());
  }

  async #project(id: string) {
    const project = await this.#projects.get(id);
    if (project?.state !== "ready") throw new HttpError(404, "not_found", "no such ready project");
    return project;
  }

  #dir(projectId: string): string {
    if (!/^[\w-]{1,64}$/.test(projectId)) throw new HttpError(404, "not_found", "no such project");
    return join(this.#dataRoot, "browser", projectId);
  }
}

/** Refuse links, foreign owners and shared profile directories before mounting or deleting them. */
async function privateDirectory(path: string, mode: "create" | "existing" = "create"): Promise<boolean> {
  try {
    if (mode === "create")
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error("browser profiles must be owner-only directories, not links");
    return true;
  } catch (error) {
    if (mode === "existing" && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The capped user scope and bubblewrap sandbox every browser process starts in: every namespace unshared (no network
 * at all), the read-only Nix store, a private /tmp and only this profile and run directory. Ends with `--`.
 */
export function sandboxArgs(runtime: BrowserRuntime, profile: string, run: string): string[] {
  const scope =
    runtime.scope === null
      ? []
      : [runtime.scope, "--user", "--scope", "--quiet", "--collect", ...SCOPE_LIMITS.flatMap((limit) => ["-p", limit])];
  return [
    ...scope,
    runtime.bwrap,
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    ...["--ro-bind", "/nix/store", "/nix/store"],
    ...["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"],
    ...["--bind", profile, profile, "--bind", run, "/run/pal"],
    "--clearenv",
    ...["--setenv", "HOME", "/tmp", "--setenv", "PATH", runtime.coreutils],
    ...(runtime.fontconfig === undefined ? [] : ["--setenv", "FONTCONFIG_FILE", runtime.fontconfig]),
    "--",
  ];
}

/** The launcher Playwright starts instead of Chromium: inside the sandbox, socat relays the proxy port to the broker. */
function script(runtime: BrowserRuntime, profile: string, run: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const relay = [
    `${quote(runtime.socat)} TCP-LISTEN:${PROXY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/pal/egress.sock &`,
    `for _ in {1..40}; do (exec 3<>/dev/tcp/127.0.0.1/${PROXY_PORT}) 2>/dev/null && break; sleep 0.05; done`,
    'exec "$0" "$@"',
  ].join("\n");
  const sandbox = sandboxArgs(runtime, profile, run).map(quote).join(" ");
  return `#!${runtime.bash}\nexec ${sandbox} ${quote(runtime.bash)} -c ${quote(relay)} ${quote(runtime.chromium)} "$@"\n`;
}
