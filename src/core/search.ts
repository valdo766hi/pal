import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { GrepCursor } from "@ff-labs/fff-node";
import { NativeFinder, type Finder, type FinderFactory } from "./native-finder.ts";
import { FileAccessError, isProtected, readFileSnapshot, resolveProjectPath } from "./files.ts";
import type { PrivateFiles } from "./file-policy.ts";

const MAX_FINDERS = 3;
const IDLE_MS = 5 * 60_000;
const SCAN_WAIT_MS = 10_000;
const WATCH_WAIT_MS = 1_000;
const WATCH_NOT_READY = "Failed to subscribe: File system watcher is not ready";
const PAGE = 50;
const LINE_CHARS = 300;
const QUERY_MS = 2_000;
const MAX_SNIPPET_BYTES = 16 * 1024;

export type SearchMode = "files" | "text" | "regex";
export type SearchHit = {
  /** Relative to the project folder. */
  readonly path: string;
  readonly line?: number;
  readonly text?: string;
  /** Character ranges of the match within `text`. */
  readonly ranges?: readonly (readonly [number, number])[];
};
export type SearchResults = {
  readonly mode: SearchMode;
  readonly hits: readonly SearchHit[];
  /** More matches exist, or the time budget ran out, than are shown. */
  readonly truncated: boolean;
  /** A scan or watcher-gap recovery has not finished, so results may be incomplete. */
  readonly indexing: boolean;
};

/** A folder Pal will not index, or a query it will not run; reported, never replaced by another search. */
export class SearchError extends Error {}

type Index = {
  finder: Finder;
  used: number;
  scanned: boolean;
  rescan: boolean;
  unwatch?: () => void;
  pending: Promise<void> | undefined;
};

/**
 * Shared, lazy fff indexes for project folders: created on first search, at most a few alive, destroyed after idling
 * and when their project goes. A folder containing Pal's own data is never indexed, so its files cannot be read into
 * an index before results are filtered.
 */
export class ProjectSearch {
  readonly #deny: readonly string[];
  readonly #privateFiles: PrivateFiles;
  readonly #indexes = new Map<string, Index>();
  readonly #sweep: NodeJS.Timeout;
  readonly #create: FinderFactory;
  readonly #retiring = new Set<Promise<void>>();
  readonly #pending = new Set<{ root: string; released: boolean }>();
  #queue = Promise.resolve();
  #stopped = false;
  #closing: Promise<void> | undefined;

  constructor(deny: readonly string[], privateFiles: PrivateFiles, create: FinderFactory = NativeFinder.open) {
    this.#deny = deny;
    this.#privateFiles = privateFiles;
    this.#create = create;
    this.#sweep = setInterval(() => this.reclaim(Date.now() - IDLE_MS), 60_000).unref();
  }

