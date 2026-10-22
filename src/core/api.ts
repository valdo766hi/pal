import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { clampThinkingLevel, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { type AgentEvent, type Conversation, watchEvents } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  CHATGPT_PROVIDER,
  type ChatGPTAccount,
  ChatGPTAuthError,
  type ChatGPTModel,
  listChatGPTModels,
} from "../pi/chatgpt.ts";
import { McpConfigError } from "../pi/mcp.ts";
import { CompatibleBody, isApiProvider, ProviderConfigError } from "../pi/providers.ts";
import { StdioConfigError, StdioServerBody } from "../pi/mcp-stdio.ts";
import type { Pal } from "./app.ts";
import { ApprovalDecision, CommandModeBody } from "./approvals.ts";
import { helperViews } from "./delegation.ts";
import { chatDiagnostics, installationDiagnostics } from "./diagnostics.ts";
import { ExtensionSelection } from "./extensions.ts";
import {
  AdmissionStopped,
  chatConfiguration,
  ChatNotFound,
  ConfigurationRevision,
  ProjectUnavailable,
  type ChatSummary,
} from "./chats.ts";
import { cookie, HttpError, isOwnOrigin, readJson, sendJson } from "./http.ts";
import { OwnerError, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "./owner.ts";
import { WorkspaceBusy } from "./execution.ts";
import { FileAccessError, searchFolder } from "./files.ts";
import { SearchError } from "./search.ts";
import { FolderError } from "./projects.ts";
import { InvalidRequest, RequestConflict, validate } from "./requests.ts";
import { UploadBody, UploadError } from "./uploads.ts";
import { TerminalSize } from "./terminals.ts";
import { MemoryBody } from "./memory.ts";
import type { ReleaseRpc } from "./release-rpc.ts";
import { ReleaseDigest } from "./release-state.ts";
import type { ScheduleNotice, ScheduleView } from "./schedules.ts";

const WorkspaceId = Type.Optional(Type.String({ minLength: 1, maxLength: 64 }));
const workspaceQuery = (url: URL) => {
  const id = url.searchParams.get("workspace");
  return id === null ? undefined : validate(WorkspaceId, id);
};
const NewTerminal = Type.Object(
  { ...TerminalSize.properties, trust: Type.Literal(true), workspace: WorkspaceId },
  { additionalProperties: false },
);
const NewMemory = Type.Object(
  { ...MemoryBody.properties, requestId: Type.Unknown(), workspace: WorkspaceId },
  { additionalProperties: false },
);
const CorrectMemory = Type.Object(
  { ...MemoryBody.properties, revision: Type.Integer({ minimum: 1 }), workspace: WorkspaceId },
  { additionalProperties: false },
);
const ForgetMemory = Type.Object(
  { revision: Type.Integer({ minimum: 1 }), workspace: WorkspaceId },
  { additionalProperties: false },
);
const HEARTBEAT_MS = 25_000;

const Passphrase = Type.Object({ passphrase: Type.String({ maxLength: 1024 }) }, { additionalProperties: false });
const Setup = Type.Object(
  { token: Type.String({ maxLength: 256 }), passphrase: Type.String({ maxLength: 1024 }) },
  { additionalProperties: false },
);
const Paste = Type.Object({ url: Type.String({ maxLength: 8192 }) }, { additionalProperties: false });
const ModelChoice = Type.Object(
  { model: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);
const ProviderId = Type.String({ minLength: 1, maxLength: 40 });
const ChatModelChoice = Type.Object(
  {
    ...ModelChoice.properties,
    provider: Type.Optional(ProviderId),
    expected: Type.Optional(ConfigurationRevision),
    // Every Pi thinking level; the chosen model's own support is enforced by clamping below.
    effort: Type.Optional(Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
  },
  { additionalProperties: false },
);
const DefaultModel = Type.Object({ ...ModelChoice.properties, provider: ProviderId }, { additionalProperties: false });
const Keyed = Type.Object({ requestId: Type.Unknown() }, { additionalProperties: true });
const McpServerBody = Type.Union([
  StdioServerBody,
  Type.Object(
    {
      transport: Type.Optional(Type.Literal("http")),
      name: Type.String({ minLength: 1, maxLength: 80 }),
      url: Type.String({ minLength: 1, maxLength: 2048 }),
      auth: Type.Union([
        Type.Object({ kind: Type.Literal("none") }, { additionalProperties: false }),
        Type.Object(
          { kind: Type.Literal("header"), header: Type.String({ maxLength: 64 }) },
          { additionalProperties: false },
        ),
        Type.Object({ kind: Type.Literal("bearer") }, { additionalProperties: false }),
      ]),
      private: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);
const ProgramApproval = Type.Object(
  { digest: Type.String({ pattern: "^[a-f0-9]{64}$" }), approved: Type.Boolean() },
  { additionalProperties: false },
);
const KeyBody = Type.Object({ key: Type.String({ maxLength: 4096 }) }, { additionalProperties: false });
const Toggle = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
const ModelSetup = Type.Object({ deferred: Type.Boolean() }, { additionalProperties: false });
const ToolChoice = Type.Object(
  { tools: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 128 }) },
  { additionalProperties: false },
);
const CatalogApproval = Type.Object(
  { tools: ToolChoice.properties.tools, catalog: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false },
);
const Review = Type.Object({ enable: Type.Boolean() }, { additionalProperties: false });
const ReviewScope = Type.Enum(["normal", "include-ignored"]);
const FileDiscard = Type.Object(
  {
    path: Type.String({ maxLength: 4096 }),
    revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    scope: Type.Optional(ReviewScope),
    workspace: WorkspaceId,
  },
  { additionalProperties: false },
);
const Commit = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" });
const BaselineMove = Type.Object(
  { from: Type.Union([Commit, Type.Null()]), to: Commit, workspace: WorkspaceId },
  { additionalProperties: false },
);
const FileComment = Type.Object(
  {
    path: Type.String({ maxLength: 4096 }),
    revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    line: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    body: Type.String({ minLength: 1, maxLength: 4000 }),
    scope: Type.Optional(ReviewScope),
    workspace: WorkspaceId,
  },
  { additionalProperties: false },
);
const FileReview = Type.Object(
  {
    path: Type.String({ maxLength: 4096 }),
    revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    reviewed: Type.Boolean(),
    scope: Type.Optional(ReviewScope),
    workspace: WorkspaceId,
  },
  { additionalProperties: false },
);

/** A sign-in in progress, bridging Pi's prompt/notify interaction to HTTP polling and a paste endpoint. */
class SignInAttempt {
  state: "waiting" | "verifying" | "connected" | "failed" | "cancelled" = "waiting";
  authUrl: string | undefined;
  error: { code: string; message: string } | undefined;
  readonly #controller = new AbortController();
  #paste: ((url: string) => void) | undefined;
  readonly #announced = Promise.withResolvers<undefined>();

  readonly interaction: ProviderAuthInteraction = {
    signal: this.#controller.signal,
    notify: (event) => {
      if (event.type === "auth_url") {
        this.authUrl = event.url;
        this.#announced.resolve(undefined);
      } else if (event.type === "progress") {
        this.state = "verifying";
      }
    },
    prompt: (prompt) =>
      new Promise((resolve, reject) => {
        this.#paste = resolve;
        prompt.signal?.addEventListener("abort", () => reject(new Error("prompt closed")), { once: true });
      }),
  };

  get active(): boolean {
    return this.state === "waiting" || this.state === "verifying";
  }

  /** Resolves once the browser link exists, or the attempt has already ended. */
  announced(): Promise<void> {
    return this.#announced.promise;
  }

  paste(url: string): void {
    if (this.#paste === undefined)
      throw new HttpError(409, "not_waiting", "this sign-in is not waiting for an address");
    this.#paste(url);
  }

  cancel(): void {
    this.#controller.abort();
  }

  settle(outcome: { account: ChatGPTAccount } | { error: unknown }): void {
    if ("account" in outcome) {
      this.state = "connected";
    } else {
      const error = outcome.error;
      const code = error instanceof ChatGPTAuthError ? error.code : "failed";
      this.state = code === "cancelled" ? "cancelled" : "failed";
      this.error = { code, message: error instanceof Error ? error.message : String(error) };
    }
    this.#announced.resolve(undefined);
  }
}

/**
 * Pal's JSON API. Everything except health, session state, setup and sign-in requires the owner's session; every
 * state-changing request must come from Pal's own origin.
 */
export function createApi(pal: Pal, publicOrigin?: string, releases?: Pick<ReleaseRpc, "call">) {
  const parsedOrigin = publicOrigin === undefined ? undefined : URL.parse(publicOrigin);
  if (parsedOrigin === null) throw new Error("invalid public origin");
  const external = parsedOrigin;
  let attempt: SignInAttempt | undefined;
  let listing: { models: ChatGPTModel[] } | { error: string } | undefined;

  async function refreshListing(): Promise<void> {
    try {
      const models = await listChatGPTModels(pal.models);
      // Listing never chooses a default: new chats use a ChatGPT model only after the owner picks one.
      listing = { models };
    } catch (error) {
      listing = { error: (error as Error).message };
    }
  }

  async function chatgptState() {
    const account = await pal.chatgpt.account();
    if (account !== undefined && listing === undefined) await refreshListing();
    return {
      account: account ?? null,
      attempt:
        attempt === undefined
          ? null
          : { state: attempt.state, authUrl: attempt.authUrl ?? null, error: attempt.error ?? null },
      models: account !== undefined && listing !== undefined && "models" in listing ? listing.models : [],
      modelsError: account !== undefined && listing !== undefined && "error" in listing ? listing.error : null,
      model: (await pal.settings.model()) ?? null,
      default: (await pal.settings.defaultModel()) ?? null,
    };
  }

  /** A model a chat may switch to now: ChatGPT's, or one of an enabled API-key provider. Never a substitute. */
  async function chosenModel(provider: string, modelId: string) {
    if (provider !== CHATGPT_PROVIDER && !(isApiProvider(provider) && (await pal.providers.usable(provider)))) {
      throw new HttpError(409, "provider_unavailable", "that provider isn't enabled in Settings → Models");
    }
    const known = pal.models.getModel(provider, modelId);
    if (known === undefined) throw new HttpError(400, "unknown_model", "Pal does not know this model’s capabilities");
    return known;
  }

  async function providersView() {
    return { providers: await pal.providers.list(), default: (await pal.settings.defaultModel()) ?? null };
  }

  async function describeChat(chat: ChatSummary) {
    return {
      ...chat,
      workspace: (await pal.workspaces.info(chat.id)) ?? null,
      commandMode: await pal.approvals.mode(chat.id),
    };
  }

  /** What a scheduled run of this chat would cost and could do, shown before the owner approves a schedule. */
  async function scheduleNotice(
    chat: ChatSummary,
    agent: Awaited<ReturnType<Conversation["agent"]>>,
  ): Promise<ScheduleNotice> {
    const mode = await pal.approvals.mode(chat.id);
    const workspace = await pal.workspaces.info(chat.id);
    const model = agent.model;
    const known = model === undefined ? undefined : pal.models.getModel(model.provider, model.modelId);
    const effort = known === undefined ? "off" : clampThinkingLevel(known, agent.thinkingLevel);
    const provider =
      model === undefined || model.provider === CHATGPT_PROVIDER
        ? { name: "ChatGPT", billing: "Counts against your ChatGPT plan's usage limits." }
        : ((await pal.providers.list()).find((item) => item.id === model.provider) ?? {
            name: model.provider,
            billing: "Billed by this model's provider.",
          });
    return {
      configuration: chatConfiguration(agent),
      mode,
      model:
        model === undefined
          ? null
          : {
              provider: model.provider,
              providerName: provider.name,
              modelId: model.modelId,
              effort,
            },
      cost:
        model === undefined
          ? "This chat has no model yet. Choose one before scheduling."
          : `${provider.billing} Each run is one message, but it can make many model requests while it uses tools; Pal can't predict its size.`,
      effects: [
        mode === "full"
          ? "Full access: agent shell commands run on this host without asking, as the Pal host user."
          : "Ask for approval: each agent shell command waits for you and is declined if nobody answers within 2 minutes.",
        workspace?.mode === "read-only"
          ? "Read-only workspace: no file writes or agent shell commands."
          : "File changes in this chat's workspace happen without asking.",
        "Internet tools granted to this project can reach outside services without asking.",
        "If this chat's model or command mode changes, the schedule pauses until you review it again.",
      ],
    };
  }

  async function scheduleViews(schedules: ScheduleView[]) {
    return Promise.all(
      schedules.map(async (schedule) => ({ ...schedule, chat: (await pal.chats.get(schedule.chatId))?.title ?? null })),
    );
  }

  async function signedIn(request: IncomingMessage): Promise<boolean> {
    return pal.owner.authenticate(cookie(request, SESSION_COOKIE));
  }

  function setSession(response: ServerResponse, token: string, request: IncomingMessage): void {
    response.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${external?.protocol === "https:" && request.headers.host === external.host ? "; Secure" : ""}`,
    );
  }

  async function route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    const path = url.pathname.split("/").filter(Boolean).slice(1);
    const [resource, id, action] = path;
    const send = (status: number, body: unknown) => sendJson(request, response, status, body);
    if (method !== "GET" && method !== "HEAD" && !isOwnOrigin(request, external)) {
      throw new HttpError(403, "cross_origin", "requests must come from Pal's own page");
    }

    if (resource === "session" && path.length === 1 && method === "GET") {
      const exists = await pal.owner.exists();
      return send(200, { owner: exists, signedIn: exists && (await signedIn(request)) });
    }
    if (resource === "setup" && path.length === 1 && method === "POST") {
      const body = validate(Setup, await readJson(request));
      setSession(response, await pal.owner.setup(body.token, body.passphrase), request);
      return send(200, { signedIn: true });
    }
    if (resource === "sign-in" && path.length === 1 && method === "POST") {
      const body = validate(Passphrase, await readJson(request));
      setSession(response, await pal.owner.signIn(body.passphrase), request);
      return send(200, { signedIn: true });
    }
    if (!(await signedIn(request))) throw new HttpError(401, "signed_out", "sign in to Pal first");

    if (resource === "sign-out" && path.length === 1 && method === "POST") {
      pal.terminals.revoke(cookie(request, SESSION_COOKIE));
      pal.browsers.revoke(cookie(request, SESSION_COOKIE));
      revokeObservers(cookie(request, SESSION_COOKIE));
      await pal.owner.signOut(cookie(request, SESSION_COOKIE));
      response.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return send(200, { signedIn: false });
    }

    if (resource === "model-setup" && path.length === 1 && (method === "GET" || method === "PUT")) {
      if (method === "PUT")
        await pal.settings.setModelSetupDeferred(validate(ModelSetup, await readJson(request)).deferred);
      return send(200, { deferred: await pal.settings.modelSetupDeferred() });
    }

    if (resource === "releases") {
      if (path.length === 1 && method === "GET")
        return send(200, releases === undefined ? { available: false } : await releases.call("view"));
      if (releases === undefined)
        throw new HttpError(
          409,
          "release_unavailable",
          "Controlled activation requires the host's pal supervise launcher.",
        );
      const digest = validate(ReleaseDigest, id);
      if (path.length === 3 && action === "review" && method === "GET")
        return send(
          200,
          await releases.call("review", {
            digest,
            path: validate(Type.String({ minLength: 1, maxLength: 4096 }), url.searchParams.get("path")),
          }),
        );
      if (path.length === 3 && action === "approve" && method === "POST") {
        const body = validate(
          Type.Object({ acceptCodeTrust: Type.Literal(true) }, { additionalProperties: false }),
          await readJson(request, 4096),
        );
        return send(200, await releases.call("approve", { digest, ...body }));
      }
      if (path.length === 3 && (action === "activate" || action === "rollback") && method === "POST") {
        validate(Type.Object({}, { additionalProperties: false }), await readJson(request, 4096));
        if (attempt?.active)
          throw new HttpError(409, "release_busy", "Finish or cancel ChatGPT sign-in before restarting.");
        return send(202, await releases.call(action, { digest }));
      }
      throw new HttpError(404, "not_found", "no such release operation");
    }

    if (resource === "diagnostics" && path.length === 1 && method === "GET")
      return send(200, await installationDiagnostics(pal));

    if (resource === "scheduler" && path.length === 1) {
      if (method === "PUT") await pal.schedules.setEnabled(validate(Toggle, await readJson(request)).enabled);
      if (method === "GET" || method === "PUT")
        return send(200, {
          enabled: await pal.schedules.enabled(),
          schedules: await scheduleViews(await pal.schedules.list()),
        });
    }

    if (resource === "extensions" && path.length === 1) {
      if (method === "GET") return send(200, await pal.extensions.view());
      if (method === "PUT")
        return send(200, await pal.extensions.select(validate(ExtensionSelection, await readJson(request))));
    }

    if (resource === "chatgpt") {
      if (path.length === 1 && method === "GET") return send(200, await chatgptState());
      if (id === "sign-in" && action === undefined && method === "POST") {
        if (attempt?.active) throw new HttpError(409, "busy", "a ChatGPT sign-in is already in progress");
        const started = new SignInAttempt();
        attempt = started;
        pal.chatgpt.signIn(started.interaction).then(
          async (account) => {
            started.settle({ account });
            listing = undefined;
            await refreshListing();
          },
          (error: unknown) => started.settle({ error }),
        );
        await started.announced();
        return send(200, await chatgptState());
      }
      if (id === "sign-in" && action === "paste" && method === "POST") {
        if (!attempt?.active) throw new HttpError(409, "not_waiting", "no ChatGPT sign-in is waiting");
        attempt.paste(validate(Paste, await readJson(request)).url);
        return send(200, await chatgptState());
      }
      if (id === "sign-in" && action === undefined && method === "DELETE") {
        attempt?.cancel();
        return send(200, await chatgptState());
      }
      if (id === "sign-out" && method === "POST") {
        await pal.chatgpt.signOut();
        listing = undefined;
        return send(200, await chatgptState());
      }
      if (id === "model" && method === "PUT") {
        const { model } = validate(ModelChoice, await readJson(request));
        await pal.settings.setDefaultModel({ provider: CHATGPT_PROVIDER, modelId: model });
        return send(200, await chatgptState());
      }
    }

    if (resource === "providers") {
      if (path.length === 1 && method === "GET") return send(200, await providersView());
      if (id !== undefined && isApiProvider(id) && path.length === 3) {
        if (action === "key" && method === "PUT") {
          await pal.providers.setKey(id, validate(KeyBody, await readJson(request)).key);
          return send(200, await providersView());
        }
        if (action === "key" && method === "DELETE") {
          await pal.providers.setKey(id, null);
          return send(200, await providersView());
        }
        if (action === "enabled" && method === "PUT") {
          await pal.providers.setEnabled(id, validate(Toggle, await readJson(request)).enabled);
          return send(200, await providersView());
        }
        if (action === "check" && method === "POST") return send(200, { check: await pal.providers.check(id) });
        if (id === "compatible" && action === "config" && method === "PUT") {
          await pal.providers.setCompatible(validate(CompatibleBody, await readJson(request)));
          return send(200, await providersView());
        }
      }
    }
    if (resource === "default-model" && path.length === 1 && method === "PUT") {
      const { provider, model } = validate(DefaultModel, await readJson(request));
      await chosenModel(provider, model);
      await pal.settings.setDefaultModel({ provider, modelId: model });
      return send(200, await providersView());
    }

    if (resource === "mcp") {
      const [, , serverId, part] = path;
      const listing = async () => ({ review: await pal.mcp.reviewPending(), servers: await pal.mcp.list() });
      if (path.length === 1 && method === "GET") return send(200, await listing());
      if (id === "review" && method === "POST") {
        await pal.mcp.finishReview(validate(Review, await readJson(request)).enable);
        return send(200, await listing());
      }
      if (id === "servers" && serverId === undefined && method === "POST") {
        return send(200, { server: await pal.mcp.add(validate(McpServerBody, await readJson(request))) });
      }
      if (id === "servers" && serverId !== undefined) {
        if (part === undefined && method === "PUT") {
          return send(200, {
            server: await pal.mcp.update(serverId, validate(McpServerBody, await readJson(request))),
          });
        }
        if (part === undefined && method === "DELETE") {
          await pal.mcp.remove(serverId);
          return send(200, await listing());
        }
        if (part === "program" && method === "PUT") {
          const body = validate(ProgramApproval, await readJson(request));
          return send(200, { server: await pal.mcp.approveProgram(serverId, body.digest, body.approved) });
        }
        if (part === "key" && method === "PUT") {
          return send(200, { server: await pal.mcp.setKey(serverId, validate(KeyBody, await readJson(request)).key) });
        }
        if (part === "key" && method === "DELETE") return send(200, { server: await pal.mcp.setKey(serverId, null) });
        if (part === "fake-ip" && method === "PUT") {
          return send(200, {
            server: await pal.mcp.setFakeIp(serverId, validate(Toggle, await readJson(request)).enabled),
          });
        }
        if (part === "enabled" && method === "PUT") {
          const { enabled } = validate(Toggle, await readJson(request));
          return send(200, { server: await pal.mcp.setEnabled(serverId, enabled) });
        }
        if (part === "test" && method === "POST") return send(200, { server: await pal.mcp.test(serverId) });
        if (part === "tools" && method === "PUT") {
          const body = validate(CatalogApproval, await readJson(request));
          return send(200, { server: await pal.mcp.approve(serverId, body.tools, body.catalog) });
        }
      }
    }

    if (resource === "projects" && path.length === 1) {
      if (method === "GET") {
        const projects = await pal.projects.list();
        return send(200, {
          projects: await Promise.all(
            projects.map(async (project) => ({
              ...project,
              chats: await Promise.all((await pal.chats.list(project.id)).map(describeChat)),
            })),
          ),
        });
      }
      if (method === "POST") {
        const { requestId, ...body } = validate(Keyed, await readJson(request));
        return send(200, { project: await pal.projects.create(requestId, body) });
      }
    }
    if (resource === "projects" && id !== undefined && action === "folders") {
      if (path.length === 3 && method === "GET")
        return send(200, { folders: await pal.folders.list(id, workspaceQuery(url)) });
      if (path.length === 3 && method === "POST") {
        const { requestId, ...body } = validate(Keyed, await readJson(request));
        return send(200, { folder: await pal.folders.add(id, requestId, body) });
      }
      if (path.length === 4 && path[3] !== undefined && method === "DELETE") {
        await pal.folders.remove(id, path[3]);
        return send(200, { removed: true });
      }
    }
    if (resource === "projects" && id !== undefined && action === "mcp") {
      if (path.length === 3 && method === "GET") return send(200, await pal.mcp.grants.view(id));
      if (path.length === 4 && path[3] !== undefined && method === "PUT")
        return send(200, await pal.mcp.grants.set(id, path[3], await readJson(request)));
    }
    if (resource === "projects" && id !== undefined && action === "terminals") {
      if (path.length === 3 && method === "GET") return send(200, { terminals: await pal.terminals.list(id) });
      if (path.length === 3 && method === "POST") {
        const { cols, rows, workspace } = validate(NewTerminal, await readJson(request));
        return send(200, { terminal: await pal.terminals.create(id, { cols, rows }, workspace) });
      }
      if (path.length === 4 && path[3] !== undefined && method === "DELETE") {
        await pal.terminals.remove(id, path[3]);
        return send(200, { closed: true });
      }
    }
    if (resource === "projects" && id !== undefined && action === "browser") {
      if (path.length === 3 && method === "GET") return send(200, await pal.browsers.status(id));
      if (path.length === 4 && path[3] === "close" && method === "POST") {
        await pal.browsers.stop(id);
        return send(200, await pal.browsers.status(id));
      }
      if (path.length === 4 && path[3] === "profile" && method === "DELETE") {
        await pal.browsers.clear(id);
        return send(200, await pal.browsers.status(id));
      }
    }
    if (resource === "projects" && id !== undefined && (action === "files" || action === "file") && path.length === 3) {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "the Files panel is read-only");
      const relative = url.searchParams.get("path") ?? "";
      const folder = url.searchParams.get("folder") ?? undefined;
      if (relative.length > 4096) throw new HttpError(400, "invalid_request", "path is too long");
      try {
        return send(
          200,
          action === "files"
            ? await pal.files.list(id, relative, folder, workspaceQuery(url))
            : await pal.files.preview(id, relative, folder, workspaceQuery(url)),
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM")
          throw new FileAccessError(`Pal cannot read ${relative || "this folder"}`);
        throw error;
      }
    }
    if (resource === "projects" && id !== undefined && action === "changes" && path.length === 3 && method === "GET") {
      return send(
        200,
        await pal.changes.list(
          id,
          validate(ReviewScope, url.searchParams.get("scope") ?? "normal"),
          workspaceQuery(url),
        ),
      );
    }
    if (resource === "projects" && id !== undefined && action === "review" && path.length === 3 && method === "PUT") {
      const body = validate(FileReview, await readJson(request));
      await pal.changes.review(id, body.path, body.revision, body.reviewed, body.scope, body.workspace);
      return send(200, { reviewed: body.reviewed });
    }
    if (resource === "projects" && id !== undefined && action === "baseline" && path.length === 3 && method === "PUT") {
      const body = validate(BaselineMove, await readJson(request));
      await pal.changes.moveBaseline(id, body.from, body.to, body.workspace);
      return send(200, { base: body.to });
    }
    if (resource === "projects" && id !== undefined && action === "discard" && path.length === 3 && method === "POST") {
      const body = validate(FileDiscard, await readJson(request));
      await pal.changes.discard(id, body.path, body.revision, body.scope, body.workspace);
      return send(200, { discarded: true });
    }
    if (resource === "projects" && id !== undefined && action === "comments") {
      if (path.length === 3 && method === "POST") {
        const body = validate(FileComment, await readJson(request));
        return send(200, {
          comment: await pal.changes.comment(
            id,
            body.path,
            body.revision,
            body.line,
            body.body,
            body.scope,
            body.workspace,
          ),
        });
      }
      if (path.length === 4 && path[3] !== undefined && method === "DELETE") {
        await pal.changes.uncomment(id, path[3], workspaceQuery(url));
        return send(200, { deleted: true });
      }
    }
    if (resource === "projects" && id !== undefined && action === "memory") {
      const memoryId = path[3];
      if (path.length === 3 && method === "GET")
        return send(200, { items: await pal.memory.list(id, context, workspaceQuery(url)) });
      if (path.length === 3 && method === "POST") {
        const { requestId, workspace, ...body } = validate(NewMemory, await readJson(request));
        return send(200, { id: await pal.memory.save(id, requestId, body, context, workspace) });
      }
      if (memoryId !== undefined && path.length === 4 && method === "PUT") {
        const { revision, workspace, ...body } = validate(CorrectMemory, await readJson(request));
        await pal.memory.correct(id, memoryId, revision, body, context, workspace);
        return send(200, { saved: true });
      }
      if (memoryId !== undefined && path.length === 4 && method === "DELETE") {
        const { revision, workspace } = validate(ForgetMemory, await readJson(request));
        await pal.memory.forget(id, memoryId, revision, workspace);
        return send(200, { forgotten: true });
      }
      if (memoryId !== undefined && path.length === 5 && path[4] === "source" && method === "GET")
        return send(200, await pal.memory.source(id, memoryId, context, workspaceQuery(url)));
    }
    if (
      resource === "projects" &&
      id !== undefined &&
      action === "memory-index" &&
      path.length === 3 &&
      method === "POST"
    ) {
      await pal.memory.rebuild(id);
      return send(200, { rebuilt: true });
    }
    if (resource === "projects" && id !== undefined && action === "search" && path.length === 3 && method === "GET") {
      const folder = await pal.folders.owner(id, url.searchParams.get("folder") ?? undefined, workspaceQuery(url));
      const query = url.searchParams.get("q") ?? "";
      const mode = url.searchParams.get("mode") ?? "text";
      if (query.length > 500) throw new HttpError(400, "invalid_request", "the query is too long");
      if (mode !== "files" && mode !== "text" && mode !== "regex")
        throw new HttpError(400, "invalid_request", "unknown search mode");
      return send(200, await searchFolder(pal.search, folder, query, mode));
    }
    if (resource === "projects" && id !== undefined && action === undefined && method === "DELETE") {
      const removing = await pal.projects.get(id);
      await pal.projects.remove(id);
      await pal.workspaces.cancelProject(id);
      for (const root of await pal.workspaces.roots(id)) await pal.search.forget(root);
      await pal.folders.forgetProject(id);
      if (removing !== undefined) await pal.search.forget(removing.root);
      pal.mcp.revokeProject(id);
      // The project's browser profile holds its site logins; it goes with the project.
      await Promise.all([pal.terminals.removeProject(id), pal.chats.abortDeleted(context), pal.browsers.clear(id)]);
      return send(200, { removed: true });
    }
    if (resource === "projects" && id !== undefined && action === "uploads" && method === "POST") {
      const project = await pal.projects.get(id);
      if (project?.state !== "ready") throw new HttpError(404, "not_found", "no such ready project");
      return send(200, { upload: await pal.uploads.admit(id, validate(UploadBody, await readJson(request))) });
    }
    if (resource === "uploads" && id !== undefined && action === undefined && method === "PUT") {
      return send(200, { upload: await pal.uploads.receive(id, request) });
    }

    if (resource === "removed-workspaces") {
      if (path.length === 1 && method === "GET") return send(200, await pal.workspacePurge.list());
      if (id !== undefined && action === "purge" && path.length === 3 && method === "POST") {
        await pal.workspacePurge.purge(id, await readJson(request));
        return send(200, { deleted: true });
      }
    }

    if (resource === "folders" && path.length === 1 && method === "GET") {
      return send(200, await pal.projects.browse(url.searchParams.get("path") ?? undefined));
    }

    if (resource === "chats") {
      if (path.length === 1 && method === "POST") {
        const { requestId, ...body } = validate(Keyed, await readJson(request));
        const chat = await pal.chats.createChat(requestId, body, context);
        try {
          await pal.workspaces.provision(chat.id);
        } catch (error) {
          if (!(error instanceof HttpError && error.code === "workspace_busy")) throw error;
        }
        const summary = await pal.chats.get(chat.id);
        if (summary === undefined) throw new HttpError(404, "not_found", "the chat was removed");
        return send(200, { chat: await describeChat(summary) });
      }
      if (id !== undefined && action === undefined && method === "DELETE") {
        const workspace = await pal.workspaces.info(id);
        await pal.chats.remove(id, context);
        pal.workspaces.cancelChat(id);
        if (workspace?.mode === "worktree") await pal.search.forget(workspace.root);
        return send(200, { removed: true });
      }
      const chat = id === undefined ? undefined : await pal.chats.get(id);
      if (chat === undefined) throw new HttpError(404, "not_found", "no such chat");
      if (action === "title" && path.length === 3 && method === "PUT")
        return send(200, { chat: await describeChat(await pal.chats.rename(chat.id, await readJson(request))) });
      if (action === "command-mode" && path.length === 3 && method === "PUT") {
        await pal.approvals.setMode(chat.id, validate(CommandModeBody, await readJson(request)).mode);
        return send(200, { chat: await describeChat(chat) });
      }
      if (action === "diagnostics" && path.length === 3 && method === "GET")
        return send(200, {
          installation: await installationDiagnostics(pal),
          chat: await chatDiagnostics(pal, chat.id, chat.conversationId),
        });
      if (action === "approvals" && path.length === 3 && method === "GET")
        return send(200, await pal.approvals.view(chat.id));
      if (action === "approvals" && path.length === 4 && path[3] !== undefined && method === "POST") {
        const body = validate(ApprovalDecision, await readJson(request));
        await pal.approvals.decide(chat.id, path[3], body.decision, body.digest);
        return send(200, await pal.approvals.view(chat.id));
      }
      if (action === "workspace" && path.length === 3 && method === "POST") {
        await pal.workspaces.provision(chat.id);
        return send(200, { chat: await describeChat(chat) });
      }
      const conversation = await pal.harness.conversation(chat.conversationId, context);
      if (conversation === undefined) throw new HttpError(404, "not_found", "the chat's conversation is missing");
      if (action === undefined && method === "GET") {
        const agent = await conversation.agent(context);
        const model =
          agent.model === undefined ? undefined : pal.models.getModel(agent.model.provider, agent.model.modelId);
        return send(200, {
          chat: await describeChat(chat),
          model: agent.model?.modelId ?? null,
          provider: agent.model?.provider ?? null,
          effort: model === undefined ? "off" : clampThinkingLevel(model, agent.thinkingLevel),
          configuration: chatConfiguration(agent),
        });
      }
      if (action === "schedules") {
        const [, , , scheduleId, change] = path;
        if (path.length === 3 && method === "GET")
          return send(200, {
            enabled: await pal.schedules.enabled(),
            notice: await scheduleNotice(chat, await conversation.agent(context)),
            schedules: await pal.schedules.list(chat.id),
          });
        if (path.length === 3 && method === "POST") {
          const { requestId, ...body } = validate(Keyed, await readJson(request));
          return send(200, { schedule: await pal.schedules.create(chat.id, requestId, body) });
        }
        if (path.length === 5 && scheduleId !== undefined && method === "POST") {
          if (change === "pause") return send(200, { schedule: await pal.schedules.pause(chat.id, scheduleId) });
          if (change === "cancel") return send(200, { schedule: await pal.schedules.cancel(chat.id, scheduleId) });
          if (change === "resume")
            return send(200, {
              schedule: await pal.schedules.resume(chat.id, scheduleId, await readJson(request)),
            });
        }
      }
      if (action === "helpers" && path.length === 3 && method === "GET")
        return send(200, {
          helpers: await helperViews(pal.harness, pal.store.storage, chat.conversationId, context),
        });
      if (action === "extensions" && path.length === 3 && method === "GET")
        return send(200, {
          release: pal.extensions.release,
          selected: chat.extensions,
          requests: await pal.extensions.pins(chat.conversationId, pal.harness, context),
        });
      if (action === "instructions" && path.length === 3) {
        if (method === "PUT") await pal.instructions.configure(chat.conversationId, await readJson(request));
        if (method === "GET" || method === "PUT")
          return send(200, await pal.instructions.inspect(chat.conversationId, context));
      }
      if (action === "skills" && path.length === 3) {
        if (method === "PUT") await pal.skills.configure(chat.conversationId, await readJson(request));
        if (method === "GET" || method === "PUT")
          return send(200, await pal.skills.inspect(chat.conversationId, context));
      }
      if (action === "skills" && path.length === 4 && path[3] === "selection" && method === "PUT") {
        await pal.skills.select(chat.conversationId, await readJson(request), context);
        return send(200, await pal.skills.inspect(chat.conversationId, context));
      }
      if (action === "context" && path.length === 3 && method === "GET")
        return send(200, await pal.context.inspect(chat, context));
      if (action === "context" && path.length === 4) {
        if (path[3] === "instructions" && method === "PUT") {
          await pal.context.pin(chat, await readJson(request), context);
          return send(200, { saved: true });
        }
        if (path[3] === "prompt" && method === "GET")
          return send(
            200,
            await pal.context.prompt(
              chat,
              {
                offset: Number(url.searchParams.get("offset") ?? "0"),
                ...(url.searchParams.has("request") ? { request: url.searchParams.get("request") } : {}),
              },
              context,
            ),
          );
      }
      if (action === "inputs" && method === "POST") {
        const { requestId, ...body } = validate(Keyed, await readJson(request));
        // A chat on a disabled provider or a removed model stops here; it is never sent anywhere else instead.
        const chosen = (await conversation.agent(context)).model;
        const problem = chosen === undefined ? undefined : await pal.providers.problem(chosen);
        if (problem !== undefined) throw new HttpError(409, problem.code, problem.message);
        return send(200, { admission: await pal.chats.submit(chat.id, requestId, body, context) });
      }
      if (action === "stop" && method === "POST") {
        await conversation.abort(context);
        return send(200, { stopped: true });
      }
      if (action === "model" && method === "PUT") {
        const {
          model,
          provider = CHATGPT_PROVIDER,
          effort: requested,
          expected,
        } = validate(ChatModelChoice, await readJson(request));
        const known = await chosenModel(provider, model);
        const effort = clampThinkingLevel(known, requested ?? (await conversation.agent(context)).thinkingLevel);
        const configuration = await pal.chats.configure(
          chat.id,
          {
            model: { provider, modelId: model },
            thinkingLevel: effort,
            ...(expected === undefined ? {} : { expected }),
          },
          context,
        );
        return send(200, { chat: await describeChat(chat), model, provider, effort, configuration });
      }
      if (action === "events" && method === "GET")
        return observe(response, chat.id, chat.conversationId, cookie(request, SESSION_COOKIE));
    }
    throw new HttpError(404, "not_found", "no such API route");
  }

  /** Live event streams by their end function, each bound to the owner session that opened it. */
  const observers = new Map<(revoked: boolean) => void, string | undefined>();
  /** Sign-out revokes this session's event streams like its terminals and browser views. */
  function revokeObservers(token: string | undefined) {
    for (const [end, owner] of observers) if (owner === token) end(true);
  }

  /**
   * Server-sent events: the conversation's snapshot, then one event batch per commit until the client leaves, the
   * owner session ends or expires, or the stream closes. The chat's command approvals arrive as whole `approvals`
   * views, first with the snapshot and again on every change. Cleanup is registered before the first write, and a
   * write blocked by backpressure also ends when the stream does, so a vanished client never holds the handler.
   */
  async function observe(
    response: ServerResponse,
    chatId: string,
    conversationId: Parameters<typeof watchEvents>[1],
    token: string | undefined,
  ): Promise<void> {
    const expiry = await pal.owner.sessionExpiry(token);
    if (expiry === undefined) throw new HttpError(401, "signed_out", "sign in to Pal first");
    const scope = new AbortController();
    // What `end` must release, filled in as the stream starts.
    const live: {
      stream?: Awaited<ReturnType<typeof watchEvents>>;
      heartbeat?: ReturnType<typeof setInterval>;
      unwatch?: () => void;
    } = {};
    // Idempotent: revocation and expiry drop anything still buffered; a finished stream flushes it.
    const end = (revoked: boolean) => {
      if (scope.signal.aborted) return;
      scope.abort();
      observers.delete(end);
      clearTimeout(expiryTimer);
      clearInterval(live.heartbeat);
      live.unwatch?.();
      void live.stream?.stop();
      if (revoked) response.destroy();
      else if (!response.writableEnded) response.end();
    };
    const expiryTimer = setTimeout(() => end(true), Math.min(Math.max(0, expiry - Date.now()), 2 ** 31 - 1));
    expiryTimer.unref();
    observers.set(end, token);
    // The response closes when the connection does, whether or not the request body was ever read.
    response.once("close", () => end(true));
    response.once("error", () => end(true));

    const stream = await watchEvents(pal.harness, conversationId, context);
    live.stream = stream;
    if (scope.signal.aborted) {
      void stream.stop();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    const write = async (event: string, data: unknown) => {
      if (scope.signal.aborted) return;
      if (!response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
        await once(response, "drain", { signal: scope.signal }).catch(() => undefined);
      }
    };
    await write("snapshot", stream.snapshot);
    if (scope.signal.aborted) return;
    // Views are written in order; a change during a write is folded into the next one.
    let approvals: Promise<void> = Promise.resolve();
    let dirty = false;
    const sendApprovals = () => {
      if (dirty) return;
      dirty = true;
      approvals = approvals.then(async () => {
        dirty = false;
        try {
          if (!scope.signal.aborted) await write("approvals", await pal.approvals.view(chatId));
        } catch {
          // A removed chat or a closed response ends the view; the event stream closes on its own.
        }
      });
    };
    live.unwatch = pal.approvals.watch(chatId, sendApprovals);
    sendApprovals();
    // A keep-alive is pointless while output is already waiting to drain.
    live.heartbeat = setInterval(() => {
      if (!scope.signal.aborted && !response.writableNeedDrain) response.write(": keep-alive\n\n");
    }, HEARTBEAT_MS);
    stream.start(async (events: readonly AgentEvent[]) => {
      // An overflowed watch replaces its undelivered batches with a snapshot, which the client applies as a reset.
      for (const event of events) await write(event.type === "snapshot" ? "snapshot" : "event", event);
    });
    void stream.closed.then(() => end(false));
  }

  const unavailable = new HttpError(
    503,
    "runtime_unavailable",
    "Pal's durable runtime is unavailable. Restart to reconcile committed work.",
  );
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    try {
      if (pal.status !== "ready") throw unavailable;
      await route(request, response, url);
    } catch (error) {
      const failure = pal.status === "ready" ? error : unavailable;
      const [status, code] = classify(failure);
      if (status >= 500 && failure !== unavailable) console.error(failure);
      if (!response.headersSent) {
        sendJson(request, response, status, { error: code, message: (failure as Error).message });
      } else {
        response.end();
      }
    }
  };
}

function classify(error: unknown): [number, string] {
  if (error instanceof HttpError) return [error.status, error.code];
  if (error instanceof InvalidRequest) return [400, "invalid_request"];
  if (error instanceof RequestConflict) return [409, "request_conflict"];
  if (error instanceof ChatNotFound) return [404, "not_found"];
  if (error instanceof ProjectUnavailable) return [409, "project_unavailable"];
  if (error instanceof FolderError) return [422, `folder_${error.code}`];
  if (error instanceof AdmissionStopped) return [503, "admission_stopped"];
  if (error instanceof McpConfigError || error instanceof StdioConfigError) return [400, "mcp_config"];
  if (error instanceof ProviderConfigError) return [400, "provider_config"];
  if (error instanceof FileAccessError) return [403, "file_access"];
  if (error instanceof SearchError) return [422, "search_unavailable"];
  if (error instanceof WorkspaceBusy) return [409, "workspace_busy"];
  if (error instanceof UploadError) {
    const status = { not_found: 404, too_large: 413, size_mismatch: 400, not_receiving: 409, not_ready: 409 };
    return [status[error.code], `upload_${error.code}`];
  }
  if (error instanceof ChatGPTAuthError) return [400, `chatgpt_${error.code}`];
  if (error instanceof OwnerError) {
    const status = { exists: 409, invalid_setup: 403, weak_passphrase: 400, wrong_passphrase: 401, throttled: 429 };
    return [status[error.code], error.code];
  }
  return [500, "internal"];
}
