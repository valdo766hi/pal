import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { diffRevisions, encoder, type JsonValue, type Op } from "@earendil-works/chord/delta";
import type { JsonObject } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/core/api.ts";
import { openPal } from "../src/core/app.ts";
import { startServer } from "../src/core/server.ts";
import { ChatStream } from "../web/src/lib/chat.svelte.ts";

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

  it("resends a snapshot with every entry once a backlog outgrows the view's window", async () => {
    const { pal, base, chat } = await setup();
    const conversation = await pal.harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing conversation");
    const append = (data: JsonObject) =>
      conversation.commit(async (tx) => tx.appendEntry(chat.conversationId, { kind: "pal.fixture", data }), context);
    // Large enough that the first snapshot waits for the reader, so later commits pile up behind it.
    const filler = "x".repeat(100_000);
    for (let i = 0; i < 40; i++) await append({ filler });
    const token = await pal.owner.signIn(PASSPHRASE);
    const controller = new AbortController();
    cleanups.push(async () => controller.abort());
    const response = await fetch(`${base}/api/chats/${chat.id}/events`, {
      headers: { cookie: `pal_session=${token}` },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (let n = 0; n < 120; n++) await append({ n });

    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (reader === undefined) throw new Error("no event stream");
    type Received = { id: number; data?: { n?: number } };
    let entries: Received[] = [];
    let snapshots = 0;
    let pending = "";
    while (!entries.some((entry) => entry.data?.n === 119)) {
      const { value, done } = await reader.read();
      if (done) throw new Error("event stream ended early");
      pending += value;
      for (let end = pending.indexOf("\n\n"); end >= 0; end = pending.indexOf("\n\n")) {
        const [, event, data] = /^event: (.*)\ndata: (.*)$/.exec(pending.slice(0, end)) ?? [];
        pending = pending.slice(end + 2);
        if (event !== "snapshot") continue;
        const snapshot = JSON.parse(data ?? "") as { view: { entries: Received[] }; earlier: Received[] };
        entries = [...snapshot.earlier, ...snapshot.view.entries];
        snapshots++;
      }
    }
    expect(snapshots).toBe(2);
    expect(entries.flatMap((entry) => (entry.data?.n === undefined ? [] : [entry.data.n]))).toEqual(
      Array.from({ length: 120 }, (_, n) => n),
    );
    expect(entries.filter((entry) => entry.data?.n === undefined)).toHaveLength(40);
    await reader.cancel();
  });
});

/** The browser's EventSource, driven by the test with the server's event names. */
class FakeEventSource {
  static CLOSED = 2;
  static last: FakeEventSource | undefined;
  readyState = 1;
  readonly #listeners = new Map<string, ((event: { data: string }) => void)[]>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, listener: (event: { data: string }) => void) {
    this.#listeners.set(name, [...(this.#listeners.get(name) ?? []), listener]);
  }
  emit(name: string, ...data: unknown[]) {
    for (const item of data)
      for (const listener of this.#listeners.get(name) ?? []) listener({ data: JSON.stringify(item) });
  }
  close() {}
}

