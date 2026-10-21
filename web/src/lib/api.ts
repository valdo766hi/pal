// Typed calls to Pal's API. Shapes mirror src/core/api.ts responses.
import type { ReviewScope } from "../../../src/core/changes.ts";
import type { WorkspaceMode } from "../../../src/core/workspaces.ts";
import type { ExtensionScope, ExtensionView, ExtensionRequestPin } from "../../../src/core/extensions.ts";
export type { ExtensionScope, ExtensionView };
import type { ReleaseView, ReleaseReview } from "../../../src/core/supervise.ts";
export type { ReleaseView, ReleaseReview };
import type { McpServerInput, McpServerView as McpServer } from "../../../src/pi/mcp.ts";
export type { McpAuth, McpState } from "../../../src/pi/mcp.ts";
export type { McpServer, McpServerInput };

import type { Admission } from "../../../src/core/chats.ts";
export type { Admission };

export type Session = { owner: boolean; signedIn: boolean };
export type { Change, ChangeComment, ChangeSet } from "../../../src/core/changes.ts";
export type { TerminalInfo } from "../../../src/core/terminals.ts";
export type { RemovedWorkspace } from "../../../src/core/workspace-purge.ts";
export type { ProjectMcp, ProjectMcpServer } from "../../../src/core/mcp-grants.ts";
export type { GrantedFolder } from "../../../src/core/folders.ts";
export type { Workspace, WorkspaceMode } from "../../../src/core/workspaces.ts";
export type { MemoryItem, MemoryInput } from "../../../src/core/memory.ts";
export type { ContextInfo, PromptInfo } from "../../../src/core/context.ts";
import type { InstructionInfo, InstructionSettings } from "../../../src/core/instructions.ts";
export type { InstructionInfo, InstructionSettings };
import type { SkillInfo, SkillSettings } from "../../../src/core/skills.ts";
export type { SkillInfo, SkillSettings };
export type { ApprovalView, CommandApproval, CommandMode } from "../../../src/core/approvals.ts";
export type { CompatibleConfig, KeyCheck, ProviderModel, ProviderView } from "../../../src/pi/providers.ts";
export type ModelRef = { provider: string; modelId: string };
export type ProvidersState = {
  providers: import("../../../src/pi/providers.ts").ProviderView[];
  default: ModelRef | null;
};

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ChatGPTModel = { slug: string; displayName: string; supported: boolean; efforts: Effort[] };
export type SignInState = "waiting" | "verifying" | "connected" | "failed" | "cancelled";
export type ChatGPTState = {
  account: { accountId: string; email?: string } | null;
  attempt: { state: SignInState; authUrl: string | null; error: { code: string; message: string } | null } | null;
  models: ChatGPTModel[];
  modelsError: string | null;
  model: string | null;
  /** The model new chats start with, which may belong to another enabled provider. */
  default: ModelRef | null;
};

export type Upload = { id: string; name: string; size: number; mediaType: string; state: "receiving" | "ready" };
export type ChatSummary = {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: number;
  workspace?: import("../../../src/core/workspaces.ts").Workspace | null;
  commandMode?: import("../../../src/core/approvals.ts").CommandMode;
  extensions: ExtensionScope["selected"];
};

