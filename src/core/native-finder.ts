import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type {
  FileFinderApi,
  GrepOptions,
  GrepResult,
  InitOptions,
  Result,
  SearchOptions,
  SearchResult,
  WatchBatchCallback,
  WatchEvent,
} from "@ff-labs/fff-node";
import { gnuTimeout } from "./timeout.ts";

type MaybeAsync<T> = T | Promise<T>;
export type Finder = {
  readonly isDestroyed: boolean;
  fileSearch(query: string, options: SearchOptions): MaybeAsync<Result<SearchResult>>;
  grep(query: string, options: GrepOptions): MaybeAsync<Result<GrepResult>>;
  scanFiles(): MaybeAsync<Result<void>>;
  waitForScan(timeout: number): Promise<Result<boolean>>;
  watch(callback: WatchBatchCallback): MaybeAsync<Result<() => void>>;
  destroy(): void;
  readonly closed?: Promise<void>;
};
export type FinderFactory = (options: InitOptions) => MaybeAsync<Result<Finder>>;
type Request =
  | { method: "init"; options: InitOptions }
  | { method: "fileSearch"; query: string; options: SearchOptions }
  | { method: "grep"; query: string; options: GrepOptions }
  | { method: "waitForScan"; timeout: number }
  | { method: "scanFiles" | "watch" | "unwatch" };
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/** Fixed trusted code: native file opens must not release the database owner's POSIX SQLite locks. */
async function finderWorker() {
  const module = process.argv[1];
  if (module === undefined) throw new Error("missing native finder module");
  const require = process.getBuiltinModule("node:module").createRequire(module);
  const { FileFinder } = require(module) as typeof import("@ff-labs/fff-node");
  let finder: FileFinderApi | undefined;
  let unwatch: (() => void) | undefined;
  const send = (value: { id: number; result: Result<unknown> } | { events: WatchEvent[] }) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024 || !process.send?.(value)) process.exit(1);
  };
  let chain = Promise.resolve();
  process.on("message", (message: Request & { id: number }) => {
    chain = chain.then(async () => {
      let result: Result<unknown>;
      try {
        if (message.method === "init") {
          if (finder !== undefined) throw new Error("finder already initialized");
          const created = FileFinder.create(message.options);
          if (created.ok) finder = created.value;
          result = created.ok ? { ok: true, value: process.pid } : created;
        } else {
          if (finder === undefined) throw new Error("finder is not initialized");
          switch (message.method) {
            case "watch": {
              const watching = finder.watch((events) => send({ events }));
              if (watching.ok) unwatch = watching.value;
              result = watching.ok ? { ok: true, value: null } : watching;
              break;
            }
            case "unwatch":
              unwatch?.();
              unwatch = undefined;
              result = { ok: true, value: null };
              break;
            case "fileSearch":
              result = finder.fileSearch(message.query, message.options);
              break;
            case "grep":
              result = finder.grep(message.query, message.options);
              break;
            case "scanFiles":
              result = finder.scanFiles();
              break;
            case "waitForScan":
              result = await finder.waitForScan(message.timeout);
              break;
            default:
              throw new Error("unsupported native finder request");
          }
        }
      } catch {
        result = { ok: false, error: "native finder operation failed" };
      }
      send({ id: message.id, result });
    });
  });
  process.once("disconnect", () => {
    finder?.destroy();
    process.exit(0);
  });
}

export class NativeFinder implements Finder {
  readonly #child: ChildProcess;
  readonly closed: Promise<void>;
  readonly #pending = new Map<number, { settle(result: Result<unknown>): void; timer: NodeJS.Timeout }>();
  #next = 0;
  #workerPid: number | undefined;
  #destroyed = false;
  #watch: WatchBatchCallback | undefined;
  #killTimer: NodeJS.Timeout | undefined;

  private constructor(lifetimeMs: number) {
    this.#child = spawn(
      gnuTimeout(),
      [
        "--kill-after=1s",
        `${lifetimeMs / 1000}s`,
        process.execPath,
        "--max-old-space-size=64",
        "--input-type=module",
        "--eval",
        `(${finderWorker.toString()})()`,
        createRequire(import.meta.url).resolve("@ff-labs/fff-node"),
      ],
      { detached: true, env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    this.closed = new Promise((resolve) => {
      this.#child.once("close", () => {
        this.#destroyed = true;
        clearTimeout(this.#killTimer);
        this.#fail();
        resolve();
      });
    });
    this.#child.once("error", () => this.destroy());
    this.#child.on("message", (message: { id?: number; result?: Result<unknown>; events?: WatchEvent[] }) => {
      if (Buffer.byteLength(JSON.stringify(message)) > MAX_MESSAGE_BYTES) return this.destroy();
      if (message.events !== undefined) {
        this.#watch?.(message.events);
        return;
      }
      const id = message.id;
      const pending = id === undefined ? undefined : this.#pending.get(id);
      if (id === undefined || pending === undefined || message.result === undefined) return this.destroy();
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.settle(message.result);
    });
  }

  static async open(options: InitOptions, lifetimeMs = 10 * 60_000): Promise<Result<NativeFinder>> {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 10 * 60_000)
      throw new Error("invalid finder lifetime");
    const finder = new NativeFinder(lifetimeMs);
    const result = await finder.#call<number>({ method: "init", options });
    if (result.ok && Number.isSafeInteger(result.value) && result.value > 0 && result.value !== process.pid) {
      finder.#workerPid = result.value;
      return { ok: true, value: finder };
    }
    finder.destroy();
    await finder.closed;
    return result.ok ? { ok: false, error: "invalid native finder identity" } : result;
  }

  get isDestroyed() {
    return this.#destroyed;
  }
  get pid() {
    return this.#child.pid;
  }
  get workerPid() {
    return this.#workerPid;
  }

  #fail() {
    for (const { settle, timer } of this.#pending.values()) {
      clearTimeout(timer);
      settle({ ok: false, error: "native finder stopped or exceeded its deadline; retry the search" });
    }
    this.#pending.clear();
  }

  #call<T>(request: Request): Promise<Result<T>> {
    if (this.#destroyed || this.#pending.size >= 64)
      return Promise.resolve({ ok: false, error: "native finder is unavailable" });
    const id = ++this.#next;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.destroy(), 15_000);
      this.#pending.set(id, { settle: (result) => resolve(result as Result<T>), timer });
      this.#child.send({ id, ...request }, (error) => {
        if (error) this.destroy();
      });
    });
  }

  fileSearch(query: string, options: SearchOptions) {
    return this.#call<SearchResult>({ method: "fileSearch", query, options });
  }
  grep(query: string, options: GrepOptions) {
    return this.#call<GrepResult>({ method: "grep", query, options });
  }
  scanFiles() {
    return this.#call<undefined>({ method: "scanFiles" });
  }
  waitForScan(timeout: number) {
    return this.#call<boolean>({ method: "waitForScan", timeout });
  }
  async watch(callback: WatchBatchCallback): Promise<Result<() => void>> {
    this.#watch = callback;
    const result = await this.#call({ method: "watch" });
    if (!result.ok) return result;
    return {
      ok: true,
      value: () => {
        this.#watch = undefined;
        void this.#call({ method: "unwatch" });
      },
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#watch = undefined;
    this.#fail();
    const kill = (signal: NodeJS.Signals) => {
      if (this.#child.pid === undefined) return;
      try {
        process.kill(-this.#child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    kill("SIGTERM");
    this.#killTimer = setTimeout(() => kill("SIGKILL"), 1000);
  }
}
