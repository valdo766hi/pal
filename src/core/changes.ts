import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { WorkspaceLocks } from "./execution.ts";
import { FileAccessError, readFileSnapshot, resolveProjectPath } from "./files.ts";
import { HttpError } from "./http.ts";
import type { PrivateFiles } from "./file-policy.ts";
import type { Projects } from "./projects.ts";
import type { Workspaces } from "./workspaces.ts";
import { directoryIdentity } from "./workspace-root.ts";
import { runGit } from "./git.ts";
import { commentFeedback, type ReviewFeedback } from "./feedback.ts";

const MAX_FILES = 128;
const MAX_COMMENTS = 200;
const LINE_TEXT = 1000;
/** No worktree diff/status: those can execute repository clean filters even with --no-textconv. */
function git(cwd: string, args: string[], signal: AbortSignal, diff = false, input?: Buffer): Promise<Buffer> {
  return runGit(cwd, args, { signal, acceptOne: diff, ...(input === undefined ? {} : { input }) });
}

export type ReviewScope = "normal" | "include-ignored";

export type Change = {
  path: string;
  ignored?: boolean;
  status: "A" | "M" | "D";
  patch: string;
  revision: string;
  reviewed: boolean;
  problem?: string;
};
/** A review comment on one line of a file revision; outdated once that line's text changes or the file stops differing. */
export type ChangeComment = {
  id: string;
  path: string;
  revision: string;
  line: number;
  lineText: string;
  body: string;
  /** Included in an input durably admitted by Pi, not merely copied into the composer. */
  sent: boolean;
  outdated: boolean;
};
export type ChangeSet = {
  state: "ready" | "unavailable";
  base: string | null;
  /** The repository's commit now; differs from `base` once something was committed or checked out since. */
  head: string | null;
  files: Change[];
  comments: ChangeComment[];
  truncated: boolean;
  note: string;
};
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};

export class Changes {
  readonly #database: SqliteDatabase;
  readonly #projects: Projects;
  readonly #deny: string;
  readonly #privateFiles: PrivateFiles;
  readonly #locks: WorkspaceLocks;
  readonly #workspaces: Workspaces | undefined;
  #active = 0;
  constructor(
    database: SqliteDatabase,
    projects: Projects,
    dataRoot: string,
    privateFiles: PrivateFiles,
    locks = new WorkspaceLocks(),
    workspaces?: Workspaces,
  ) {
    this.#database = database;
    this.#projects = projects;
    this.#deny = dataRoot;
    this.#privateFiles = privateFiles;
    this.#locks = locks;
    this.#workspaces = workspaces;
  }

