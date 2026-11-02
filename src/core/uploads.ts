import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { type Static, Type } from "typebox";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** What of one attachment reaches the model: text inline up to this, images up to the next. */
const MAX_TEXT_BYTES = 100 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Characters of text one read returns, like a project file read; a longer line is cut. */
const MAX_PAGE_CHARS = 256 * 1024;

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

/** What of an attachment its message gave the model: its leading text, the whole image, or nothing of a binary file. */
export type Received =
  { readonly kind: "text"; readonly bytes: number } | { readonly kind: "image" } | { readonly kind: "binary" };
/** An attachment as its message's transcript entry records it. */
export type AttachmentLabel = Pick<Upload, "id" | "name" | "size" | "mediaType"> & { readonly received: Received };
/** Part of an attachment the agent asked for: lines of text, the whole image, or only what a binary file is. */
export type AttachmentPage =
  | {
      readonly kind: "text";
      readonly lines: readonly string[];
      /** The attachment's line count once the read reached its end; absent while lines follow. */
      readonly total?: number;
    }
  | { readonly kind: "image"; readonly data: string; readonly mimeType: string }
  | { readonly kind: "binary"; readonly name: string; readonly mediaType: string; readonly size: number };

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

  /** What the model receives for each attachment, bounded, and the labels that record it in the transcript. */
  async content(
    projectId: string,
    ids: readonly string[],
  ): Promise<{ content: (TextContent | ImageContent)[]; labels: AttachmentLabel[] }> {
    const content: (TextContent | ImageContent)[] = [];
    const labels: AttachmentLabel[] = [];
    for (const item of await this.check(projectId, ids)) {
      const label = `id="${item.id}" name="${item.name.replace(/"/g, "'")}" type="${item.mediaType}" size="${item.size}"`;
      const image = IMAGE_TYPES.has(item.mediaType) && item.size <= MAX_IMAGE_BYTES;
      const head = await this.#head(item, image ? item.size : MAX_TEXT_BYTES);
      let received: Received;
      if (image) {
        content.push({ type: "text", text: `<attachment ${label}>image follows</attachment>` });
        content.push({ type: "image", data: head.toString("base64"), mimeType: item.mediaType });
        received = { kind: "image" };
      } else if (!head.includes(0)) {
        const cut =
          item.size > head.length
            ? `\n[only the first ${head.length} bytes are shown; files_attachment reads the rest]`
            : "";
        content.push({ type: "text", text: `<attachment ${label}>\n${head.toString("utf8")}${cut}\n</attachment>` });
        received = { kind: "text", bytes: head.length };
      } else {
        content.push({
          type: "text",
          text: `<attachment ${label}>binary file; its contents are not shown</attachment>`,
        });
        received = { kind: "binary" };
      }
      labels.push({ id: item.id, name: item.name, size: item.size, mediaType: item.mediaType, received });
    }
    return { content, labels };
  }

  /**
   * Up to `limit` lines of an attachment from line `offset`, like a project file read, streamed through its integrity
   * check without holding the payload. An image comes whole; a file with a NUL in its first text bytes is binary.
   */
  async read(projectId: string, id: string, offset: number, limit: number): Promise<AttachmentPage> {
    const [item] = await this.check(projectId, [id]);
    if (item === undefined) throw new UploadError("not_found", `no upload ${id} in this project`);
    if (IMAGE_TYPES.has(item.mediaType) && item.size <= MAX_IMAGE_BYTES)
      return { kind: "image", data: (await this.#head(item, item.size)).toString("base64"), mimeType: item.mediaType };
    const decoder = new StringDecoder("utf8");
    const lines: string[] = [];
    let line = 1;
    let current = "";
    let cut = false;
    let chars = 0;
    let more = false;
    let seen = 0;
    let binary = false;
    const finish = () => {
      if (line >= offset && !more) {
        const text = cut ? `${current} [line cut at ${MAX_PAGE_CHARS} characters]` : current;
        // A page always takes its first line, so a cut line cannot stall paging.
        if (lines.length === 0 || (lines.length < limit && chars + text.length <= MAX_PAGE_CHARS)) {
          lines.push(text);
          chars += text.length + 1;
        } else more = true;
      }
      line += 1;
      current = "";
      cut = false;
    };
    const append = (text: string) => {
      cut ||= current.length + text.length > MAX_PAGE_CHARS;
      current += text.slice(0, MAX_PAGE_CHARS - current.length);
    };
    await this.#stream(item, (chunk) => {
      binary ||= seen < MAX_TEXT_BYTES && chunk.subarray(0, MAX_TEXT_BYTES - seen).includes(0);
      seen += chunk.length;
      if (binary || more) return;
      const parts = decoder.write(chunk).split("\n");
      parts.forEach((part, index) => {
        if (index > 0) finish();
        append(part);
      });
    });
    if (binary) return { kind: "binary", name: item.name, mediaType: item.mediaType, size: item.size };
    if (!more) {
      append(decoder.end());
      if (current !== "" || cut) finish();
    }
    return more ? { kind: "text", lines } : { kind: "text", lines, total: line - 1 };
  }

  /** The first `length` bytes of an attachment, after checking all of it. */
  async #head(item: Upload, length: number): Promise<Buffer> {
    const head = Buffer.alloc(Math.min(length, item.size));
    let filled = 0;
    await this.#stream(item, (chunk) => {
      if (filled < head.length) filled += chunk.copy(head, filled);
    });
    return head;
  }

  /** Stream a ready attachment through its recorded length and hash; a missing or damaged payload is unavailable. */
  async #stream(item: Upload, visit: (chunk: Buffer) => void): Promise<void> {
    const damaged = () => new UploadError("unavailable", `${item.name} is missing or damaged on this device.`);
    const hash = createHash("sha256");
    let size = 0;
    try {
      const path = join(this.#directory({ id: item.id, project_id: item.projectId }), "data");
      for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > item.size) throw damaged();
        hash.update(chunk);
        visit(chunk);
      }
    } catch (error) {
      throw error instanceof UploadError ? error : damaged();
    }
    if (size !== item.size || hash.digest("hex") !== item.sha256) throw damaged();
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
