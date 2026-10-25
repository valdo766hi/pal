import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { HelperLinks } from "./delegation.ts";
import type { FolderLease } from "./folders.ts";
import { FileAccessError } from "./files.ts";
import { HttpError } from "./http.ts";
import type { Projects } from "./projects.ts";
import { validate } from "./requests.ts";
import { directoryIdentity } from "./workspace-root.ts";
import { WorktreeFiles, type WorktreePlan } from "./worktree-files.ts";

export const WorkspaceMode = Type.Enum(["local", "worktree", "read-only"]);
export type WorkspaceMode = "local" | "worktree" | "read-only";
export type Workspace = {
  readonly id: string;
  readonly projectId: string;
  readonly chatId: string;
  readonly mode: WorkspaceMode;
  readonly root: string;
  readonly source: string;
  readonly base: string | null;
  readonly state: "provisioning" | "ready" | "failed";
  readonly submodules: number;
  readonly error: string | null;
};

type Row = {
  id: string;
  project_id: string;
  chat_id: string;
  mode: WorkspaceMode;
  root: string;
  source: string;
  plan: string | null;
  identity: string | null;
  nonce: string;
  state: Workspace["state"];
  error: string | null;
};
const Plan = Type.Object(
  {
    source: Type.String({ maxLength: 4096 }),
    sourceIdentity: Type.String({ maxLength: 128 }),
    common: Type.String({ maxLength: 4096 }),
    commonIdentity: Type.String({ maxLength: 128 }),
    base: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
    submodules: Type.Integer({ minimum: 0, maximum: 10_000 }),
  },
  { additionalProperties: false },
);
const LIVE =
  "JOIN pal_chats c ON c.id = w.chat_id JOIN pal_projects p ON p.id = w.project_id WHERE c.deleted_at IS NULL AND p.removed_at IS NULL AND p.state = 'ready'";

/** A chat's immutable working directory. Starting a different mode creates a different chat, never re-roots a live run. */
export class Workspaces {
  readonly #database: SqliteDatabase;
  readonly #projects: Projects;
  readonly #files: WorktreeFiles;
  readonly #links: Pick<HelperLinks, "chat"> | undefined;
  readonly #jobs = new Map<string, { controller: AbortController; promise: Promise<Workspace> }>();
  #closing = false;

  private constructor(
    database: SqliteDatabase,
    projects: Projects,
    files: WorktreeFiles,
    links: Pick<HelperLinks, "chat"> | undefined,
  ) {
    this.#database = database;
    this.#projects = projects;
    this.#files = files;
    this.#links = links;
  }

  static async open(
    database: SqliteDatabase,
    projects: Projects,
    dataRoot: string,
    installRoot: string,
    links?: Pick<HelperLinks, "chat">,
  ): Promise<Workspaces> {
    const service = new Workspaces(
      database,
      projects,
      new WorktreeFiles(dataRoot, [dataRoot, installRoot, "/nix/store"]),
      links,
    );
    const legacy = await database.all<{ id: string; project_id: string; intent: string }>(
      "SELECT c.id, c.project_id, c.intent FROM pal_chats c JOIN pal_projects p ON p.id = c.project_id LEFT JOIN pal_workspaces w ON w.chat_id = c.id WHERE c.state = 'ready' AND c.deleted_at IS NULL AND p.removed_at IS NULL AND p.state = 'ready' AND w.id IS NULL",
    );
    for (const chat of legacy) await service.allocate(chat.id, chat.project_id, workspaceMode(chat.intent));
    const pending = await database.all<{ chat_id: string }>(
      `SELECT w.chat_id FROM pal_workspaces w ${LIVE} AND w.state = 'provisioning' ORDER BY w.rowid LIMIT 100`,
    );
    for (const row of pending) await service.provision(row.chat_id);
    return service;
  }

