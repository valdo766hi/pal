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
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
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
    expect(await after.store.database.get("SELECT max(version) AS n FROM pal_migrations")).toEqual({
      n: MIGRATIONS.at(-1)?.version,
    });
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
    expect(await store.database.get("SELECT max(version) AS n FROM pal_migrations")).toEqual({
      n: MIGRATIONS.at(-1)?.version,
    });
    await store.close();
  });

  it("upgrades a Pi 1.4 store only once its release finished its work, and older builds refuse it unchanged", async () => {
    const dataRoot = await tempDir();
    await (await openStore(dataRoot)).close();
    const path = join(dataRoot, "pal.sqlite");
    const database = await openDatabase(path);
    // What a release on Pi 1.4 left: Pal schema 24, here with a task it has not finished.
    await database.run("DELETE FROM pal_migrations WHERE version > 24");
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

    await (await openStore(dataRoot)).close();
    const upgraded = await openDatabase(path);
    cleanups.push(() => upgraded.close());
    const migrated = await snapshot(upgraded);
    expect(await upgraded.get("SELECT max(version) AS n FROM pal_migrations")).toEqual({
      n: MIGRATIONS.at(-1)?.version,
    });
    await expect(migrate(upgraded, MIGRATIONS.slice(0, 24))).rejects.toThrow(
      /migration 25 'pi_durable_1_5_documents'.*does not know/,
    );
    expect(await snapshot(upgraded)).toEqual(migrated);
  });

  it("keeps every admission through the schema 24 rebuild and binds a blocked reason to admitting inputs", async () => {
    const database = await openDatabase(join(await tempDir(), "pal.sqlite"));
    cleanups.push(() => database.close());
    await migrate(database, MIGRATIONS.slice(0, 23));
    const insert =
      "INSERT INTO pal_admissions (seq, chat_id, request_id, digest, intent, state, submission_id, created_at, folder_scope) VALUES (?, 'chat-one', ?, 'digest', '{}', ?, ?, 100, ?)";
    await database.run(insert, 7, "admitted-request", "admitted", 3, "scope");
    await database.run(insert, 9, "admitting-request", "admitting", null, null);
    const before = await database.all("SELECT * FROM pal_admissions ORDER BY seq");
    await migrate(database);
    expect(await database.all("SELECT * FROM pal_admissions ORDER BY seq")).toEqual(
      before.map((row) => ({ ...row, blocked: null })),
    );
    await database.run("UPDATE pal_admissions SET blocked = 'missing' WHERE seq = 9");
    await expect(database.run("UPDATE pal_admissions SET blocked = 'missing' WHERE seq = 7")).rejects.toThrow(
      /CHECK constraint/,
    );
    await database.run("UPDATE pal_admissions SET state = 'withdrawn', blocked = NULL WHERE seq = 9");
    expect(await database.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  });

  it("keeps every chat, mode and approval through the schema 26 rebuild, and older builds refuse it unchanged", async () => {
    const database = await openDatabase(join(await tempDir(), "pal.sqlite"));
    cleanups.push(() => database.close());
    await migrate(database, MIGRATIONS.slice(0, 25));
    const chat =
      "INSERT INTO pal_chats (id, request_id, digest, intent, state, conversation_id, created_at, project_id, title, deleted_at, command_mode) VALUES (?, ?, 'digest', '{}', 'ready', ?, 100, 'project', ?, ?, ?)";
    await database.run(chat, "chat-ask", "request-ask", 1, "Asks", null, "ask");
    await database.run(chat, "chat-full", "request-full", 2, null, 200, "full");
    const approval =
      "INSERT INTO pal_command_approvals (id, chat_id, task_id, call_id, command, cwd, timeout, digest, state, created_at, expires_at, decided_at) VALUES (?, 'chat-ask', ?, 'call', 'ls', '/srv/project', 10, 'digest', ?, 100, 200, ?)";
    for (const [index, state] of ["pending", "approved", "denied", "expired"].entries())
      await database.run(approval, `approval-${state}`, index + 1, state, state === "pending" ? null : 150);
    const chats = await database.all("SELECT * FROM pal_chats ORDER BY id");
    const approvals = await database.all("SELECT * FROM pal_command_approvals ORDER BY task_id");
    await migrate(database);
    expect(await database.all("SELECT * FROM pal_chats ORDER BY id")).toEqual(chats);
    expect(await database.all("SELECT * FROM pal_command_approvals ORDER BY task_id")).toEqual(
      approvals.map((row) => {
        const { state } = row as { state: string };
        return { ...row, decided_by: state === "approved" || state === "denied" ? "owner" : null, advice: null };
      }),
    );
    await database.run("UPDATE pal_chats SET command_mode = 'auto' WHERE id = 'chat-ask'");
    await expect(database.run("UPDATE pal_chats SET command_mode = 'yolo' WHERE id = 'chat-ask'")).rejects.toThrow(
      /CHECK constraint/,
    );
    await expect(
      database.run("UPDATE pal_command_approvals SET decided_by = 'model' WHERE id = 'approval-approved'"),
    ).rejects.toThrow(/CHECK constraint/);
    await expect(
      database.run(
        "INSERT INTO pal_chats (id, request_id, digest, intent, state, created_at) VALUES ('x', 'request-ask', 'd', '{}', 'provisioning', 1)",
      ),
    ).rejects.toThrow(/UNIQUE constraint/);
    const migrated = await Promise.all([
      database.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"),
      database.all("SELECT * FROM pal_chats ORDER BY id"),
      database.all("SELECT * FROM pal_command_approvals ORDER BY task_id"),
      database.all("SELECT version, name, applied_at FROM pal_migrations ORDER BY version"),
    ]);
    await expect(migrate(database, MIGRATIONS.slice(0, 25))).rejects.toThrow(
      /migration 26 'auto_command_mode'.*does not know/,
    );
    expect(
      await Promise.all([
        database.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"),
        database.all("SELECT * FROM pal_chats ORDER BY id"),
        database.all("SELECT * FROM pal_command_approvals ORDER BY task_id"),
        database.all("SELECT version, name, applied_at FROM pal_migrations ORDER BY version"),
      ]),
    ).toEqual(migrated);
    expect(await database.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  });

  it("adds project-list indexes in schema 27 without losing rows, and older builds refuse it unchanged", async () => {
    const database = await openDatabase(join(await tempDir(), "pal.sqlite"));
    cleanups.push(() => database.close());
    await migrate(database, MIGRATIONS.slice(0, 26));
    await database.run(
      "INSERT INTO pal_projects (id, request_id, digest, name, mode, state, root, created_at) VALUES ('p1', 'rp1', 'd', 'One', 'managed', 'ready', '/tmp/p1', 100)",
    );
    await database.run(
      "INSERT INTO pal_chats (id, request_id, digest, intent, state, conversation_id, created_at, project_id, title, deleted_at, command_mode) VALUES ('c1', 'rc1', 'd', '{}', 'ready', 1, 200, 'p1', 'First', NULL, 'auto')",
    );
    await database.run(
      "INSERT INTO pal_admissions (seq, chat_id, request_id, digest, intent, state, submission_id, created_at, blocked) VALUES (1, 'c1', 'ra1', 'd', '{\"text\":\"wait\"}', 'admitting', NULL, 210, 'missing attachment')",
    );
    const beforeChats = await database.all("SELECT * FROM pal_chats ORDER BY id");
    const beforeAdmissions = await database.all("SELECT * FROM pal_admissions ORDER BY seq");

    await migrate(database);

    expect(await database.all("SELECT * FROM pal_chats ORDER BY id")).toEqual(beforeChats);
    expect(await database.all("SELECT * FROM pal_admissions ORDER BY seq")).toEqual(beforeAdmissions);
    const indexes = (
      await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
    ).map((row) => row.name);
    expect(indexes).toContain("pal_chats_project_ready");
    expect(indexes).toContain("pal_admissions_pending");

    const plan = await database.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT c.id, c.title, c.conversation_id, c.created_at, c.intent, c.command_mode,
         (SELECT json_object('requestId', a.request_id, 'text', json_extract(a.intent, '$.text'), 'reason', a.blocked)
          FROM pal_admissions a WHERE a.chat_id = c.id AND a.state = 'admitting' AND a.blocked IS NOT NULL) AS blocked,
         CASE WHEN p.id IS NOT NULL THEN w.id END AS workspace_id,
         w.project_id AS workspace_project_id, w.mode AS workspace_mode, w.root AS workspace_root,
         w.source AS workspace_source, w.plan AS workspace_plan, w.state AS workspace_state, w.error AS workspace_error
       FROM pal_chats c
       LEFT JOIN pal_workspaces w ON w.chat_id = c.id
       LEFT JOIN pal_projects p ON p.id = w.project_id AND p.removed_at IS NULL AND p.state = 'ready'
       WHERE c.project_id = ? AND c.state = 'ready' AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC, c.rowid DESC`,
      "p1",
    );
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("pal_chats_project_ready");
    expect(details).toContain("pal_admissions_pending");
    expect(details).not.toMatch(/TEMP B-TREE/i);

    const migrated = await Promise.all([
      database.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"),
      database.all("SELECT version, name, applied_at FROM pal_migrations ORDER BY version"),
    ]);
    await expect(migrate(database, MIGRATIONS.slice(0, 26))).rejects.toThrow(
      /migration 27 'project_list_indexes'.*does not know/,
    );
    expect(
      await Promise.all([
        database.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"),
        database.all("SELECT version, name, applied_at FROM pal_migrations ORDER BY version"),
      ]),
    ).toEqual(migrated);
    expect(await database.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  });

  it("refuses schema 27 migration while unfinished work is pending, leaving schema 26 intact for the retained build", async () => {
    const dataRoot = await tempDir();
    // Create a store at schema 26 with Pi's tables, then interrupt an input at the input-recorded barrier.
    const initDb = await openDatabase(join(dataRoot, "pal.sqlite"));
    await migrate(initDb, MIGRATIONS.slice(0, 26));
    await initDb.close();

    const openAt26 = async (barrier?: (point: string) => void) => {
      const database = await openDatabase(join(dataRoot, "pal.sqlite"));
      await migrate(database, MIGRATIONS.slice(0, 26));
      const storage = await SqliteStorage.open(database, { prefix: "pi_" });
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
      const model = faux.getModel();
      const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
      const chats = await ChatService.open(
        {
          database,
          harness,
          agentFor: async () => ({ model: { provider: model.provider, modelId: model.id } }),
          ...(barrier === undefined ? {} : { barrier }),
        },
        context,
      );
      return {
        database,
        harness,
        chats,
        close: async () => {
          await harness.close(context);
          await storage.close(context);
        },
      };
    };

    const stop = new Error("crash at input-recorded");
    const first = await openAt26((point) => {
      if (point === "input-recorded") throw stop;
    });
    const chat = await first.chats.createChat("req-chat-26", { projectId: "project-1" }, context);
    await expect(first.chats.submit(chat.id, "req-input-26", { text: "finish me" }, context)).rejects.toBe(stop);
    await first.close();

    const beforeDb = await openDatabase(join(dataRoot, "pal.sqlite"));
    const beforeSnapshot = await snapshot(beforeDb);
    const beforeAdmissions = await beforeDb.all("SELECT * FROM pal_admissions ORDER BY seq");
    expect(await beforeDb.get("SELECT max(version) AS n FROM pal_migrations")).toEqual({ n: 26 });
    expect(beforeAdmissions).toMatchObject([{ chat_id: chat.id, request_id: "req-input-26", state: "admitting" }]);
    await beforeDb.close();

    // Upgrading directly to schema 27 must refuse without changing the database.
    await expect(openStore(dataRoot)).rejects.toThrow(/unfinished work needs its retained Pal release/);
    const afterRefusal = await openDatabase(join(dataRoot, "pal.sqlite"));
    expect(await snapshot(afterRefusal)).toEqual(beforeSnapshot);
    expect(await afterRefusal.all("SELECT * FROM pal_admissions ORDER BY seq")).toEqual(beforeAdmissions);
    await afterRefusal.close();

    // The retained schema 26 build can still reopen and finish the interrupted input.
    const retained = await openAt26();
    const conversation = await retained.harness.conversation(chat.conversationId, context);
    await conversation?.waitForIdle(context);
    expect(await retained.database.all("SELECT state FROM pal_admissions")).toEqual([{ state: "admitted" }]);
    await retained.close();

    // Once idle, upgrading to schema 27 succeeds.
    const upgraded = await openStore(dataRoot);
    expect(await upgraded.database.get("SELECT max(version) AS n FROM pal_migrations")).toEqual({
      n: MIGRATIONS.at(-1)?.version,
    });
    await upgraded.close();
  });

  it("numbers migrations consecutively from 1", () => {
    expect(MIGRATIONS.map(({ version }) => version)).toEqual(MIGRATIONS.map((_, index) => index + 1));
  });
});
