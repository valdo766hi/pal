import { randomUUID } from "node:crypto";
import { access, constants, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { type Static, Type } from "typebox";
import { inside } from "./paths.ts";
import { InvalidRequest, normalize, RequestConflict } from "./requests.ts";

export const ProjectBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    /** Absent: create a managed workspace. Present: use this existing folder on the server. */
    folder: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
);
export type ProjectBody = Static<typeof ProjectBody>;

export type Project = {
  readonly id: string;
  readonly name: string;
  readonly mode: "managed" | "existing";
  readonly state: "provisioning" | "ready" | "failed";
  /** Canonical path of the project's primary folder on the server. */
  readonly root: string;
  readonly error?: string;
  readonly createdAt: number;
};

export type FolderEntry = { readonly name: string; readonly path: string; readonly git: boolean };
export type FolderListing = {
  readonly path: string;
  readonly parent?: string;
  readonly entries: readonly FolderEntry[];
  readonly truncated: boolean;
  readonly problem?: "denied" | "missing" | "not_directory";
};

/** An explicitly chosen folder that cannot be used; never replaced by a substitute. */
export class FolderError extends Error {
  readonly code: "missing" | "not_directory" | "unreadable" | "forbidden";

  constructor(code: FolderError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_ENTRIES = 500;

type ProjectRow = {
  id: string;
  digest: string;
  name: string;
  mode: Project["mode"];
  state: Project["state"];
  root: string;
  error: string | null;
  created_at: number;
  removed_at: number | null;
};

/**
 * Projects and their primary folders. A managed workspace is recorded, created exclusively under the data root, then
 * marked ready; `open()` finishes any a crash interrupted. An existing folder is validated and referenced, never copied.
 */
export class Projects {
  readonly #database: SqliteDatabase;
  readonly #dataRoot: string;
  /** Places a project folder must not be inside: Pal's data and installation, and the Nix store. */
  readonly #forbidden: readonly string[];

  private constructor(database: SqliteDatabase, dataRoot: string, forbidden: readonly string[]) {
    this.#database = database;
    this.#dataRoot = dataRoot;
    this.#forbidden = forbidden;
  }

  static async open(options: { database: SqliteDatabase; dataRoot: string; installRoot: string }): Promise<Projects> {
    const projects = new Projects(options.database, options.dataRoot, [
      options.dataRoot,
      options.installRoot,
      "/nix/store",
    ]);
    const pending = await options.database.all<{ id: string; root: string }>(
      "SELECT id, root FROM pal_projects WHERE state = 'provisioning' AND removed_at IS NULL ORDER BY rowid",
    );
    for (const { id, root } of pending) await projects.#provision(id, root);
    return projects;
  }

  async list(): Promise<Project[]> {
    return (
      await this.#database.all<ProjectRow>(
        "SELECT * FROM pal_projects WHERE removed_at IS NULL ORDER BY created_at, rowid",
      )
    ).map(project);
  }

  async get(id: string): Promise<Project | undefined> {
    const row = await this.#database.get<ProjectRow>(
      "SELECT * FROM pal_projects WHERE id = ? AND removed_at IS NULL",
      id,
    );
    return row === undefined ? undefined : project(row);
  }

