import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { FileAccessError, readFileSnapshot } from "./files.ts";
import { runGit, runGitEffect } from "./git.ts";
import { inside } from "./paths.ts";
import { directoryIdentity } from "./workspace-root.ts";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

type TreeFile = { path: string; mode: string; oid: string; size: number };
export type WorktreePlan = {
  source: string;
  sourceIdentity: string;
  common: string;
  commonIdentity: string;
  base: string;
  submodules: number;
};
export type WorktreeIntent = WorktreePlan & { id: string; nonce: string; identity: string | null };

/** Creates raw committed files, never a checkout that can run repository filters, hooks or submodule initialization. */
export class WorktreeFiles {
  readonly #dataRoot: string;
  readonly #forbidden: readonly string[];

  constructor(dataRoot: string, forbidden: readonly string[]) {
    this.#dataRoot = dataRoot;
    this.#forbidden = forbidden;
  }

  root(id: string): string {
    if (!UUID.test(id)) throw new FileAccessError("invalid workspace identity");
    return join(this.#dataRoot, "worktrees", id);
  }

  async plan(source: string, signal: AbortSignal): Promise<WorktreePlan> {
    const sourceIdentity = await directoryIdentity(source);
    const top = (await runGit(source, ["rev-parse", "--show-toplevel"], { signal })).toString().replace(/\r?\n$/, "");
    if ((await realpath(top)) !== source) throw new FileAccessError("worktree mode requires a repository root");
    const common = await this.#common(source, signal);
    if (this.#forbidden.some((root) => inside(root, common) && !inside(source, common)))
      throw new FileAccessError("Git metadata is inside Pal's protected files");
    const base = (await runGit(source, ["rev-parse", "--verify", "HEAD^{commit}"], { signal })).toString().trim();
    if (!OBJECT_ID.test(base)) throw new FileAccessError("worktree mode requires a committed Git revision");
    const files = await this.#tree(source, base, signal);
    return {
      source,
      sourceIdentity,
      common,
      commonIdentity: await directoryIdentity(common),
      base,
      submodules: files.filter((file) => file.mode === "160000").length,
    };
  }

  async provision(
    intent: WorktreeIntent,
    signal: AbortSignal,
    recordIdentity: (identity: string) => Promise<void>,
    checkAuthority: () => Promise<void> = async () => {},
  ): Promise<string> {
    const check = async () => {
      await checkAuthority();
      signal.throwIfAborted();
    };
    await check();
    if (!UUID.test(intent.nonce) || !OBJECT_ID.test(intent.base)) throw new FileAccessError("invalid worktree intent");
    if (
      (await directoryIdentity(intent.source)) !== intent.sourceIdentity ||
      (await this.#common(intent.source, signal)) !== intent.common ||
      (await directoryIdentity(intent.common)) !== intent.commonIdentity
    )
      throw new FileAccessError("the source repository was replaced or redirected");
    const root = this.root(intent.id);
    const parent = dirname(root);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await plainDirectory(parent);
    const receipts = join(this.#dataRoot, "workspace-operations");
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    await plainDirectory(receipts);
    const files = await this.#tree(intent.source, intent.base, signal);
    const reason = `pal:${intent.id}:${intent.nonce}`;
    const registered = await this.#registration(intent.source, root, signal);
    if (registered === undefined) {
      if (
        await lstat(root).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        })
      )
        throw new FileAccessError("an unregistered directory already occupies the worktree path; nothing was claimed");
    } else if (registered.head !== intent.base || registered.reason !== reason) {
      throw new FileAccessError("worktree registration does not match the recorded intent");
    }
    await check();
    await runGitEffect(
      intent.source,
      ["worktree", "add", "--no-checkout", "--detach", "--lock", "--reason", reason, root, intent.base],
      join(receipts, `${intent.id}-add`),
      signal,
      registered === undefined ? "start" : "reconcile",
    );
    const registration = await this.#registration(intent.source, root, signal);
    if (registration?.head !== intent.base || registration.reason !== reason)
      throw new FileAccessError("the expected locked worktree was not registered");
    await check();
    const identity = await directoryIdentity(root);
    if (intent.identity !== null && intent.identity !== identity)
      throw new FileAccessError("the worktree directory was replaced");
    await recordIdentity(identity);
    const gitFile = await readFileSnapshot(join(root, ".git"));
    const common = await this.#common(root, signal);
    const gitDirectory = await realpath(
      (await runGit(root, ["rev-parse", "--absolute-git-dir"], { signal })).toString().replace(/\r?\n$/, ""),
    );
    const backlink = await readFileSnapshot(join(gitDirectory, "gitdir"));
    if (
      gitFile.truncated ||
      !gitFile.bytes.toString("utf8").startsWith("gitdir: ") ||
      common !== intent.common ||
      dirname(gitDirectory) !== join(common, "worktrees") ||
      backlink.truncated ||
      backlink.bytes.toString().replace(/\r?\n$/, "") !== join(root, ".git")
    )
      throw new FileAccessError("the worktree's Git metadata changed");
    const gitIdentity = await directoryIdentity(gitDirectory);
    for (const file of files) {
      await check();
      if ((await directoryIdentity(root)) !== identity)
        throw new FileAccessError("the worktree directory was replaced");
      await this.#parents(root, file.path);
      const target = join(root, file.path);
      if (file.mode === "160000") {
        await mkdir(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        await plainDirectory(target);
        continue;
      }
      const bytes = await runGit(intent.source, ["cat-file", "blob", file.oid], {
        signal,
        maxBytes: MAX_FILE_BYTES + 1,
      });
      if (bytes.length !== file.size) throw new FileAccessError("a Git object no longer matches the recorded tree");
      const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (existing !== undefined) {
        if (file.mode === "120000") {
          if (!existing.isSymbolicLink() || (await readlink(target)) !== bytes.toString("utf8"))
            throw new FileAccessError("a worktree link was changed; nothing was overwritten");
        } else {
          if (!existing.isFile()) throw new FileAccessError("a worktree path was replaced; nothing was overwritten");
          const snapshot = await readFileSnapshot(target, MAX_FILE_BYTES);
          if (
            snapshot.truncated ||
            !snapshot.bytes.equals(bytes) ||
            ((snapshot.mode & 0o111) !== 0) !== (file.mode === "100755")
          )
            throw new FileAccessError("a worktree file was changed; nothing was overwritten");
        }
        continue;
      }
      await check();
      if (file.mode === "120000") {
        if (!isUtf8(bytes) || bytes.includes(0) || bytes.length > 4096)
          throw new FileAccessError("unsupported Git symlink target");
        await symlink(bytes.toString("utf8"), target);
      } else {
        const temporary = join(receipts, `${intent.nonce}-${createHash("sha256").update(file.path).digest("hex")}.tmp`);
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        const mode = file.mode === "100755" ? 0o755 : 0o644;
        const handle = await open(temporary, "wx", mode);
        try {
          await handle.writeFile(bytes);
          await handle.chmod(mode);
          await handle.sync();
          await handle.close();
          await check();
          await link(temporary, target);
        } finally {
          await handle.close().catch(() => {});
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
      await syncDirectory(dirname(target));
    }
    const expected = files.map((file) => `${file.mode} ${file.oid} 0\t${file.path}`).sort();
    const gitScope = [`--git-dir=${gitDirectory}`, `--work-tree=${root}`];
    if ((await directoryIdentity(gitDirectory)) !== gitIdentity || (await this.#common(root, signal)) !== common)
      throw new FileAccessError("the worktree's Git metadata changed");
    const readIndex = async () =>
      (await runGit(root, [...gitScope, "ls-files", "--stage", "-z"], { signal, maxBytes: 4 * 1024 * 1024 }))
        .toString()
        .split("\0")
        .filter(Boolean)
        .sort();
    let current = await readIndex();
    const index = await lstat(join(gitDirectory, "index")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    const indexReceipt = join(receipts, `${intent.id}-index`);
    const indexStarted = await lstat(`${indexReceipt}.started`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (indexStarted !== undefined || (index === undefined && current.length === 0 && expected.length > 0)) {
      await check();
      await runGitEffect(
        root,
        [...gitScope, "-c", "core.sparseCheckout=false", "read-tree", "--reset", intent.base],
        indexReceipt,
        signal,
        indexStarted === undefined ? "start" : "reconcile",
      );
      current = await readIndex();
    }
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new FileAccessError("the worktree index was changed; nothing was reset");
    }
    if ((await directoryIdentity(root)) !== identity) throw new FileAccessError("the worktree directory was replaced");
    await syncDirectory(root);
    await check();
    return identity;
  }

  async #common(root: string, signal: AbortSignal): Promise<string> {
    const path = (await runGit(root, ["rev-parse", "--git-common-dir"], { signal })).toString().replace(/\r?\n$/, "");
    return realpath(resolve(root, path));
  }

  async #tree(source: string, base: string, signal: AbortSignal): Promise<TreeFile[]> {
    const raw = await runGit(source, ["ls-tree", "-r", "-l", "-z", "--full-tree", base], {
      signal,
      maxBytes: 4 * 1024 * 1024,
    });
    if (!isUtf8(raw)) throw new FileAccessError("worktree paths must be UTF-8");
    const files: TreeFile[] = [];
    let bytes = 0;
    for (const entry of raw.toString().split("\0").filter(Boolean)) {
      const match =
        /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+|-)\t([\s\S]+)$/.exec(entry);
      const [, mode, type, oid, size, path] = match ?? [];
      if (
        mode === undefined ||
        oid === undefined ||
        size === undefined ||
        path === undefined ||
        (mode === "160000") !== (type === "commit") ||
        (size === "-") !== (mode === "160000") ||
        isAbsolute(path) ||
        path.includes("\0") ||
        path.split("/").some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git") ||
        Buffer.byteLength(path) > 4096
      )
        throw new FileAccessError("unsupported path or object in the Git tree");
      const length = size === "-" ? 0 : Number(size);
      bytes += length;
      if (files.length >= MAX_FILES || length > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES)
        throw new FileAccessError("worktree limit: 10,000 files, 8 MiB per file and 256 MiB total");
      files.push({ mode, oid, size: length, path });
    }
    return files;
  }

  async #registration(
    source: string,
    root: string,
    signal: AbortSignal,
  ): Promise<{ head: string; reason: string } | undefined> {
    const raw = (
      await runGit(source, ["worktree", "list", "--porcelain", "-z"], { signal, maxBytes: 4 * 1024 * 1024 })
    ).toString();
    for (const entry of raw.split("\0\0")) {
      const fields = entry.split("\0");
      if (fields[0] !== `worktree ${root}`) continue;
      return {
        head: fields.find((field) => field.startsWith("HEAD "))?.slice(5) ?? "",
        reason: fields.find((field) => field.startsWith("locked "))?.slice(7) ?? "",
      };
    }
    return undefined;
  }

  async #parents(root: string, path: string): Promise<void> {
    if (!inside(root, join(root, path))) throw new FileAccessError("path escapes the worktree");
    let parent = root;
    for (const part of dirname(path)
      .split(sep)
      .filter((part) => part !== ".")) {
      parent = join(parent, part);
      await mkdir(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await plainDirectory(parent);
    }
  }
}

async function plainDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new FileAccessError("workspace path is not an owned plain directory");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
