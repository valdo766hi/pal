// Stopped-state backup and restore of one data directory; see docs/configuration.md.
import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { MIGRATIONS } from "../storage/migrations.ts";
import { DatabaseOwnedError, openDatabase } from "../storage/sqlite.ts";
import type { Command } from "./config.ts";
import { releaseLock } from "./release-files.ts";

const DATABASE = "pal.sqlite";
const KEY = "credentials.key";
const BROWSER = "browser";
const MAX_ENTRIES = 1_000_000;
const MAX_MANIFEST_BYTES = 512 * 1024 * 1024;
// Recreated by Pal, or meaningful only while a process holds them.
const RUNTIME = new Set([
  DATABASE,
  `${DATABASE}-wal`,
  `${DATABASE}-shm`,
  `${DATABASE}-journal`,
  "release-control/supervisor.lock",
]);

/** The backup or restore was refused before anything was replaced. */
export class BackupError extends Error {}

const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Path = Type.String({ minLength: 1, maxLength: 4096 });
const Entry = Type.Union([
  Type.Object(
    {
      type: Type.Literal("directory"),
      path: Path,
      mode: Type.Integer({ minimum: 0, maximum: 0o7777 }),
      identity: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("file"),
      path: Path,
      mode: Type.Integer({ minimum: 0, maximum: 0o7777 }),
      size: Type.Integer({ minimum: 0 }),
      sha256: Sha256,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("symlink"), path: Path, target: Type.String({ minLength: 1, maxLength: 4096 }) },
    { additionalProperties: false },
  ),
]);
type Entry = Static<typeof Entry>;
const Manifest = Type.Object(
  {
    format: Type.Literal(1),
    kind: Type.Literal("pal-stopped-backup"),
    createdAt: Type.Integer({ minimum: 0 }),
    dataRoot: Path,
    version: Type.String({ maxLength: 64 }),
    schema: Type.Integer({ minimum: 1 }),
    installation: Type.String({ minLength: 1, maxLength: 128 }),
    database: Type.Object({ size: Type.Integer({ minimum: 1 }), sha256: Sha256 }, { additionalProperties: false }),
    credentialKey: Type.Object({ included: Type.Boolean(), sha256: Sha256 }, { additionalProperties: false }),
    browserProfiles: Type.Union([Type.Literal("included"), Type.Literal("excluded"), Type.Literal("absent")]),
    external: Type.Array(
      Type.Object(
        { kind: Type.Union([Type.Literal("project"), Type.Literal("folder")]), root: Path },
        { additionalProperties: false },
      ),
    ),
    unfinished: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    entries: Type.Array(Entry, { maxItems: MAX_ENTRIES }),
  },
  { additionalProperties: false },
);
export type BackupManifest = Static<typeof Manifest>;

// Fixed statements for every stored folder identity Pal compares against a live folder; restore remaps the ones
// inside the data directory.
const IDENTITY_COLUMNS = [
  {
    table: "pal_workspaces",
    select: "SELECT identity AS value FROM pal_workspaces",
    update: "UPDATE pal_workspaces SET identity = ? WHERE identity = ?",
  },
  {
    table: "pal_workspace_purges",
    select: "SELECT identity AS value FROM pal_workspace_purges",
    update: "UPDATE pal_workspace_purges SET identity = ? WHERE identity = ?",
  },
  {
    table: "pal_folder_grants",
    select: "SELECT identity AS value FROM pal_folder_grants",
    update: "UPDATE pal_folder_grants SET identity = ? WHERE identity = ?",
  },
] as const;
const IDENTITY_DOCUMENTS = [
  {
    table: "pal_workspaces",
    fields: ["sourceIdentity", "commonIdentity"],
    select: "SELECT rowid AS id, plan AS value FROM pal_workspaces WHERE plan IS NOT NULL",
    update: "UPDATE pal_workspaces SET plan = ? WHERE rowid = ?",
  },
  {
    table: "pal_memory_versions",
    fields: ["identity"],
    select: "SELECT rowid AS id, source AS value FROM pal_memory_versions",
    update: "UPDATE pal_memory_versions SET source = ? WHERE rowid = ?",
  },
] as const;
const UNFINISHED = [
  ["tasks", "pi_tasks", "SELECT count(*) AS n FROM pi_tasks WHERE status <> 'terminal'"],
  ["submissions", "pi_submissions", "SELECT count(*) AS n FROM pi_submissions WHERE status IN ('queued', 'placed')"],
  ["admissions", "pal_admissions", "SELECT count(*) AS n FROM pal_admissions WHERE state = 'admitting'"],
  ["approvals", "pal_command_approvals", "SELECT count(*) AS n FROM pal_command_approvals WHERE state = 'pending'"],
  ["purges", "pal_workspace_purges", "SELECT count(*) AS n FROM pal_workspace_purges WHERE completed_at IS NULL"],
] as const;

