import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { PrivateFiles } from "./file-policy.ts";
import { readFileSnapshot, resolveProjectPath } from "./files.ts";
import type { FolderLease } from "./folders.ts";
import { runGit } from "./git.ts";

export const REVISION_SCOPE =
  "Git HEAD, tracked files and non-ignored untracked files (bytes and modes); excludes ignored files, Git metadata other than HEAD, dependency installations and external state. Before/after observations are not an atomic or hermetic snapshot.";

/** A bounded source fingerprint, never a claim that the command or its environment is a sufficient acceptance test. */
export async function workspaceRevision(
  lease: FolderLease,
  privateFiles: PrivateFiles,
  deny: readonly string[],
  context: Context,
) {
  await lease.check();
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(context.abortSignal ? [context.abortSignal] : [])]);
  const top = (await runGit(lease.root, ["rev-parse", "--show-toplevel"], { signal })).toString().replace(/\r?\n$/, "");
  if (top !== lease.root) throw new Error("verification requires the granted repository root");
  const head = (await runGit(lease.root, ["rev-parse", "--verify", "--quiet", "HEAD"], { signal, acceptOne: true }))
    .toString()
    .trim();
  if (head !== "" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error("unverifiable Git HEAD");
  const listed = await runGit(lease.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { signal });
  if (!isUtf8(listed)) throw new Error("verification requires UTF-8 paths");
  const paths = [...new Set(listed.toString().split("\0").filter(Boolean))].sort();
  if (paths.length > 2048) throw new Error("verification is limited to 2,048 source files");
  const hash = createHash("sha256").update(JSON.stringify(["pal.workspace-revision.1", head]));
  let budget = 16 * 1024 * 1024;
  for (const path of paths) {
    signal.throwIfAborted();
    const { target } = await resolveProjectPath(lease.root, path, deny, "allow");
    const info = await lstat(join(lease.root, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (info === undefined) {
      hash.update(JSON.stringify([path, null]));
      continue;
    }
    if (!info.isFile()) throw new Error("verification requires regular source files, not links or submodules");
    const file = await readFileSnapshot(target, Math.min(budget, 1024 * 1024), privateFiles);
    if (file.truncated) throw new Error("verification exceeds 1 MiB per file or 16 MiB total");
    budget -= file.bytes.length;
    hash.update(JSON.stringify([path, file.mode, createHash("sha256").update(file.bytes).digest("hex")]));
  }
  signal.throwIfAborted();
  await lease.check();
  return hash.digest("hex");
}
