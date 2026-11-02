import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { type Static, Type } from "typebox";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** What of one attachment reaches the model: text inline up to this, images up to the next. */
const MAX_TEXT_BYTES = 100 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const UploadBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 255 }),
    size: Type.Integer({ minimum: 0, maximum: MAX_UPLOAD_BYTES }),
    type: Type.String({ maxLength: 200 }),
  },
  { additionalProperties: false },
);
export type UploadBody = Static<typeof UploadBody>;

export type Upload = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string | null;
  readonly state: "receiving" | "ready";
};

export class UploadError extends Error {
  readonly code: "not_found" | "too_large" | "size_mismatch" | "not_receiving" | "not_ready" | "unavailable";

  constructor(code: UploadError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

type Row = {
  id: string;
  project_id: string;
  name: string;
  media_type: string;
  size: number;
  sha256: string | null;
  state: Upload["state"];
};

/**
 * Files sent from the owner's device: admitted as metadata first, then streamed to a server-chosen file, counted and
 * hashed while streaming, synced and renamed into place. They are immutable attachments, never host paths: the
 * filename is only a label, and nothing is extracted, executed or copied into a workspace.
 */
export class Uploads {
  readonly #database: SqliteDatabase;
  readonly #root: string;

  private constructor(database: SqliteDatabase, dataRoot: string) {
    this.#database = database;
    this.#root = join(dataRoot, "uploads");
  }

  /** Drop uploads a crash or a dropped connection left unfinished. */
  static async open(database: SqliteDatabase, dataRoot: string): Promise<Uploads> {
    const uploads = new Uploads(database, dataRoot);
    for (const row of await database.all<Row>("SELECT * FROM pal_uploads WHERE state = 'receiving'")) {
      await rm(uploads.#directory(row), { recursive: true, force: true });
      await database.run("DELETE FROM pal_uploads WHERE id = ?", row.id);
    }
    return uploads;
  }

  async admit(projectId: string, body: UploadBody): Promise<Upload> {
    const id = randomUUID();
    const mediaType = /^[\w.+-]+\/[\w.+-]+$/.test(body.type) ? body.type.toLowerCase() : "application/octet-stream";
    await this.#database.run(
      "INSERT INTO pal_uploads (id, project_id, name, media_type, size, state, created_at) VALUES (?, ?, ?, ?, ?, 'receiving', ?)",
      id,
      projectId,
      body.name,
      mediaType,
      body.size,
      Date.now(),
    );
    return (await this.get(id)) as Upload;
  }

  async get(id: string): Promise<Upload | undefined> {
    const row = await this.#database.get<Row>("SELECT * FROM pal_uploads WHERE id = ?", id);
    return row === undefined ? undefined : upload(row);
  }

  /** Receive the bytes of an admitted upload; exactly the admitted size, never more than the limit. */
  async receive(id: string, body: Readable): Promise<Upload> {
    const row = await this.#database.get<Row>("SELECT * FROM pal_uploads WHERE id = ?", id);
    if (row === undefined) throw new UploadError("not_found", "no such upload");
    if (row.state !== "receiving") throw new UploadError("not_receiving", "this upload is already complete");
    const directory = this.#directory(row);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const partial = join(directory, "data.part");
    const file = await open(partial, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "EEXIST" ? new UploadError("not_receiving", "this upload is already being received") : error;
    });
    const hash = createHash("sha256");
    let received = 0;
    try {
      for await (const chunk of body as AsyncIterable<Buffer>) {
        received += chunk.length;
        if (received > row.size) throw new UploadError("size_mismatch", `more than the announced ${row.size} bytes`);
        hash.update(chunk);
        for (let written = 0; written < chunk.length;)
          written += (await file.write(chunk, written, chunk.length - written)).bytesWritten;
      }
      if (received !== row.size) throw new UploadError("size_mismatch", `received ${received} of ${row.size} bytes`);
      await file.sync();
      if ((await file.stat()).size !== row.size) throw new Error("the upload was not stored completely");
    } catch (error) {
      await file.close();
      await rm(partial, { force: true });
      throw error;
    }
    await file.close();
    await rename(partial, join(directory, "data"));
    // Persist the new entries: the file in its directory, and the directory, created above, in its parent.
    for (const path of [directory, dirname(directory)]) {
      const entry = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await entry.sync();
      } finally {
        await entry.close();
      }
    }
    await this.#database.run("UPDATE pal_uploads SET state = 'ready', sha256 = ? WHERE id = ?", hash.digest("hex"), id);
    return (await this.get(id)) as Upload;
  }

  /** Check attachments for a message in a project: ready, and that project's own. */
  async check(projectId: string, ids: readonly string[]): Promise<Upload[]> {
    const found: Upload[] = [];
    for (const id of ids) {
      const item = await this.get(id);
      if (item === undefined || item.projectId !== projectId)
        throw new UploadError("not_found", `no upload ${id} in this project`);
      if (item.state !== "ready") throw new UploadError("not_ready", `${item.name} has not finished uploading`);
      found.push(item);
    }
    return found;
  }

  /** What the model receives for each attachment, bounded; the transcript shows the labels separately. */
  async content(projectId: string, ids: readonly string[]): Promise<(TextContent | ImageContent)[]> {
    const blocks: (TextContent | ImageContent)[] = [];
    for (const item of await this.check(projectId, ids)) {
      const label = `name="${item.name.replace(/"/g, "'")}" type="${item.mediaType}" size="${item.size}"`;
      const bytes = await readFile(join(this.#directory({ id: item.id, project_id: item.projectId }), "data")).catch(
        () => undefined,
      );
      if (bytes?.length !== item.size || createHash("sha256").update(bytes).digest("hex") !== item.sha256)
        throw new UploadError("unavailable", `${item.name} is missing or damaged on this device; it cannot be sent`);
      if (IMAGE_TYPES.has(item.mediaType) && item.size <= MAX_IMAGE_BYTES) {
        blocks.push({ type: "text", text: `<attachment ${label}>image follows</attachment>` });
        blocks.push({ type: "image", data: bytes.toString("base64"), mimeType: item.mediaType });
      } else if (!bytes.subarray(0, MAX_TEXT_BYTES).includes(0)) {
        const shown = bytes.subarray(0, MAX_TEXT_BYTES).toString("utf8");
        const cut = item.size > MAX_TEXT_BYTES ? `\n[only the first ${MAX_TEXT_BYTES} bytes are shown]` : "";
        blocks.push({ type: "text", text: `<attachment ${label}>\n${shown}${cut}\n</attachment>` });
      } else {
        blocks.push({
          type: "text",
          text: `<attachment ${label}>binary file; its contents are not shown</attachment>`,
        });
      }
    }
    return blocks;
  }

  #directory(row: Pick<Row, "id" | "project_id">): string {
    return join(this.#root, row.project_id, row.id);
  }
}

function upload(row: Row): Upload {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    mediaType: row.media_type,
    size: row.size,
    sha256: row.sha256,
    state: row.state,
  };
}
