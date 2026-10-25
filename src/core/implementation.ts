import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { validate } from "./requests.ts";

const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_PACKAGES = 256;
const Dependencies = Type.Record(Type.String({ pattern: "^(?:@[a-zA-Z0-9_.-]+/)?[a-zA-Z0-9_.-]+$" }), Type.String());
const Metadata = Type.Object({
  name: Type.Optional(Type.String()),
  dependencies: Type.Optional(Dependencies),
  optionalDependencies: Type.Optional(Dependencies),
  peerDependencies: Type.Optional(Dependencies),
  peerDependenciesMeta: Type.Optional(
    Type.Record(Type.String(), Type.Object({ optional: Type.Optional(Type.Boolean()) })),
  ),
});
type PrivateRoot = { path: string; inodes: Set<string> };
const cache = new Map<string, { stamp: string; digest: string }>();
const stamp = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(":");
const nixOutput = (path: string) => /^\/nix\/store\/[a-z0-9]{32}-[^/]+/.exec(path)?.[0];
function compare(a: string, b: string) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function assertPublic(path: string, dataRoot: PrivateRoot | undefined, info?: BigIntStats) {
  if (dataRoot === undefined) return;
  if (info !== undefined && dataRoot.inodes.has(`${info.dev}:${info.ino}`))
    throw new Error("private Pal data cannot be part of the implementation");
  const child = relative(dataRoot.path, path);
  if (child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)))
    throw new Error("private Pal data cannot be part of the implementation");
}

