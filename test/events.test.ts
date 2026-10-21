import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/core/api.ts";
import { openPal } from "../src/core/app.ts";
import { startServer } from "../src/core/server.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

const PASSPHRASE = "correct horse battery";

/** A Pal behind a real server whose API handler is counted like `main.ts` counts it for draining. */
async function setup() {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-events-test-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
  cleanups.push(() => pal.close());
  let watches = 0;
  const watch = pal.approvals.watch.bind(pal.approvals);
  vi.spyOn(pal.approvals, "watch").mockImplementation((chatId, listener) => {
    watches++;
    const stop = watch(chatId, listener);
    let stopped = false;
    return () => {
      if (!stopped) watches--;
      stopped = true;
      stop();
    };
  });
  let inFlight = 0;
  const api = createApi(pal);
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    version: "test",
    api: async (request, response, url) => {
      inFlight++;
      try {
        await api(request, response, url);
      } finally {
        inFlight--;
      }
    },
  });
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  await pal.owner.setup(pal.owner.setupToken, PASSPHRASE);
  const project = await pal.projects.create("events-project", { name: "Events" });
  const chat = await pal.chats.createChat("events-chat", { projectId: project.id }, context);
  return { pal, base, port, chat, inFlight: () => inFlight, watches: () => watches };
}

/** An event stream read as text, with a way to wait for content or for its end. */
async function stream(base: string, chatId: string, token: string) {
  const controller = new AbortController();
  cleanups.push(async () => controller.abort());
  const response = await fetch(`${base}/api/chats/${chatId}/events`, {
    headers: { cookie: `pal_session=${token}` },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (reader === undefined) throw new Error("no event stream");
  let text = "";
  let ended = false;
  const pump = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += chunk.value;
      }
    } catch {
      // A destroyed stream ends the read with an error; either way it has ended.
    }
    ended = true;
  })();
  return {
    text: () => text,
    ended: () => ended,
    until: (done: (text: string) => boolean) => expect.poll(() => done(text), { timeout: 5_000 }).toBe(true),
    closed: () => pump,
  };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("chat event streams", () => {
  it("end on sign-out for that session only, before any later change reaches them", async () => {
    const { pal, base, chat } = await setup();
    const leaving = await pal.owner.signIn(PASSPHRASE);
    const staying = await pal.owner.signIn(PASSPHRASE);
    const revoked = await stream(base, chat.id, leaving);
    const kept = await stream(base, chat.id, staying);
    await revoked.until((text) => text.includes("event: approvals"));
    await kept.until((text) => text.includes("event: approvals"));

    const signOut = await fetch(`${base}/api/sign-out`, {
      method: "POST",
      headers: { origin: base, cookie: `pal_session=${leaving}` },
    });
    expect(signOut.status).toBe(200);
    await expect.poll(() => revoked.ended(), { timeout: 5_000 }).toBe(true);
    const before = revoked.text();

    // A change committed after sign-out reaches the other session's stream, never the revoked one.
    await pal.approvals.setMode(chat.id, "full");
    await kept.until((text) => text.includes('"mode":"full"'));
    expect(kept.ended()).toBe(false);
    expect(revoked.text()).toBe(before);
    expect(before).not.toContain('"mode":"full"');
  });

  it("closes an idle stream at its session's expiry, with no event to trigger it", async () => {
    const { pal, base, chat, watches } = await setup();
    const token = await pal.owner.signIn(PASSPHRASE);
    await pal.store.database.run(
      "UPDATE pal_sessions SET expires_at = ? WHERE token_hash = ?",
      Date.now() + 800,
      createHash("sha256").update(token).digest("hex"),
    );
    const expiring = await stream(base, chat.id, token);
    await expiring.until((text) => text.includes("event: approvals"));
    expect(watches()).toBe(1);
    await expect.poll(() => expiring.ended(), { timeout: 5_000 }).toBe(true);
    expect(watches()).toBe(0);
    const after = await fetch(`${base}/api/chats/${chat.id}/events`, { headers: { cookie: `pal_session=${token}` } });
    expect(after.status).toBe(401);
  });

  it("settles and detaches when the client vanishes during backpressure, and lets a slow reader resume", async () => {
    const { pal, port, chat, inFlight, watches } = await setup();
    // A snapshot far larger than the socket buffers, so its first write must wait for drain.
    const conversation = await pal.harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing conversation");
    const filler = "x".repeat(100_000);
    for (let i = 0; i < 40; i++)
      await conversation.commit(
        async (tx) => tx.appendEntry(chat.conversationId, { kind: "pal.fixture", data: { filler } }),
        context,
      );
    const token = await pal.owner.signIn(PASSPHRASE);
    const open = () => {
      const socket = connect(port, "127.0.0.1");
      socket.pause();
      socket.write(
        `GET /api/chats/${chat.id}/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: pal_session=${token}\r\n\r\n`,
      );
      cleanups.push(async () => socket.destroy());
      return socket;
    };

    const vanishing = open();
    await expect.poll(() => inFlight()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(inFlight()).toBe(1);
    vanishing.destroy();
    await expect.poll(() => inFlight(), { timeout: 5_000 }).toBe(0);
    expect(watches()).toBe(0);

    const slow = open();
    await new Promise((resolve) => setTimeout(resolve, 300));
    let received = "";
    slow.setEncoding("utf8");
    slow.on("data", (chunk: string) => (received += chunk));
    slow.resume();
    await expect.poll(() => count(received, "event: approvals"), { timeout: 10_000 }).toBe(1);
    expect(received).toContain("event: snapshot");
    expect(count(received, filler)).toBe(40);
    expect(watches()).toBe(1);
    slow.destroy();
    await expect.poll(() => watches(), { timeout: 5_000 }).toBe(0);
    await expect.poll(() => inFlight(), { timeout: 5_000 }).toBe(0);
  });
});
