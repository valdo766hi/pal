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

describe("web projection of native events", () => {
  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    type: "snapshot",
    entries: [],
    tools: [],
    nestedTools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {} },
    ...overrides,
  });
  const open = () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const stream = new ChatStream("chat-one");
    const source = FakeEventSource.last as FakeEventSource;
    source.emit("snapshot", snapshot());
    return { stream, event: (...events: unknown[]) => source.emit("event", ...events), source };
  };
  const call = (id: string, task: number, parent?: { id: string; task: number }) => ({
    toolCallId: id,
    toolName: parent === undefined ? "codemode" : "files_read",
    taskId: task,
    ...(parent === undefined ? {} : { parentToolCallId: parent.id, parentTaskId: parent.task }),
  });
  afterEach(() => vi.unstubAllGlobals());

  it("applies tool-call argument deltas at their path, between interleaved text", () => {
    const { stream, event } = open();
    event(
      { type: "message_start", message: { role: "assistant", content: [] } },
      {
        type: "message_update",
        changes: [
          { type: "text_start", contentIndex: 0, block: { type: "text", text: "Let me " } },
          {
            type: "toolcall_start",
            contentIndex: 1,
            block: { type: "toolCall", id: "call-1", name: "codemode", arguments: { code: "console." } },
          },
          { type: "toolcall_delta", contentIndex: 1, path: ["code"], delta: 'log("hello")' },
          { type: "text_delta", contentIndex: 0, delta: "check." },
        ],
      },
    );
    expect(stream.partial?.content).toEqual([
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "call-1", name: "codemode", arguments: { code: 'console.log("hello")' } },
    ]);
  });

  it("projects nested calls by native IDs and never shows a faulted call as done", () => {
    const { stream, event } = open();
    const parent = { id: "call-1", task: 7 };
    event(
      { type: "run_start", inputs: [1] },
      { type: "tool_execution_start", args: { code: "x" }, ...call("call-1", 7) },
      { type: "tool_execution_start", args: { path: "a" }, ...call("call-1/1", 8, parent) },
      { type: "tool_execution_start", args: { path: "b" }, ...call("call-1/2", 9, parent) },
      { type: "tool_execution_update", output: { append: "partial" }, ...call("call-1/1", 8, parent) },
      {
        type: "tool_execution_end",
        result: { taskId: 8, isError: false, diagnostics: [] },
        ...call("call-1/1", 8, parent),
      },
      { type: "tool_execution_end", ...call("call-1/2", 9, parent) },
    );
    expect(stream.tools).toEqual([{ callId: "call-1", name: "codemode", status: "running", taskId: 7 }]);
    expect(stream.nested.map((slot) => [slot.callId, slot.parentTaskId, slot.status, slot.summary?.isError])).toEqual([
      ["call-1/1", 7, "done", false],
      ["call-1/2", 7, "done", true],
    ]);
    expect(stream.nested[0]?.output).toBe("partial");
    // The model-issued call faulted: no result entry, so nothing records it as done.
    event(
      { type: "tool_execution_end", ...call("call-1", 7) },
      { type: "task_failed", taskId: 7, kind: "tool", message: "the tool task faulted" },
    );
    expect([stream.tools, stream.nested, stream.entries]).toEqual([[], [], []]);
    expect(stream.failure).toEqual({ kind: "tool", message: "the tool task faulted" });
  });

  it("keeps repeated provider call IDs of different turns apart", () => {
    const { stream, event } = open();
    const entry = (id: number) => ({
      id,
      kind: "pi.toolResult",
      model: [{ role: "toolResult", toolCallId: "call-1", content: [] }],
    });
    event(
      { type: "run_start", inputs: [1] },
      { type: "tool_execution_start", args: {}, ...call("call-1", 7) },
      { type: "tool_execution_end", entry: entry(11), ...call("call-1", 7) },
      { type: "turn_end" },
      { type: "turn_start" },
      { type: "tool_execution_start", args: {}, ...call("call-1", 12) },
    );
    expect(stream.entries.map((item) => item.id)).toEqual([11]);
    expect(stream.tools).toEqual([{ callId: "call-1", name: "codemode", status: "running", taskId: 12 }]);
  });

  it("replaces stale live state from a reconnect snapshot and tracks retries, polls and compaction", () => {
    const { stream, event, source } = open();
    event(
      { type: "run_start", inputs: [1] },
      { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
      { type: "tool_execution_start", args: {}, ...call("call-1", 7) },
      { type: "auto_retry_start", attempt: 2, at: 5, errorMessage: "overloaded" },
      { type: "auto_retry_end", attempt: 2 },
      { type: "deferred_poll", pollAt: 9 },
      { type: "compaction_start", taskId: 20, reason: "threshold", blocking: true },
      { type: "task_failed", taskId: 21, kind: "generation", message: "stale failure" },
    );
    expect([stream.running, stream.retry, stream.deferredPoll, stream.compactions.length]).toEqual([
      true,
      undefined,
      9,
      1,
    ]);
    event({ type: "compaction_end", taskId: 20, reason: "threshold", error: "summary failed" });
    expect([stream.compactions, stream.compactionFailure?.error]).toEqual([[], "summary failed"]);
    // Even a snapshot that omits fields replaces everything.
    source.emit("snapshot", { entries: [{ id: 3, kind: "pi.user" }] });
    expect({
      running: stream.running,
      partial: stream.partial,
      tools: stream.tools,
      deferred: stream.deferredPoll,
      compactionFailure: stream.compactionFailure,
      failure: stream.failure,
      entries: stream.entries.map((item) => item.id),
    }).toEqual({
      running: false,
      partial: undefined,
      tools: [],
      deferred: undefined,
      compactionFailure: undefined,
      failure: undefined,
      entries: [3],
    });
  });
});
