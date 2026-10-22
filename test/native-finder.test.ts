import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NativeFinder, type Finder } from "../src/core/native-finder.ts";
import { PrivateFiles } from "../src/core/file-policy.ts";
import { ProjectSearch } from "../src/core/search.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-native-finder-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "seed.txt"), "public needle fixture\n");
  return root;
}

it("serves live native content and Unicode watcher updates across the process boundary", async () => {
  const root = await fixture();
  const search = new ProjectSearch([], await PrivateFiles.open([]));
  cleanups.push(() => search.close());
  expect((await search.search(root, "needle", "text")).hits).toMatchObject([
    { path: "seed.txt", text: "public needle fixture" },
  ]);
  await mkdir(join(root, "漢 space"));
  await writeFile(join(root, "漢 space", "snow 雪.txt"), "public snow needle\n");
  await expect
    .poll(async () => (await search.search(root, "snow", "text")).hits.map((hit) => hit.path.normalize("NFC")))
    .toEqual(["漢 space/snow 雪.txt"]);
  await writeFile(join(root, "seed.txt"), "revised needle\n");
  await expect
    .poll(async () => (await search.search(root, "revised", "regex")).hits)
    .toMatchObject([{ path: "seed.txt", text: "revised needle" }]);
  await expect(search.search(root, "[", "regex")).rejects.toThrow(/invalid regex/);
});

it("reclaims a crashed native process and recreates the index without a search fallback", async () => {
  const root = await fixture();
  const finders: NativeFinder[] = [];
  const search = new ProjectSearch([], await PrivateFiles.open([]), async (options) => {
    const opened = await NativeFinder.open(options);
    if (opened.ok) finders.push(opened.value);
    return opened;
  });
  cleanups.push(() => search.close());
  expect((await search.search(root, "needle", "text")).hits).toHaveLength(1);
  const first = finders[0];
  if (first?.pid === undefined) throw new Error("missing native finder process");
  process.kill(-first.pid, "SIGKILL");
  await first.closed;
  expect(first.isDestroyed).toBe(true);
  expect((await search.search(root, "needle", "text")).hits).toHaveLength(1);
  expect(finders).toHaveLength(2);
});

it("joins a finder initialized concurrently with shutdown rather than publishing it afterwards", async () => {
  const root = await fixture();
  const ready = Promise.withResolvers<NativeFinder>();
  const release = Promise.withResolvers<undefined>();
  const search = new ProjectSearch([], await PrivateFiles.open([]), async (options) => {
    const opened = await NativeFinder.open(options);
    if (!opened.ok) throw new Error(opened.error);
    ready.resolve(opened.value);
    await release.promise;
    return opened;
  });
  cleanups.push(() => search.close());
  const finding = search.search(root, "needle", "text");
  try {
    const finder = await Promise.race([
      ready.promise,
      finding.then(() => {
        throw new Error("finder published before its initialization barrier");
      }),
    ]);
    const closed = search.close();
    release.resolve(undefined);
    await expect(finding).rejects.toThrow(/closed/);
    await closed;
    expect(finder.isDestroyed).toBe(true);
    await finder.closed;
    expect(search.size).toBe(0);
  } finally {
    release.resolve(undefined);
    await finding.catch(() => {});
  }
});

it("does not publish or query an index forgotten while its factory was pending", async () => {
  const root = await fixture();
  const ready = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let destroyed = false;
  const unexpected = () => {
    throw new Error("queried a forgotten index");
  };
  const finder: Finder = {
    get isDestroyed() {
      return destroyed;
    },
    fileSearch: unexpected,
    grep: unexpected,
    scanFiles: () => ({ ok: true, value: undefined }),
    waitForScan: async () => ({ ok: true, value: true }),
    watch: () => ({ ok: true, value: () => {} }),
    destroy: () => {
      destroyed = true;
    },
  };
  const search = new ProjectSearch([], await PrivateFiles.open([]), async () => {
    ready.resolve(undefined);
    await release.promise;
    return { ok: true, value: finder };
  });
  cleanups.push(() => search.close());
  const finding = search.search(root, "seed", "files");
  try {
    await ready.promise;
    const forgotten = search.forget(root);
    release.resolve(undefined);
    await expect(finding).rejects.toThrow(/closed|released/);
    await forgotten;
    expect(destroyed).toBe(true);
    expect(search.size).toBe(0);
  } finally {
    release.resolve(undefined);
    await finding.catch(() => {});
  }
});
