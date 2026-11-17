import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupDataRoot, restoreBackup, unfinishedWork } from "../src/core/backup.ts";
import { WorkspaceBusy, WorkspaceLocks } from "../src/core/execution.ts";
import { Projects } from "../src/core/projects.ts";
import { InvalidRequest, RequestConflict } from "../src/core/requests.ts";
import { WorkspacePurge } from "../src/core/workspace-purge.ts";
import { openStore } from "../src/storage/store.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-purge-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  let store = await openStore(dataRoot);
  cleanups.push(() => store.close());
  const locks = new WorkspaceLocks();
  const projects = await Projects.open({ database: store.database, dataRoot, installRoot: "/nonexistent" });
  const project = await projects.create("workspace-purge-project", { name: "Retained" });
  const purge = new WorkspacePurge(store.database, dataRoot, locks);
  const snapshot = async () => {
    const item = (await purge.list()).workspaces.find((item) => item.id === project.id);
    if (item?.identity == null) throw new Error("missing workspace snapshot");
    return { root: item.root, identity: item.identity };
  };
  return {
    root,
    dataRoot,
    store,
    locks,
    projects,
    project,
    purge,
    snapshot,
    reopen: async () => {
      await store.close();
      store = await openStore(dataRoot);
      return new WorkspacePurge(store.database, dataRoot, locks);
    },
  };
}