export type BackupOptions = {
  dataRoot: string;
  output: string;
  version: string;
  includeCredentialKey: boolean;
  includeBrowserProfiles: boolean;
};

/** Run `pal backup` or `pal restore` and return its JSON report. */
export async function backupCommand(command: Extract<Command, { kind: "backup" | "restore" }>, version: string) {
  if (command.kind === "backup") return backupDataRoot({ ...command, version });
  if (command.check) return (await inspectBackup(command.from, command.credentialKey)).report;
  return restoreBackup(command.from, command.dataRoot, command.credentialKey);
}

/** Copy a stopped data directory while holding its exclusive database lock, then publish the backup atomically. */
export async function backupDataRoot(options: BackupOptions) {
  const dataRoot = await realpath(options.dataRoot);
  const output = resolve(options.output);
  if (!isAbsolute(options.output)) throw new BackupError("--output must be an absolute path");
  if (within(output, dataRoot) || within(dataRoot, output))
    throw new BackupError("the backup must be outside the data directory");
  if (!(await lstat(join(dataRoot, DATABASE)).catch(() => undefined))?.isFile())
    throw new BackupError(`${dataRoot} is not a Pal data directory`);
  const supervisor = await holdSupervisor(dataRoot);
  try {
    const database = await ownStore(dataRoot);
    try {
      const facts = await storeFacts(database);
      if (await lstat(output).catch(() => undefined)) throw new BackupError(`${output} already exists`);
      const staging = `${output}.partial-${randomBytes(6).toString("hex")}`;
      await mkdir(staging, { mode: 0o700 });
      try {
        const manifest = await copyStore(database, dataRoot, join(staging, "data"), facts, options);
        await writePrivate(join(staging, "manifest.json"), Buffer.from(`${JSON.stringify(manifest)}\n`));
        await publish(staging, output);
        return summary(manifest);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    } finally {
      await database.close();
    }
  } finally {
    await supervisor?.close();
  }
}

async function ownStore(dataRoot: string) {
  try {
    return await openDatabase(join(dataRoot, DATABASE));
  } catch (cause) {
    if (cause instanceof DatabaseOwnedError)
      throw new BackupError("Pal is running on this data directory; stop it before a backup", { cause });
    throw new BackupError("the database could not be opened", { cause });
  }
}

/** What the manifest records about the store, read on the owning connection. */
async function storeFacts(database: SqliteDatabase) {
  const check = await database.get<{ integrity_check: string }>("PRAGMA integrity_check");
  if (check?.integrity_check !== "ok") throw new BackupError("the database failed its integrity check");
  const tables = new Set(
    (await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((t) => t.name),
  );
  const schema = (await database.get<{ n: number }>("SELECT max(version) AS n FROM pal_migrations"))?.n;
  const installation = (await database.get<{ id: string }>("SELECT id FROM pal_installation"))?.id;
  if (schema === undefined || installation === undefined) throw new BackupError("the store has no Pal identity");
  const unfinished: Record<string, number> = {};
  for (const [name, table, sql] of UNFINISHED)
    if (tables.has(table)) unfinished[name] = (await database.get<{ n: number }>(sql))?.n ?? 0;
  const projects = await database.all<{ root: string }>(
    "SELECT root FROM pal_projects WHERE mode = 'existing' AND removed_at IS NULL ORDER BY root",
  );
  const folders = tables.has("pal_folder_grants")
    ? await database.all<{ root: string }>(
        "SELECT DISTINCT root FROM pal_folder_grants WHERE revoked_at IS NULL ORDER BY root",
      )
    : [];
  const external = [
    ...projects.map(({ root }) => ({ kind: "project" as const, root })),
    ...folders.map(({ root }) => ({ kind: "folder" as const, root })),
  ];
  const referenced = new Set<string>();
  for (const { table, select } of IDENTITY_COLUMNS) {
    if (!tables.has(table)) continue;
    for (const row of await database.all<{ value: string | null }>(select))
      if (row.value !== null) referenced.add(row.value);
  }
  for (const { table, fields, select } of IDENTITY_DOCUMENTS) {
    if (!tables.has(table)) continue;
    for (const row of await database.all<{ value: string }>(select)) {
      const document = parseDocument(row.value);
      for (const field of fields) if (typeof document[field] === "string") referenced.add(document[field]);
    }
  }
  return { schema, installation, unfinished, external, referenced };
}

async function copyStore(
  database: SqliteDatabase,
  dataRoot: string,
  data: string,
  facts: Awaited<ReturnType<typeof storeFacts>>,
  options: BackupOptions,
): Promise<BackupManifest> {
  await mkdir(data, { mode: 0o700 });
  // Pal's own connection makes the consistent copy into an empty private file; nothing else may open the live file.
  await writePrivate(join(data, DATABASE), Buffer.alloc(0));
  await database.run("VACUUM INTO ?", join(data, DATABASE));
  const copy = new DatabaseSync(join(data, DATABASE));
  try {
    copy.exec("PRAGMA journal_mode = DELETE");
  } finally {
    copy.close();
  }
  const key = await readFile(join(dataRoot, KEY)).catch(() => undefined);
  if (key?.length !== 32) throw new BackupError("the credential key is missing or invalid");
  if (options.includeCredentialKey) await writePrivate(join(data, KEY), key);
  const browser = (path: string) => path === BROWSER || path.startsWith(`${BROWSER}/`);
  const entries: Entry[] = [];
  await walk(
    dataRoot,
    (path) => RUNTIME.has(path) || path === KEY || (!options.includeBrowserProfiles && browser(path)),
    async (path, info) => {
      if (entries.length >= MAX_ENTRIES) throw new BackupError(`more than ${MAX_ENTRIES} entries`);
      entries.push(await copyEntry(join(dataRoot, path), join(data, path), path, info, facts.referenced));
    },
  );
  let browserProfiles: BackupManifest["browserProfiles"] = "absent";
  if ((await lstat(join(dataRoot, BROWSER)).catch(() => undefined)) !== undefined)
    browserProfiles = options.includeBrowserProfiles ? "included" : "excluded";
  return {
    format: 1,
    kind: "pal-stopped-backup",
    createdAt: Date.now(),
    dataRoot,
    version: options.version,
    schema: facts.schema,
    installation: facts.installation,
    database: await hashFile(join(data, DATABASE)),
    credentialKey: { included: options.includeCredentialKey, sha256: sha256(key) },
    browserProfiles,
    external: facts.external,
    unfinished: facts.unfinished,
    entries,
  };
}

async function copyEntry(
  source: string,
  target: string,
  path: string,
  info: BigIntStats,
  referenced: ReadonlySet<string>,
): Promise<Entry> {
  if (info.isDirectory()) {
    const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
    await mkdir(target, { mode: 0o700 });
    return {
      type: "directory",
      path,
      mode: Number(info.mode & 0o7777n),
      ...(referenced.has(identity) ? { identity } : {}),
    };
  }
  if (info.isFile()) {
    const copied = await copyHashed(source, target);
    if (BigInt(copied.size) !== info.size) throw new BackupError(`${path} changed during the backup`);
    return { type: "file", path, mode: Number(info.mode & 0o7777n), ...copied };
  }
  if (info.isSymbolicLink()) {
    const linked = await readlink(source);
    await symlink(linked, target);
    return { type: "symlink", path, target: linked };
  }
  throw new BackupError(`${path} is not a file, folder or symbolic link`);
}

/** Verify a backup completely without writing anything; `credentialKey` is a separately kept key file. */
export async function inspectBackup(from: string, credentialKey?: string) {
  const root = await realpath(from);
  const manifest = await readManifest(root);
  const data = join(root, "data");
  await verifyTree(data, manifest);
  const owners = verifyDatabase(join(data, DATABASE), manifest, await hashFile(join(data, DATABASE)));
  const key = await readKey(data, manifest, credentialKey);
  let keyState: "included" | "provided" | "missing" = "missing";
  if (manifest.credentialKey.included) keyState = "included";
  else if (key !== undefined) keyState = "provided";
  return {
    manifest,
    key,
    report: {
      ...summary(manifest),
      integrity: "ok" as const,
      owners,
      supportedSchema: MIGRATIONS.at(-1)?.version ?? 0,
      credentialKey: keyState,
    },
  };
}

async function readManifest(root: string): Promise<BackupManifest> {
  const path = join(root, "manifest.json");
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_MANIFEST_BYTES) throw new BackupError("the backup has no readable manifest");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new BackupError("the backup manifest is not valid JSON");
  }
  if (!Value.Check(Manifest, manifest)) throw new BackupError("the backup manifest is not a Pal backup manifest");
  const supported = MIGRATIONS.at(-1)?.version ?? 0;
  if (manifest.schema > supported)
    throw new BackupError(`the backup has schema ${manifest.schema}; this Pal supports up to ${supported}`);
  if (!isAbsolute(manifest.dataRoot) || normalize(manifest.dataRoot) !== manifest.dataRoot)
    throw new BackupError("the backup names an invalid data directory");
  return manifest;
}

