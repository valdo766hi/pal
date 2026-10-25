import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { MIGRATIONS } from "../storage/migrations.ts";
import { descriptorPath } from "./release-files.ts";

// Widening this list is an owner-reviewed evaluator upgrade, never a candidate's own policy change.
export const RELEASE_CONTRIBUTIONS = [
  "web/src/components/FilesPanel.svelte",
  "web/src/components/ChangesPanel.svelte",
  "web/src/components/ContextPanel.svelte",
  "web/src/app.css",
] as const;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export type SourceFile = { path: string; hash: string; executable: boolean; size: number };
export type SourceSnapshot = { files: SourceFile[]; digest: string; compatibility: string; bytes: Map<string, Buffer> };
export type ReleaseManifest = {
  format: 1;
  package: string;
  nixpkgs: string;
  schema: number;
  source: Omit<SourceSnapshot, "bytes">;
};
export const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export function sourcePath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".." && !/^(?:agents|stack|plan)\.md$/i.test(part)) &&
    !path.split("/").some((part) => [".git", ".design", "node_modules"].includes(part))
  );
}

/** Ignore non-build entries (including repository skill links), without reading or copying their targets. */
export function candidateFiles(index: string, expectedPaths: readonly string[]): string[] {
  if (index.includes("\ufffd")) throw new Error("candidate source paths must be UTF-8");
  const expected = new Set(expectedPaths);
  const paths = index.split("\0").flatMap((entry) => {
    if (entry === "") return [];
    const match = /^([0-9]{6}) [a-f0-9]+ ([0-3])\t(.+)$/.exec(entry);
    const path = match?.[3];
    if (path === undefined || !sourcePath(path))
      throw new Error("candidate contains a private or unsupported source path");
    if (!expected.has(path)) {
      if (/^(?:src|web|test|nix|scripts)(?:\/|$)/.test(path))
        throw new Error("candidate changes the fixed build file set");
      return [];
    }
    if (!["100644", "100755"].includes(match?.[1] ?? "") || match?.[2] !== "0")
      throw new Error("candidate contains a linked or conflicted build source");
    return [path];
  });
  if (paths.length !== expected.size || new Set(paths).size !== paths.length)
    throw new Error("candidate changes the fixed build file set");
  return paths;
}

/** Public, whitelisted build source only. Runtime data and Git metadata are never part of the manifest. */
export async function sourcePaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (!sourcePath(path)) throw new Error("private or unsupported path in release source");
      if (paths.length >= MAX_FILES) throw new Error("release source has too many files");
      if (path.split("/").length > 20) throw new Error("release source is too deeply nested");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error("release source must not contain links or special files");
    }
  };
  await walk("");
  return paths.sort();
}

export async function readSource(
  root: string,
  paths: readonly string[],
  rejectHardlinks = true,
): Promise<SourceSnapshot> {
  if (paths.length > MAX_FILES || new Set(paths).size !== paths.length) throw new Error("invalid release file set");
  const files: SourceFile[] = [],
    bytes = new Map<string, Buffer>();
  const canonical = await realpath(root);
  let total = 0;
  for (const path of [...paths].sort()) {
    if (!sourcePath(path)) throw new Error("private or unsupported release source path");
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const stat = await lstat(join(root, ...segments.slice(0, i)));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("linked release source directory");
    }
    const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_FILE_BYTES || (rejectHardlinks && before.nlink !== 1))
        throw new Error("release source file is linked, special or too large");
      if (rejectHardlinks && (await descriptorPath(file)) !== join(canonical, path))
        throw new Error("release source requires an unchanged, confined file descriptor");
      const content = Buffer.alloc(before.size + 1);
      const read = await file.read(content, 0, content.length, 0);
      if (rejectHardlinks && (await descriptorPath(file)) !== join(canonical, path))
        throw new Error("release source requires an unchanged, confined file descriptor");
      const after = await file.stat();
      if (
        read.bytesRead !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("release source changed while reading");
      const data = content.subarray(0, read.bytesRead);
      total += data.length;
      if (total > MAX_SOURCE_BYTES) throw new Error("release source exceeds its byte budget");
      bytes.set(path, data);
      files.push({ path, hash: hash(data), executable: (before.mode & 0o111) !== 0, size: data.length });
    } finally {
      await file.close();
    }
  }
  const fingerprint = (files: SourceFile[]) => hash(JSON.stringify(files));
  return {
    files,
    bytes,
    digest: fingerprint(files),
    compatibility: fingerprint(
      files.filter((file) => !(RELEASE_CONTRIBUTIONS as readonly string[]).includes(file.path)),
    ),
  };
}

export function checkCandidate(base: ReleaseManifest, candidate: SourceSnapshot): void {
  if (base.schema !== MIGRATIONS.at(-1)?.version || candidate.compatibility !== base.source.compatibility)
    throw new Error(
      "candidate changes protected code, tests, dependencies, policy or schema; an owner-reviewed evaluator upgrade is required",
    );
  if (
    JSON.stringify(base.source.files.map((file) => file.path)) !==
    JSON.stringify(candidate.files.map((file) => file.path))
  )
    throw new Error("candidate changes the fixed release file set");
  if (base.source.files.some((file, index) => file.executable !== candidate.files[index]?.executable))
    throw new Error("candidate changes executable permissions; only contribution contents may change");
}
export function manifest(snapshot: SourceSnapshot, packagePath: string, nixpkgs: string): ReleaseManifest {
  const source = { files: snapshot.files, digest: snapshot.digest, compatibility: snapshot.compatibility };
  return { format: 1, package: packagePath, nixpkgs, schema: MIGRATIONS.at(-1)?.version ?? 0, source };
}