describe("managed workspace cleanup", () => {
  it("keeps files on project removal, then deletes only the separately confirmed workspace without following links", async () => {
    const { root, dataRoot, projects, project, purge, snapshot } = await setup();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "external files stay");
    await writeFile(join(dataRoot, "credentials.key"), "fixture key stays");
    await writeFile(join(project.root, "notes.txt"), "delete me");
    await symlink(outside, join(project.root, "linked"));
    await symlink(join(dataRoot, "credentials.key"), join(project.root, "key-link"));
    const sibling = await projects.create("workspace-purge-sibling", { name: "Sibling" });
    expect((await purge.list()).workspaces).toEqual([]);
    expect(await lstat(join(dataRoot, "workspace-trash")).catch(() => undefined)).toBeUndefined();
    await expect(purge.purge(project.id, { root: project.root, identity: "1:1:1:1" })).rejects.toBeInstanceOf(
      InvalidRequest,
    );
    await projects.remove(project.id);
    expect(await readFile(join(project.root, "notes.txt"), "utf8")).toBe("delete me");
    const body = await snapshot();
    await expect(purge.purge(project.id, { ...body, root: outside })).rejects.toBeInstanceOf(RequestConflict);
    await purge.purge(project.id, body);
    expect(await lstat(project.root).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("external files stay");
    expect(await readFile(join(dataRoot, "credentials.key"), "utf8")).toBe("fixture key stays");
    expect((await lstat(sibling.root)).isDirectory()).toBe(true);
    expect((await purge.list()).workspaces).toEqual([]);
    await purge.purge(project.id, body);
    // Repeating the completed request cannot delete a new directory at the old path.
    await mkdir(project.root, { recursive: true });
    await writeFile(join(project.root, "new.txt"), "not the approved directory");
    await purge.purge(project.id, body);
    expect(await readFile(join(project.root, "new.txt"), "utf8")).toBe("not the approved directory");
  });

  it("never offers or deletes external folders, failed projects, or a forged managed path", async () => {
    const { root, store, projects, project, purge } = await setup();
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "keep.txt"), "keep");
    const other = await projects.create("workspace-purge-external", { name: "External", folder: external });
    await projects.remove(other.id);
    await expect(purge.purge(other.id, { root: external, identity: "1:1:1:1" })).rejects.toBeInstanceOf(InvalidRequest);
    await projects.remove(project.id);
    await store.database.run("UPDATE pal_projects SET root = ? WHERE id = ?", external, project.id);
    const listing = await purge.list();
    expect(listing.workspaces).toHaveLength(1);
    expect(listing.workspaces[0]).toMatchObject({ identity: null, problem: expect.stringMatching(/not a managed/) });
    await expect(purge.purge(project.id, { root: external, identity: "1:1:1:1" })).rejects.toBeInstanceOf(
      RequestConflict,
    );
    expect(await readFile(join(external, "keep.txt"), "utf8")).toBe("keep");
    await store.database.run("UPDATE pal_projects SET state = 'failed' WHERE id = ?", project.id);
    expect((await purge.list()).workspaces).toEqual([]);
  });

  it("refuses a replaced directory, parent or trash link and preserves unexpected container files", async () => {
    const { root, dataRoot, projects, project, purge, snapshot } = await setup();
    await projects.remove(project.id);
    const body = await snapshot();
    const original = `${project.root}-original`;
    await rename(project.root, original);
    await mkdir(project.root);
    await expect(purge.purge(project.id, body)).rejects.toBeInstanceOf(RequestConflict);
    await rm(project.root, { recursive: true });
    await rename(original, project.root);
    await writeFile(join(dirname(project.root), "unexpected"), "keep");
    await expect(purge.purge(project.id, body)).rejects.toBeInstanceOf(RequestConflict);
    await rm(join(dirname(project.root), "unexpected"));
    const container = dirname(project.root);
    await rename(container, `${container}-original`);
    const external = join(root, "outside");
    await mkdir(join(external, "workspace"), { recursive: true });
    await writeFile(join(external, "workspace", "keep.txt"), "keep");
    await symlink(external, container);
    expect((await purge.list()).workspaces[0]?.identity).toBeNull();
    await expect(purge.purge(project.id, body)).rejects.toBeInstanceOf(RequestConflict);
    await rm(container);
    await rename(`${container}-original`, container);
    await symlink(external, join(dataRoot, "workspace-trash"));
    await expect(purge.purge(project.id, body)).rejects.toBeInstanceOf(RequestConflict);
    await rm(join(dataRoot, "workspace-trash"));
    await rename(join(dataRoot, "projects"), join(dataRoot, "original-projects"));
    await symlink(external, join(dataRoot, "projects"));
    await expect(purge.purge(project.id, body)).rejects.toBeInstanceOf(RequestConflict);
    expect(await readFile(join(external, "workspace", "keep.txt"), "utf8")).toBe("keep");
  });

  it("refuses deletion while an overlapping writer still owns the workspace", async () => {
    const { projects, project, purge, locks, snapshot } = await setup();
    await projects.remove(project.id);
    const body = await snapshot();
    const release = Promise.withResolvers<undefined>();
    const running = locks.run(dirname(project.root), () => release.promise);
    await expect(purge.purge(project.id, body)).rejects.toBeInstanceOf(WorkspaceBusy);
    release.resolve(undefined);
    await running;
    const deleting = purge.purge(project.id, body);
    await expect(purge.purge(project.id, body)).rejects.toBeInstanceOf(WorkspaceBusy);
    await deleting;
    expect((await purge.list()).workspaces).toEqual([]);
  });

  it.each(["recorded", "moved", "partial", "workspace-gone", "container-gone", "trash-gone"] as const)(
    "inspects an interrupted deletion after restart (%s), without automatically retrying it",
    async (phase) => {
      const { dataRoot, store, projects, project, snapshot, reopen } = await setup();
      await projects.remove(project.id);
      await writeFile(join(project.root, "first.txt"), "first");
      await writeFile(join(project.root, "second.txt"), "second");
      const body = await snapshot();
      const directory = `${project.id}-interrupted`;
      const trash = join(dataRoot, "workspace-trash");
      const destination = join(trash, directory);
      await mkdir(trash);
      await store.database.run(
        "INSERT INTO pal_workspace_purges (project_id, directory, identity) VALUES (?, ?, ?)",
        project.id,
        directory,
        body.identity,
      );
      if (phase !== "recorded") await rename(dirname(project.root), destination);
      if (phase === "partial") await rm(join(destination, "workspace", "first.txt"));
      if (phase === "workspace-gone") await rm(join(destination, "workspace"), { recursive: true });
      if (phase === "container-gone" || phase === "trash-gone") await rm(destination, { recursive: true });
      if (phase === "trash-gone") await rm(trash, { recursive: true });
      const again = await reopen();
      if (phase === "recorded") expect((await lstat(project.root)).isDirectory()).toBe(true);
      if (phase === "moved" || phase === "partial")
        expect(await readFile(join(destination, "workspace", "second.txt"), "utf8")).toBe("second");
      expect((await again.list()).workspaces[0]).toMatchObject({ pending: true, identity: body.identity });
      await again.purge(project.id, body);
      expect((await again.list()).workspaces).toEqual([]);
      expect(await lstat(destination).catch(() => undefined)).toBeUndefined();
    },
  );

  it("bounds the retained list and reports unavailable folders without creating or deleting them", async () => {
    const { dataRoot, store, purge } = await setup();
    await store.database.transaction(async (tx) => {
      for (let index = 0; index < 101; index++) {
        const id = `missing-${String(index).padStart(3, "0")}`;
        await tx.run(
          "INSERT INTO pal_projects (id, request_id, digest, name, mode, state, root, created_at, removed_at) VALUES (?, ?, 'fixture', 'Missing', 'managed', 'ready', ?, 0, ?)",
          id,
          id,
          join(dataRoot, "projects", id, "workspace"),
          index + 1,
        );
      }
    });
    const listing = await purge.list();
    expect(listing.truncated).toBe(true);
    expect(listing.workspaces).toHaveLength(100);
    expect(listing.workspaces[0]?.id).toBe("missing-100");
    expect(listing.workspaces.every((item) => item.identity === null && item.problem !== undefined)).toBe(true);
    expect(await lstat(join(dataRoot, "workspace-trash")).catch(() => undefined)).toBeUndefined();
  });

  it.each(["recorded", "moved", "partial", "workspace-gone", "container-gone", "replaced"] as const)(
    "completes an interrupted deletion restored from a stopped backup (%s) only on explicit retry",
    async (phase) => {
      const { root, dataRoot, store, projects, project, snapshot } = await setup();
      await projects.remove(project.id);
      await writeFile(join(project.root, "kept.txt"), "kept");
      const body = await snapshot();
      const directory = `${project.id}-interrupted`;
      const destination = join(dataRoot, "workspace-trash", directory);
      await mkdir(join(dataRoot, "workspace-trash"));
      await store.database.run(
        "INSERT INTO pal_workspace_purges (project_id, directory, identity) VALUES (?, ?, ?)",
        project.id,
        directory,
        body.identity,
      );
      if (phase !== "recorded") await rename(dirname(project.root), destination);
      if (phase === "partial") await rm(join(destination, "workspace", "kept.txt"));
      if (phase === "workspace-gone") await rm(join(destination, "workspace"), { recursive: true });
      if (phase === "container-gone") await rm(destination, { recursive: true });
      await writeFile(join(dataRoot, "credentials.key"), randomBytes(32), { mode: 0o600 });
      await store.close();
      const backup = join(root, "backup");
      await backupDataRoot({
        dataRoot,
        output: backup,
        version: "test",
        includeCredentialKey: true,
        includeBrowserProfiles: false,
      });
      await rename(dataRoot, join(root, "data-before"));
      await restoreBackup(backup, dataRoot);
      const restored = await openStore(dataRoot);
      cleanups.push(() => restored.close());
      const purge = new WorkspacePurge(restored.database, dataRoot, new WorkspaceLocks());
      // Restoring deletes nothing.
      if (phase === "recorded") expect(await readFile(join(project.root, "kept.txt"), "utf8")).toBe("kept");
      if (phase === "moved") expect(await readFile(join(destination, "workspace", "kept.txt"), "utf8")).toBe("kept");
      if (phase === "replaced") {
        await rm(join(destination, "workspace"), { recursive: true });
        await mkdir(join(destination, "workspace"));
      }
      const [item] = (await purge.list()).workspaces;
      if (phase === "replaced") {
        expect(item).toMatchObject({ pending: true, identity: null });
        await expect(purge.purge(project.id, { root: project.root, identity: body.identity })).rejects.toBeInstanceOf(
          RequestConflict,
        );
        expect((await lstat(join(destination, "workspace"))).isDirectory()).toBe(true);
        return;
      }
      expect(item?.pending).toBe(true);
      expect(item?.problem).toBeUndefined();
      await purge.purge(project.id, { root: project.root, identity: item?.identity ?? "" });
      expect((await purge.list()).workspaces).toEqual([]);
      expect(await lstat(destination).catch(() => undefined)).toBeUndefined();
      expect(await unfinishedWork(restored.database, new Set(["pal_workspace_purges"]))).toEqual({ purges: 0 });
    },
  );

  it("refuses ambiguous interrupted locations instead of choosing files to delete", async () => {
    const { dataRoot, store, projects, project, purge, snapshot } = await setup();
    await projects.remove(project.id);
    const body = await snapshot();
    const directory = `${project.id}-ambiguous`;
    await mkdir(join(dataRoot, "workspace-trash", directory), { recursive: true });
    await store.database.run(
      "INSERT INTO pal_workspace_purges (project_id, directory, identity) VALUES (?, ?, ?)",
      project.id,
      directory,
      body.identity,
    );
    expect((await purge.list()).workspaces[0]).toMatchObject({
      identity: null,
      problem: expect.stringMatching(/Both/),
    });
    await expect(purge.purge(project.id, body)).rejects.toBeInstanceOf(RequestConflict);
    expect((await lstat(project.root)).isDirectory()).toBe(true);
  });
});
