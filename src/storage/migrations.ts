import { randomUUID } from "node:crypto";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";

export type Migration = {
  readonly version: number;
  readonly name: string;
  up(transaction: SqliteExecutor): Promise<void>;
};

/** Pal's own `pal_` schema, versioned separately from Pi's. Append only: never edit or reorder an applied entry. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "installation",
    // A stable identity for provider registration; generated once, never per request or restart.
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_installation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT`);
      await transaction.run(
        "INSERT INTO pal_installation (singleton, id, created_at) VALUES (1, ?, ?)",
        randomUUID(),
        Date.now(),
      );
    },
  },
  {
    version: 2,
    name: "chats",
    // `intent` is the normalized request body, frozen so reconciliation completes exactly what was asked.
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_chats (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        intent TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready')),
        conversation_id INTEGER UNIQUE,
        created_at INTEGER NOT NULL,
        CHECK ((state = 'ready') = (conversation_id IS NOT NULL))
      ) STRICT`);
      await transaction.exec(`CREATE TABLE pal_admissions (
        seq INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        intent TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('admitting', 'admitted')),
        submission_id INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (chat_id, request_id),
        CHECK ((state = 'admitted') = (submission_id IS NOT NULL))
      ) STRICT`);
    },
  },
  {
    version: 3,
    name: "credentials",
    // `sealed` is the encrypted credential, NULL after sign-out; `retained` keeps non-secret identity for returning.
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_credentials (
        provider_id TEXT PRIMARY KEY,
        type TEXT CHECK (type IN ('api_key', 'oauth')),
        sealed BLOB,
        retained TEXT,
        updated_at INTEGER NOT NULL,
        CHECK ((type IS NULL) = (sealed IS NULL))
      ) STRICT`);
    },
  },
  {
    version: 4,
    name: "owner_and_settings",
    // Sessions are stored by token hash only: a copied database cannot be replayed as a cookie.
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        passphrase TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT`);
      await transaction.exec(`CREATE TABLE pal_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT`);
      await transaction.exec(`CREATE TABLE pal_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT`);
    },
  },
  {
    version: 5,
    name: "projects",
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_projects (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('managed', 'existing')),
        state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'failed')),
        root TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL
      ) STRICT`);
      await transaction.exec("ALTER TABLE pal_chats ADD COLUMN project_id TEXT");
      // Mutable display label, unlike the frozen intent; the first input names an untitled chat.
      await transaction.exec("ALTER TABLE pal_chats ADD COLUMN title TEXT");
    },
  },
  {
    version: 6,
    name: "mcp_servers",
    // Keys live in the credential store as `mcp:<id>`; `approved` holds the exact tool definitions the owner approved.
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        preset TEXT,
        url TEXT NOT NULL,
        auth TEXT NOT NULL,
        private INTEGER NOT NULL CHECK (private IN (0, 1)),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        approved TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT`);
    },
  },
  {
    version: 7,
    name: "uploads",
    // Bytes live at dataRoot/uploads/<project>/<id>/data once ready; `name` is display metadata from the device.
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_uploads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT,
        state TEXT NOT NULL CHECK (state IN ('receiving', 'ready')),
        created_at INTEGER NOT NULL,
        CHECK ((state = 'ready') = (sha256 IS NOT NULL))
      ) STRICT`);
    },
  },
  {
    version: 8,
    name: "removed_projects_and_chats",
    up: async (transaction) => {
      await transaction.exec("ALTER TABLE pal_projects ADD COLUMN removed_at INTEGER");
      await transaction.exec("ALTER TABLE pal_chats ADD COLUMN deleted_at INTEGER");
    },
  },
  {
    version: 9,
    name: "mcp_fake_ip_routing",
    up: async (transaction) => {
      await transaction.exec(
        "ALTER TABLE pal_mcp_servers ADD COLUMN fake_ip INTEGER NOT NULL DEFAULT 0 CHECK (fake_ip IN (0, 1))",
      );
    },
  },
  {
    version: 10,
    name: "change_reviews",
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_change_bases (
        project_id TEXT PRIMARY KEY,
        head TEXT
      ) STRICT`);
      await transaction.exec(`CREATE TABLE pal_change_reviews (
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        revision TEXT NOT NULL,
        PRIMARY KEY (project_id, path)
      ) STRICT`);
    },
  },
  {
    version: 11,
    name: "project_mcp_grants",
    up: async (transaction) => {
      await transaction.exec("ALTER TABLE pal_mcp_servers ADD COLUMN authority INTEGER NOT NULL DEFAULT 0");
      await transaction.exec(`CREATE TABLE pal_mcp_project_grants (
        project_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        policy TEXT,
        PRIMARY KEY (project_id, server_id)
      ) STRICT`);
    },
  },
  {
    version: 12,
    name: "change_comments",
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_change_comments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        revision TEXT NOT NULL,
        line INTEGER NOT NULL,
        line_text TEXT NOT NULL,
        line_hash TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      ) STRICT`);
      await transaction.exec(
        "CREATE INDEX pal_change_comments_project ON pal_change_comments (project_id, created_at)",
      );
    },
  },
  {
    version: 13,
    name: "workspace_purges",
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_workspace_purges (
        project_id TEXT PRIMARY KEY,
        directory TEXT NOT NULL UNIQUE,
        identity TEXT NOT NULL,
        completed_at INTEGER
      ) STRICT`);
    },
  },
  {
    version: 14,
    name: "reference_folders",
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_folder_grants (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        root TEXT NOT NULL,
        identity TEXT NOT NULL,
        indexed INTEGER NOT NULL CHECK (indexed IN (0, 1)),
        revoked_at INTEGER,
        UNIQUE (project_id, request_id)
      ) STRICT`);
      await transaction.exec("CREATE INDEX pal_folder_grants_project ON pal_folder_grants (project_id)");
      await transaction.exec("ALTER TABLE pal_admissions ADD COLUMN folder_scope TEXT");
    },
  },
  {
    version: 15,
    name: "chat_workspaces",
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        chat_id TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL CHECK (mode IN ('local', 'worktree', 'read-only')),
        root TEXT NOT NULL,
        source TEXT NOT NULL,
        plan TEXT,
        identity TEXT,
        nonce TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'failed')),
        error TEXT
      ) STRICT`);
      await transaction.exec("CREATE INDEX pal_workspaces_project ON pal_workspaces (project_id)");
      await transaction.exec("ALTER TABLE pal_change_bases RENAME COLUMN project_id TO scope_id");
      await transaction.exec("ALTER TABLE pal_change_reviews RENAME COLUMN project_id TO scope_id");
      await transaction.exec("ALTER TABLE pal_change_comments RENAME COLUMN project_id TO scope_id");
      await transaction.exec("DROP INDEX pal_change_comments_project");
      await transaction.exec("CREATE INDEX pal_change_comments_scope ON pal_change_comments (scope_id, created_at)");
    },
  },
  {
    version: 16,
    name: "stdio_mcp",
    up: async (transaction) => {
      await transaction.exec("ALTER TABLE pal_mcp_servers ADD COLUMN stdio TEXT");
    },
  },
  {
    version: 17,
    name: "curated_memory",
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_memory (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_id TEXT NOT NULL,
        digest TEXT NOT NULL, revision INTEGER NOT NULL, forgotten_at INTEGER,
        UNIQUE (project_id, request_id)
      ) STRICT`);
      await transaction.exec("CREATE INDEX pal_memory_project ON pal_memory (project_id)");
      await transaction.exec(`CREATE TABLE pal_memory_versions (
        id TEXT NOT NULL REFERENCES pal_memory(id), revision INTEGER NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (id, revision)
      ) STRICT`);
      await transaction.exec(
        "CREATE VIRTUAL TABLE pal_memory_fts USING fts5(id UNINDEXED, project_id UNINDEXED, revision UNINDEXED, title, body)",
      );
    },
  },
  {
    version: 18,
    name: "mcp_query_cache",
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_mcp_cache (
        key TEXT PRIMARY KEY, project_id TEXT NOT NULL, server_id TEXT NOT NULL,
        fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used INTEGER NOT NULL,
        bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 262144), value TEXT NOT NULL,
        CHECK (bytes = length(CAST(value AS BLOB))),
        CHECK (expires_at > fetched_at AND expires_at - fetched_at <= 86400000)
      ) STRICT`);
    },
  },
  {
    version: 19,
    name: "command_approvals",
    // Existing chats start in Ask too: the owner chose per-chat modes with Ask as the default.
    up: async (transaction) => {
      await transaction.exec(
        "ALTER TABLE pal_chats ADD COLUMN command_mode TEXT NOT NULL DEFAULT 'ask' CHECK (command_mode IN ('ask', 'full'))",
      );
      await transaction.exec(`CREATE TABLE pal_command_approvals (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, task_id INTEGER NOT NULL UNIQUE, call_id TEXT NOT NULL,
        assistant INTEGER, command TEXT NOT NULL, cwd TEXT NOT NULL, timeout REAL NOT NULL,
        digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired', 'stopped')),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER
      ) STRICT`);
      await transaction.exec("CREATE INDEX pal_command_approvals_chat ON pal_command_approvals (chat_id, created_at)");
    },
  },
  {
    version: 20,
    name: "browser_action_approvals",
    up: async (transaction) => {
      await transaction.exec(
        "ALTER TABLE pal_command_approvals ADD COLUMN tool TEXT NOT NULL DEFAULT 'shell_run' CHECK (tool IN ('shell_run', 'browser_act'))",
      );
    },
  },
  {
    version: 21,
    name: "feedback_admission_receipts",
    up: async (transaction) => {
      // Historical sent_at meant copied into a composer, not durably admitted.
      await transaction.exec("ALTER TABLE pal_change_comments ADD COLUMN submission_id INTEGER");
    },
  },
  {
    version: 22,
    name: "working_execution_allowance_compatibility",
    // Older builds must refuse the store rather than silently ignore its durable execution limits.
    up: async (transaction) => {
      await transaction.exec("SELECT 1");
    },
  },
];

/**
 * Apply pending migrations in one transaction, so a crash leaves the previous schema intact. Refuses a history this
 * build does not know, such as one written by a newer Pal, instead of running against it.
 */
export async function migrate(database: SqliteDatabase, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.exec(`CREATE TABLE IF NOT EXISTS pal_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT`);
    const applied = await transaction.all<{ version: number; name: string }>(
      "SELECT version, name FROM pal_migrations ORDER BY version",
    );
    for (const [index, row] of applied.entries()) {
      const known = migrations[index];
      if (known?.version !== row.version || known.name !== row.name) {
        throw new Error(`database has migration ${row.version} '${row.name}', which this Pal build does not know`);
      }
    }
    for (const migration of migrations.slice(applied.length)) {
      await migration.up(transaction);
      await transaction.run(
        "INSERT INTO pal_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        migration.version,
        migration.name,
        Date.now(),
      );
    }
  });
}
