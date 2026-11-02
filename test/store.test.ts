import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { ChatService } from "../src/core/chats.ts";
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

async function openChats(dataRoot: string) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
  const model = faux.getModel();
  const store = await openStore(dataRoot);
  const harness = await Harness.open(store.storage, { models, registry: createRegistry() }, context);
  cleanups.push(() => harness.close(context).catch(() => {}));
  const chats = await ChatService.open(
    {
      database: store.database,
      harness,
      agentFor: async () => ({ model: { provider: model.provider, modelId: model.id } }),
    },
    context,
  );
  return { store, harness, chats };
}

/** Reshape a current store into what a release on Pi 1.3 left: Pal schema 22, Pi schema 1 without `sleeping`. */
async function asPiOneThreeStore(dataRoot: string): Promise<void> {
  const database = await openDatabase(join(dataRoot, "pal.sqlite"));
  await database.transaction(async (tx) => {
    const table = await tx.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'pi_tasks'");
    const indexes = await tx.all<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pi_tasks' AND sql IS NOT NULL",
    );
    const v1 = table?.sql.replace(/^CREATE TABLE "?pi_tasks"?/, "CREATE TABLE pi_tasks_v1").replace("'sleeping', ", "");
    if (v1 === undefined || v1.includes("sleeping") || !v1.startsWith("CREATE TABLE pi_tasks_v1"))
      throw new Error("unexpected Pi task table");
    await tx.exec(v1);
    await tx.exec("INSERT INTO pi_tasks_v1 SELECT * FROM pi_tasks");
    await tx.exec("DROP TABLE pi_tasks");
    await tx.exec("ALTER TABLE pi_tasks_v1 RENAME TO pi_tasks");
    for (const { sql } of indexes) await tx.exec(sql);
    await tx.run("UPDATE pi_durable_schema SET version = 1");
    await tx.run("DELETE FROM pal_migrations WHERE version > 22");
  });
  await database.close();
}

const snapshot = (database: Awaited<ReturnType<typeof openDatabase>>) =>
  Promise.all([
    database.all("SELECT version, name, applied_at FROM pal_migrations ORDER BY version"),
    database.all("SELECT version FROM pi_durable_schema"),
    database.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"),
    database.all("SELECT id, status, record FROM pi_tasks ORDER BY id"),
    database.all("SELECT id, record FROM pi_entries ORDER BY id"),
  ]);

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

  it("migrates a quiescent Pi 1.3 store one way: history and new work continue, older builds refuse it unchanged", async () => {
    const dataRoot = await tempDir();
    const before = await openChats(dataRoot);
    const chat = await before.chats.createChat("pi-upgrade-chat", { projectId: "project-1" }, context);
    await before.chats.submit(chat.id, "pi-upgrade-before", { text: "before" }, context);
    await before.harness.waitForIdle(context);
    await before.harness.close(context);
    await asPiOneThreeStore(dataRoot);

    const after = await openChats(dataRoot);
    expect(await after.store.database.all("SELECT version FROM pi_durable_schema")).toEqual([{ version: 2 }]);
    expect(await after.store.database.get("SELECT max(version) AS n FROM pal_migrations")).toEqual({ n: 23 });
    await after.chats.submit(chat.id, "pi-upgrade-after", { text: "after" }, context);
    await after.harness.waitForIdle(context);
    const { messages } = (await (await after.harness.conversation(chat.conversationId, context))?.context(context)) ?? {
      messages: [],
    };
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    await after.harness.close(context);

    const database = await openDatabase(join(dataRoot, "pal.sqlite"));
    cleanups.push(() => database.close());
    const migrated = await snapshot(database);
    await expect(migrate(database, MIGRATIONS.slice(0, 22))).rejects.toThrow(
      /migration 23 'pi_durable_schema_2'.*does not know/,
    );
    expect(await snapshot(database)).toEqual(migrated);
  });

  it("leaves a Pi 1.3 store with unfinished work unmigrated until the release that started it finishes", async () => {
    const dataRoot = await tempDir();
    await (await openStore(dataRoot)).close();
    await asPiOneThreeStore(dataRoot);
    const path = join(dataRoot, "pal.sqlite");
    const database = await openDatabase(path);
    await database.run(
      "INSERT INTO pi_tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (1, 1, 'fixture', 'pending', 0, 0, '{}')",
    );
    const unfinished = await snapshot(database);
    await database.close();

    await expect(openStore(dataRoot)).rejects.toThrow(/unfinished work needs its retained Pal release/);
    const reopened = await openDatabase(path);
    expect(await snapshot(reopened)).toEqual(unfinished);
    await reopened.run("UPDATE pi_tasks SET status = 'terminal'");
    await reopened.close();

    const store = await openStore(dataRoot);
    expect(await store.database.all("SELECT version FROM pi_durable_schema")).toEqual([{ version: 2 }]);
    expect(await store.database.get("SELECT max(version) AS n FROM pal_migrations")).toEqual({ n: 23 });
    await store.close();
  });

  it("numbers migrations consecutively from 1", () => {
    expect(MIGRATIONS.map(({ version }) => version)).toEqual(MIGRATIONS.map((_, index) => index + 1));
  });
});
