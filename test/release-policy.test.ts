import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateReleaseDirectory, readReleaseJson, releaseLock, writeReleaseJson } from "../src/core/release-files.ts";
import {
  candidateFiles,
  checkCandidate,
  manifest,
  readSource,
  sourcePath,
  sourcePaths,
} from "../src/core/release-policy.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-release-policy-")));
  roots.push(root);
  return root;
}
async function source() {
  const root = await directory();
  for (const [path, text] of [
    ["src/core/owner.ts", "protected authorization"],
    ["test/fixed.test.ts", "protected evaluation"],
    ["web/src/app.css", "body { color: white; }"],
  ] as const) {
    await mkdir(join(root, path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), text);
  }
  const snapshot = await readSource(root, await sourcePaths(root));
  return {
    root,
    snapshot,
    base: manifest(snapshot, `/nix/store/${"0".repeat(32)}-pal`, `/nix/store/${"1".repeat(32)}-source`),
  };
}

describe("controlled release policy", () => {
  it("ignores tracked non-build skill links but refuses linked, missing, private or conflicted build inputs", () => {
    const expected = ["package.json", "web/src/app.css"];
    const entry = (path: string, mode = "100644", stage = "0") => `${mode} ${"0".repeat(40)} ${stage}\t${path}\0`;
    const index = expected.map((path) => entry(path)).join("");
    expect(candidateFiles(index + entry(".claude/skills/fixture", "120000") + entry("README.md"), expected)).toEqual(
      expected,
    );
    for (const invalid of [
      entry("package.json") + entry("web/src/app.css", "120000"),
      entry("package.json") + entry("web/src/app.css", "100644", "1"),
      index + entry("web/extra.ts"),
      entry("package.json"),
      index + entry("PLAN.md"),
      index + entry(".design/raw.html"),
      index + entry("../private"),
      index + entry("package.json"),
      index + "\ufffd",
    ])
      expect(() => candidateFiles(invalid, expected)).toThrow();
  });

  it("hashes exact public bytes and permits only exercised contribution changes", async () => {
    const { root, snapshot, base } = await source();
    expect(snapshot.files.map((file) => file.path)).toEqual([
      "src/core/owner.ts",
      "test/fixed.test.ts",
      "web/src/app.css",
    ]);
    await writeFile(join(root, "web/src/app.css"), "body { color: silver; }");
    const candidate = await readSource(
      root,
      snapshot.files.map((file) => file.path),
    );
    expect(candidate.digest).not.toBe(snapshot.digest);
    expect(candidate.compatibility).toBe(snapshot.compatibility);
    expect(() => checkCandidate(base, candidate)).not.toThrow();
    await writeFile(join(root, "src/core/owner.ts"), "weaken authorization");
    expect(() => checkCandidate(base, candidate)).not.toThrow();
    expect(() => checkCandidate(base, { ...candidate, compatibility: "changed" })).toThrow(/protected/);
    const changed = await readSource(
      root,
      snapshot.files.map((file) => file.path),
    );
    expect(() => checkCandidate(base, changed)).toThrow(/protected/);
  });

  it("refuses permission-only changes, so the review is always about contribution contents", async () => {
    const { root, snapshot, base } = await source();
    await chmod(join(root, "web/src/app.css"), 0o755);
    const changed = await readSource(
      root,
      snapshot.files.map((file) => file.path),
    );
    expect(changed.digest).not.toBe(snapshot.digest);
    expect(() => checkCandidate(base, changed)).toThrow(/executable permissions/);
  });

  it("refuses protected test replacement, schema drift and private/source-set changes", async () => {
    const { root, snapshot, base } = await source();
    await writeFile(join(root, "test/fixed.test.ts"), "skip the evaluation");
    expect(() => checkCandidate(base, snapshot)).not.toThrow();
    const replaced = await readSource(
      root,
      snapshot.files.map((file) => file.path),
    );
    expect(() => checkCandidate(base, replaced)).toThrow(/protected/);
    expect(() => checkCandidate({ ...base, schema: base.schema + 1 }, snapshot)).toThrow(/schema/);
    expect(() => checkCandidate(base, { ...snapshot, files: snapshot.files.slice(1) })).toThrow(/file set/);
    for (const path of [
      "../secret",
      "/etc/passwd",
      "src/../../secret",
      "AGENTS.md",
      "Plan.MD",
      ".design/raw.html",
      "src/node_modules/code.js",
      "x\\y",
    ])
      expect(sourcePath(path), path).toBe(false);
    await writeFile(join(root, "PLAN.md"), "private handoff");
    await expect(sourcePaths(root)).rejects.toThrow(/private/);
  });

  it("rejects links and oversize files without copying their target", async () => {
    const { root, snapshot } = await source();
    const outside = await directory(),
      secret = join(outside, "secret");
    await writeFile(secret, "private-canary");
    const file = join(root, "web/src/app.css");
    await rm(file);
    await symlink(secret, file);
    await expect(
      readSource(
        root,
        snapshot.files.map((file) => file.path),
      ),
    ).rejects.toThrow();
    expect(await readFile(secret, "utf8")).toBe("private-canary");
    await rm(file);
    await link(secret, file);
    await expect(
      readSource(
        root,
        snapshot.files.map((file) => file.path),
      ),
    ).rejects.toThrow(/linked/);
    await rm(file);
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(
      readSource(
        root,
        snapshot.files.map((file) => file.path),
      ),
    ).rejects.toThrow(/too large/);
  });

  it("rejects a source descriptor moved outside its admitted directory during the read", async () => {
    const { root } = await source();
    const outside = await directory();
    const probe = await open(join(root, "web/src/app.css"), "r");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const read = prototype.read;
    await probe.close();
    vi.spyOn(prototype, "read").mockImplementationOnce(async function (this: FileHandle, ...args) {
      await rename(join(root, "web"), join(outside, "moved"));
      return Reflect.apply(read, this, args) as ReturnType<FileHandle["read"]>;
    });
    await expect(readSource(root, ["web/src/app.css"])).rejects.toThrow(/confined file descriptor/);
    expect(await readFile(join(outside, "moved/src/app.css"), "utf8")).toBe("body { color: white; }");
  });

  it("keeps JSON private and atomic, and refuses linked, corrupt or oversized metadata", async () => {
    const root = await directory(),
      control = join(root, "control");
    await privateReleaseDirectory(control);
    const path = join(control, "selection.json");
    await writeReleaseJson(path, { selected: "old", phase: "stable" });
    await writeReleaseJson(path, { selected: "new", phase: "trying" });
    expect(await readReleaseJson(path)).toEqual({ selected: "new", phase: "trying" });
    expect((await readdir(control)).some((name) => name.endsWith(".next"))).toBe(false);
    await expect(writeReleaseJson(path, "x".repeat(1024 * 1024))).rejects.toThrow(/bounds/);
    await writeFile(path, "invalid-private-canary", { mode: 0o600 });
    await expect(readReleaseJson(path)).rejects.toThrow("release metadata is corrupt");
    const other = join(root, "keep");
    await writeFile(other, "keep", { mode: 0o600 });
    await rm(path);
    await symlink(other, path);
    await expect(readReleaseJson(path)).rejects.toThrow();
    await expect(writeReleaseJson(path, { selected: "forged" })).rejects.toThrow();
    expect(await readFile(other, "utf8")).toBe("keep");
    await chmod(control, 0o755);
    await expect(privateReleaseDirectory(control)).rejects.toThrow(/owner-only/);
  });

  it("holds the process lock after flock exits and releases it only when the descriptor closes", async () => {
    const root = await directory(),
      path = join(root, "release.lock");
    const first = await releaseLock(path);
    try {
      await expect(releaseLock(path)).rejects.toThrow(/another release/);
    } finally {
      await first.close();
    }
    const next = await releaseLock(path);
    await next.close();
  });
});
