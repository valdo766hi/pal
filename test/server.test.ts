import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingHttpHeaders, request as httpRequest, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compressAssets } from "../scripts/compress-assets.ts";
import { startServer } from "../src/core/server.ts";
import { releaseHealth } from "../src/core/supervise.ts";

let dir: string;
const servers: Server[] = [];

async function serve(webRoot: string | undefined): Promise<string> {
  const server = await startServer({ host: "127.0.0.1", port: 0, version: "1.2.3", webRoot });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pal-server-test-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>Pal</title>");
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "assets", "index-1a2b3c.js"), "");
});

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  await rm(dir, { recursive: true, force: true });
});

describe("HTTP server", () => {
  it("holds APIs, assets and upgrades behind probation/drain while health verifies the exact artifact", async () => {
    let available = false,
      calls = 0,
      upgrades = 0;
    const release = "c".repeat(64);
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      version: "test",
      webRoot: dir,
      available: () => available,
      health: () => ({ status: "ok", release, admitting: available }),
      api: async (_request, response) => {
        calls++;
        response.end("{}");
      },
      upgrade: async (_request, socket) => {
        upgrades++;
        socket.destroy();
      },
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port,
      base = `http://127.0.0.1:${port}`;
    await releaseHealth(base, release);
    await expect(releaseHealth(base, "d".repeat(64))).rejects.toThrow(/immutable artifact/);
    for (const path of ["/", "/api/session", "/api/projects"]) expect((await fetch(`${base}${path}`)).status).toBe(503);
    expect(calls).toBe(0);
    const upgrade = () =>
      new Promise<void>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.on("error", () => {});
        socket.once("close", () => resolve());
        socket.end(
          `GET /api/socket HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        );
      });
    await upgrade();
    expect(upgrades).toBe(0);
    available = true;
    await upgrade();
    expect(upgrades).toBe(1);
    expect((await fetch(`${base}/api/session`)).status).toBe(200);
    expect(calls).toBe(1);
    expect((await fetch(base)).status).toBe(200);
    await expect(releaseHealth(base, release)).rejects.toThrow(/admission barrier/);
  });

  it("reports health with security headers and no caching", async () => {
    const base = await serve(dir);
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", name: "pal", version: "1.2.3" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self' data: blob:;");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self';");

    const head = await fetch(`${base}/api/health`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("rejects writes and unknown API routes", async () => {
    const base = await serve(dir);
    const post = await fetch(`${base}/api/health`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    const missing = await fetch(`${base}/api/unknown`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect((await fetch(`${base}/`, { method: "DELETE" })).status).toBe(405);
  });

  it("serves the built shell, falling back to index.html for client routes", async () => {
    const base = await serve(dir);
    for (const path of ["/", "/projects/abc"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>Pal</title>");
      // Unhashed files are checked again on each load, so a new release replaces them at once.
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
    const asset = await fetch(`${base}/assets/index-1a2b3c.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("answers a malformed request target with 400 and keeps serving", async () => {
    const base = await serve(dir);
    const { port } = new URL(base);
    const socket = connect(Number(port), "127.0.0.1");
    socket.end("GET http://[bad HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    let reply = "";
    for await (const chunk of socket) reply += chunk;
    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it("serves only the API when no frontend was built", async () => {
    const base = await serve(undefined);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(404);
    expect(await page.json()).toEqual({ error: "web_not_built" });
  });

  it("serves precompressed Brotli and gzip JS/CSS assets while keeping HTML no-cache and SSE unbuffered", async () => {
    const compressedDir = await mkdtemp(join(tmpdir(), "pal-compressed-test-"));
    try {
      const html = '<!doctype html><title>Pal</title><script src="/assets/app-abc123.js"></script>';
      const js = `export const payload = ${JSON.stringify("pal-static-asset-".repeat(200))};\n`;
      const css = `.pal-shell { color: var(--fg); }\n`.repeat(150);
      await writeFile(join(compressedDir, "index.html"), html);
      await mkdir(join(compressedDir, "assets"));
      await writeFile(join(compressedDir, "assets", "app-abc123.js"), js);
      await writeFile(join(compressedDir, "assets", "app-abc123.css"), css);
      expect(await compressAssets(compressedDir)).toBe(2);

      const server = await startServer({
        host: "127.0.0.1",
        port: 0,
        version: "1.2.3",
        webRoot: compressedDir,
        api: async (_req, response, url) => {
          if (url.pathname !== "/api/sse") return void response.writeHead(404).end();
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
          });
          response.write("data: first\n\n");
          response.end("data: second\n\n");
        },
      });
      servers.push(server);
      const { port } = server.address() as AddressInfo;

      const rawGet = (path: string, acceptEncoding?: string) =>
        new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: "127.0.0.1",
              port,
              path,
              headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        });

      for (const [path, expected] of [
        ["/assets/app-abc123.js", Buffer.from(js)],
        ["/assets/app-abc123.css", Buffer.from(css)],
      ] as const) {
        const identity = await rawGet(path, "identity");
        expect(identity.status).toBe(200);
        expect(identity.headers["content-encoding"]).toBeUndefined();
        expect(identity.headers["vary"]).toBe("Accept-Encoding");
        expect(identity.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        expect(identity.body).toEqual(expected);

        const gzip = await rawGet(path, "gzip");
        expect(gzip.status).toBe(200);
        expect(gzip.headers["content-encoding"]).toBe("gzip");
        expect(gzip.headers["vary"]).toBe("Accept-Encoding");
        expect(gzip.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        expect(gzip.headers["content-type"]).toBe(identity.headers["content-type"]);
        expect(gzip.body.length).toBeLessThan(identity.body.length);
        expect(gunzipSync(gzip.body)).toEqual(expected);

        const br = await rawGet(path, "gzip, br");
        expect(br.status).toBe(200);
        expect(br.headers["content-encoding"]).toBe("br");
        expect(br.headers["vary"]).toBe("Accept-Encoding");
        expect(br.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        expect(br.headers["content-type"]).toBe(identity.headers["content-type"]);
        expect(br.body.length).toBeLessThan(identity.body.length);
        expect(brotliDecompressSync(br.body)).toEqual(expected);
      }

      const index = await rawGet("/", "gzip, br");
      expect(index.status).toBe(200);
      expect(index.headers["content-encoding"]).toBeUndefined();
      expect(index.headers["cache-control"]).toBe("no-cache");
      expect(index.body.toString("utf8")).toBe(html);

      const sse = await rawGet("/api/sse", "gzip, br");
      expect(sse.status).toBe(200);
      expect(sse.headers["content-encoding"]).toBeUndefined();
      expect(sse.headers["content-type"]).toContain("text/event-stream");
      expect(sse.body.toString("utf8")).toBe("data: first\n\ndata: second\n\n");
    } finally {
      await rm(compressedDir, { recursive: true, force: true });
    }
  });
});
