import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_JSON = 1024 * 1024;
export async function privateReleaseDirectory(path: string): Promise<void> {
  const check = async (path: string) => {
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw new Error("release control requires real owner-only directories");
  };
  await check(dirname(path));
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await check(path);
}
async function privateFile(file: FileHandle) {
  const stat = await file.stat();
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
    throw new Error("release metadata must be a private regular file");
  return stat;
}
export async function readReleaseJson(path: string, privateOnly = true): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = privateOnly ? await privateFile(file) : await file.stat();
    if (!before.isFile() || before.size > MAX_JSON) throw new Error("release metadata exceeds its bounds");
    const data = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    const after = await file.stat();
    if (
      bytesRead !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("release metadata changed while reading");
    try {
      return JSON.parse(data.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw new Error("release metadata is corrupt");
    }
  } finally {
    await file.close();
  }
}
export async function writeReleaseJson(path: string, value: unknown): Promise<void> {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(data) > MAX_JSON) throw new Error("release metadata exceeds its bounds");
  try {
    const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await privateFile(existing);
    } finally {
      await existing.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = `${path}.${randomUUID()}.next`;
  let created = false;
  try {
    const file = await open(
      next,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(next, path);
    created = false;
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (created) await rm(next, { force: true });
  }
}

/** flock locks the shared open-file description; this process retains it after the small helper exits. */
export async function releaseLock(path: string): Promise<FileHandle> {
  const native = process.env.PAL_RELEASE_LOCK;
  if (process.platform !== "linux" && (process.platform !== "darwin" || !native))
    throw new Error("release locking requires Linux or the bundled macOS lock helper");
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await privateFile(file);
    const result = spawnSync(
      native ?? process.env.PAL_FLOCK ?? "flock",
      native === undefined ? ["--nonblock", "3"] : [],
      {
        stdio: ["ignore", "pipe", "pipe", file.fd],
        timeout: 5000,
        maxBuffer: 4096,
        env: { PATH: process.env.PATH ?? "/run/current-system/sw/bin", LC_ALL: "C" },
      },
    );
    if (result.error !== undefined || result.status !== 0)
      throw new Error("another release operation owns this lock, or its helper is unavailable");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