  async search(configured: string, query: string, mode: SearchMode): Promise<SearchResults> {
    if (query.trim() === "") throw new SearchError("type something to search for");
    const root = await realpath(configured);
    const index = await this.#index(root);
    const keep = (path: string) => {
      const target = join(root, path);
      const between = relative(root, target);
      return !between.startsWith("..") && !isAbsolute(between) && !isProtected(this.#deny, root, target);
    };
    if (mode === "files") {
      const found = await index.finder.fileSearch(query, { pageSize: PAGE });
      if (!found.ok) throw new SearchError(found.error);
      const hits = found.value.items.flatMap((item) => (keep(item.relativePath) ? [{ path: item.relativePath }] : []));
      return { mode, hits, truncated: found.value.totalMatched > hits.length, indexing: !index.scanned };
    }
    // Hidden matches do not consume the public page; all pages share one query deadline.
    const deadline = performance.now() + QUERY_MS;
    const hits: SearchHit[] = [];
    let cursor: GrepCursor | null = null;
    let truncated = false;
    do {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const found = await index.finder.grep(query, {
        mode: mode === "regex" ? "regex" : "plain",
        pageSize: PAGE,
        maxMatchesPerFile: 20,
        timeBudgetMs: remaining,
        enforceTimeBudget: true,
        cursor,
      });
      if (!found.ok) throw new SearchError(found.error);
      // fff falls back to literal matching on a bad pattern; Pal reports the error instead.
      if (found.value.regexFallbackError !== undefined)
        throw new SearchError(`invalid regex: ${found.value.regexFallbackError}`);
      for (const item of found.value.items) {
        if (performance.now() >= deadline) {
          truncated = true;
          break;
        }
        // fff's isBinary can mislabel text by extension; content NULs still disqualify a line.
        if (item.lineContent.includes("\u0000") || !keep(item.relativePath)) continue;
        const length = Buffer.byteLength(item.lineContent);
        if (length > MAX_SNIPPET_BYTES || !Number.isSafeInteger(item.byteOffset) || item.byteOffset < 0)
          throw new SearchError("search snippet exceeds its size or offset limits");
        let bytes: Buffer;
        try {
          const resolved = await resolveProjectPath(root, item.relativePath, this.#deny);
          if (resolved.root !== root) throw new SearchError("the search folder changed; retry the query");
          bytes = (await readFileSnapshot(resolved.target, length, this.#privateFiles, item.byteOffset)).bytes;
        } catch (error) {
          if (error instanceof FileAccessError) continue;
          throw error;
        }
        if (!bytes.equals(Buffer.from(item.lineContent)))
          throw new SearchError("a search source changed; retry the query");
        const text = bytes.toString("utf8").slice(0, LINE_CHARS);
        // fff reports byte ranges; the UI uses UTF-16 character offsets.
        const toChars = (offset: number) => bytes.subarray(0, offset).toString("utf8").length;
        hits.push({
          path: item.relativePath,
          line: item.lineNumber,
          text,
          ranges: item.matchRanges
            .map(([start, end]) => [toChars(start), toChars(end)] as const)
            .filter(([start]) => start < text.length),
        });
        if (hits.length > PAGE) {
          truncated = true;
          break;
        }
      }
      cursor = found.value.nextCursor;
    } while (!truncated && cursor !== null);
    return { mode, hits: hits.slice(0, PAGE), truncated, indexing: !index.scanned };
  }

  /** Release a folder's index at once, as when its project is removed. */
  async forget(configured: string): Promise<void> {
    // Revoke canonical queued roots before yielding to path resolution.
    this.#release(configured);
    const root = await realpath(configured).catch(() => configured);
    if (root !== configured) this.#release(root);
    // Revocation joins child exit, not observations that may be paused in their caller.
    await Promise.all(this.#retiring);
  }

  close(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#sweep);
    for (const root of [...this.#indexes.keys()]) this.#drop(root);
    return (this.#closing ??= this.#queue.then(async () => {
      await Promise.all(this.#retiring);
    }));
  }

  /** How many indexes are alive, for tests of reclamation. */
  get size(): number {
    return this.#indexes.size;
  }

  /** Destroy indexes last used before `before`; the sweep passes now minus the idle limit. */
  reclaim(before: number): void {
    for (const [root, index] of this.#indexes) if (index.used < before) this.#drop(root);
  }

  #index(root: string): Promise<Index> {
    const ticket = { root, released: false };
    const task = this.#queue.then(() => this.#openIndex(ticket));
    this.#pending.add(ticket);
    const settled = () => {
      this.#pending.delete(ticket);
    };
    this.#queue = task.then(settled, settled);
    return task;
  }

  async #openIndex(ticket: { root: string; released: boolean }): Promise<Index> {
    const { root } = ticket;
    if (this.#stopped || ticket.released) throw new SearchError("search is closed or its folder was released");
    const existing = this.#indexes.get(root);
    if (existing !== undefined && !existing.finder.isDestroyed) {
      existing.used = Date.now();
      await this.#scan(root, existing);
      return existing;
    }
    if (existing !== undefined) this.#drop(root);
    if (this.#deny.some((denied) => isAncestorOf(root, denied) && !isAncestorOf(denied, root))) {
      throw new SearchError(
        "this folder contains Pal's own data, so Pal does not index it; search a project inside it",
      );
    }
    while (this.#indexes.size >= MAX_FINDERS) {
      const oldest = [...this.#indexes.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      if (oldest === undefined) break;
      this.#drop(oldest[0]);
    }
    await Promise.all(this.#retiring);
    if (this.#stopped || ticket.released) throw new SearchError("search is closed or its folder was released");
    // Only filenames are indexed; content searches remain live and never warm a private content cache.
    const created = await this.#create({
      basePath: root,
      aiMode: true,
      disableMmapCache: true,
      disableContentIndexing: true,
    });
    if (!created.ok) throw new SearchError(`search is unavailable for this folder: ${created.error}`);
    if (this.#stopped || ticket.released) {
      created.value.destroy();
      await created.value.closed;
      throw new SearchError("search is closed or its folder was released");
    }
    const index: Index = { finder: created.value, used: Date.now(), scanned: false, rescan: false, pending: undefined };
    this.#indexes.set(root, index);
    await this.#scan(root, index);
    return index;
  }

  async #scan(root: string, index: Index): Promise<void> {
    const pending = (index.pending ??= this.#ready(root, index));
    try {
      await pending;
    } finally {
      if (index.pending === pending) index.pending = undefined;
    }
  }

  async #ready(root: string, index: Index): Promise<void> {
    if (index.rescan) {
      const started = await index.finder.scanFiles();
      if (!started.ok) throw new SearchError(`search recovery failed: ${started.error}`);
      index.rescan = false;
    }
    if (!index.scanned) {
      const scan = await index.finder.waitForScan(SCAN_WAIT_MS);
      if (!scan.ok) throw new SearchError(`search scan failed: ${scan.error}`);
      if (index.finder.isDestroyed) throw new SearchError("search index was released; try again");
      // A second gap during the wait still needs a scan; never label that snapshot complete.
      index.scanned = scan.value === true && !index.rescan;
    }
    if (index.scanned && index.unwatch === undefined) {
      const deadline = Date.now() + WATCH_WAIT_MS;
      let retried = false;
      // In fff 0.11, scan completion can precede native watcher startup.
      for (;;) {
        if (this.#indexes.get(root) !== index || index.finder.isDestroyed)
          throw new SearchError("search index was released; try again");
        const watching = await index.finder.watch((events) => {
          if (this.#indexes.get(root) !== index || !events.some((event) => event.kind === "rescan")) return;
          index.scanned = false;
          index.rescan = true;
        });
        if (watching.ok) {
          index.unwatch = watching.value;
          break;
        }
        if (watching.error !== WATCH_NOT_READY || Date.now() >= deadline) {
          this.#drop(root);
          throw new SearchError(`search watcher is unavailable: ${watching.error}`);
        }
        retried = true;
        await sleep(50);
      }
      if (retried) {
        index.scanned = false;
        index.rescan = true;
        await this.#ready(root, index);
      }
    }
  }

  #release(root: string): void {
    for (const ticket of this.#pending) if (ticket.root === root) ticket.released = true;
    this.#drop(root);
  }

  #drop(root: string): void {
    const index = this.#indexes.get(root);
    this.#indexes.delete(root);
    index?.unwatch?.();
    if (index !== undefined) {
      index.finder.destroy();
      const closed = index.finder.closed;
      if (closed !== undefined) {
        this.#retiring.add(closed);
        void closed.then(() => this.#retiring.delete(closed));
      }
    }
  }
}

function isAncestorOf(ancestor: string, path: string): boolean {
  const between = relative(ancestor, path);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}
