import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { Changes } from "../src/core/changes.ts";
import { WorkspaceBusy, WorkspaceLocks } from "../src/core/execution.ts";
import { fileTools } from "../src/core/files.ts";
import { PrivateFiles } from "../src/core/file-policy.ts";
import { Projects } from "../src/core/projects.ts";
import { openStore } from "../src/storage/store.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  exec(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
    { cwd },
  );

async function setup(committed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-changes-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "pal-data");
  const store = await openStore(dataRoot);
  cleanups.push(() => store.close());
  await git(root, "init", "-q");
  await writeFile(join(root, "file.txt"), "before\n");
  await writeFile(join(root, "deleted.txt"), "old\n");
  if (committed) {
    await git(root, "add", "file.txt", "deleted.txt");
    await git(root, "commit", "-qm", "base");
  }
  const projects = await Projects.open({ database: store.database, dataRoot, installRoot: "/nonexistent-install" });
  const project = await projects.create("fixture-project", { name: "Repo", folder: root });
  const changes = new Changes(
    store.database,
    projects,
    dataRoot,
    await PrivateFiles.open([store.path, `${store.path}-wal`, `${store.path}-shm`]),
  );
  return { root, dataRoot, store, projects, project, changes };
}

describe("revision-bound Git changes", () => {
  it("reviews ignored files only with explicit scope, including unusual names, without broadening protected paths", async () => {
    const { root, dataRoot, project, changes, store } = await setup();
    const path = "-local\n雪.secret";
    await writeFile(join(root, ".gitignore"), "*.secret\n");
    await writeFile(join(root, path), "ignored fixture\n");
    await writeFile(join(dataRoot, "private.secret"), "never reveal fixture");
    await symlink(join(dataRoot, "private.secret"), join(root, "escape.secret"));
    expect(JSON.stringify(await changes.list(project.id))).not.toContain("ignored fixture");
    const visible = await changes.list(project.id, "include-ignored");
    const file = visible.files.find((file) => file.path === path);
    expect(file).toMatchObject({ ignored: true, status: "A", patch: expect.stringContaining("ignored fixture") });
    expect(visible.files.find((file) => file.path === "escape.secret")).toMatchObject({
      ignored: true,
      patch: "",
      problem: expect.any(String),
    });
    expect(JSON.stringify(visible)).not.toContain("never reveal fixture");
    const revision = file?.revision ?? "";
    await expect(changes.review(project.id, path, revision, true)).rejects.toMatchObject({
      code: "ignored_permission",
    });
    await expect(changes.comment(project.id, path, revision, 1, "Review")).rejects.toMatchObject({
      code: "ignored_permission",
    });
    await changes.review(project.id, path, revision, true, "include-ignored");
    const comment = await changes.comment(project.id, path, revision, 1, "Review", "include-ignored");
    expect((await changes.list(project.id)).comments).toEqual([]);
    expect((await changes.list(project.id, "include-ignored")).comments).toMatchObject([
      { id: comment.id, lineText: "ignored fixture" },
    ]);
    expect((await changes.list(project.id, "include-ignored")).comments[0]?.sent).toBe(false);
    await expect(changes.discard(project.id, path, revision)).rejects.toMatchObject({ code: "ignored_permission" });
    await changes.discard(project.id, path, revision, "include-ignored");
    await expect(access(join(root, path))).rejects.toThrow();
    expect((await changes.list(project.id, "include-ignored")).comments).toEqual([]);
    expect(await store.database.all("SELECT * FROM pal_change_reviews WHERE path = ?", path)).toEqual([]);
    expect(await readFile(join(dataRoot, "private.secret"), "utf8")).toBe("never reveal fixture");
  });

  it("does not remember ignored-review permission across store reopen or retain newly ignored excerpts in normal results", async () => {
    const { root, dataRoot, project, changes, store } = await setup();
    await writeFile(join(root, "note.local"), "local fixture line\n");
    const file = (await changes.list(project.id)).files.find((file) => file.path === "note.local");
    const comment = await changes.comment(project.id, "note.local", file?.revision ?? "", 1, "Local decision");
    await writeFile(join(root, ".gitignore"), "*.local\n");
    const normal = await changes.list(project.id);
    expect(normal.files.some((file) => file.path === "note.local")).toBe(false);
    expect(normal.comments).toEqual([]);
    await store.close();
    const reopened = await openStore(dataRoot);
    cleanups.push(() => reopened.close());
    const projects = await Projects.open({
      database: reopened.database,
      dataRoot,
      installRoot: "/nonexistent-install",
    });
    const next = new Changes(
      reopened.database,
      projects,
      dataRoot,
      await PrivateFiles.open([reopened.path, `${reopened.path}-wal`, `${reopened.path}-shm`]),
    );
    expect((await next.list(project.id)).comments).toEqual([]);
    expect((await next.list(project.id, "include-ignored")).comments).toMatchObject([{ id: comment.id }]);
  });

  it("captures before file tools mutate, includes manual dirt and never moves the recorded baseline", async () => {
    const { root, dataRoot, store, projects, project, changes } = await setup();
    const head = (await git(root, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(root, "file.txt"), "manual edit\n");
    const locks = new WorkspaceLocks((root) => changes.capture(root));
    const tools = fileTools({
      root: async () => root,
      deny: [dataRoot],
      privateFiles: await PrivateFiles.open([store.path, `${store.path}-wal`, `${store.path}-shm`]),
      locks,
    });
    const write = tools.tools?.find((tool) => tool.name === "files_write") as ToolRegistration;
    const expectedHash = createHash("sha256").update("manual edit\n").digest("hex");
    await write.execute(
      { path: "file.txt", content: "after\n", expectedHash } as never,
      { conversationId: 1 as ConversationId } as ToolExecutionApi,
      context,
    );
    await writeFile(join(root, "new.txt"), "new\n");
    await unlink(join(root, "deleted.txt"));
    const first = await changes.list(project.id);
    expect(first.base).toBe(head);
    expect(first.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "deleted.txt", status: "D" },
      { path: "file.txt", status: "M" },
      { path: "new.txt", status: "A" },
    ]);
    expect(first.files.find((file) => file.path === "file.txt")?.patch).toContain("-before\n+after");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("after\n");
    await git(root, "add", "file.txt");
    await git(root, "commit", "-qm", "later");
    expect(
      (
        await new Changes(
          store.database,
          projects,
          dataRoot,
          await PrivateFiles.open([store.path, `${store.path}-wal`, `${store.path}-shm`]),
        ).list(project.id)
      ).base,
    ).toBe(head);
  });

  it("moves the baseline to a later commit only on the owner's explicit, current request", async () => {
    const { root, project, changes } = await setup();
    const base = (await git(root, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(root, "file.txt"), "committed\n");
    const edited = (await changes.list(project.id)).files.find((file) => file.path === "file.txt");
    await changes.review(project.id, "file.txt", edited?.revision ?? "", true);
    await git(root, "commit", "-qam", "agent commit");
    const later = (await git(root, "rev-parse", "HEAD")).stdout.trim();
    const committed = await changes.list(project.id);
    expect(committed).toMatchObject({ base, head: later });
    expect(committed.files.map((file) => file.path)).toEqual(["file.txt"]);

    // A request made from an older view changes nothing.
    await expect(changes.moveBaseline(project.id, later, later)).rejects.toMatchObject({ code: "changes_stale" });
    await expect(changes.moveBaseline(project.id, base, base)).rejects.toMatchObject({ code: "changes_stale" });
    expect((await changes.list(project.id)).base).toBe(base);

    await changes.moveBaseline(project.id, base, later);
    expect(await changes.list(project.id)).toMatchObject({ base: later, head: later, files: [] });
    // Later edits compare with the new baseline, and Discard restores the committed text.
    await writeFile(join(root, "file.txt"), "after commit\n");
    const next = (await changes.list(project.id)).files[0];
    expect(next).toMatchObject({
      path: "file.txt",
      reviewed: false,
      patch: expect.stringContaining("-committed\n+after commit"),
    });
    await changes.discard(project.id, "file.txt", next?.revision ?? "");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("committed\n");
  });

  it("binds reviewed marks to bytes and rejects stale reviews, including after reopen", async () => {
    const { root, dataRoot, store, project, changes } = await setup();
    await writeFile(join(root, "file.txt"), "manual\n");
    const file = (await changes.list(project.id)).files[0];
    if (file === undefined) throw new Error("missing diff");
    expect(file.patch).toContain("+manual");
    await changes.review(project.id, file.path, file.revision, true);
    expect((await changes.list(project.id)).files[0]?.reviewed).toBe(true);
    await store.close();
    const reopened = await openStore(dataRoot);
    cleanups.push(() => reopened.close());
    const projects = await Projects.open({ database: reopened.database, dataRoot, installRoot: "/nonexistent" });
    const next = new Changes(
      reopened.database,
      projects,
      dataRoot,
      await PrivateFiles.open([reopened.path, `${reopened.path}-wal`, `${reopened.path}-shm`]),
    );
    expect((await next.list(project.id)).files[0]?.reviewed).toBe(true);
    await writeFile(join(root, "file.txt"), "later\n");
    await expect(next.review(project.id, file.path, file.revision, true)).rejects.toMatchObject({
      status: 409,
      code: "changes_stale",
    });
    expect((await next.list(project.id)).files[0]?.reviewed).toBe(false);
    await projects.remove(project.id);
    await expect(next.list(project.id)).rejects.toMatchObject({ status: 404 });
  });

  it("discards one file to the baseline only while it still matches the revision shown", async () => {
    const { root, project, changes, dataRoot, store, projects } = await setup();
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "run.sh"), "#!/bin/sh\n");
    await chmod(join(root, "bin", "run.sh"), 0o755);
    await symlink("file.txt", join(root, "link"));
    await git(root, "add", "bin/run.sh", "link");
    await git(root, "commit", "-qm", "more");
    await writeFile(join(root, "file.txt"), "after\n");
    await unlink(join(root, "deleted.txt"));
    await rm(join(root, "bin"), { recursive: true });
    await unlink(join(root, "link"));
    await writeFile(join(root, "new.txt"), "new\n");
    const locks = new WorkspaceLocks();
    const discarding = new Changes(
      store.database,
      projects,
      dataRoot,
      await PrivateFiles.open([store.path, `${store.path}-wal`, `${store.path}-shm`]),
      locks,
    );
    const revision = async (path: string) =>
      (await changes.list(project.id)).files.find((file) => file.path === path)?.revision ?? "";

    // Each kind of later change makes the revision shown stale; nothing is touched.
    const shown = await revision("file.txt");
    await changes.review(project.id, "file.txt", shown, true);
    await writeFile(join(root, "file.txt"), "later\n");
    const stale = { status: 409, code: "changes_stale" };
    await expect(discarding.discard(project.id, "file.txt", shown)).rejects.toMatchObject(stale);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("later\n");
    const added = await revision("new.txt");
    await writeFile(join(root, "new.txt"), "newer\n");
    await expect(discarding.discard(project.id, "new.txt", added)).rejects.toMatchObject(stale);
    const deleted = await revision("deleted.txt");
    await writeFile(join(root, "deleted.txt"), "recreated\n");
    await expect(discarding.discard(project.id, "deleted.txt", deleted)).rejects.toMatchObject(stale);
    expect(await readFile(join(root, "deleted.txt"), "utf8")).toBe("recreated\n");
    await unlink(join(root, "deleted.txt"));

    // Pal's own writes and commands hold the workspace lock, so a discard cannot interleave with them.
    let release = () => {};
    const held = locks.run(root, () => new Promise<void>((resolve) => (release = resolve)));
    await expect(discarding.discard(project.id, "deleted.txt", deleted)).rejects.toBeInstanceOf(WorkspaceBusy);
    release();
    await held;

    await writeFile(join(root, "file.txt"), "after\n");
    await discarding.discard(project.id, "file.txt", shown);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("before\n");
    await discarding.discard(project.id, "deleted.txt", deleted);
    expect(await readFile(join(root, "deleted.txt"), "utf8")).toBe("old\n");
    await discarding.discard(project.id, "bin/run.sh", await revision("bin/run.sh"));
    expect((await stat(join(root, "bin", "run.sh"))).mode & 0o777).toBe(0o755);
    await discarding.discard(project.id, "new.txt", await revision("new.txt"));
    await expect(access(join(root, "new.txt"))).rejects.toThrow();
    await expect(discarding.discard(project.id, "link", await revision("link"))).rejects.toMatchObject({
      code: "changes_unsupported",
    });
    await expect(discarding.discard(project.id, ".git/config", "0".repeat(64))).rejects.toThrow(/protected/);
    expect((await changes.list(project.id)).files.map((file) => file.path)).toEqual(["link"]);
    // The review mark went with the discarded bytes.
    await writeFile(join(root, "file.txt"), "after\n");
    expect((await changes.list(project.id)).files.find((file) => file.path === "file.txt")?.reviewed).toBe(false);
  });

  it("keeps line comments on the revision shown and marks them outdated when that line changes", async () => {
    const { root, project, changes, store } = await setup();
    await writeFile(join(root, "file.txt"), "one\ntwo\nthree\n");
    const shown = (await changes.list(project.id)).files[0];
    if (shown === undefined) throw new Error("missing diff");
    await expect(changes.comment(project.id, "file.txt", "0".repeat(64), 2, "Rename")).rejects.toMatchObject({
      code: "changes_stale",
    });
    await expect(changes.comment(project.id, "file.txt", shown.revision, 4, "Past the end")).rejects.toMatchObject({
      status: 400,
    });
    const comment = await changes.comment(project.id, "file.txt", shown.revision, 2, "  Rename two.  ");
    expect(comment).toMatchObject({ line: 2, lineText: "two", body: "Rename two.", sent: false, outdated: false });
    await changes.comment(project.id, "file.txt", shown.revision, 3, "Keep three.");

    // Editing another line keeps the comment current; editing its own line makes it outdated, not moved or lost.
    await writeFile(join(root, "file.txt"), "ONE\ntwo\nthree\n");
    expect((await changes.list(project.id)).comments.map((c) => [c.line, c.outdated])).toEqual([
      [2, false],
      [3, false],
    ]);
    await writeFile(join(root, "file.txt"), "ONE\nTWO\nthree\n");
    const listed = await changes.list(project.id);
    expect(listed.comments.map((c) => [c.lineText, c.outdated])).toEqual([
      ["two", true],
      ["three", false],
    ]);
    // An old composed-only receipt must not become evidence of durable admission after an upgrade.
    await store.database.run("UPDATE pal_change_comments SET sent_at = ? WHERE id = ?", Date.now(), comment.id);
    expect((await changes.list(project.id)).comments.map((c) => c.sent)).toEqual([false, false]);
    await changes.uncomment(project.id, comment.id);
    expect((await changes.list(project.id)).comments.map((c) => c.body)).toEqual(["Keep three."]);

    // A file that stops differing leaves its comments listed as outdated until deleted; discarding removes them.
    await writeFile(join(root, "file.txt"), "before\n");
    expect((await changes.list(project.id)).comments.map((c) => c.outdated)).toEqual([true]);
    await writeFile(join(root, "file.txt"), "one\ntwo\nthree\n");
    const again = (await changes.list(project.id)).files[0];
    await changes.discard(project.id, "file.txt", again?.revision ?? "");
    expect((await changes.list(project.id)).comments).toEqual([]);
  });

  it("detects edits beyond a comment's display excerpt", async () => {
    const { root, project, changes } = await setup();
    const prefix = "x".repeat(1200);
    await writeFile(join(root, "file.txt"), `${prefix}before\n`);
    const revision = (await changes.list(project.id)).files[0]?.revision ?? "";
    await changes.comment(project.id, "file.txt", revision, 1, "Check the end of this line.");
    expect((await changes.list(project.id)).comments[0]).toMatchObject({ outdated: false });
    await writeFile(join(root, "file.txt"), `${prefix}after\n`);
    expect((await changes.list(project.id)).comments[0]).toMatchObject({ outdated: true });
  });

  it("bounds comments per project", async () => {
    const { root, project, changes } = await setup();
    await writeFile(join(root, "file.txt"), "line\n");
    const revision = (await changes.list(project.id)).files[0]?.revision ?? "";
    for (let i = 0; i < 200; i++) await changes.comment(project.id, "file.txt", revision, 1, `note ${i}`);
    await expect(changes.comment(project.id, "file.txt", revision, 1, "one more")).rejects.toMatchObject({
      code: "comments_full",
    });
  });

  it("never invokes repository clean filters, textconv, external diffs or hooks", async () => {
    const { root, project, changes } = await setup();
    const marker = join(root, "executed");
    for (const key of ["filter.evil.clean", "diff.evil.textconv", "diff.external", "core.fsmonitor"])
      await git(root, "config", key, `touch ${marker}`);
    await writeFile(join(root, ".gitattributes"), "*.txt filter=evil diff=evil\n*.secret filter=evil diff=evil\n");
    await writeFile(join(root, ".gitignore"), "*.secret\n");
    await writeFile(join(root, "local.secret"), "ignored fixture\n");
    await writeFile(join(root, "file.txt"), "after\n");
    const result = await changes.list(project.id, "include-ignored");
    expect(result.files.find((file) => file.path === "file.txt")?.patch).toContain("+after");
    expect(result.files.find((file) => file.path === "local.secret")?.patch).toContain("+ignored fixture");
    await expect(access(marker)).rejects.toThrow();
  });

  it("shows unsupported bytes and links without reading Pal data or escaping the project", async () => {
    const { root, dataRoot, project, changes } = await setup();
    await writeFile(join(dataRoot, "private.txt"), "NEVER DISPLAY");
    await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "large"), "x".repeat(256 * 1024 + 1));
    await symlink(join(dataRoot, "private.txt"), join(root, "link"));
    const result = await changes.list(project.id);
    expect(result.files.map((file) => file.path)).toEqual(["binary", "large", "link"]);
    expect(result.files.every((file) => file.problem !== undefined && file.patch === "")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("NEVER DISPLAY");
    await expect(changes.review(project.id, "link", "", true)).rejects.toMatchObject({ status: 409 });
  });

  it("supports an unborn repository, bounds scans and does not invent a non-Git rollback", async () => {
    const { root, project, changes, projects } = await setup(false);
    expect((await changes.list(project.id)).files.every((file) => file.status === "A")).toBe(true);
    await Promise.all(Array.from({ length: 130 }, (_, i) => writeFile(join(root, `extra-${i}`), "x")));
    expect(await changes.list(project.id)).toMatchObject({ truncated: true });
    const folder = join(root, "nested");
    await mkdir(folder);
    const nested = await projects.create("nested-project", { name: "Nested", folder });
    expect(await changes.list(nested.id)).toMatchObject({ state: "unavailable", files: [] });
    await expect(changes.review(nested.id, "file.txt", "0".repeat(64), true)).rejects.toMatchObject({ status: 409 });
    await expect(changes.comment(nested.id, "file.txt", "0".repeat(64), 1, "Unavailable")).rejects.toMatchObject({
      status: 409,
    });
  });
});