/** Every listed path exists with its type, size, checksum or link, and nothing else is present. */
async function verifyTree(data: string, manifest: BackupManifest) {
  const expected = new Map<string, Entry>();
  for (const entry of manifest.entries) {
    if (!safeRelative(entry.path) || RUNTIME.has(entry.path) || entry.path === KEY || expected.has(entry.path))
      throw new BackupError(`the manifest lists an unsafe or duplicate path: ${entry.path}`);
    const parent = dirname(entry.path);
    if (parent !== "." && expected.get(parent)?.type !== "directory")
      throw new BackupError(`${entry.path} is listed before its folder`);
    expected.set(entry.path, entry);
  }
  let found = 0;
  await walk(
    data,
    (path) => path === DATABASE || (path === KEY && manifest.credentialKey.included),
    async (path, info) => {
      const entry = expected.get(path);
      if (entry === undefined) throw new BackupError(`the backup contains an unlisted path: ${path}`);
      found++;
      await verifyEntry(join(data, path), entry, info);
    },
  );
  if (found !== expected.size) throw new BackupError("the backup is missing listed paths");
}

async function verifyEntry(path: string, entry: Entry, info: BigIntStats) {
  switch (entry.type) {
    case "directory":
      if (!info.isDirectory()) throw new BackupError(`${entry.path} is not the listed folder`);
      return;
    case "file": {
      if (!info.isFile()) throw new BackupError(`${entry.path} is not the listed file`);
      const actual = await hashFile(path);
      if (actual.size !== entry.size || actual.sha256 !== entry.sha256)
        throw new BackupError(`${entry.path} does not match its checksum`);
      return;
    }
    case "symlink":
      if (!info.isSymbolicLink() || (await readlink(path)) !== entry.target)
        throw new BackupError(`${entry.path} does not match its recorded link`);
  }
}

