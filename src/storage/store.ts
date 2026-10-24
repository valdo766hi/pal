import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type SqliteDatabase, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { migrate } from "./migrations.ts";
import { openDatabase } from "./sqlite.ts";

export type Store = {
  readonly path: string;
  readonly installationId: string;
  /** The shared facade for Pal's `pal_` tables; Pi's durable state lives in `pi_` tables on the same connection. */
  readonly database: SqliteDatabase;
  readonly storage: SqliteStorage;
  close(): Promise<void>;
};

/**
 * Open a data root's single store: take exclusive ownership, apply Pal's migrations, then open Pi's storage.
 * Rejects with `DatabaseOwnedError` while another process owns it.
 */
export async function openStore(dataRoot: string): Promise<Store> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const path = join(await realpath(dataRoot), "pal.sqlite");
  const database = await openDatabase(path);
  let installationId: string | undefined;
  try {
    await migrate(database);
    installationId = (await database.get<{ id: string }>("SELECT id FROM pal_installation"))?.id;
    if (installationId === undefined) throw new Error("installation identity is missing");
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
  // Pi's storage owns the facade from here: it closes it on failure and on close.
  const storage = await SqliteStorage.open(database, { prefix: "pi_" });
  return { path, installationId, database, storage, close: () => storage.close(BACKGROUND_CONTEXT) };
}