async function read(
  path: string,
  limit: number,
  consume: (chunk: Buffer) => void,
  dataRoot?: PrivateRoot,
  info?: BigIntStats,
) {
  assertPublic(path, dataRoot);
  // Closing even a read-only hardlink descriptor drops this process's POSIX SQLite locks.
  assertPublic(path, dataRoot, info ?? (await lstat(path, { bigint: true })));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw new Error("implementation file is special or too large");
    const size = Number(before.size),
      buffer = Buffer.alloc(Math.min(64 * 1024, size));
    let length = 0;
    while (length < size) {
      const part = await handle.read(buffer, 0, Math.min(buffer.length, size - length), length);
      if (part.bytesRead === 0) break;
      length += part.bytesRead;
      consume(buffer.subarray(0, part.bytesRead));
    }
    if (BigInt(length) !== before.size || stamp(before) !== stamp(await handle.stat({ bigint: true })))
      throw new Error("implementation changed while reading");
    return stamp(before);
  } finally {
    await handle.close();
  }
}
async function metadata(root: string, dataRoot?: PrivateRoot) {
  const chunks: Buffer[] = [];
  await read(join(root, "package.json"), 1024 * 1024, (chunk) => chunks.push(Buffer.from(chunk)), dataRoot);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return validate(Metadata, JSON.parse(text));
  } catch (cause) {
    throw new Error("Invalid implementation package metadata", { cause });
  }
}
async function rootOf(installRoot: string, dataRoot?: PrivateRoot) {
  try {
    const root = await realpath(installRoot);
    if ((await metadata(root, dataRoot)).name !== "pal") throw new Error("not a Pal installation");
    return root;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let root = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth++) {
    try {
      if ((await metadata(root, dataRoot)).name === "pal") return await realpath(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    root = dirname(root);
  }
  throw new Error("cannot find the running Pal implementation");
}
async function dependency(root: string, name: string) {
  if ([".", ".."].includes(name)) throw new Error("invalid implementation dependency");
  for (const directory of createRequire(join(root, "package.json")).resolve.paths(`${name}/package.json`) ?? []) {
    try {
      return await realpath(join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

/** A startup snapshot, not a sandbox: mutable installations must stay unchanged for the process lifetime. */
export async function mutableIdentity(installRoot: string, privateDataRoot?: string): Promise<string> {
  try {
    let dataRoot: PrivateRoot | undefined;
    if (privateDataRoot !== undefined) {
      const path = await realpath(privateDataRoot),
        inodes = new Set<string>();
      for (const name of ["pal.sqlite", "pal.sqlite-wal", "pal.sqlite-shm", "credentials.key"]) {
        try {
          const info = await stat(join(path, name), { bigint: true });
          inodes.add(`${info.dev}:${info.ino}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      dataRoot = { path, inodes };
    }
    const root = await rootOf(installRoot, dataRoot);
    let files = 0,
      entries = 0,
      total = 0;
    async function file(path: string) {
      assertPublic(path, dataRoot);
      const info = await lstat(path, { bigint: true });
      assertPublic(path, dataRoot, info);
      if (!info.isFile() || info.size > BigInt(MAX_FILE_BYTES))
        throw new Error("linked, special or oversized implementation file");
      if (++files > MAX_FILES || (total += Number(info.size)) > MAX_BYTES)
        throw new Error("implementation exceeds its file/byte limits");
      const key = stamp(info),
        known = cache.get(path);
      let digest = known?.stamp === key ? known.digest : undefined;
      if (digest === undefined) {
        const hash = createHash("sha256");
        const actual = await read(path, MAX_FILE_BYTES, (chunk) => hash.update(chunk), dataRoot, info);
        if (actual !== key) throw new Error("implementation changed while opening");
        digest = hash.digest("hex");
      }
      cache.delete(path);
      cache.set(path, { stamp: key, digest });
      if (cache.size > MAX_FILES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return [digest, (info.mode & 0o111n) !== 0n] as const;
    }
    async function tree(root: string, directory: string, depth = 0): Promise<unknown[]> {
      if (depth > 32) throw new Error("implementation is too deeply nested");
      assertPublic(join(root, directory), dataRoot);
      const result: unknown[] = [],
        listing: Dirent[] = [],
        pending: string[] = [];
      for await (const entry of await opendir(join(root, directory), { bufferSize: 32 })) {
        if (++entries > MAX_FILES || entry.name.includes("\ufffd"))
          throw new Error("implementation exceeds its entry limits");
        listing.push(entry);
      }
      for (const entry of listing.sort((a, b) => compare(a.name, b.name))) {
        if (entry.name === "node_modules" || entry.name === ".git" || /^(?:agents|stack|plan)\.md$/i.test(entry.name))
          continue;
        const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
        if (entry.isDirectory()) result.push(...(await tree(root, path, depth + 1)));
        else if (entry.isFile()) pending.push(path);
        else throw new Error("linked or special implementation path");
      }
      for (let offset = 0; offset < pending.length; offset += 8)
        result.push(
          ...(await Promise.all(
            pending.slice(offset, offset + 8).map(async (path) => [path, ...(await file(join(root, path)))]),
          )),
        );
      return result;
    }
    const roots = new Map<string, number>(),
      packages: unknown[] = [];
    async function visit(path: string, role: "application" | "dependency" = "dependency"): Promise<number> {
      const root = await realpath(path),
        known = roots.get(root);
      assertPublic(root, dataRoot);
      if (known !== undefined) return known;
      if (packages.length >= MAX_PACKAGES) throw new Error("too many implementation packages");
      const index = packages.length;
      roots.set(root, index);
      packages.push(null);
      const immutable = nixOutput(root);
      if (role === "dependency" && immutable !== undefined) {
        packages[index] = { immutable, path: relative(immutable, root) };
        return index;
      }
      const pkg = await metadata(root, dataRoot);
      let content: unknown[];
      if (role === "application") {
        content = [
          ["package.json", ...(await file(join(root, "package.json")))],
          ["pnpm-lock.yaml", ...(await file(join(root, "pnpm-lock.yaml")))],
        ];
        try {
          content.push(["pnpm-workspace.yaml", ...(await file(join(root, "pnpm-workspace.yaml")))]);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        let runtimeFiles = 0;
        for (const directory of ["src", "dist"]) {
          let info;
          try {
            info = await lstat(join(root, directory));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("linked implementation directory");
          const entries = await tree(root, directory);
          runtimeFiles += entries.length;
          content.push(...entries);
        }
        if (runtimeFiles === 0) throw new Error("missing implementation code");
      } else content = await tree(root, "");
      const edges: unknown[] = [];
      for (const name of Object.keys({
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
        ...pkg.peerDependencies,
      }).sort(compare)) {
        const child = await dependency(root, name);
        if (child === undefined) {
          if (isBuiltin(name)) {
            edges.push([name, "node-builtin"]);
            continue;
          }
          if (
            Object.hasOwn(pkg.optionalDependencies ?? {}, name) ||
            pkg.peerDependenciesMeta?.[name]?.optional === true
          ) {
            edges.push([name, "absent"]);
            continue;
          }
          throw new Error(`missing implementation dependency ${name}`);
        }
        edges.push([name, await visit(child)]);
      }
      packages[index] = { content, edges };
      return index;
    }
    await visit(root, "application");
    const executable = await realpath(process.execPath),
      immutableNode = nixOutput(executable);
    const node =
      immutableNode === undefined ? await file(executable) : [immutableNode, relative(immutableNode, executable)];
    return createHash("sha256")
      .update(
        JSON.stringify({
          format: 1,
          packages,
          node,
          versions: process.versions,
          platform: process.platform,
          arch: process.arch,
          flags: process.execArgv,
          options: process.env.NODE_OPTIONS ?? "",
        }),
      )
      .digest("hex");
  } catch (cause) {
    throw new Error(
      "Cannot verify the mutable Pal implementation; use an intact retained build and frozen dependencies before resuming work.",
      { cause },
    );
  }
}