function verifyDatabase(path: string, manifest: BackupManifest, actual: { size: number; sha256: string }): number {
  if (actual.sha256 !== manifest.database.sha256 || actual.size !== manifest.database.size)
    throw new BackupError("the database copy does not match its checksum");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (row?.integrity_check !== "ok") throw new BackupError("the database copy failed its integrity check");
    const schema = (db.prepare("SELECT max(version) AS n FROM pal_migrations").get() as { n?: number } | undefined)?.n;
    const installation = (db.prepare("SELECT id FROM pal_installation").get() as { id?: string } | undefined)?.id;
    if (schema !== manifest.schema || installation !== manifest.installation)
      throw new BackupError("the database copy does not match the manifest's schema or installation");
    return (db.prepare("SELECT count(*) AS n FROM pal_owner").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

async function readKey(data: string, manifest: BackupManifest, credentialKey: string | undefined) {
  let key: Buffer | undefined;
  if (manifest.credentialKey.included) key = await readFile(join(data, KEY));
  else if (credentialKey !== undefined) {
    const info = await lstat(credentialKey);
    if (!info.isFile() || (info.mode & 0o077) !== 0)
      throw new BackupError("the credential key must be a regular file readable only by its owner (chmod 600)");
    key = await readFile(credentialKey);
  }
  if (key !== undefined && (key.length !== 32 || sha256(key) !== manifest.credentialKey.sha256))
    throw new BackupError("the credential key does not belong to this backup");
  return key;
}

/**
 * Restore a verified backup to the data directory it came from, which must not exist. Folder identities that Pal
 * pinned inside the data directory are remapped to the restored folders; external pins are left untouched.
 */
export async function restoreBackup(from: string, dataRoot: string, credentialKey?: string) {
  const { manifest, key, report } = await inspectBackup(from, credentialKey);
  if (key === undefined) throw new BackupError("this backup excludes the credential key; pass --credential-key");
  if (!isAbsolute(dataRoot)) throw new BackupError("--data-dir must be an absolute path");
  const target = join(await realpath(dirname(resolve(dataRoot))), basename(dataRoot));
  if (target !== manifest.dataRoot)
    throw new BackupError(`this backup restores only to its original data directory ${manifest.dataRoot}`);
  // Claim the name first: an existing installation is never replaced.
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (cause) {
    throw new BackupError(`${target} already exists; move it aside before restoring`, { cause });
  }
  const staging = `${target}.restore-${randomBytes(6).toString("hex")}`;
  try {
    await mkdir(staging, { mode: 0o700 });
    const remap = await materialize(join(await realpath(from), "data"), staging, manifest);
    await writePrivate(join(staging, KEY), key);
    const remapped = remapIdentities(join(staging, DATABASE), remap);
    await rename(staging, target);
    return { ...report, restored: target, remappedIdentities: remapped };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // Only the empty folder claimed above; a successful rename never reaches here.
    await rmdir(target).catch(() => {});
    throw error;
  }
}

/** Recreate the listed entries and database, returning each pinned folder's old identity mapped to its new one. */
async function materialize(source: string, staging: string, manifest: BackupManifest) {
  const remap = new Map<string, string>();
  for (const entry of manifest.entries) {
    const path = join(staging, entry.path);
    if (entry.type === "directory") {
      await mkdir(path, { mode: 0o700 });
      if (entry.identity === undefined) continue;
      const info = await lstat(path, { bigint: true });
      remap.set(entry.identity, `${info.dev}:${info.ino}:${info.birthtimeNs}`);
    } else if (entry.type === "file") {
      const copied = await copyHashed(join(source, entry.path), path, (entry.mode & 0o700) | 0o600);
      if (copied.sha256 !== entry.sha256) throw new BackupError(`${entry.path} changed while restoring`);
    } else await symlink(entry.target, path);
  }
  const copied = await copyHashed(join(source, DATABASE), join(staging, DATABASE));
  if (copied.sha256 !== manifest.database.sha256) throw new BackupError("the database changed while restoring");
  return remap;
}

function remapIdentities(path: string, remap: ReadonlyMap<string, string>): number {
  const db = new DatabaseSync(path);
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (t) => t.name,
      ),
    );
    let changed = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const { table, update } of IDENTITY_COLUMNS) {
        if (!tables.has(table)) continue;
        const statement = db.prepare(update);
        for (const [old, current] of remap) changed += Number(statement.run(current, old).changes);
      }
      for (const { table, fields, select, update } of IDENTITY_DOCUMENTS) {
        if (!tables.has(table)) continue;
        const statement = db.prepare(update);
        for (const row of db.prepare(select).all() as { id: number; value: string }[]) {
          const document = parseDocument(row.value);
          const touched = fields.filter((field) => {
            const current = typeof document[field] === "string" ? remap.get(document[field]) : undefined;
            if (current !== undefined) document[field] = current;
            return current !== undefined;
          });
          if (touched.length > 0) changed += Number(statement.run(JSON.stringify(document), row.id).changes);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (check?.integrity_check !== "ok") throw new BackupError("the restored database failed its integrity check");
    return changed;
  } finally {
    db.close();
  }
}

