import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeFiles, type WorktreeIntent } from "../src/core/worktree-files.ts";
import { ProjectSearch } from "../src/core/search.ts";
import { PrivateFiles } from "../src/core/file-policy.ts";
import { GitEffectUnknown, runGitEffect } from "../src/core/git.ts";

const exec = promisify(execFile);
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const git = (cwd: string, ...args: string[]) =>
  exec(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd },
  );

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-worktree-files-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const dataRoot = join(root, "data");
  await mkdir(source);
  await mkdir(dataRoot);
  await mkdir(join(source, "bin"));
  await git(source, "init", "-q");
  await writeFile(join(source, "file.txt"), "committed bytes\n");
  await writeFile(join(source, "binary.bin"), Buffer.from([0, 255, 1, 2]));
  await writeFile(join(source, "bin", "run.sh"), "#!/bin/sh\nprintf fixture\n");
  await chmod(join(source, "bin", "run.sh"), 0o755);
  await symlink("file.txt", join(source, "inside-link"));
  await writeFile(join(dataRoot, "credentials.key"), "private-worktree-fixture-needle");
  await symlink(join(dataRoot, "credentials.key"), join(source, "outside-link"));
  await git(source, "add", "file.txt", "binary.bin", "bin/run.sh", "inside-link", "outside-link");
  await git(source, "commit", "-qm", "base");
  const files = new WorktreeFiles(dataRoot, [dataRoot, "/nonexistent-install", "/nix/store"]);
  const plan = await files.plan(source, AbortSignal.timeout(10_000));
  const intent: WorktreeIntent = { ...plan, id: randomUUID(), nonce: randomUUID(), identity: null };
  return { root, source, dataRoot, files, intent };
}

async function provision(files: WorktreeFiles, intent: WorktreeIntent) {
  return files.provision(intent, AbortSignal.timeout(30_000), async (identity) => {
    intent.identity = identity;
  });
}

