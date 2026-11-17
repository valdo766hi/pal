import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

/** A request the API refuses with this status and machine-readable code. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(request: IncomingMessage, response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(request.method === "HEAD" ? undefined : payload);
}

/** Read a JSON body of at most `limit` bytes, counting while reading rather than trusting Content-Length. */
export async function readJson(request: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  if (!/^application\/json(;|$)/.test(request.headers["content-type"] ?? "")) {
    throw new HttpError(415, "unsupported_media_type", "send application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "too_large", `request bodies are limited to ${limit} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "the body is not valid JSON");
  }
}

export function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/**
 * A loopback name at the arrival port, or the exact configured public host. No forwarded headers or wildcard hosts.
 * The IPv4 loopback address a request arrived on, such as `127.0.0.2` from `--host`, counts as a loopback name.
 */
export function isOwnHost(request: IncomingMessage, external?: URL): boolean {
  const host = request.headers.host;
  const local = request.socket.localAddress?.replace(/^::ffff:/, "");
  const names =
    local !== undefined && isIP(local) === 4 && local.startsWith("127.") ? [...LOOPBACK_NAMES, local] : LOOPBACK_NAMES;
  return (
    host !== undefined &&
    (host === external?.host || names.some((name) => host === `${name}:${request.socket.localPort}`))
  );
}

/** Whether a state-changing request comes from this server's own pages: the exact origin, not merely same-site. */
export function isOwnOrigin(request: IncomingMessage, external?: URL): boolean {
  const origin =
    external !== undefined && request.headers.host === external.host
      ? external.origin
      : `http://${request.headers.host}`;
  return request.headers.origin === origin;
}