function parseDocument(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BackupError("stored workspace or memory metadata is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new BackupError("stored workspace or memory metadata is not an object");
  return parsed as Record<string, unknown>;
}

function summary(manifest: BackupManifest) {
  const files = manifest.entries.filter((entry) => entry.type === "file");
  return {
    format: manifest.format,
    dataRoot: manifest.dataRoot,
    version: manifest.version,
    schema: manifest.schema,
    installation: manifest.installation,
    files: files.length + 1,
    bytes: files.reduce((sum, entry) => sum + entry.size, manifest.database.size),
    credentialKeyIncluded: manifest.credentialKey.included,
    browserProfiles: manifest.browserProfiles,
    external: manifest.external,
    unfinished: manifest.unfinished,
  };
}

async function holdSupervisor(dataRoot: string): Promise<FileHandle | undefined> {
  const path = join(dataRoot, "release-control", "supervisor.lock");
  if (process.platform !== "linux" || (await lstat(path).catch(() => undefined)) === undefined) return undefined;
  try {
    return await releaseLock(path);
  } catch (cause) {
    throw new BackupError("a Pal supervisor owns this data directory; stop it before a backup", { cause });
  }
}

/** Visit entries below `root` in pre-order (parents first), without following symbolic links. */
async function walk(
  root: string,
  skip: (path: string) => boolean,
  visit: (path: string, info: BigIntStats) => Promise<void>,
  prefix = "",
): Promise<void> {
  for (const name of await readdir(join(root, prefix))) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (skip(path)) continue;
    const info = await lstat(join(root, path), { bigint: true });
    await visit(path, info);
    if (info.isDirectory()) await walk(root, skip, visit, path);
  }
}

async function copyHashed(source: string, target: string, mode = 0o600) {
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const output = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  ).catch(async (error: unknown) => {
    await input.close();
    throw error;
  });
  // The streams own and close both handles; the output is flushed to disk before it closes.
  await pipeline(input.createReadStream(), tap, output.createWriteStream({ flush: true }));
  return { size, sha256: hash.digest("hex") };
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  let size = 0;
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  for await (const chunk of input.createReadStream() as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

async function writePrivate(path: string, bytes: Buffer) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Publish a finished staging folder under a name that must not exist yet. */
async function publish(staging: string, output: string) {
  try {
    await mkdir(output, { mode: 0o700 });
  } catch (cause) {
    throw new BackupError(`${output} already exists`, { cause });
  }
  // Replaces only the empty folder just claimed; a folder that gained entries meanwhile fails with ENOTEMPTY.
  await rename(staging, output);
}

function safeRelative(path: string): boolean {
  return (
    !isAbsolute(path) &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    normalize(path) === path &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function within(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
