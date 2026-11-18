import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Projects } from "../src/core/projects.ts";
import { openStore } from "../src/storage/store.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A project recorded as provisioning, as a crash right after the record would leave it. */
async function interrupted(dirs: "none" | "parent" | "symlink") {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-projects-test-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  cleanups.push(() => store.close());
  const root = join(dataRoot, "projects", "p-1", "workspace");
  await store.database.run(
    "INSERT INTO pal_projects (id, request_id, digest, name, mode, state, root, created_at) VALUES ('p-1', 'project-request', 'd', 'Notes', 'managed', 'provisioning', ?, 0)",
    root,
  );
  if (dirs !== "none") await mkdir(dirname(root), { recursive: true });
  if (dirs === "symlink") await symlink(tmpdir(), root);
  const projects = await Projects.open({ database: store.database, dataRoot, installRoot: "/nonexistent" });
  return { projects, root };
}

describe("managed workspaces", () => {
  it.each(["none", "parent"] as const)("finish provisioning after a crash (directories created: %s)", async (dirs) => {
    const { projects, root } = await interrupted(dirs);
    expect(await projects.get("p-1")).toMatchObject({ state: "ready", root });
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it("refuses a folder inside Pal's data even when its name starts with two dots, and allows a sibling", async () => {
    const { projects } = await interrupted("none");
    const dataRoot = dirname(dirname(dirname((await projects.get("p-1"))?.root ?? "")));
    for (const [index, inside] of ["..reference", "projects/..notes"].entries()) {
      await mkdir(join(dataRoot, inside), { recursive: true });
      await expect(
        projects.create(`inside-request-${index}`, { name: "Inside", folder: join(dataRoot, inside) }),
      ).rejects.toThrow(/inside Pal's own files/);
    }
    const sibling = `${dataRoot}-sibling`;
    await mkdir(sibling);
    cleanups.push(() => rm(sibling, { recursive: true, force: true }));
    expect(await projects.create("sibling-request", { name: "Sibling", folder: sibling })).toMatchObject({
      root: sibling,
    });
  });

  it("refuses to claim something else at the workspace path", async () => {
    const { projects } = await interrupted("symlink");
    expect(await projects.get("p-1")).toMatchObject({
      state: "failed",
      error: expect.stringMatching(/not a workspace/),
    });
  });
});