  async allocate(chatId: string, projectId: string, mode: WorkspaceMode): Promise<Workspace> {
    const existing = await this.#row(chatId);
    if (existing !== undefined) {
      if (existing.project_id !== projectId || existing.mode !== mode)
        throw new FileAccessError("workspace intent changed");
      return view(existing);
    }
    const project = await this.#projects.get(projectId);
    if (project?.state !== "ready") throw new FileAccessError("no such ready project");
    const id = randomUUID();
    let plan: WorktreePlan | undefined;
    let identity: string | null = null;
    let error: string | null = null;
    try {
      if (mode === "worktree") plan = await this.#files.plan(project.root, AbortSignal.timeout(10_000));
      else identity = await directoryIdentity(project.root);
    } catch {
      error =
        mode === "worktree"
          ? "Worktree unavailable: choose a readable repository root with a committed HEAD within the worktree limits. No checkout hooks, filters or network are allowed."
          : "The project's working folder is unavailable or was redirected.";
    }
    const root = mode === "worktree" ? this.#files.root(id) : project.root;
    await this.#database.transaction(async (tx) => {
      if (await tx.get("SELECT 1 FROM pal_workspaces WHERE chat_id = ?", chatId)) return;
      if (
        (await tx.get(
          "SELECT 1 FROM pal_chats c JOIN pal_projects p ON p.id = c.project_id WHERE c.id = ? AND c.project_id = ? AND c.deleted_at IS NULL AND p.removed_at IS NULL AND p.state = 'ready'",
          chatId,
          projectId,
        )) === undefined
      )
        throw new FileAccessError("the chat or project is no longer available");
      if (mode === "worktree") {
        const count = await tx.get<{ n: number }>(
          "SELECT count(*) AS n FROM pal_workspaces WHERE project_id = ? AND mode = 'worktree' AND plan IS NOT NULL",
          projectId,
        );
        if ((count?.n ?? 0) >= 8) {
          plan = undefined;
          error = "At most 8 retained worktrees per project. Inspect existing worktrees before creating more.";
        }
      }
      let state: Workspace["state"] = mode === "worktree" ? "provisioning" : "ready";
      if (error !== null) state = "failed";
      await tx.run(
        "INSERT INTO pal_workspaces (id, project_id, chat_id, mode, root, source, plan, identity, nonce, state, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        projectId,
        chatId,
        mode,
        root,
        project.root,
        plan === undefined ? null : JSON.stringify(plan),
        identity,
        randomUUID(),
        state,
        error,
      );
    });
    const recorded = await this.#row(chatId);
    if (recorded === undefined) throw new FileAccessError("workspace mapping is missing");
    if (recorded.mode !== mode || recorded.project_id !== projectId)
      throw new FileAccessError("workspace intent changed");
    return view(recorded);
  }

  async info(chatId: string): Promise<Workspace | undefined> {
    const row = await this.#row(chatId);
    return row === undefined ? undefined : view(row);
  }

  /** A helper conversation uses its parent chat's workspace. */
  async forConversation(conversation: ConversationId): Promise<Workspace | undefined> {
    const row = await this.#database.get<Row>(
      `SELECT w.* FROM pal_workspaces w ${LIVE} AND c.conversation_id = ?`,
      (await this.#links?.chat(conversation)) ?? conversation,
    );
    return row === undefined ? undefined : view(row);
  }

  async provision(chatId: string): Promise<Workspace> {
    const running = this.#jobs.get(chatId);
    if (running !== undefined) return running.promise;
    const row = await this.#row(chatId);
    if (row === undefined) throw new FileAccessError("no such workspace");
    const raced = this.#jobs.get(chatId);
    if (raced !== undefined) return raced.promise;
    if (row.state !== "provisioning") return view(row);
    if (this.#closing) throw new HttpError(503, "closing", "Pal is closing; workspace creation stays recorded");
    if (this.#jobs.size >= 2)
      throw new HttpError(409, "workspace_busy", "two worktrees are being prepared; retry shortly");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    const promise = this.#provision(row, signal);
    this.#jobs.set(chatId, { controller, promise });
    try {
      return await promise;
    } finally {
      this.#jobs.delete(chatId);
    }
  }

  async #provision(row: Row, signal: AbortSignal): Promise<Workspace> {
    try {
      if (row.mode !== "worktree" || row.plan === null) throw new FileAccessError("worktree intent is missing");
      const plan = decodePlan(row.plan);
      if (row.root !== this.#files.root(row.id) || plan.source !== row.source)
        throw new FileAccessError("worktree intent changed");
      const check = async () => {
        const current = await this.#row(row.chat_id);
        if (current?.id !== row.id || current.state !== "provisioning")
          throw new FileAccessError("workspace authority was revoked");
        signal.throwIfAborted();
      };
      const identity = await this.#files.provision(
        { ...plan, id: row.id, nonce: row.nonce, identity: row.identity },
        signal,
        async (identity) => {
          await check();
          await this.#database.run(
            "UPDATE pal_workspaces SET identity = ? WHERE id = ? AND (identity IS NULL OR identity = ?)",
            identity,
            row.id,
            identity,
          );
        },
        check,
      );
      await check();
      await this.#database.transaction(async (tx) => {
        const ready = await tx.get(
          "UPDATE pal_workspaces SET state = 'ready', identity = ?, error = NULL WHERE id = ? AND state = 'provisioning' AND chat_id IN (SELECT c.id FROM pal_chats c JOIN pal_projects p ON p.id = c.project_id WHERE c.deleted_at IS NULL AND p.removed_at IS NULL AND p.state = 'ready') RETURNING id",
          identity,
          row.id,
        );
        if (ready === undefined) throw new FileAccessError("workspace authority was revoked");
        await tx.run(
          "INSERT OR IGNORE INTO pal_change_bases (scope_id, head) VALUES (?, ?)",
          `worktree:${row.id}`,
          plan.base,
        );
      });
    } catch {
      if (!this.#closing)
        await this.#database.run(
          "UPDATE pal_workspaces SET state = 'failed', error = ? WHERE id = ? AND state = 'provisioning'",
          "Worktree preparation stopped. Retained files and receipts require inspection; no uncertain Git mutation was retried.",
          row.id,
        );
    }
    const current = await this.#row(row.chat_id);
    if (current === undefined) throw new FileAccessError("workspace authority was revoked");
    return view(current);
  }

  async lease(projectId: string, workspaceId: string): Promise<FolderLease> {
    const row = await this.#database.get<Row>(
      `SELECT w.* FROM pal_workspaces w ${LIVE} AND w.project_id = ? AND w.id = ?`,
      projectId,
      workspaceId,
    );
    if (row?.state !== "ready" || row.identity === null)
      throw new FileAccessError("workspace is not ready; inspect its status before sending work");
    const check = async () => {
      if ((await directoryIdentity(row.root)) !== row.identity)
        throw new FileAccessError("the working folder was replaced");
      const current = await this.#row(row.chat_id);
      if (
        current?.id !== row.id ||
        current.state !== "ready" ||
        current.identity !== row.identity ||
        current.root !== row.root
      )
        throw new FileAccessError("workspace authority was revoked");
    };
    await check();
    return {
      id: "primary",
      root: row.root,
      access: row.mode === "read-only" ? "read" : "write",
      indexed: true,
      instructions: "untrusted",
      check,
    };
  }

  async roots(projectId: string): Promise<string[]> {
    return (
      await this.#database.all<{ root: string }>(
        "SELECT root FROM pal_workspaces WHERE project_id = ? AND mode = 'worktree'",
        projectId,
      )
    ).map(({ root }) => root);
  }

  cancelChat(chatId: string): void {
    this.#jobs.get(chatId)?.controller.abort();
  }
  async cancelProject(projectId: string): Promise<void> {
    const chats = await this.#database.all<{ chat_id: string }>(
      "SELECT chat_id FROM pal_workspaces WHERE project_id = ?",
      projectId,
    );
    for (const { chat_id } of chats) this.cancelChat(chat_id);
  }
  async close(): Promise<void> {
    this.#closing = true;
    for (const job of this.#jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.#jobs.values()].map((job) => job.promise));
  }

  #row(chatId: string): Promise<Row | undefined> {
    return this.#database.get<Row>(`SELECT w.* FROM pal_workspaces w ${LIVE} AND w.chat_id = ?`, chatId);
  }
}

export function workspaceMode(intent: string): WorkspaceMode {
  try {
    const body = validate(
      Type.Object({ workspace: Type.Optional(WorkspaceMode) }, { additionalProperties: true }),
      JSON.parse(intent),
    );
    return body.workspace ?? "local";
  } catch {
    throw new FileAccessError("the recorded chat workspace mode is corrupt; no workspace was substituted");
  }
}

function decodePlan(raw: string): WorktreePlan {
  try {
    return validate(Plan, JSON.parse(raw));
  } catch {
    throw new FileAccessError("the stored worktree intent is corrupt; no mutation was retried");
  }
}
function view(row: Row): Workspace {
  const plan = row.plan === null ? undefined : decodePlan(row.plan);
  return {
    id: row.id,
    projectId: row.project_id,
    chatId: row.chat_id,
    mode: row.mode,
    root: row.root,
    source: row.source,
    base: plan?.base ?? null,
    state: row.state,
    submodules: plan?.submodules ?? 0,
    error: row.error,
  };
}
