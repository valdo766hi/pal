import { once } from "node:events";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import sirv from "sirv";
import { isOwnHost, sendJson } from "./http.ts";

export type ServerOptions = {
  version: string;
  /** Probation/drain blocks all observation and admission except the public health probe. */
  available?: (() => boolean) | undefined;
  health?: (() => Record<string, unknown>) | undefined;
  upgrade?: ((request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>) | undefined;
  publicOrigin?: string | undefined;
  /** Built frontend directory; absent in development, where Vite serves the UI. */
  webRoot?: string | undefined;
  /** Handles every other `/api/` route; absent, they are 404. */
  api?: ((request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>) | undefined;
};

const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  // The UI ships its own scripts, styles and fonts; nothing loads from elsewhere.
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

export function createRequestListener({
  version,
  webRoot,
  api,
  publicOrigin,
  available,
  health,
}: ServerOptions): RequestListener {
  const external = publicOrigin === undefined ? undefined : URL.parse(publicOrigin);
  if (external === null) throw new Error("invalid public origin");
  // Built files come from the Nix store, whose timestamps are all 1970: without a policy, browsers keep index.html and
  // the icons for years. Vite's content-hashed assets never change under the same name.
  const assets =
    webRoot === undefined
      ? undefined
      : sirv(webRoot, {
          single: true,
          setHeaders: (response, pathname) => {
            let cache = "no-cache";
            if (pathname.startsWith("/assets/")) cache = "public, max-age=31536000, immutable";
            response.setHeader("cache-control", cache);
          },
        });

  return (request, response) => {
    for (const [name, value] of Object.entries(BASE_HEADERS)) response.setHeader(name, value);
    // A throw here would crash the process, so malformed request targets get a 400 instead.
    const url = URL.parse(request.url ?? "/", "http://pal.invalid");
    if (url === null) return sendJson(request, response, 400, { error: "bad_request" });
    if (!isOwnHost(request, external)) return sendJson(request, response, 421, { error: "wrong_host" });
    const ws = `${external?.protocol === "https:" && request.headers.host === external.host ? "wss" : "ws"}://${request.headers.host}`;
    response.setHeader(
      "content-security-policy",
      BASE_HEADERS["content-security-policy"] + "; connect-src 'self' " + ws,
    );
    const { pathname } = url;
    const readOnly = request.method === "GET" || request.method === "HEAD";

    if (pathname === "/api/health") {
      if (!readOnly) return methodNotAllowed(response);
      const current = health?.() ?? { status: "ok", name: "pal", version };
      return sendJson(request, response, current.status === "ok" ? 200 : 503, current);
    }
    if (available?.() === false)
      return sendJson(request, response, 503, {
        error: "restarting",
        message: "Pal is checking a release or draining for restart. Reconnect shortly.",
      });
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (api !== undefined) return void api(request, response, url);
      return sendJson(request, response, 404, { error: "not_found" });
    }
    if (!readOnly) return methodNotAllowed(response);
    if (assets === undefined) {
      return sendJson(request, response, 404, { error: "web_not_built" });
    }
    assets(request, response, () => sendJson(request, response, 404, { error: "not_found" }));
  };
}

/** Listen on one port; resolves once bound so callers can read the actual address. */
export async function startServer(options: ServerOptions & { host: string; port: number }): Promise<Server> {
  const server = createServer(createRequestListener(options));
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    if (options.upgrade === undefined || options.available?.() === false) {
      socket.destroy();
      return;
    }
    socket.pause();
    const deadline = setTimeout(() => socket.destroy(), 5000);
    deadline.unref();
    void options
      .upgrade(request, socket, head)
      .catch(() => socket.destroy())
      .finally(() => {
        clearTimeout(deadline);
        socket.resume();
      });
  });
  server.listen(options.port, options.host);
  await once(server, "listening");
  return server;
}

function methodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
  response.end("Method Not Allowed\n");
}