const inWorkspace = (path: string, id?: string) => {
  if (id === undefined) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}workspace=${encodeURIComponent(id)}`;
};
export type Project = {
  id: string;
  name: string;
  mode: "managed" | "existing";
  state: "provisioning" | "ready" | "failed";
  root: string;
  error?: string;
  createdAt: number;
  chats: ChatSummary[];
};
export type FolderListing = {
  path: string;
  parent?: string;
  entries: { name: string; path: string; git: boolean }[];
  truncated: boolean;
  problem?: "denied" | "missing" | "not_directory";
};

export type McpListing = { review: boolean; servers: McpServer[] };

/** One folder of a project, as the Files panel shows it. */
export type ProjectFolder = {
  path: string;
  parent?: string;
  entries: import("../../../src/core/files.ts").FolderEntry[];
  omitted: number;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Called when the server says the owner's session ended, so the app can show sign-in again. */
export const signedOut = new EventTarget();

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    cache: "no-store",
    signal: signal ?? null,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch((error: unknown) => {
    if (response.ok) throw error;
    return {};
  })) as { error?: string; message?: string };
  if (!response.ok) {
    if (response.status === 401 && data.error === "signed_out") signedOut.dispatchEvent(new Event("signed-out"));
    throw new ApiError(response.status, data.error ?? "error", data.message ?? `HTTP ${response.status}`);
  }
  return data as T;
}

/** A fresh idempotency key: retrying the same request reuses it, so the server admits it once. */
// getRandomValues also works on HTTP over a private access layer, where randomUUID is unavailable.
export const requestId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const api = {
  skills: (id: string, signal?: AbortSignal) => call<SkillInfo>("GET", `chats/${id}/skills`, undefined, signal),
  configureSkills: (id: string, settings: SkillSettings) => call<SkillInfo>("PUT", `chats/${id}/skills`, settings),
  selectSkills: (id: string, revision: number, skills: { id: string; revision: string }[]) =>
    call<SkillInfo>("PUT", `chats/${id}/skills/selection`, { revision, skills }),
  instructions: (id: string, signal?: AbortSignal) =>
    call<InstructionInfo>("GET", `chats/${id}/instructions`, undefined, signal),
  configureInstructions: (id: string, settings: InstructionSettings) =>
    call<InstructionInfo>("PUT", `chats/${id}/instructions`, settings),
  releases: () => call<ReleaseView>("GET", "releases"),
  releaseReview: (digest: string, path: string) =>
    call<ReleaseReview>("GET", `releases/${digest}/review?path=${encodeURIComponent(path)}`),
  approveRelease: (digest: string) =>
    call<{ approved: string }>("POST", `releases/${digest}/approve`, { acceptCodeTrust: true }),
  activateRelease: (digest: string) => call<{ restarting: true }>("POST", `releases/${digest}/activate`, {}),
  rollbackRelease: (digest: string) => call<{ restarting: true }>("POST", `releases/${digest}/rollback`, {}),
  extensions: () => call<ExtensionView>("GET", "extensions"),
  chatExtensions: (id: string) =>
    call<{ release: string; selected: ExtensionScope["selected"]; requests: ExtensionRequestPin[] }>(
      "GET",
      `chats/${id}/extensions`,
    ),
  selectExtensions: (selected: ExtensionScope["selected"], digest: string) =>
    call<ExtensionView>("PUT", "extensions", { selected, digest }),
  session: () => call<Session>("GET", "session"),
  setup: (token: string, passphrase: string) => call<{ signedIn: true }>("POST", "setup", { token, passphrase }),
  signIn: (passphrase: string) => call<{ signedIn: true }>("POST", "sign-in", { passphrase }),
  signOut: () => call<{ signedIn: false }>("POST", "sign-out"),

  chatgpt: () => call<ChatGPTState>("GET", "chatgpt"),
  chatgptSignIn: () => call<ChatGPTState>("POST", "chatgpt/sign-in"),
  chatgptPaste: (url: string) => call<ChatGPTState>("POST", "chatgpt/sign-in/paste", { url }),
  chatgptCancel: () => call<ChatGPTState>("DELETE", "chatgpt/sign-in"),
  chatgptSignOut: () => call<ChatGPTState>("POST", "chatgpt/sign-out"),
  providers: () => call<ProvidersState>("GET", "providers"),
  providerKey: (id: string, key: string | null) =>
    key === null
      ? call<ProvidersState>("DELETE", `providers/${id}/key`)
      : call<ProvidersState>("PUT", `providers/${id}/key`, { key }),
  providerEnabled: (id: string, enabled: boolean) =>
    call<ProvidersState>("PUT", `providers/${id}/enabled`, { enabled }),
  providerCompatible: (config: import("../../../src/pi/providers.ts").CompatibleConfig) =>
    call<ProvidersState>("PUT", "providers/compatible/config", config),
  providerCheck: (id: string) =>
    call<{ check: import("../../../src/pi/providers.ts").KeyCheck }>("POST", `providers/${id}/check`),
  setDefault: (provider: string, model: string) => call<ProvidersState>("PUT", "default-model", { provider, model }),

  projects: () => call<{ projects: Project[] }>("GET", "projects"),
  createProject: (key: string, name: string, folder?: string) =>
    call<{ project: Project }>("POST", "projects", {
      requestId: key,
      name,
      ...(folder === undefined ? {} : { folder }),
    }),
  projectMcp: (id: string) => call<import("../../../src/core/mcp-grants.ts").ProjectMcp>("GET", `projects/${id}/mcp`),
  setProjectMcp: (project: string, server: string, revision: string, mode: "inherit" | "subset", tools: string[]) =>
    call<import("../../../src/core/mcp-grants.ts").ProjectMcp>("PUT", `projects/${project}/mcp/${server}`, {
      revision,
      mode,
      tools,
    }),
  changes: (id: string, scope: ReviewScope = "normal", workspace?: string) =>
    call<import("../../../src/core/changes.ts").ChangeSet>(
      "GET",
      inWorkspace(`projects/${id}/changes?scope=${scope}`, workspace),
    ),
  context: (id: string) => call<import("../../../src/core/context.ts").ContextInfo>("GET", `chats/${id}/context`),
  pinInstructions: (id: string, revision: number, text: string) =>
    call<{ saved: boolean }>("PUT", `chats/${id}/context/instructions`, { revision, text }),
  contextPrompt: (id: string, offset = 0, request?: string) =>
    call<import("../../../src/core/context.ts").PromptInfo>(
      "GET",
      `chats/${id}/context/prompt?offset=${offset}${request === undefined ? "" : `&request=${encodeURIComponent(request)}`}`,
    ),
  memory: (id: string, workspace?: string) =>
    call<{ items: import("../../../src/core/memory.ts").MemoryItem[] }>(
      "GET",
      inWorkspace(`projects/${id}/memory`, workspace),
    ),
  memorySave: (id: string, key: string, input: import("../../../src/core/memory.ts").MemoryInput, workspace?: string) =>
    call<{ id: string }>("POST", `projects/${id}/memory`, { ...input, requestId: key, workspace }),
  memoryCorrect: (
    project: string,
    id: string,
    revision: number,
    input: import("../../../src/core/memory.ts").MemoryInput,
    workspace?: string,
  ) => call<{ saved: true }>("PUT", `projects/${project}/memory/${id}`, { ...input, revision, workspace }),
  memoryForget: (project: string, id: string, revision: number, workspace?: string) =>
    call<{ forgotten: true }>("DELETE", `projects/${project}/memory/${id}`, { revision, workspace }),
  memorySource: (project: string, id: string, workspace?: string) =>
    call<Awaited<ReturnType<import("../../../src/core/memory.ts").ProjectMemory["source"]>>>(
      "GET",
      inWorkspace(`projects/${project}/memory/${id}/source`, workspace),
    ),
  memoryRebuild: (id: string) => call<{ rebuilt: true }>("POST", `projects/${id}/memory-index`),
  projectFolders: (id: string, workspace?: string) =>
    call<{ folders: import("../../../src/core/folders.ts").GrantedFolder[] }>(
      "GET",
      inWorkspace(`projects/${id}/folders`, workspace),
    ),
  addFolder: (id: string, key: string, folder: string, indexed: boolean) =>
    call<{ folder: import("../../../src/core/folders.ts").GrantedFolder }>("POST", `projects/${id}/folders`, {
      requestId: key,
      folder,
      indexed,
    }),
  removeFolder: (project: string, id: string) => call<{ removed: true }>("DELETE", `projects/${project}/folders/${id}`),
  files: (id: string, path: string, folder = "primary", workspace?: string) =>
    call<ProjectFolder>(
      "GET",
      inWorkspace(
        `projects/${id}/files?path=${encodeURIComponent(path)}&folder=${encodeURIComponent(folder)}`,
        workspace,
      ),
    ),
  search: (id: string, query: string, mode: "text" | "regex" | "files", folder = "primary", workspace?: string) =>
    call<import("../../../src/core/search.ts").SearchResults>(
      "GET",
      inWorkspace(
        `projects/${id}/search?q=${encodeURIComponent(query)}&mode=${mode}&folder=${encodeURIComponent(folder)}`,
        workspace,
      ),
    ),
  file: (id: string, path: string, folder = "primary", workspace?: string) =>
    call<import("../../../src/core/files.ts").FilePreview>(
      "GET",
      inWorkspace(
        `projects/${id}/file?path=${encodeURIComponent(path)}&folder=${encodeURIComponent(folder)}`,
        workspace,
      ),
    ),
  moveBaseline: (id: string, from: string | null, to: string, workspace?: string) =>
    call<{ base: string }>("PUT", `projects/${id}/baseline`, { from, to, workspace }),
  discard: (id: string, path: string, revision: string, scope: ReviewScope = "normal", workspace?: string) =>
    call<{ discarded: true }>("POST", `projects/${id}/discard`, { path, revision, scope, workspace }),
  comment: (
    id: string,
    path: string,
    revision: string,
    line: number,
    body: string,
    scope: ReviewScope = "normal",
    workspace?: string,
  ) =>
    call<{ comment: import("../../../src/core/changes.ts").ChangeComment }>("POST", `projects/${id}/comments`, {
      path,
      revision,
      line,
      body,
      scope,
      workspace,
    }),
  uncomment: (id: string, comment: string, workspace?: string) =>
    call<{ deleted: true }>("DELETE", inWorkspace(`projects/${id}/comments/${comment}`, workspace)),
  review: (
    id: string,
    path: string,
    revision: string,
    reviewed: boolean,
    scope: ReviewScope = "normal",
    workspace?: string,
  ) => call<{ reviewed: boolean }>("PUT", `projects/${id}/review`, { path, revision, reviewed, scope, workspace }),
  terminals: (id: string) =>
    call<{ terminals: import("../../../src/core/terminals.ts").TerminalInfo[] }>("GET", `projects/${id}/terminals`),
  newTerminal: (id: string, workspace?: string) =>
    call<{ terminal: import("../../../src/core/terminals.ts").TerminalInfo }>("POST", `projects/${id}/terminals`, {
      cols: 80,
      rows: 24,
      trust: true,
      workspace,
    }),
  closeTerminal: (project: string, id: string) =>
    call<{ closed: true }>("DELETE", `projects/${project}/terminals/${id}`),
  removeProject: (id: string) => call<{ removed: true }>("DELETE", `projects/${id}`),
  browser: (project: string) => call<{ available: boolean; running: boolean }>("GET", `projects/${project}/browser`),
  closeBrowser: (project: string) =>
    call<{ available: boolean; running: boolean }>("POST", `projects/${project}/browser/close`),
  clearBrowser: (project: string) =>
    call<{ available: boolean; running: boolean }>("DELETE", `projects/${project}/browser/profile`),
  removedWorkspaces: () =>
    call<{ workspaces: import("../../../src/core/workspace-purge.ts").RemovedWorkspace[]; truncated: boolean }>(
      "GET",
      "removed-workspaces",
    ),
  purgeWorkspace: (id: string, root: string, identity: string) =>
    call<{ deleted: true }>("POST", `removed-workspaces/${id}/purge`, { root, identity }),
  folders: (path?: string) =>
    call<FolderListing>("GET", `folders${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`),

  createChat: (key: string, projectId: string, workspace: WorkspaceMode = "local") =>
    call<{ chat: ChatSummary }>("POST", "chats", { requestId: key, projectId, workspace }),
  prepareWorkspace: (id: string) => call<{ chat: ChatSummary }>("POST", `chats/${id}/workspace`, {}),
  deleteChat: (id: string) => call<{ removed: true }>("DELETE", `chats/${id}`),
  chat: (id: string) =>
    call<{ chat: ChatSummary; model: string | null; provider: string | null; effort: Effort; configuration: string }>(
      "GET",
      `chats/${id}`,
    ),
  send: (
    id: string,
    key: string,
    text: string,
    whenBusy: "followUp" | "steer",
    attachments: readonly string[],
    configuration: string,
    signal?: AbortSignal,
    feedback?: import("../../../src/core/feedback.ts").ReviewFeedback,
  ) =>
    call<{ admission: Admission }>(
      "POST",
      `chats/${id}/inputs`,
      {
        requestId: key,
        text,
        whenBusy,
        configuration,
        feedback,
        ...(attachments.length === 0 ? {} : { attachments }),
      },
      signal,
    ),
  /** Admit an upload, then stream its bytes; the server checks size and hashes while receiving. */
  upload: async (projectId: string, file: File, signal?: AbortSignal): Promise<Upload> => {
    const { upload } = await call<{ upload: Upload }>(
      "POST",
      `projects/${projectId}/uploads`,
      {
        name: file.name,
        size: file.size,
        type: file.type,
      },
      signal,
    );
    const response = await fetch(`/api/uploads/${upload.id}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: file,
      signal: signal ?? null,
    });
    const data = (await response.json()) as { upload?: Upload; error?: string; message?: string };
    if (!response.ok || data.upload === undefined) {
      throw new ApiError(response.status, data.error ?? "error", data.message ?? `HTTP ${response.status}`);
    }
    return data.upload;
  },
  stop: (id: string) => call<{ stopped: true }>("POST", `chats/${id}/stop`),
  diagnostics: () => call<Record<string, unknown>>("GET", "diagnostics"),
  chatDiagnostics: (id: string) => call<Record<string, unknown>>("GET", `chats/${id}/diagnostics`),
  renameChat: (id: string, title: string, expectedTitle: string | null) =>
    call<{ chat: ChatSummary }>("PUT", `chats/${id}/title`, { title, expectedTitle }),
  setCommandMode: (id: string, mode: import("../../../src/core/approvals.ts").CommandMode) =>
    call<{ chat: ChatSummary }>("PUT", `chats/${id}/command-mode`, { mode }),
  decideCommand: (id: string, approval: string, decision: "approve" | "deny", digest: string) =>
    call<import("../../../src/core/approvals.ts").ApprovalView>("POST", `chats/${id}/approvals/${approval}`, {
      decision,
      digest,
    }),
  setChatModel: (id: string, model: string, effort?: Effort, provider?: string, expected?: string) =>
    call<{ model: string; provider: string; effort: Effort; configuration: string }>("PUT", `chats/${id}/model`, {
      model,
      effort,
      provider,
      expected,
    }),

  mcp: () => call<McpListing>("GET", "mcp"),
  mcpReview: (enable: boolean) => call<McpListing>("POST", "mcp/review", { enable }),
  mcpAdd: (input: McpServerInput) => call<{ server: McpServer }>("POST", "mcp/servers", input),
  mcpUpdate: (id: string, input: McpServerInput) => call<{ server: McpServer }>("PUT", `mcp/servers/${id}`, input),
  mcpProgram: (id: string, digest: string, approved: boolean) =>
    call<{ server: McpServer }>("PUT", `mcp/servers/${id}/program`, { digest, approved }),
  mcpRemove: (id: string) => call<McpListing>("DELETE", `mcp/servers/${id}`),
  mcpKey: (id: string, key: string | null) =>
    call<{ server: McpServer }>(
      key === null ? "DELETE" : "PUT",
      `mcp/servers/${id}/key`,
      key === null ? undefined : { key },
    ),
  mcpEnabled: (id: string, enabled: boolean) =>
    call<{ server: McpServer }>("PUT", `mcp/servers/${id}/enabled`, { enabled }),
  mcpFakeIp: (id: string, enabled: boolean) =>
    call<{ server: McpServer }>("PUT", `mcp/servers/${id}/fake-ip`, { enabled }),
  mcpTest: (id: string) => call<{ server: McpServer }>("POST", `mcp/servers/${id}/test`),
  mcpTools: (id: string, tools: string[], catalog: string) =>
    call<{ server: McpServer }>("PUT", `mcp/servers/${id}/tools`, { tools, catalog }),
};