describe("raw Git worktree provisioning", () => {
  it("creates one detached worktree from committed bytes without copying dirt or running hooks/filters/startup files", async () => {
    const { source, root, files, intent } = await setup();
    const marker = join(root, "executed");
    await writeFile(join(source, ".gitattributes"), "*.txt filter=evil diff=evil\n");
    await writeFile(join(source, ".envrc"), `touch '${marker}'\n`);
    await git(source, "add", ".gitattributes", ".envrc");
    await git(source, "commit", "-qm", "attributes");
    Object.assign(intent, await files.plan(source, AbortSignal.timeout(10_000)));
    for (const key of [
      "filter.evil.clean",
      "filter.evil.smudge",
      "filter.evil.process",
      "diff.external",
      "core.fsmonitor",
    ])
      await git(source, "config", key, `touch ${marker}`);
    await writeFile(join(source, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(join(source, ".git", "hooks", "post-checkout"), 0o755);
    await writeFile(join(source, "file.txt"), "manual dirt\n");
    await writeFile(join(source, "untracked.txt"), "untracked dirt\n");
    const before = (await git(source, "ls-files", "--stage", "-z")).stdout;
    const startup = process.env.BASH_ENV;
    process.env.BASH_ENV = join(source, ".envrc");
    let identity;
    try {
      identity = await provision(files, intent);
    } finally {
      if (startup === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = startup;
    }
    const workspace = files.root(intent.id);
    expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("committed bytes\n");
    expect(await readFile(join(workspace, "binary.bin"))).toEqual(Buffer.from([0, 255, 1, 2]));
    expect(await readlink(join(workspace, "inside-link"))).toBe("file.txt");
    expect(await readlink(join(workspace, "outside-link"))).toBe(join(root, "data", "credentials.key"));
    await expect(access(join(workspace, "untracked.txt"))).rejects.toThrow();
    expect(await readFile(join(workspace, ".envrc"), "utf8")).toBe(`touch '${marker}'\n`);
    expect(await readFile(join(source, "file.txt"), "utf8")).toBe("manual dirt\n");
    expect((await git(source, "ls-files", "--stage", "-z")).stdout).toBe(before);
    await expect(access(marker)).rejects.toThrow();
    expect(await provision(files, intent)).toBe(identity);
    const listing = (await git(source, "worktree", "list", "--porcelain", "-z")).stdout;
    expect(listing.split("\0\0").filter((entry) => entry.startsWith(`worktree ${workspace}\0`))).toHaveLength(1);
  });

  it("does not let the native worktree index read an escaping symlink to private data", async () => {
    const { files, intent, dataRoot } = await setup();
    await provision(files, intent);
    const search = new ProjectSearch([dataRoot], await PrivateFiles.open([join(dataRoot, "credentials.key")]));
    cleanups.push(() => search.close());
    expect((await search.search(files.root(intent.id), "private-worktree-fixture-needle", "text")).hits).toEqual([]);
  });

  it("refuses changed files and a redirected .git file without overwriting source state", async () => {
    const { files, intent, source } = await setup();
    await provision(files, intent);
    const root = files.root(intent.id);
    await writeFile(join(root, "file.txt"), "manual workspace edit\n");
    await expect(provision(files, intent)).rejects.toThrow(/changed/);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("manual workspace edit\n");
    await writeFile(join(root, ".git"), `gitdir: ${join(source, ".git")}\n`);
    const index = (await git(source, "ls-files", "--stage", "-z")).stdout;
    await expect(provision(files, intent)).rejects.toThrow();
    expect((await git(source, "ls-files", "--stage", "-z")).stdout).toBe(index);
  });

  it("refuses an index changed after a completed receipt instead of treating the old receipt as current truth", async () => {
    const { files, intent } = await setup();
    await provision(files, intent);
    const root = files.root(intent.id);
    await writeFile(join(root, "file.txt"), "staged owner edit\n");
    await git(root, "add", "file.txt");
    await writeFile(join(root, "file.txt"), "committed bytes\n");
    const before = (await git(root, "ls-files", "--stage", "-z")).stdout;
    await expect(provision(files, intent)).rejects.toThrow(/index/);
    expect((await git(root, "ls-files", "--stage", "-z")).stdout).toBe(before);
  });

  it("does not repeat an effect with a missing receipt or silently accept a changed command", async () => {
    const { source, dataRoot } = await setup();
    const receipt = join(dataRoot, "effect-receipt");
    const args = ["config", "--add", "pal.fixture", "once"];
    await runGitEffect(source, args, receipt, AbortSignal.timeout(10_000));
    await unlink(receipt);
    await expect(runGitEffect(source, args, receipt, AbortSignal.timeout(10_000))).rejects.toBeInstanceOf(
      GitEffectUnknown,
    );
    expect((await git(source, "config", "--get-all", "pal.fixture")).stdout).toBe("once\n");
    await expect(
      runGitEffect(source, [...args.slice(0, -1), "changed"], receipt, AbortSignal.timeout(10_000)),
    ).rejects.toThrow(/intent/);
    await writeFile(receipt, "corrupt\n");
    await expect(runGitEffect(source, args, receipt, AbortSignal.timeout(10_000))).rejects.toThrow(/receipt/);
    expect((await git(source, "config", "--get-all", "pal.fixture")).stdout).toBe("once\n");
  });

  it("will not claim a pre-existing foreign path or accept a changed intent", async () => {
    const { files, intent } = await setup();
    await mkdir(files.root(intent.id), { recursive: true });
    await writeFile(join(files.root(intent.id), "keep"), "foreign files");
    await expect(provision(files, intent)).rejects.toThrow(/unregistered/);
    expect(await readFile(join(files.root(intent.id), "keep"), "utf8")).toBe("foreign files");
    const next = { ...intent, id: randomUUID(), identity: null };
    await provision(files, next);
    await expect(provision(files, { ...next, nonce: randomUUID() })).rejects.toThrow(/intent/);
  });

  it("rejects an unborn repository and oversized blobs before worktree registration", async () => {
    const { source, files, root } = await setup();
    const unborn = join(root, "unborn");
    await mkdir(unborn);
    await git(unborn, "init", "-q");
    await expect(files.plan(unborn, AbortSignal.timeout(10_000))).rejects.toThrow(/Git/);
    await writeFile(join(source, "large"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await git(source, "add", "large");
    await git(source, "commit", "-qm", "large");
    await expect(files.plan(source, AbortSignal.timeout(10_000))).rejects.toThrow(/worktree limit/);
    const listing = (await git(source, "worktree", "list", "--porcelain", "-z")).stdout;
    expect(listing.split("\0\0").filter(Boolean)).toHaveLength(1);
  });

  it("reconciles completed registration after SIGKILL without adding a second worktree", async () => {
    const { files, intent, source, root } = await setup();
    const journal = join(root, "intent.json");
    await writeFile(journal, JSON.stringify(intent));
    const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "worktree-child.ts"), root, journal], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    const lines = createInterface({ input: child.stdout });
    const [line] = await Promise.race([
      once(lines, "line"),
      once(child, "exit").then(() => {
        throw new Error("fixture exited before registration");
      }),
    ]);
    expect(JSON.parse(String(line))).toMatchObject({ registered: true });
    child.kill("SIGKILL");
    await once(child, "exit");
    const recovered = JSON.parse(await readFile(journal, "utf8")) as WorktreeIntent;
    await provision(files, recovered);
    expect(await readFile(join(files.root(intent.id), "file.txt"), "utf8")).toBe("committed bytes\n");
    const listing = (await git(source, "worktree", "list", "--porcelain", "-z")).stdout;
    expect(listing.split("\0\0").filter(Boolean)).toHaveLength(2);
  });
});
