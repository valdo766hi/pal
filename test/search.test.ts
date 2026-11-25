import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileFinder, type WatchBatchCallback } from "@ff-labs/fff-node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { fileTools } from "../src/core/files.ts";
import { PrivateFiles } from "../src/core/file-policy.ts";
import { ProjectSearch, SearchError } from "../src/core/search.ts";

const publicFiles = await PrivateFiles.open([]);
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function folder(files: Record<string, string | Buffer>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-search-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function searcher(deny: string[] = []): ProjectSearch {
  const search = new ProjectSearch(deny, publicFiles, (options) => FileFinder.create(options));
  cleanups.push(() => search.close());
  return search;
}

/** Miss real events deliberately; deliver the SDK's documented rescan signal against a real native index. */
function interruptedWatcher() {
  const create = FileFinder.create;
  vi.spyOn(FileFinder, "create").mockImplementation((options) => create({ ...options, disableWatch: true }));
  const stop = vi.fn();
  let notify: WatchBatchCallback | undefined;
  vi.spyOn(FileFinder.prototype, "watch").mockImplementation(
    (pattern: string | WatchBatchCallback, callback?: WatchBatchCallback) => {
      notify = typeof pattern === "function" ? pattern : callback;
      return { ok: true, value: stop };
    },
  );
  return {
    stop,
    gap: (root: string) => {
      if (notify === undefined) throw new Error("Pal did not subscribe to watcher gap signals");
      notify([{ path: root, kind: "rescan" }]);
    },
  };
}

describe("project search", () => {
  it("does not label a timed-out scan complete on a later search", async () => {
    const root = await folder({ "initial.txt": "needle" });
    vi.spyOn(FileFinder.prototype, "waitForScan")
      .mockResolvedValueOnce({ ok: true, value: false })
      .mockResolvedValueOnce({ ok: true, value: false });
    const search = searcher();
    expect((await search.search(root, "needle", "text")).indexing).toBe(true);
    expect((await search.search(root, "needle", "text")).indexing).toBe(true);
    expect((await search.search(root, "needle", "text")).indexing).toBe(false);
  });

  it("coalesces watcher gaps into a real rescan before the next query and releases the subscription", async () => {
    const watcher = interruptedWatcher();
    const rescans = vi.spyOn(FileFinder.prototype, "scanFiles");
    const root = await folder({ "initial.txt": "needle" });
    const search = searcher();
    await search.search(root, "needle", "text");
    await writeFile(join(root, "missed.txt"), "needle after a missed event");
    expect((await search.search(root, "missed.txt", "files")).hits).toEqual([]);
    watcher.gap(root);
    watcher.gap(root);
    watcher.gap(root);
    const recovered = await search.search(root, "needle", "text");
    expect(recovered.indexing).toBe(false);
    expect(recovered.hits.map((hit) => hit.path).sort()).toEqual(["initial.txt", "missed.txt"]);
    expect(rescans).toHaveBeenCalledTimes(1);
    await search.forget(root);
    expect(watcher.stop).toHaveBeenCalledTimes(1);
    watcher.gap(root);
    expect(search.size).toBe(0);
    expect(rescans).toHaveBeenCalledTimes(1);
  });

  it("keeps a second gap received during recovery incomplete until another scan finishes", async () => {
    const watcher = interruptedWatcher();
    const root = await folder({ "initial.txt": "needle" });
    const search = searcher();
    await search.search(root, "needle", "text");
    const rescans = vi.spyOn(FileFinder.prototype, "scanFiles");
    vi.spyOn(FileFinder.prototype, "waitForScan").mockImplementationOnce(async () => {
      watcher.gap(root);
      return { ok: true, value: true };
    });
    watcher.gap(root);
    expect((await search.search(root, "needle", "text")).indexing).toBe(true);
    expect((await search.search(root, "needle", "text")).indexing).toBe(false);
    expect(rescans).toHaveBeenCalledTimes(2);
  });

  it("reports a refused recovery scan and retries the still-dirty index on the next query", async () => {
    const watcher = interruptedWatcher();
    const root = await folder({ "initial.txt": "needle" });
    const search = searcher();
    await search.search(root, "needle", "text");
    const rescans = vi
      .spyOn(FileFinder.prototype, "scanFiles")
      .mockReturnValueOnce({ ok: false, error: "fixture scan refused" });
    watcher.gap(root);
    await expect(search.search(root, "needle", "text")).rejects.toThrow(/fixture scan refused/);
    expect((await search.search(root, "needle", "text")).indexing).toBe(false);
    expect(rescans).toHaveBeenCalledTimes(2);
  });

  it("bounds transient watcher startup retries and coalesces concurrent initialization", async () => {
    const watcher = interruptedWatcher();
    const watch = vi.spyOn(FileFinder.prototype, "watch").mockReturnValueOnce({
      ok: false,
      error: "Failed to subscribe: File system watcher is not ready",
    });
    const rescans = vi.spyOn(FileFinder.prototype, "scanFiles");
    const root = await folder({ "initial.txt": "needle" });
    const search = searcher();
    const results = await Promise.all([search.search(root, "needle", "text"), search.search(root, "initial", "files")]);
    expect(results.every((result) => !result.indexing && result.hits.length === 1)).toBe(true);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(rescans).toHaveBeenCalledTimes(1);
    search.close();
    expect(watcher.stop).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for an unready watcher instead of retrying forever", async () => {
    const watch = vi.spyOn(FileFinder.prototype, "watch").mockReturnValue({
      ok: false,
      error: "Failed to subscribe: File system watcher is not ready",
    });
    const root = await folder({ "initial.txt": "needle" });
    const search = searcher();
    await expect(search.search(root, "needle", "text")).rejects.toThrow(/watcher is not ready/);
    expect(search.size).toBe(0);
    expect(watch.mock.calls.length).toBeGreaterThan(1);
    expect(watch.mock.calls.length).toBeLessThan(25);
  });

  it("destroys a finder whose watch subscription could not be established", async () => {
    const root = await folder({ "initial.txt": "needle" });
    const destroy = vi.spyOn(FileFinder.prototype, "destroy");
    vi.spyOn(FileFinder.prototype, "watch").mockReturnValue({ ok: false, error: "fixture watcher unavailable" });
    const search = searcher();
    await expect(search.search(root, "needle", "text")).rejects.toThrow(/fixture watcher unavailable/);
    expect(search.size).toBe(0);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("finds exact text with lines and ranges, never turning zero matches into a guess", async () => {
    const root = await folder({
      "src/app.ts": "const x = 1;\nconsole.log('needle here');\n",
      "docs/guide.md": "# Guide\nA needle and another needle.\n",
      "image.bin": Buffer.from([0x00, 0x01, ...Buffer.from("needle")]),
    });
    const search = searcher();
    const text = await search.search(root, "needle", "text");
    expect(text.indexing).toBe(false);
    expect(text.hits.map(({ path, line }) => `${path}:${line}`).sort()).toEqual(["docs/guide.md:2", "src/app.ts:2"]);
    const guide = text.hits.find((hit) => hit.path === "docs/guide.md");
    expect(guide?.ranges?.map(([start, end]) => guide.text?.slice(start, end))).toEqual(["needle", "needle"]);
    expect((await search.search(root, "nedle", "text")).hits).toEqual([]);

    const regex = await search.search(root, "need(le)? and", "regex");
    expect(regex.hits.map((hit) => hit.path)).toEqual(["docs/guide.md"]);
    await expect(search.search(root, "(unclosed", "regex")).rejects.toThrow(/invalid regex/);

    expect((await search.search(root, "guide", "files")).hits.map((hit) => hit.path)).toContain("docs/guide.md");
    await expect(search.search(root, "  ", "text")).rejects.toBeInstanceOf(SearchError);
  });

  it("never indexes a folder holding Pal's data, but indexes a managed workspace inside it", async () => {
    const home = await folder({
      "notes.txt": "needle\n",
      "data/pal/credentials.key": "secret needle\n",
      "data/pal/projects/p1/workspace/a.txt": "needle\n",
    });
    const search = searcher([join(home, "data", "pal")]);
    await expect(search.search(home, "needle", "text")).rejects.toThrow(/contains Pal's own data/);
    expect(search.size).toBe(0);
    const workspace = join(home, "data", "pal", "projects", "p1", "workspace");
    expect((await search.search(workspace, "needle", "text")).hits.map((hit) => hit.path)).toEqual(["a.txt"]);
  });

  it("keeps at most three indexes and releases idle or forgotten ones", async () => {
    const roots = await Promise.all([1, 2, 3, 4].map((n) => folder({ [`f${n}.txt`]: `needle ${n}\n` })));
    const search = searcher();
    for (const root of roots) await search.search(root, "needle", "text");
    expect(search.size).toBe(3);
    await search.forget(roots[3] as string);
    expect(search.size).toBe(2);
    search.reclaim(Date.now() + 1);
    expect(search.size).toBe(0);
    // A reclaimed index is rebuilt on the next search.
    expect((await search.search(roots[0] as string, "needle", "text")).hits).toHaveLength(1);
  });

  it("serves the model's files_search tool from the same indexes, reporting zero matches plainly", async () => {
    const root = await folder({ "src/app.ts": "const x = 1;\nconsole.log('needle here');\n" });
    const search = searcher();
    const privateFiles = await PrivateFiles.open([]);
    const tools = fileTools({ root: async () => root, deny: [], privateFiles, search }).tools ?? [];
    const tool = tools.find((candidate) => candidate.name === "files_search") as ToolRegistration;
    const api = { conversationId: 1 as ConversationId } as ToolExecutionApi;
    const run = async (args: Record<string, unknown>) =>
      (await tool.execute(args as never, api, context)).output
        ?.map((block) => (block.type === "text" ? block.text : ""))
        .join("");
    expect(await run({ query: "needle" })).toBe("src/app.ts:2: console.log('needle here');");
    expect(await run({ query: "nedle" })).toBe("No matches.");
    expect(tool).toMatchObject({ callers: ["tools"], replay: "safe" });
    expect(
      fileTools({ root: async () => root, deny: [], privateFiles }).tools?.some(
        (candidate) => candidate.name === "files_search",
      ),
    ).toBe(false);
  });

  it("lets a ready warm index bypass an unrelated project's blocked scan", async () => {
    const rootA = await folder({ "a.txt": "alpha needle\n" });
    const rootB = await folder({ "b.txt": "beta needle\n" });
    let startedB!: () => void;
    let releaseB!: () => void;
    const bEntered = new Promise<void>((resolve) => (startedB = resolve));
    const bGate = new Promise<void>((resolve) => (releaseB = resolve));
    const search = new ProjectSearch([], publicFiles, (options) => {
      const created = FileFinder.create(options);
      if (created.ok && options.basePath === rootB) {
        const wait = created.value.waitForScan.bind(created.value);
        created.value.waitForScan = async (ms) => {
          startedB();
          await bGate;
          return wait(ms);
        };
      }
      return created;
    });
    cleanups.push(() => {
      releaseB();
      return search.close();
    });

    await search.search(rootA, "alpha", "text");
    const pendingB = search.search(rootB, "beta", "text");
    await bEntered;

    // Project A must finish while project B's scan is still blocked.
    const resultA = await search.search(rootA, "alpha", "text");
    expect(resultA.indexing).toBe(false);
    expect(resultA.hits.map((hit) => hit.path)).toEqual(["a.txt"]);

    releaseB();
    const resultB = await pendingB;
    expect(resultB.indexing).toBe(false);
    expect(resultB.hits.map((hit) => hit.path)).toEqual(["b.txt"]);
  });

  it("still serializes rescan recovery, forget/revocation, eviction and close races behind blocked scans", async () => {
    const watcher = interruptedWatcher();
    const rootA = await folder({ "a.txt": "alpha needle\n" });
    const rootB = await folder({ "b.txt": "beta needle\n" });
    const rootC = await folder({ "c.txt": "gamma needle\n" });
    const rootD = await folder({ "d.txt": "delta needle\n" });

    let releaseScan: (() => void) | undefined;
    let enteredScan: (() => void) | undefined;
    let blockedRoot: string | undefined;
    const armBlock = (root: string) => {
      blockedRoot = root;
      const entered = new Promise<void>((resolve) => (enteredScan = resolve));
      const gate = new Promise<void>((resolve) => (releaseScan = resolve));
      return {
        entered,
        release: () => {
          blockedRoot = undefined;
          releaseScan?.();
        },
        gate,
      };
    };

    let currentGate: Promise<void> | undefined;
    const search = new ProjectSearch([], publicFiles, (options) => {
      const created = FileFinder.create(options);
      if (created.ok && options.basePath === blockedRoot) {
        const gate = currentGate;
        const wait = created.value.waitForScan.bind(created.value);
        created.value.waitForScan = async (ms) => {
          enteredScan?.();
          await gate;
          return wait(ms);
        };
      }
      return created;
    });
    cleanups.push(() => {
      releaseScan?.();
      return search.close();
    });

    // Warm A, then mark A dirty via a watcher gap; A must NOT bypass B's blocked scan.
    await search.search(rootA, "alpha", "text");
    await writeFile(join(rootA, "a2.txt"), "alpha second\n");
    watcher.gap(rootA);
    const blockB = armBlock(rootB);
    currentGate = blockB.gate;
    const pendingB = search.search(rootB, "beta", "text");
    await blockB.entered;

    let aResolved = false;
    const pendingA = search.search(rootA, "alpha", "text").then((res) => {
      aResolved = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(aResolved).toBe(false);
    blockB.release();
    expect((await pendingB).hits).toHaveLength(1);
    expect((await pendingA).hits.map((h) => h.path).sort()).toEqual(["a.txt", "a2.txt"]);

    // Fill MAX_FINDERS = 3 (A, B, C), keep A freshest, then block on D which evicts oldest (B).
    await search.search(rootC, "gamma", "text");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await search.search(rootA, "alpha", "text");
    const blockD = armBlock(rootD);
    currentGate = blockD.gate;
    const pendingD = search.search(rootD, "delta", "text");
    await blockD.entered;

    // A and C stayed warm and answer immediately; evicted B must wait for D.
    expect((await search.search(rootA, "alpha", "text")).hits).toHaveLength(2);
    expect((await search.search(rootC, "gamma", "text")).hits).toHaveLength(1);
    let bResolved = false;
    const pendingB2 = search.search(rootB, "beta", "text").then((res) => {
      bResolved = true;
      return res;
    });
    // Forget C while D is blocked: C is revoked and must not use the fast path, and a queued lookup for C rejects if forgotten.
    await search.forget(rootC);
    let cSettled = false;
    const pendingC = search.search(rootC, "gamma", "text").finally(() => {
      cSettled = true;
    });
    // Yield so pendingC resolves realpath and enters the queue before forget revokes its ticket.
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(bResolved).toBe(false);
    expect(cSettled).toBe(false);
    await search.forget(rootC);

    blockD.release();
    await expect(pendingC).rejects.toThrow(/closed or its folder was released/);
    expect((await pendingD).hits).toHaveLength(1);
    expect((await pendingB2).hits).toHaveLength(1);

    // Close race: closing while a scan is blocked rejects warm searches immediately and resolves cleanly.
    await search.forget(rootD);
    const blockD2 = armBlock(rootD);
    currentGate = blockD2.gate;
    const pendingD2 = search.search(rootD, "delta", "text");
    await blockD2.entered;
    const closing = search.close();
    await expect(search.search(rootA, "alpha", "text")).rejects.toThrow(/closed or its folder was released/);
    blockD2.release();
    await expect(pendingD2).rejects.toThrow();
    await closing;
    expect(search.size).toBe(0);
  });
});
