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
});