  async #location(projectId: string, workspaceId?: string) {
    const project = await this.#projects.get(projectId);
    if (project?.state !== "ready") throw new HttpError(404, "not_found", "no such ready project");
    if (workspaceId !== undefined) {
      const lease = await this.#workspaces?.lease(projectId, workspaceId);
      const info = await this.#database.get<{ mode: string }>(
        "SELECT mode FROM pal_workspaces WHERE id = ?",
        workspaceId,
      );
      if (lease === undefined || info === undefined) throw new FileAccessError("no such workspace");
      return {
        root: lease.root,
        key: info.mode === "worktree" ? `worktree:${workspaceId}` : projectId,
        check: lease.check,
      };
    }
    const identity = await directoryIdentity(project.root);
    return {
      root: project.root,
      key: projectId,
      check: async () => {
        const current = await this.#projects.get(projectId);
        if (
          current?.state !== "ready" ||
          current.root !== project.root ||
          (await directoryIdentity(project.root)) !== identity
        )
          throw new FileAccessError("the project folder was revoked or replaced");
      },
    };
  }

  /** Called before the first Pal mutation as well as on opening the panel; never moves an existing baseline. */
  async capture(root: string): Promise<void> {
    const projects = await this.#database.all<{ id: string }>(
      "SELECT id FROM pal_projects WHERE root = ? AND removed_at IS NULL AND state = 'ready' UNION SELECT 'worktree:' || w.id AS id FROM pal_workspaces w JOIN pal_chats c ON c.id = w.chat_id JOIN pal_projects p ON p.id = w.project_id WHERE w.root = ? AND w.mode = 'worktree' AND w.state = 'ready' AND c.deleted_at IS NULL AND p.removed_at IS NULL",
      root,
      root,
    );
    for (const { id } of projects) await this.#baseline(id, root);
  }
  async #baseline(id: string, root: string): Promise<{ head: string | null } | undefined> {
    const stored = await this.#database.get<{ head: string | null }>(
      "SELECT head FROM pal_change_bases WHERE scope_id = ?",
      id,
    );
    if (stored !== undefined) return stored;
    const signal = AbortSignal.timeout(10_000);
    try {
      const top = (await git(root, ["rev-parse", "--show-toplevel"], signal)).toString().replace(/\r?\n$/, "");
      if ((await realpath(top)) !== root) return undefined;
    } catch {
      return undefined;
    }
    const head = await this.#head(root, signal);
    await this.#database.run("INSERT OR IGNORE INTO pal_change_bases (scope_id, head) VALUES (?, ?)", id, head);
    return await this.#database.get<{ head: string | null }>(
      "SELECT head FROM pal_change_bases WHERE scope_id = ?",
      id,
    );
  }
  async #head(root: string, signal: AbortSignal): Promise<string | null> {
    let value = "";
    try {
      value = (await git(root, ["rev-parse", "--verify", "HEAD"], signal)).toString().trim();
    } catch {
      // An unborn branch has no commit yet.
    }
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : null;
  }
  /**
   * Move the baseline to the repository's current commit. Only the owner does this, never a commit by itself: an agent
   * commit must not hide its changes from review. `from` and `to` are what the owner saw; if either moved since,
   * nothing changes. Review marks bind the old baseline, so they go with it.
   */
  async moveBaseline(projectId: string, from: string | null, to: string, workspaceId?: string): Promise<void> {
    const location = await this.#location(projectId, workspaceId);
    const { root, key } = location;
    const stale = () => new HttpError(409, "changes_stale", "the baseline or commit changed; refresh first");
    await this.#locks.run(root, async () => {
      await location.check();
      if ((await this.#head(root, AbortSignal.timeout(10_000))) !== to) throw stale();
      await this.#database.transaction(async (tx) => {
        await this.#ready(projectId, tx, workspaceId);
        const stored = await tx.get<{ head: string | null }>(
          "SELECT head FROM pal_change_bases WHERE scope_id = ?",
          key,
        );
        if (stored === undefined || stored.head !== from) throw stale();
        await tx.run("UPDATE pal_change_bases SET head = ? WHERE scope_id = ?", to, key);
        await tx.run("DELETE FROM pal_change_reviews WHERE scope_id = ?", key);
      });
    });
  }
  async list(projectId: string, scope: ReviewScope = "normal", workspaceId?: string): Promise<ChangeSet> {
    if (this.#active >= 2)
      throw new HttpError(409, "changes_busy", "another change scan is in progress; retry shortly");
    this.#active++;
    try {
      const location = await this.#location(projectId, workspaceId);
      const { root, key } = location;
      const baseline = await this.#baseline(key, root);
      const note =
        "Raw text against the recorded Git commit (or empty tree). Includes pre-existing changes; no hooks or filters run. Refresh to see later edits. Discard restores one file, only while it still matches the revision shown.";
      if (baseline === undefined) {
        await location.check();
        return {
          state: "unavailable",
          base: null,
          head: null,
          files: [],
          comments: [],
          truncated: false,
          note: "Git is unavailable or this folder is not a repository root. No baseline or rollback is invented. Use the host terminal to initialize Git explicitly.",
        };
      }
      const signal = AbortSignal.timeout(10_000);
      const tracked =
        baseline.head === null
          ? []
          : (await git(root, ["ls-tree", "-r", "-z", "--name-only", baseline.head], signal))
              .toString()
              .split("\0")
              .filter(Boolean);
      const current = (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], signal))
        .toString()
        .split("\0")
        .filter(Boolean);
      const ignored =
        scope === "include-ignored"
          ? (await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], signal))
              .toString()
              .split("\0")
              .filter(Boolean)
          : [];
      const names = [...new Set([...tracked, ...current, ...ignored])]
        .filter((path) => this.#allowed(root, path))
        .sort();
      const reviews = await this.#database.all<{ path: string; revision: string }>(
        "SELECT path, revision FROM pal_change_reviews WHERE scope_id = ?",
        key,
      );
      const comments = await this.#database.all<CommentRow>(
        "SELECT * FROM pal_change_comments WHERE scope_id = ? ORDER BY created_at, id",
        key,
      );
      const commented = new Set(comments.map((comment) => comment.path));
      const lines = new Map<string, string[]>();
      const files: Change[] = [];
      let budget = 2 * 1024 * 1024;
      let truncated = names.length > MAX_FILES;
      const selected = names.slice(0, MAX_FILES);
      const initiallyHidden = scope === "normal" ? await this.#ignored(root, selected, signal) : new Set<string>();
      for (const path of selected) {
        if (initiallyHidden.has(path)) continue;
        if (signal.aborted) {
          truncated = true;
          break;
        }
        let change;
        try {
          change = await this.#inspect(root, baseline.head, path, tracked.includes(path), signal);
        } catch {
          files.push({
            path,
            status: "M",
            patch: "",
            revision: "",
            reviewed: false,
            problem: "Unavailable: binary, oversized, missing Git object, symlink, or outside the granted folder.",
          });
          continue;
        }
        if (change === undefined) continue;
        budget -= Buffer.byteLength(change.patch);
        if (budget < 0) {
          truncated = true;
          break;
        }
        const { status, patch, revision } = change;
        if (commented.has(path) && change.after !== null) lines.set(path, change.after.toString("utf8").split("\n"));
        files.push({
          path,
          status,
          patch,
          revision,
          reviewed: reviews.some((row) => row.path === path && row.revision === revision),
        });
      }
      const hidden = await this.#ignored(
        root,
        [...files.map((file) => file.path), ...comments.map((comment) => comment.path)],
        signal,
      );
      const visible = (path: string) => this.#allowed(root, path) && (scope === "include-ignored" || !hidden.has(path));
      await location.check();
      return {
        state: "ready",
        base: baseline.head,
        head: await this.#head(root, signal),
        files: files.flatMap((file) => {
          if (!visible(file.path)) return [];
          return [hidden.has(file.path) ? { ...file, ignored: true } : file];
        }),
        comments: comments.flatMap((row) => {
          if (!visible(row.path)) return [];
          const line = lines.get(row.path)?.[row.line - 1];
          return [
            {
              ...toComment(row),
              outdated: line === undefined || createHash("sha256").update(line).digest("hex") !== row.line_hash,
            },
          ];
        }),
        truncated,
        note,
      };
    } finally {
      this.#active--;
    }
  }
  /** One file against the baseline, or undefined when its bytes match. Throws when it cannot be shown as text. */
  async #inspect(root: string, head: string | null, path: string, tracked: boolean, signal: AbortSignal) {
    const before = tracked && head !== null ? await git(root, ["cat-file", "blob", `${head}:${path}`], signal) : null;
    let after: Buffer | null = null;
    try {
      const target = join(root, path);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("non-regular file");
      if (!this.#allowed(root, relative(root, await realpath(target)))) throw new Error("outside grant");
      const snapshot = await readFileSnapshot(target, undefined, this.#privateFiles);
      if (snapshot.truncated) throw new Error("too large");
      after = snapshot.bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if ((before === null && after === null) || (before !== null && after !== null && before.equals(after)))
      return undefined;
    if (
      (before !== null && (!isUtf8(before) || before.includes(0))) ||
      (after !== null && (!isUtf8(after) || after.includes(0)))
    )
      throw new Error("binary file");
    const temporary = await mkdtemp(join(tmpdir(), "pal-diff-"));
    let patch;
    try {
      for (const [side, content] of [
        ["a", before],
        ["b", after],
      ] as const) {
        if (content === null) continue;
        const target = join(temporary, side, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600 });
      }
      patch = (
        await git(
          temporary,
          [
            "diff",
            "--no-index",
            "--no-prefix",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            before === null ? "/dev/null" : `a/${path}`,
            after === null ? "/dev/null" : `b/${path}`,
          ],
          signal,
          true,
        )
      ).toString();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    const revision = createHash("sha256")
      .update(JSON.stringify([head, path, before?.toString("base64") ?? null, after?.toString("base64") ?? null]))
      .digest("hex");
    let status: Change["status"] = "M";
    if (before === null) status = "A";
    else if (after === null) status = "D";
    return { before, after, status, patch, revision };
  }
  #allowed(root: string, path: string): boolean {
    if (isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).some((part) => part === ".." || part === ".git"))
      return false;
    const target = join(root, path);
    return within(root, target) && !(within(this.#deny, target) && !within(this.#deny, root));
  }
  async #ignored(root: string, paths: readonly string[], signal: AbortSignal): Promise<Set<string>> {
    const names = [...new Set(paths)].filter((path) => this.#allowed(root, path));
    if (names.length === 0) return new Set();
    const found = await git(
      root,
      ["check-ignore", "-z", "--stdin"],
      signal,
      true,
      Buffer.from(`${names.join("\0")}\0`),
    );
    return new Set(found.toString().split("\0").filter(Boolean));
  }

  async #permission(root: string, path: string, scope: ReviewScope, signal: AbortSignal): Promise<void> {
    if (scope === "normal" && (await this.#ignored(root, [path], signal)).has(path))
      throw new HttpError(
        403,
        "ignored_permission",
        "include ignored files explicitly before reviewing or discarding this file",
      );
  }

  async review(
    projectId: string,
    path: string,
    revision: string,
    reviewed: boolean,
    scope: ReviewScope = "normal",
    workspaceId?: string,
  ): Promise<void> {
    const location = await this.#location(projectId, workspaceId);
    const listing = await this.list(projectId, scope, workspaceId);
    if (listing.state === "ready") await this.#permission(location.root, path, scope, AbortSignal.timeout(10_000));
    const latest = listing.files.find((file) => file.path === path);
    if (latest === undefined || latest.problem !== undefined || latest.revision !== revision)
      throw new HttpError(409, "changes_stale", "the file changed; refresh and review its latest revision");
    await location.check();
    await this.#database.transaction(async (tx) => {
      await this.#ready(projectId, tx, workspaceId);
      if (reviewed)
        await tx.run(
          "INSERT INTO pal_change_reviews (scope_id, path, revision) VALUES (?, ?, ?) ON CONFLICT (scope_id, path) DO UPDATE SET revision = excluded.revision",
          location.key,
          path,
          revision,
        );
      else await tx.run("DELETE FROM pal_change_reviews WHERE scope_id = ? AND path = ?", location.key, path);
    });
  }

  /**
   * Restore one file to the baseline, only if its bytes still match `revision`: an edit, delete or new file since the
   * owner looked fails without touching anything. Held under the workspace lock so Pal's own writes and commands cannot
   * interleave; external editors are rechecked just before the final rename.
   */
  async discard(
    projectId: string,
    path: string,
    revision: string,
    scope: ReviewScope = "normal",
    workspaceId?: string,
  ): Promise<void> {
    const location = await this.#location(projectId, workspaceId);
    const { root, key } = location;
    const stale = () =>
      new HttpError(409, "changes_stale", "the file changed since you viewed it; nothing was discarded. Refresh first");
    await this.#locks.run(root, async () => {
      await location.check();
      const baseline = await this.#baseline(key, root);
      if (!this.#allowed(root, path)) throw new FileAccessError(`${path} is outside the project folder or protected`);
      if (baseline === undefined) throw stale();
      const signal = AbortSignal.timeout(10_000);
      await this.#permission(root, path, scope, signal);
      const entry = await this.#entry(root, baseline.head, path, signal);
      if (entry !== undefined && (entry.type !== "blob" || !/^100(?:644|755)$/.test(entry.mode)))
        throw new HttpError(409, "changes_unsupported", "only regular baseline files can be restored here");
      const change = await this.#inspect(root, baseline.head, path, entry !== undefined, signal).catch(() => {
        throw new HttpError(409, "changes_unsupported", "this file cannot be discarded here; use the terminal");
      });
      if (change?.revision !== revision) throw stale();
      // Rechecked right before the change; a link, oversized or unreadable file counts as changed.
      const unchanged = async (target: string) => {
        await location.check();
        await this.#permission(root, path, scope, signal);
        const now = await readFileSnapshot(target, undefined, this.#privateFiles).then(
          (snapshot) => (snapshot.truncated ? undefined : snapshot.bytes),
          (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : undefined),
        );
        return now === null ? change.after === null : now !== undefined && change.after?.equals(now) === true;
      };
      if (change.before === null) {
        const { target } = await resolveProjectPath(root, path, [this.#deny], "allow");
        if (!(await unchanged(target))) throw stale();
        await unlink(target);
        await syncDirectory(dirname(target));
      } else {
        // A deleted file's folders may be gone too; recreate them one level at a time, never through a symlink.
        let parent = root;
        if (change.after === null)
          for (const part of dirname(path)
            .split(sep)
            .filter((part) => part !== ".")) {
            parent = join(parent, part);
            await mkdir(parent).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
            });
            if (!(await lstat(parent)).isDirectory()) throw new FileAccessError(`${path} is not inside a plain folder`);
          }
        const { target } = await resolveProjectPath(root, path, [this.#deny], "allow");
        const baselineMode = entry?.mode === "100755" ? 0o755 : 0o644;
        const mode = change.after === null ? baselineMode : (await stat(target)).mode & 0o777;
        const temporary = join(dirname(target), `.pal-${randomUUID()}.tmp`);
        const handle = await open(temporary, "wx", mode);
        try {
          await handle.writeFile(change.before);
          await handle.sync();
          await handle.close();
          if (!(await unchanged(target))) throw stale();
          if (change.after === null)
            await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
              throw error.code === "EEXIST" ? stale() : error;
            });
          else await rename(temporary, target);
          await syncDirectory(dirname(target));
        } finally {
          await handle.close().catch(() => {});
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
      await this.#database.run("DELETE FROM pal_change_reviews WHERE scope_id = ? AND path = ?", key, path);
      await this.#database.run("DELETE FROM pal_change_comments WHERE scope_id = ? AND path = ?", key, path);
    });
  }

  /** Comment on a line of the file as currently shown; its text is read here, not taken from the browser. */
  async comment(
    projectId: string,
    path: string,
    revision: string,
    line: number,
    body: string,
    scope: ReviewScope = "normal",
    workspaceId?: string,
  ): Promise<ChangeComment> {
    const location = await this.#location(projectId, workspaceId);
    const { root, key } = location;
    if (!this.#allowed(root, path)) throw new FileAccessError(`${path} is outside the project folder or protected`);
    const baseline = await this.#baseline(key, root);
    const signal = AbortSignal.timeout(10_000);
    if (baseline !== undefined) await this.#permission(root, path, scope, signal);
    const change =
      baseline === undefined
        ? undefined
        : await this.#entry(root, baseline.head, path, signal)
            .then((entry) => this.#inspect(root, baseline.head, path, entry !== undefined, signal))
            .catch(() => undefined);
    if (change?.revision !== revision)
      throw new HttpError(409, "changes_stale", "the file changed; refresh and comment on its latest revision");
    const lines = change.after?.toString("utf8").split("\n") ?? [];
    const text = lines[line - 1];
    if (text === undefined || (line === lines.length && text === ""))
      throw new HttpError(400, "invalid_request", "that line is not in the current file");
    if (body.trim() === "") throw new HttpError(400, "invalid_request", "write a comment first");
    const row: CommentRow = {
      id: randomUUID(),
      scope_id: key,
      path,
      revision,
      line,
      line_text: text.slice(0, LINE_TEXT),
      line_hash: createHash("sha256").update(text).digest("hex"),
      body: body.trim(),
      created_at: Date.now(),
      sent_at: null,
      submission_id: null,
    };
    await this.#permission(root, path, scope, signal);
    await location.check();
    await this.#database.transaction(async (transaction) => {
      await this.#ready(projectId, transaction, workspaceId);
      const count = await transaction.get<{ count: number }>(
        "SELECT count(*) AS count FROM pal_change_comments WHERE scope_id = ?",
        key,
      );
      if ((count?.count ?? 0) >= MAX_COMMENTS)
        throw new HttpError(409, "comments_full", `at most ${MAX_COMMENTS} comments per project; delete some first`);
      await transaction.run(
        "INSERT INTO pal_change_comments (id, scope_id, path, revision, line, line_text, line_hash, body, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        row.id,
        key,
        path,
        revision,
        line,
        row.line_text,
        row.line_hash,
        row.body,
        row.created_at,
      );
    });
    return { ...toComment(row), outdated: false };
  }

  async #ready(projectId: string, database: SqliteExecutor, workspaceId?: string): Promise<void> {
    if (
      workspaceId !== undefined &&
      (await database.get(
        "SELECT 1 FROM pal_workspaces w JOIN pal_chats c ON c.id = w.chat_id JOIN pal_projects p ON p.id = w.project_id WHERE w.id = ? AND w.project_id = ? AND w.state = 'ready' AND c.deleted_at IS NULL AND p.removed_at IS NULL AND p.state = 'ready'",
        workspaceId,
        projectId,
      )) === undefined
    )
      throw new FileAccessError("workspace authority was revoked");
    if (
      (await database.get(
        "SELECT 1 FROM pal_projects WHERE id = ? AND state = 'ready' AND removed_at IS NULL",
        projectId,
      )) === undefined
    )
      throw new HttpError(404, "not_found", "no such ready project");
  }

  async uncomment(projectId: string, id: string, workspaceId?: string): Promise<void> {
    const location = await this.#location(projectId, workspaceId);
    await this.#database.transaction(async (transaction) => {
      await this.#ready(projectId, transaction, workspaceId);
      await transaction.run("DELETE FROM pal_change_comments WHERE scope_id = ? AND id = ?", location.key, id);
    });
  }

  async #feedbackWorkspace(chatId: string, database: SqliteExecutor) {
    const workspace = await database.get<{ id: string; project_id: string; mode: string }>(
      "SELECT w.id, w.project_id, w.mode FROM pal_workspaces w JOIN pal_chats c ON c.id = w.chat_id AND c.project_id = w.project_id WHERE c.id = ?",
      chatId,
    );
    if (workspace === undefined) throw new HttpError(404, "not_found", "no review workspace for this chat");
    return { ...workspace, key: workspace.mode === "worktree" ? `worktree:${workspace.id}` : workspace.project_id };
  }

  async checkFeedback(chatId: string, feedback: ReviewFeedback, text: string): Promise<void> {
    const workspace = await this.#feedbackWorkspace(chatId, this.#database);
    const location = await this.#location(workspace.project_id, workspace.id);
    const rows = await this.#database.all<CommentRow>(
      "SELECT * FROM pal_change_comments WHERE scope_id = ?",
      location.key,
    );
    const comments = feedback.ids.map((id) => {
      const row = rows.find((comment) => comment.id === id);
      if (row === undefined)
        throw new HttpError(
          409,
          "feedback_stale",
          "A linked comment was removed or belongs to another workspace. Your draft is kept; copy the remaining feedback again.",
        );
      const comment = toComment(row);
      if (!text.includes(commentFeedback(comment)) && !text.includes(commentFeedback({ ...comment, outdated: true })))
        throw new HttpError(
          409,
          "feedback_mismatch",
          "The message no longer contains its linked feedback. Your comments are kept; copy them again or send the edited text without feedback links.",
        );
      return comment;
    });
    const hidden = await this.#ignored(
      location.root,
      comments.map((comment) => comment.path),
      AbortSignal.timeout(10_000),
    );
    if (feedback.scope === "normal" && hidden.size > 0)
      throw new HttpError(403, "ignored_permission", "include ignored files explicitly before sharing their comments");
    await location.check();
    await this.#ready(workspace.project_id, this.#database, workspace.id);
  }

  /** Runs in the Pal admission commit, after Pi has accepted this exact input. */
  async admitFeedback(
    transaction: SqliteExecutor,
    chatId: string,
    feedback: ReviewFeedback,
    submissionId: number,
  ): Promise<void> {
    const workspace = await this.#feedbackWorkspace(chatId, transaction);
    for (const id of feedback.ids)
      await transaction.run(
        "UPDATE pal_change_comments SET sent_at = ?, submission_id = ? WHERE scope_id = ? AND id = ? AND submission_id IS NULL",
        Date.now(),
        submissionId,
        workspace.key,
        id,
      );
  }

  /** The baseline's tree entry for exactly this path, or undefined when the baseline lacks it. */
  async #entry(root: string, head: string | null, path: string, signal: AbortSignal) {
    if (head === null) return undefined;
    const listed = (await git(root, ["--literal-pathspecs", "ls-tree", "-z", head, "--", path], signal)).toString();
    if (listed === "") return undefined;
    const match = /^(\d{6}) (\w+) [a-f0-9]+\t([^\0]*)\0$/.exec(listed);
    if (match?.[3] !== path || match[1] === undefined || match[2] === undefined)
      throw new HttpError(409, "changes_unsupported", "this path is not a single file in the baseline");
    return { mode: match[1], type: match[2] };
  }
}

type CommentRow = {
  id: string;
  scope_id: string;
  path: string;
  revision: string;
  line: number;
  line_text: string;
  line_hash: string;
  body: string;
  created_at: number;
  sent_at: number | null;
  submission_id: number | null;
};
const toComment = (row: CommentRow): Omit<ChangeComment, "outdated"> => ({
  id: row.id,
  path: row.path,
  revision: row.revision,
  line: row.line,
  lineText: row.line_text,
  body: row.body,
  sent: row.submission_id !== null,
});

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