  async create(requestId: unknown, body: unknown): Promise<Project> {
    const { key, digest } = normalize(requestId, ProjectBody, body, (value) => ({
      name: value.name.trim(),
      folder: value.folder ?? null,
    }));
    const existing = await this.#database.get<ProjectRow>("SELECT * FROM pal_projects WHERE request_id = ?", key);
    if (existing !== undefined) {
      if (existing.digest !== digest) throw new RequestConflict(`request ${key} created a different project`);
      if (existing.removed_at !== null) throw new RequestConflict(`request ${key} belongs to a removed project`);
      return project(existing);
    }
    const { name, folder } = body as ProjectBody;
    if (name.trim() === "") throw new InvalidRequest("/name must not be blank");
    const id = randomUUID();
    const managed = folder === undefined;
    const root = managed ? join(this.#dataRoot, "projects", id, "workspace") : await this.existingFolder(folder);
    const recorded = await this.#database.transaction(async (tx) => {
      const raced = await tx.get<ProjectRow>("SELECT * FROM pal_projects WHERE request_id = ?", key);
      if (raced !== undefined) return raced;
      await tx.run(
        "INSERT INTO pal_projects (id, request_id, digest, name, mode, state, root, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        key,
        digest,
        name.trim(),
        managed ? "managed" : "existing",
        managed ? "provisioning" : "ready",
        root,
        Date.now(),
      );
      return undefined;
    });
    if (recorded !== undefined) {
      if (recorded.digest !== digest) throw new RequestConflict(`request ${key} created a different project`);
      if (recorded.removed_at !== null) throw new RequestConflict(`request ${key} belongs to a removed project`);
      return project(recorded);
    }
    if (managed) await this.#provision(id, root);
    const created = await this.get(id);
    if (created === undefined) throw new RequestConflict("project was removed while it was being created");
    return created;
  }

  /** Revoke the project and its chats atomically. Neither external nor managed files are deleted. */
  async remove(id: string): Promise<void> {
    await this.#database.transaction(async (tx) => {
      const at = Date.now();
      await tx.run("UPDATE pal_projects SET removed_at = COALESCE(removed_at, ?) WHERE id = ?", at, id);
      await tx.run("UPDATE pal_chats SET deleted_at = COALESCE(deleted_at, ?) WHERE project_id = ?", at, id);
    });
  }

  /** List a server folder's subfolders for the picker; problems are reported, not thrown. */
  async browse(path: string | undefined): Promise<FolderListing> {
    const requested = path ?? homedir();
    if (!isAbsolute(requested)) throw new InvalidRequest("folder path must be absolute");
    const parent = dirname(requested) === requested ? {} : { parent: dirname(requested) };
    let names;
    try {
      names = await readdir(requested, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      let problem: NonNullable<FolderListing["problem"]> = "missing";
      if (code === "EACCES" || code === "EPERM") problem = "denied";
      else if (code === "ENOTDIR") problem = "not_directory";
      return { path: requested, ...parent, entries: [], truncated: false, problem };
    }
    const folders = names.flatMap((entry) => {
      const child = join(requested, entry.name);
      return (entry.isDirectory() || entry.isSymbolicLink()) && !this.#isForbidden(child) ? [child] : [];
    });
    const entries: FolderEntry[] = [];
    for (const child of folders.sort((a, b) => a.localeCompare(b)).slice(0, MAX_ENTRIES)) {
      if (!(await stat(child).catch(() => undefined))?.isDirectory()) continue;
      const git = (await stat(join(child, ".git")).catch(() => undefined)) !== undefined;
      entries.push({ name: child.slice(requested.length).replace(/^\//, ""), path: child, git });
    }
    return { path: requested, ...parent, entries, truncated: folders.length > MAX_ENTRIES };
  }

  async existingFolder(folder: string): Promise<string> {
    if (!isAbsolute(folder)) throw new InvalidRequest("/folder must be an absolute path on the server");
    let canonical;
    try {
      canonical = await realpath(folder);
    } catch {
      throw new FolderError("missing", `${folder} does not exist on the server`);
    }
    if (!(await stat(canonical)).isDirectory()) throw new FolderError("not_directory", `${folder} is not a folder`);
    try {
      await access(canonical, constants.R_OK | constants.X_OK);
    } catch {
      throw new FolderError("unreadable", `Pal cannot read ${folder}`);
    }
    if (this.#isForbidden(canonical)) throw new FolderError("forbidden", `${folder} is inside Pal's own files`);
    return canonical;
  }

  #isForbidden(path: string): boolean {
    return this.#forbidden.some((root) => inside(root, path));
  }

  /**
   * Create the workspace and mark it ready. Its random-ID path is recorded first and its parent is Pal's own, so an
   * existing directory there is an earlier attempt's: it is accepted only as a real directory owned by this user.
   */
  async #provision(id: string, root: string): Promise<void> {
    try {
      await mkdir(dirname(dirname(root)), { recursive: true, mode: 0o700 });
      for (const directory of [dirname(root), root]) {
        await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.uid !== process.getuid?.()) {
          throw new Error(`${directory} exists but is not a workspace Pal created`);
        }
      }
      await this.#database.run("UPDATE pal_projects SET state = 'ready' WHERE id = ?", id);
    } catch (error) {
      await this.#database.run(
        "UPDATE pal_projects SET state = 'failed', error = ? WHERE id = ?",
        (error as Error).message,
        id,
      );
    }
  }
}

function project(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    state: row.state,
    root: row.root,
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
  };
}
