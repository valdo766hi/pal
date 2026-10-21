import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FileAccessError, isProtected } from "./files.ts";

export const guidanceHash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const guidanceMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

type Options = { deny: readonly string[]; privateFiles: readonly string[] };
type ReadOptions = { global: boolean; fileBytes: number; headerBytes?: number };

/** Bounded document reads share the same protected-object checks; they never grant execution authority. */
export class GuidanceFiles {
  readonly #deny: readonly string[];
  readonly #privateFiles: readonly string[];
  readonly #privateInodes: ReadonlySet<string>;

  private constructor(options: Options, privateInodes: ReadonlySet<string>) {
    this.#deny = options.deny;
    this.#privateFiles = options.privateFiles;
    this.#privateInodes = privateInodes;
  }

  static async open(options: Options) {
    // Retain protected objects even when their original paths are moved.
    const inodes = new Set<string>();
    for (const path of options.privateFiles) {
      const info = await stat(path).catch((error) => {
        if (guidanceMissing(error)) return undefined;
        throw error;
      });
      if (info !== undefined) inodes.add(`${info.dev}:${info.ino}`);
    }
    return new GuidanceFiles(options, inodes);
  }

  async directory(root: string, name: string, global: boolean) {
    this.#relative(name);
    const configured = resolve(root, name);
    this.#protected(root, configured, global);
    const canonicalRoot = await realpath(root);
    let current = canonicalRoot;
    for (const part of name.split(sep).filter((part) => part !== "." && part !== "")) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new FileAccessError("guidance sources cannot follow symbolic links");
    }
    const target = await realpath(configured);
    if (!inside(canonicalRoot, target)) throw new FileAccessError("guidance source escaped its root");
    this.#protected(canonicalRoot, target, global);
    if (!(await stat(target)).isDirectory()) throw new FileAccessError("guidance root must be a directory");
    return target;
  }

  async entries(root: string, name: string, global: boolean) {
    const target = await this.directory(root, name, global);
    const directory = await opendir(target);
    const entries: { name: string; directory: boolean; symlink: boolean }[] = [];
    for await (const entry of directory) {
      if (entries.length >= 2048) throw new FileAccessError("guidance directory entry limit reached");
      entries.push({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() });
    }
    if ((await realpath(resolve(root, name))) !== target) throw new FileAccessError("guidance directory changed");
    return entries.sort((a, b) => {
      if (a.name === b.name) return 0;
      return a.name < b.name ? -1 : 1;
    });
  }

  async read(root: string, name: string, options: ReadOptions) {
    this.#relative(name);
    const configured = join(root, name);
    const parent = await this.directory(root, dirname(name), options.global);
    const leaf = name.split(sep).at(-1)?.normalize("NFC");
    let matched = false;
    for (const entry of await this.entries(parent, ".", options.global)) {
      const spelling = entry.name.normalize("NFC");
      if (spelling.toLowerCase() !== leaf?.toLowerCase()) continue;
      if (matched || spelling !== leaf) throw new FileAccessError("ambiguous guidance filename or case mismatch");
      matched = true;
    }
    if ((await lstat(configured)).isSymbolicLink())
      throw new FileAccessError("guidance sources cannot follow symbolic links");
    const canonicalRoot = await realpath(root);
    const target = await realpath(configured);
    if (!inside(canonicalRoot, target)) throw new FileAccessError("guidance source escaped its root");
    this.#protected(canonicalRoot, target, options.global);
    const before = await lstat(target);
    if (!before.isFile() || before.nlink !== 1 || before.size > options.fileBytes)
      throw new FileAccessError("guidance must be a bounded regular file without hardlinks");
    if (this.#privateInodes.has(`${before.dev}:${before.ino}`)) throw new FileAccessError("private guidance source");
    for (const path of this.#privateFiles) {
      const info = await stat(path).catch((error) => {
        if (guidanceMissing(error)) return undefined;
        throw error;
      });
      if (info?.dev === before.dev && info.ino === before.ino) throw new FileAccessError("private guidance source");
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1 || !info.isFile())
        throw new FileAccessError("guidance source changed");
      const limit = options.headerBytes ?? options.fileBytes;
      const chunks: Buffer[] = [];
      let length = 0;
      let headerEnd: number | undefined;
      for await (const chunk of handle.createReadStream({
        start: 0,
        end: limit,
        highWaterMark: options.headerBytes === undefined ? 4096 : 256,
        autoClose: false,
      })) {
        chunks.push(chunk);
        length += chunk.length;
        if (options.headerBytes !== undefined) {
          const prefix = Buffer.concat(chunks).toString("utf8");
          const match = /\n---[ \t]*\r?\n/.exec(prefix);
          if (match !== null) {
            headerEnd = Buffer.byteLength(prefix.slice(0, match.index + match[0].length));
            break;
          }
        }
      }
      const bytes = Buffer.concat(chunks);
      const after = await handle.stat();
      if (
        (options.headerBytes === undefined && length > limit) ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        (await realpath(configured)) !== target
      )
        throw new FileAccessError("guidance source changed or exceeded its limit");
      if (options.headerBytes !== undefined && (headerEnd === undefined || headerEnd > limit))
        throw new FileAccessError("SKILL.md needs a closing frontmatter line within the metadata limit");
      const retained = headerEnd === undefined ? bytes : bytes.subarray(0, headerEnd);
      if (!isUtf8(retained) || retained.includes(0)) throw new FileAccessError("guidance must be UTF-8 text");
      return {
        path: target,
        text: retained.toString("utf8"),
        sha256: guidanceHash(retained),
        revision: guidanceHash(
          JSON.stringify([target, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]),
        ),
      };
    } finally {
      await handle.close();
    }
  }

  #relative(name: string) {
    if (isAbsolute(name) || name.includes("\0") || name.split(/[\\/]/).includes(".."))
      throw new FileAccessError("guidance paths must stay inside their configured root");
  }
  #protected(root: string, target: string, global: boolean) {
    if (global ? this.#deny.some((path) => inside(path, target)) : isProtected(this.#deny, root, target))
      throw new FileAccessError("protected guidance source");
  }
}
