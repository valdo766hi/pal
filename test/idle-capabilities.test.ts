import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { terminalHome } from "./fixtures/terminal-home.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

/** This process's worker threads, libuv child processes and loaded native addons, as Node reports them. */
function workers() {
  const report = process.report.getReport() as unknown as {
    libuv: { type: string }[];
    workers: unknown[];
    sharedObjects: string[];
  };
  return {
    threads: report.workers.length,
    processes: report.libuv.filter((handle) => handle.type === "process").length,
    addons: report.sharedObjects.filter((path) => path.endsWith(".node")).sort(),
  };
}

describe("optional capability workers", () => {
  it("starts no worker, child process, terminal, browser or search index until one is used", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-idle-test-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    for (const [key, value] of Object.entries(await terminalHome(join(root, "host-home")))) vi.stubEnv(key, value);
    vi.stubEnv("SHELL", process.env.PAL_BASH ?? "/bin/bash");
    const before = workers();
    const pal = await openPal({ dataRoot: join(root, "data"), installRoot: join(root, "install") }, context);
    cleanups.push(() => pal.close());
    await pal.owner.setup(pal.owner.setupToken, "correct horse battery");
    const project = await pal.projects.create("idle-project", { name: "Idle" });
    await writeFile(join(project.root, "needle.txt"), "idle needle\n");
    await pal.chats.createChat("idle-chat", { projectId: project.id }, context);
    await pal.extensions.view();
    await pal.providers.list();

    expect(workers()).toEqual(before);
    expect(pal.search.size).toBe(0);
    expect(await pal.browsers.status(project.id)).toMatchObject({ running: false });

    // The same observations see a capability once the owner uses it.
    await pal.search.search(project.root, "needle", "files");
    expect(pal.search.size).toBe(1);
    const terminal = await pal.terminals.create(project.id, { cols: 80, rows: 24 });
    expect(terminal.ended).toBe(false);
    expect(workers().addons.some((path) => path.endsWith("/pty.node"))).toBe(true);
  });
});
