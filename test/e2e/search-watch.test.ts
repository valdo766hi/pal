import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { FileFinder, type WatchBatchCallback, type WatchEvent } from "@ff-labs/fff-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSearch } from "../../src/core/search.ts";
import { PrivateFiles } from "../../src/core/file-policy.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe("native project search watcher", () => {
  it("applies real create, modify, rename and removal events with Unicode paths and text", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-native-watch-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "seed.txt"), "seed");
    const events: WatchEvent[] = [];
    let stopped = 0;
    const nativeWatch = FileFinder.prototype.watch;
    vi.spyOn(FileFinder.prototype, "watch").mockImplementation(function (
      this: FileFinder,
      pattern: string | WatchBatchCallback,
      callback?: WatchBatchCallback,
    ) {
      const listener = typeof pattern === "function" ? pattern : callback;
      if (listener === undefined) throw new Error("missing watcher callback");
      const record: WatchBatchCallback = (batch) => {
        events.push(...batch);
        listener(batch);
      };
      const watch = nativeWatch.bind(this);
      const result = typeof pattern === "function" ? watch(record) : watch(pattern, record);
      if (!result.ok) return result;
      return {
        ok: true,
        value: () => {
          result.value();
          stopped++;
        },
      };
    });
    const created = vi.spyOn(FileFinder, "create");
    const search = new ProjectSearch([], await PrivateFiles.open([]), (options) => FileFinder.create(options));
    cleanups.push(() => search.close());
    expect(await search.search(root, "watchfixture", "files")).toMatchObject({ indexing: false, hits: [] });
    const initial = created.mock.results[0];
    if (initial?.type !== "return" || !initial.value.ok) throw new Error("missing native finder");
    const finder = initial.value.value;
    expect(finder.isDestroyed).toBe(false);
    const paths = async () =>
      (await search.search(root, "watchfixture", "files")).hits.map((hit) => hit.path.normalize("NFC")).sort();
    const delivered = (since: number, kind: WatchEvent["kind"], path: string) =>
      events
        .slice(since)
        .some((event) =>
          event.kind === "rescan"
            ? event.path.normalize("NFC") === root.normalize("NFC")
            : event.kind === kind && event.path.normalize("NFC") === path.normalize("NFC"),
        );
    const wait = { timeout: 5000 };
    const directory = join(root, "notes α");
    const first = join(directory, "watchfixture-café-🙂.txt");
    const next = join(directory, "watchfixture-révisé-β.txt");
    let since = events.length;
    await mkdir(directory);
    await writeFile(first, "🙂 café watchneedle first\n");
    await expect.poll(() => delivered(since, "created", first), wait).toBe(true);
    await expect.poll(paths, wait).toEqual([relative(root, first).normalize("NFC")]);
    const found = await search.search(root, "watchneedle", "text");
    expect(found.indexing).toBe(false);
    expect(found.hits).toHaveLength(1);
    const hit = found.hits[0];
    if (hit === undefined) throw new Error("missing native text match");
    expect(hit.ranges?.map(([start, end]) => hit.text?.slice(start, end))).toEqual(["watchneedle"]);
    expect(await readFile(join(root, hit.path), "utf8")).toBe("🙂 café watchneedle first\n");

    since = events.length;
    await writeFile(first, "🙂 café watchneedle second\n");
    await expect.poll(() => delivered(since, "modified", first), wait).toBe(true);
    await expect
      .poll(async () => (await search.search(root, "watchneedle", "text")).hits[0]?.text, wait)
      .toBe("🙂 café watchneedle second");

    since = events.length;
    await rename(first, next);
    await expect.poll(() => delivered(since, "renamed", next), wait).toBe(true);
    await expect.poll(paths, wait).toEqual([relative(root, next).normalize("NFC")]);
    const moved = events.slice(since).find((event) => event.kind === "renamed");
    if (moved !== undefined) expect(moved.from?.normalize("NFC")).toBe(first.normalize("NFC"));

    since = events.length;
    await rm(next);
    await expect.poll(() => delivered(since, "removed", next), wait).toBe(true);
    await expect.poll(paths, wait).toEqual([]);
    expect((await search.search(root, "watchneedle", "text")).hits).toEqual([]);
    await search.forget(root);
    expect(stopped).toBe(1);
    expect(finder.isDestroyed).toBe(true);
    expect(search.size).toBe(0);
  });
});
