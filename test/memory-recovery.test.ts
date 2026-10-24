import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { openPal } from "../src/core/app.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("memory projection recovery", () => {
  it.each(["projected", "committed"])("recovers an atomic head/version/FTS after SIGKILL at %s", async (phase) => {
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-memory-crash-")));
    cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
    const child = spawn(
      process.execPath,
      [...process.execArgv, join(import.meta.dirname, "fixtures/memory-child.ts"), dataRoot, phase],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
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
        throw new Error("memory fixture exited before barrier");
      }),
    ]);
    lines.close();
    const { project } = JSON.parse(String(line)) as { project: string };
    child.kill("SIGKILL");
    await once(child, "exit");
    const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
    cleanups.push(() => pal.close());
    const expected = phase === "committed" ? 1 : 0;
    for (const table of ["pal_memory", "pal_memory_versions", "pal_memory_fts"])
      expect(await pal.store.database.get(`SELECT count(*) AS n FROM ${table}`)).toEqual({ n: expected });
    const input = { title: "Journal", body: "Use SQLite", source: { kind: "owner" } };
    const id = await pal.memory.save(project, "recovery-memory-note", input, context);
    expect(await pal.memory.save(project, "recovery-memory-note", input, context)).toBe(id);
    expect(await pal.memory.list(project, context)).toMatchObject([{ id, revision: 1, body: "Use SQLite" }]);
    expect(await pal.store.database.all("SELECT id FROM pal_memory_fts WHERE pal_memory_fts MATCH 'SQLite'")).toEqual([
      { id },
    ]);
  });
});
