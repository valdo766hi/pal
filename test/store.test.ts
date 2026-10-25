import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS } from "../src/storage/migrations.ts";
import { DatabaseOwnedError, openDatabase } from "../src/storage/sqlite.ts";
import { openStore } from "../src/storage/store.ts";

const child = join(import.meta.dirname, "fixtures", "store-child.ts");
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pal-store-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Start the fixture and resolve with its first JSON line, printed once it reaches its barrier. */
async function startChild(mode: string, target: string): Promise<{ process: ChildProcess; line: unknown }> {
  const proc = spawn(process.execPath, [child, mode, target], { stdio: ["ignore", "pipe", "inherit"] });
  cleanups.push(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await once(proc, "exit");
    }
  });
  if (proc.stdout === null) throw new Error("child stdout is not piped");
  const lines = createInterface({ input: proc.stdout });
  const [line] = (await Promise.race([
    once(lines, "line"),
    once(proc, "exit").then(([code]) => Promise.reject(new Error(`child exited ${code} before its barrier`))),
  ])) as [string];
  return { process: proc, line: JSON.parse(line) };
}

async function kill(proc: ChildProcess): Promise<void> {
  proc.kill("SIGKILL");
  await once(proc, "exit");
}

describe("store", () => {
  it("applies Pal's migrations once, keeps the installation identity and prefixes every table", async () => {
    const dataRoot = join(await tempDir(), "data");
    const first = await openStore(dataRoot);
    const id = first.installationId;
    const tables = await first.database.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    expect(tables.length).toBeGreaterThan(2);
    for (const { name } of tables) expect(name).toMatch(/^(pal|pi)_/);
    await first.close();

    const again = await openStore(dataRoot);
    expect(again.installationId).toBe(id);
    expect(await again.database.all("SELECT version, name FROM pal_migrations")).toEqual(
      MIGRATIONS.map(({ version, name }) => ({ version, name })),
    );
    await again.close();
  });

  it("pins the owned store path through a pre-existing parent-directory alias", async () => {
    const root = await realpath(await tempDir());
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    await mkdir(actual);
    await symlink(actual, alias);
    const owner = await openStore(join(alias, "data"));
    cleanups.push(() => owner.close());
    expect(owner.path).toBe(join(actual, "data", "pal.sqlite"));
    await expect(openStore(join(actual, "data"))).rejects.toBeInstanceOf(DatabaseOwnedError);
    expect(owner.installationId).toBeDefined();
  });

  it("refuses a second owner in this process until the first closes", async () => {
    const dataRoot = await tempDir();
    const owner = await openStore(dataRoot);
    await expect(openStore(dataRoot)).rejects.toBeInstanceOf(DatabaseOwnedError);
    await owner.close();
    await (await openStore(dataRoot)).close();
  });

  it("refuses another process's store until that process is killed, keeping what it committed", async () => {
    const dataRoot = await tempDir();
    const { process: owner, line } = await startChild("own", dataRoot);
    await expect(openStore(dataRoot)).rejects.toBeInstanceOf(DatabaseOwnedError);
    // Exclusive WAL without a shared-memory index: nothing else can map the database state.
    expect(existsSync(join(dataRoot, "pal.sqlite-shm"))).toBe(false);

    await kill(owner);
    const store = await openStore(dataRoot);
    expect(store.installationId).toBe((line as { installationId: string }).installationId);
    await store.close();
  });

  it("leaves no trace of migrations killed mid-transaction", async () => {
    const path = join(await tempDir(), "pal.sqlite");
    const { process: migrating } = await startChild("hang-in-migration", path);
    await kill(migrating);

    const database = await openDatabase(path);
    expect(await database.all("SELECT name FROM sqlite_master WHERE name LIKE 'pal_%'")).toEqual([]);
    await migrate(database);
    expect(await database.all("SELECT version FROM pal_migrations")).toEqual(
      MIGRATIONS.map(({ version }) => ({ version })),
    );
    await database.close();
  });

  it("refuses a schema history this build does not know, without changing it", async () => {
    const dataRoot = await tempDir();
    const database = await openDatabase(join(dataRoot, "pal.sqlite"));
    await migrate(database);
    await database.run("INSERT INTO pal_migrations (version, name, applied_at) VALUES (99, 'future', 0)");
    await database.close();

    await expect(openStore(dataRoot)).rejects.toThrow(/migration 99 'future'.*does not know/);
    const reopened = await openDatabase(join(dataRoot, "pal.sqlite"));
    expect(await reopened.all("SELECT version FROM pal_migrations ORDER BY version")).toEqual([
      ...MIGRATIONS.map(({ version }) => ({ version })),
      { version: 99 },
    ]);
    await reopened.close();
  });

  it("preserves composed-only feedback on schema 20 upgrade without inventing an admission", async () => {
    const database = await openDatabase(join(await tempDir(), "pal.sqlite"));
    cleanups.push(() => database.close());
    await migrate(database, MIGRATIONS.slice(0, 20));
    await database.run(
      "INSERT INTO pal_change_comments (id, scope_id, path, revision, line, line_text, line_hash, body, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "comment-one",
      "project-one",
      "review.txt",
      "a".repeat(64),
      1,
      "original line",
      "b".repeat(64),
      "Keep my feedback.",
      100,
      200,
    );
    await migrate(database);
    await migrate(database);
    expect(await database.get("SELECT body, sent_at, submission_id FROM pal_change_comments")).toEqual({
      body: "Keep my feedback.",
      sent_at: 200,
      submission_id: null,
    });
    await expect(migrate(database, MIGRATIONS.slice(0, 20))).rejects.toThrow(/migration 21.*does not know/);
    expect(await database.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  });

  it("numbers migrations consecutively from 1", () => {
    expect(MIGRATIONS.map(({ version }) => version)).toEqual(MIGRATIONS.map((_, index) => index + 1));
  });
});
