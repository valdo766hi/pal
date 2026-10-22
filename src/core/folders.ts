import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  LiveDoc,
  type Storage,
  type TaskId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import type { HelperLinks } from "./delegation.ts";
import { FileAccessError } from "./files.ts";
import type { Projects } from "./projects.ts";
import type { ProjectSearch } from "./search.ts";
import { normalize, RequestConflict, validate } from "./requests.ts";
import { directoryIdentity } from "./workspace-root.ts";
import type { Workspaces } from "./workspaces.ts";

const MAX_REFERENCES = 8;
const ReferenceBody = Type.Object(
  { folder: Type.String({ minLength: 1, maxLength: 4096 }), indexed: Type.Boolean() },
  { additionalProperties: false },
);
const Scope = Type.Object(
  {
    primary: Type.String(),
    references: Type.Array(Type.String(), { maxItems: MAX_REFERENCES }),
    workspace: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);

export type GrantedFolder = {
  readonly id: string;
  readonly root: string;
  readonly access: "write" | "read";
  readonly indexed: boolean;
  readonly instructions: "untrusted";
};

/** Authority is checked again after I/O, before delivering a result or committing a write. */
export type FolderLease = GrantedFolder & { check(): Promise<void> };

type Reference = {
  id: string;
  root: string;
  identity: string;
  indexed: number;
  digest: string;
  revoked_at: number | null;
};

/** Immutable read-only grants. Removing and re-adding a folder never revives an earlier run's authority. */
export class FolderGrants {
  readonly database: SqliteDatabase;
  readonly projects: Projects;
  readonly storage: Storage;
  readonly search: ProjectSearch;
  readonly forbidden: readonly string[];
  readonly workspaces: Workspaces | undefined;
  readonly links: Pick<HelperLinks, "parent"> | undefined;

  constructor(
    database: SqliteDatabase,
    projects: Projects,
    storage: Storage,
    search: ProjectSearch,
    forbidden: readonly string[],
    workspaces?: Workspaces,
    links?: Pick<HelperLinks, "parent">,
  ) {
    this.database = database;
    this.projects = projects;
    this.storage = storage;
    this.search = search;
    this.forbidden = forbidden;
    this.workspaces = workspaces;
    this.links = links;
  }

  async list(projectId: string, workspaceId?: string): Promise<GrantedFolder[]> {
    const lease = await this.#lease(projectId, "primary", undefined, workspaceId);
    await lease.check();
    // Read grants last: identity checks can yield while a reference is revoked.
    const rows = await this.database.all<{ id: string | null; root: string | null; indexed: number | null }>(
      "SELECT g.id, g.root, g.indexed FROM pal_projects p LEFT JOIN pal_folder_grants g ON g.project_id = p.id AND g.revoked_at IS NULL WHERE p.id = ? AND p.state = 'ready' AND p.removed_at IS NULL AND (? IS NULL OR EXISTS (SELECT 1 FROM pal_workspaces w JOIN pal_chats c ON c.id = w.chat_id WHERE w.id = ? AND w.project_id = p.id AND w.state = 'ready' AND c.deleted_at IS NULL)) ORDER BY g.rowid",
      projectId,
      workspaceId ?? null,
      workspaceId ?? null,
    );
    if (rows.length === 0) throw new FileAccessError("workspace authority was revoked");
    return [
      { ...primary(lease.root), access: lease.access },
      ...rows.flatMap((row) =>
        row.id === null || row.root === null || row.indexed === null
          ? []
          : [reference({ id: row.id, root: row.root, indexed: row.indexed })],
      ),
    ];
  }

  async add(projectId: string, requestId: unknown, body: unknown): Promise<GrantedFolder> {
    const { key, digest } = normalize(requestId, ReferenceBody, body, (value) => value);
    const prior = await this.database.get<Reference>(
      "SELECT * FROM pal_folder_grants WHERE project_id = ? AND request_id = ?",
      projectId,
      key,
    );
    await this.#project(projectId);
    if (prior !== undefined) return this.#retry(prior, digest);
    const input = body as { folder: string; indexed: boolean };
    const root = await this.projects.existingFolder(input.folder);
    if (this.forbidden.some((path) => overlaps(root, path)))
      throw new FileAccessError("a reference folder must not contain Pal's data, installation or the Nix store");
    const identity = await directoryIdentity(root);
    return this.database.transaction(async (tx) => {
      const project = await tx.get<{ root: string }>(
        "SELECT root FROM pal_projects WHERE id = ? AND state = 'ready' AND removed_at IS NULL",
        projectId,
      );
      if (project === undefined) throw new FileAccessError("no such ready project");
      if (overlaps(project.root, root))
        throw new FileAccessError("reference folders must not overlap the writable workspace");
      const raced = await tx.get<Reference>(
        "SELECT * FROM pal_folder_grants WHERE project_id = ? AND request_id = ?",
        projectId,
        key,
      );
      if (raced !== undefined) return this.#retry(raced, digest);
      const active = await tx.all<{ root: string }>(
        "SELECT root FROM pal_folder_grants WHERE project_id = ? AND revoked_at IS NULL",
        projectId,
      );
      if (active.length >= MAX_REFERENCES)
        throw new FileAccessError(`at most ${MAX_REFERENCES} reference folders per project`);
      if (active.some((entry) => overlaps(entry.root, root)))
        throw new FileAccessError("this reference overlaps an existing grant");
      const id = randomUUID();
      await tx.run(
        "INSERT INTO pal_folder_grants (id, project_id, request_id, digest, root, identity, indexed) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        projectId,
        key,
        digest,
        root,
        identity,
        Number(input.indexed),
      );
      return reference({ id, root, indexed: Number(input.indexed) });
    });
  }

  async remove(projectId: string, id: string): Promise<void> {
    await this.#project(projectId);
    if (id === "primary") throw new FileAccessError("the primary workspace is not a removable reference grant");
    const row = await this.database.get<{ root: string }>(
      "SELECT root FROM pal_folder_grants WHERE project_id = ? AND id = ?",
      projectId,
      id,
    );
    await this.database.run(
      "UPDATE pal_folder_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE project_id = ? AND id = ?",
      Date.now(),
      projectId,
      id,
    );
    if (row !== undefined) await this.search.forget(row.root);
  }

  async forgetProject(projectId: string): Promise<void> {
    const rows = await this.database.all<{ root: string }>(
      "SELECT root FROM pal_folder_grants WHERE project_id = ? AND revoked_at IS NULL",
      projectId,
    );
    await Promise.all(rows.map(({ root }) => this.search.forget(root)));
  }

  /** Frozen at input admission, before Pi may start it; retries and crash reconciliation keep this exact scope. */
  async capture(projectId: string, chatId?: string): Promise<string> {
    const workspace = chatId === undefined ? undefined : await this.workspaces?.info(chatId);
    if (this.workspaces !== undefined && chatId !== undefined && workspace?.projectId !== projectId)
      throw new FileAccessError("this chat has no workspace");
    const lease = await this.#lease(projectId, "primary", undefined, workspace?.id);
    const identity = await directoryIdentity(lease.root);
    const references = await this.database.all<{ id: string }>(
      "SELECT id FROM pal_folder_grants WHERE project_id = ? AND revoked_at IS NULL ORDER BY rowid",
      projectId,
    );
    await lease.check();
    return JSON.stringify({
      primary: identity,
      references: references.map(({ id }) => id),
      ...(workspace === undefined ? {} : { workspace: workspace.id }),
    });
  }

  async owner(projectId: string, id = "primary", workspaceId?: string): Promise<FolderLease> {
    return this.#lease(projectId, id, undefined, workspaceId);
  }

  async forTool(api: ToolExecutionApi, context: Context, id = "primary"): Promise<FolderLease> {
    const { projectId, scope, input, readOnly } = await this.#run(api, context);
    if (id !== "primary" && !scope.references.includes(id))
      throw new FileAccessError("this folder was not granted when the run was admitted; start a new run");
    const lease = await this.#lease(projectId, id, id === "primary" ? scope.primary : undefined, scope.workspace);
    return {
      ...lease,
      access: readOnly ? "read" : lease.access,
      check: async () => {
        if ((await this.#run(api, context)).input !== input)
          throw new FileAccessError("the run's folder authority changed");
        await lease.check();
        context.abortSignal?.throwIfAborted();
      },
    };
  }

  async forRun(api: ToolExecutionApi, context: Context): Promise<GrantedFolder[]> {
    const { projectId, scope, input, readOnly } = await this.#run(api, context);
    if ((await this.#run(api, context)).input !== input)
      throw new FileAccessError("the run's folder authority changed");
    await (await this.#lease(projectId, "primary", scope.primary, scope.workspace)).check();
    const folders = (await this.list(projectId, scope.workspace)).filter(
      (entry) => entry.id === "primary" || scope.references.includes(entry.id),
    );
    context.abortSignal?.throwIfAborted();
    return readOnly ? folders.map<GrantedFolder>((entry) => ({ ...entry, access: "read" })) : folders;
  }

  /**
   * The authority of a tool call: its run's admitted folder scope. A helper's call must belong to the helper's live run
   * and has exactly its parent run's scope, reached through the delegating call, which must still be running.
   */
  async #run(api: ToolExecutionApi, context: Context) {
    const link = await this.links?.parent(api.conversationId);
    if (link !== undefined) await this.#active(api, api.conversationId, api.taskId, context);
    const conversation = link?.conversation ?? api.conversationId;
    const { input, submission } = await this.#active(api, conversation, link?.task ?? api.taskId, context);
    const row = await this.database.get<{ chat_id: string; project_id: string; folder_scope: string | null }>(
      "SELECT c.id AS chat_id, c.project_id, a.folder_scope FROM pal_chats c JOIN pal_projects p ON p.id = c.project_id LEFT JOIN pal_admissions a ON a.chat_id = c.id AND a.request_id = ? WHERE c.conversation_id = ? AND c.deleted_at IS NULL AND p.removed_at IS NULL AND p.state = 'ready'",
      submission.requestId ?? null,
      conversation,
    );
    if (row === undefined) throw new FileAccessError("this conversation has no ready project");
    // Pre-grant/host-direct submissions retain primary-only access, never references added later.
    const scope =
      row.folder_scope === null
        ? { primary: undefined, references: [] as string[], workspace: undefined }
        : validate(Scope, JSON.parse(row.folder_scope));
    const workspace = await this.workspaces?.info(row.chat_id);
    if (scope.workspace !== undefined && workspace?.id !== scope.workspace)
      throw new FileAccessError("the run's workspace does not belong to this chat");
    if (this.workspaces !== undefined && workspace === undefined)
      throw new FileAccessError("this chat has no workspace");
    return {
      projectId: row.project_id,
      scope: { ...scope, workspace: scope.workspace ?? workspace?.id },
      input,
      readOnly: link !== undefined,
    };
  }

  async #active(api: ToolExecutionApi, conversation: ConversationId, task: TaskId, context: Context) {
    const live = await api.snapshot(LiveDoc, conversation, context);
    // Pi hands taskId between generations; the first input stays stable through tool rounds and steering.
    const input = live?.run?.inputs[0];
    const current = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].some(
      (slot) => slot.taskId === task && slot.status !== "done",
    );
    if (input === undefined || !current) throw new FileAccessError("this tool no longer belongs to an active run");
    const submission = await this.storage.submission(input, context);
    if (submission?.conversationId !== conversation || submission.type !== "input" || submission.status !== "placed")
      throw new FileAccessError("this input no longer owns an active run");
    return { input, submission };
  }

  async #lease(projectId: string, id: string, pinnedIdentity?: string, workspaceId?: string): Promise<FolderLease> {
    const project = await this.#project(projectId);
    const workspace = workspaceId === undefined ? undefined : await this.workspaces?.lease(projectId, workspaceId);
    if (workspaceId !== undefined && workspace === undefined) throw new FileAccessError("no such workspace");
    let grant = workspace ?? primary(project.root);
    let identity = pinnedIdentity;
    if (id !== "primary") {
      const row = await this.#reference(projectId, id);
      grant = reference(row);
      identity = row.identity;
    }
    identity ??= await directoryIdentity(grant.root);
    const expected = identity;
    const check = async () => {
      if ((await directoryIdentity(grant.root)) !== expected)
        throw new FileAccessError("the granted folder was replaced; choose it again");
      const current = await this.#project(projectId);
      await workspace?.check();
      if (id === "primary") {
        if (workspace === undefined && current.root !== grant.root) throw new FileAccessError("the workspace changed");
      } else if ((await this.#reference(projectId, id)).identity !== expected)
        throw new FileAccessError("the folder grant changed");
    };
    await check();
    return { ...grant, check };
  }

  async #reference(projectId: string, id: string): Promise<Reference> {
    const row = await this.database.get<Reference>(
      "SELECT * FROM pal_folder_grants WHERE project_id = ? AND id = ? AND revoked_at IS NULL",
      projectId,
      id,
    );
    if (row === undefined) throw new FileAccessError("this reference folder has been revoked or is not granted");
    return row;
  }

  async #project(projectId: string) {
    const project = await this.projects.get(projectId);
    if (project?.state !== "ready") throw new FileAccessError("no such ready project");
    return project;
  }

  #retry(row: Reference, digest: string): GrantedFolder {
    if (row.digest !== digest || row.revoked_at !== null)
      throw new RequestConflict("this request belongs to a different or revoked folder grant");
    return reference(row);
  }
}

function primary(root: string): GrantedFolder {
  return { id: "primary", root, access: "write", indexed: true, instructions: "untrusted" };
}

function reference(row: { id: string; root: string; indexed: number }): GrantedFolder {
  return { id: row.id, root: row.root, access: "read", indexed: row.indexed === 1, instructions: "untrusted" };
}

function overlaps(a: string, b: string): boolean {
  const inside = (root: string, path: string) => {
    const part = relative(root, path);
    return part === "" || (!part.startsWith("..") && !isAbsolute(part));
  };
  return inside(a, b) || inside(b, a);
}
