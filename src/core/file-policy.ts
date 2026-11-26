import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";

/** A path a script may not read: outside the project folder, or inside Pal's own data. */
export class FileAccessError extends Error {}

type FileObject = Pick<Stats, "dev" | "ino">;
const identity = (info: FileObject) => `${info.dev}:${info.ino}`;
async function objectAt(path: string) {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return info === undefined ? undefined : identity(info);
}

/** Protect startup objects after their names move, as well as the files currently at those private paths. */
export class PrivateFiles {
  readonly #paths: readonly string[];
  readonly #startup: ReadonlySet<string>;

  private constructor(paths: readonly string[], startup: ReadonlySet<string>) {
    this.#paths = [...paths];
    this.#startup = startup;
  }

  static async open(paths: readonly string[]) {
    const objects = await Promise.all(paths.map(objectAt));
    const startup = new Set<string>();
    for (const object of objects) if (object !== undefined) startup.add(object);
    return new PrivateFiles(paths, startup);
  }

  async contains(info: FileObject): Promise<boolean> {
    const object = identity(info);
    if (this.#startup.has(object)) return true;
    if (this.#paths.length === 0) return false;
    const results = await Promise.allSettled(this.#paths.map(objectAt));
    let failure: unknown;
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value === object) return true;
      } else if (failure === undefined) {
        failure = result.reason;
      }
    }
    if (failure !== undefined) throw failure;
    return false;
  }
}