describe("web projection of the conversation view", () => {
  type View = { conversation: { id: number }; entries: { id: number; kind: string }[]; before?: number; docs: Docs };
  type Docs = Record<string, Record<string, unknown>>;
  const view = (docs: Docs = {}, entries: View["entries"] = [], before?: number): View => ({
    conversation: { id: 1 },
    entries,
    ...(before === undefined ? {} : { before }),
    docs: { "pi.inbox": { items: [] }, ...docs },
  });
  const entry = (id: number, kind = "pi.user") => ({ id, kind });
  /** A stream fed like the server feeds it: a snapshot, then each change as encoded ops from that snapshot on. */
  const open = (first: View = view(), earlier: View["entries"] = []) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const stream = new ChatStream("chat-one");
    const source = FakeEventSource.last as FakeEventSource;
    let current = first;
    let encoding = encoder();
    source.emit("snapshot", { view: first, earlier });
    return {
      stream,
      source,
      ops: (ops: Op[]) => source.emit("change", encoding.encode(ops)),
      change(next: View) {
        source.emit(
          "change",
          encoding.encode(diffRevisions(current as unknown as JsonValue, next as unknown as JsonValue)),
        );
        current = next;
      },
      snapshot(next: View, before: View["entries"] = []) {
        encoding = encoder();
        current = next;
        source.emit("snapshot", { view: next, earlier: before });
      },
    };
  };
  const live = (state: Record<string, unknown>) => ({ "pi.live": state });
  afterEach(() => vi.unstubAllGlobals());

  it("appends streamed text and tool-call arguments at their paths without rebuilding history", () => {
    const message = (code: string, text: string) => ({
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "toolCall", id: "call-1", name: "codemode", arguments: { code } },
      ],
    });
    const { stream, ops } = open(
      view(
        live({
          run: { taskId: 5, inputs: [1], turns: 0 },
          generation: { attempt: 1, message: message("console.", "Let me ") },
        }),
        [entry(1)],
      ),
    );
    const history = stream.entries;
    const content = ["docs", "pi.live", "generation", "message", "content"] as const;
    ops([
      ["a", [...content, 1, "arguments", "code"], 'log("hello")'],
      ["a", [...content, 0, "text"], "check."],
    ]);
    expect(stream.partial?.content).toEqual(message('console.log("hello")', "Let me check.").content);
    expect(stream.running).toBe(true);
    expect(stream.entries).toBe(history);
  });

  it("projects tool slots by native IDs and never shows a faulted call or run as done", () => {
    const run = { taskId: 5, inputs: [1], turns: 1 };
    const parent = { parentCallId: "call-1", parentTaskId: 7 };
    const { stream, change } = open();
    change(
      view(
        live({
          run,
          tools: [{ callId: "call-1", name: "codemode", status: "running", taskId: 7 }],
          nestedTools: [
            {
              callId: "call-1/1",
              name: "files_read",
              status: "running",
              taskId: 8,
              arguments: {},
              output: "partial",
              ...parent,
            },
            {
              callId: "call-1/2",
              name: "files_read",
              status: "done",
              taskId: 9,
              arguments: {},
              summary: { isError: true },
              ...parent,
            },
          ],
        }),
      ),
    );
    expect(stream.tools).toEqual([{ callId: "call-1", name: "codemode", status: "running", taskId: 7 }]);
    expect(stream.nested.map((slot) => [slot.callId, slot.parentTaskId, slot.status, slot.summary?.isError])).toEqual([
      ["call-1/1", 7, "running", undefined],
      ["call-1/2", 7, "done", true],
    ]);
    expect(stream.nested[0]?.output).toBe("partial");
    // The model-issued call faulted: done without a result entry, so nothing records it as succeeded.
    change(view(live({ run, tools: [{ callId: "call-1", name: "codemode", status: "done", taskId: 7 }] })));
    expect(stream.tools[0]).toMatchObject({ status: "done" });
    expect(stream.tools[0]?.entry).toBeUndefined();
    expect(stream.nested).toEqual([]);
    change(view(live({ runFailure: { taskId: 5, inputs: [1], reason: "faulted", detail: "the run's task faulted" } })));
    expect([stream.running, stream.tools, stream.failure]).toEqual([
      false,
      [],
      { reason: "faulted", message: "the run's task faulted" },
    ]);
    // A run the owner stopped shows as stopped in its answer, not as a failure.
    change(view(live({ runFailure: { taskId: 6, inputs: [2], reason: "aborted" } })));
    expect(stream.failure).toBeUndefined();
  });

  it("keeps the entries a window drops and the history before it, adding only new ones", () => {
    const { stream, change } = open(view({}, [entry(3), entry(4, "pi.assistant")], 2), [entry(1), entry(2)]);
    expect(stream.entries.map((item) => item.id)).toEqual([1, 2, 3, 4]);
    // Past its maximum the window drops its oldest entries in one splice, after appending the new one.
    change(view({}, [entry(5, "pi.assistant")], 4));
    expect(stream.entries.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("replaces stale live state from a reconnect snapshot and tracks retries, polls and compaction", () => {
    const { stream, change, snapshot } = open();
    const generation = { attempt: 2, message: { role: "assistant", content: [{ type: "text", text: "old" }] } };
    const compaction = { taskId: 20, trigger: "threshold", blocking: true, attempt: 1 };
    change(
      view(
        live({
          run: { taskId: 5, inputs: [1], turns: 0 },
          generation: { ...generation, retry: { at: 5, error: "overloaded" } },
          tools: [{ callId: "call-1", name: "codemode", status: "running", taskId: 7 }],
          compactions: [compaction],
        }),
      ),
    );
    expect([stream.running, stream.retry, stream.compactions.length]).toEqual([
      true,
      { at: 5, error: "overloaded" },
      1,
    ]);
    change(
      view(
        live({
          run: { taskId: 5, inputs: [1], turns: 0 },
          generation: { ...generation, deferred: { pollAt: 9 } },
          compactionFailure: { taskId: 20, trigger: "threshold", error: "summary failed" },
          runFailure: { taskId: 4, inputs: [], reason: "interrupted", detail: "cut off once" },
        }),
      ),
    );
    expect([stream.retry, stream.deferredPoll, stream.compactions, stream.compactionFailure?.error]).toEqual([
      undefined,
      9,
      [],
      "summary failed",
    ]);
    expect(stream.failure).toEqual({ reason: "interrupted", message: "cut off once" });
    // A snapshot that omits documents replaces everything.
    snapshot({ conversation: { id: 1 }, entries: [entry(3)], docs: {} });
    expect({
      running: stream.running,
      partial: stream.partial,
      tools: stream.tools,
      inbox: stream.inbox,
      deferred: stream.deferredPoll,
      compactionFailure: stream.compactionFailure,
      failure: stream.failure,
      entries: stream.entries.map((item) => item.id),
    }).toEqual({
      running: false,
      partial: undefined,
      tools: [],
      inbox: [],
      deferred: undefined,
      compactionFailure: undefined,
      failure: undefined,
      entries: [3],
    });
  });

  it("ignores a malformed or unsafe change and keeps the view it had", () => {
    const { stream, source, change } = open(view(live({ run: { taskId: 5, inputs: [1], turns: 0 } })));
    source.emit("change", [["s", ["__proto__", "polluted"], true]], ["nonsense"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(stream.running).toBe(true);
    // Later changes still apply to the view it kept.
    change(view());
    expect(stream.running).toBe(false);
  });
});
