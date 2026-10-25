import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../src/core/api.ts";
import { openPal, type Pal } from "../src/core/app.ts";
import type { CommandApproval } from "../src/core/approvals.ts";
import { startServer } from "../src/core/server.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const shell = (command: string, timeout = 5) =>
  `return await tools.shell_run({ command: ${JSON.stringify(command)}, timeout: ${timeout} });`;

/** Point the open Pal at a fresh faux model that answers `codes` as scripts, then "done". */
function answer(pal: Pal, codes: string[]) {
  const faux = fauxProvider();
  (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  faux.setResponses([
    ...codes.map((code) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" })),
    fauxAssistantMessage("done"),
  ]);
  return faux.getModel();
}

async function setup(options: { approvalTtlMs?: number; dataRoot?: string } = {}) {
  const dataRoot = options.dataRoot ?? (await realpath(await mkdtemp(join(tmpdir(), "pal-approvals-"))));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const open = () =>
    openPal(
      {
        dataRoot,
        installRoot: "/nonexistent-install",
        ...(options.approvalTtlMs === undefined ? {} : { approvalTtlMs: options.approvalTtlMs }),
      },
      context,
    );
  let pal = await open();
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("approval-project", { name: "Fixture" });
  const chat = await pal.chats.createChat("approval-chat", { projectId: project.id }, context);
  const conversation = async () => {
    const found = await pal.harness.conversation(chat.conversationId, context);
    if (found === undefined) throw new Error("fixture conversation missing");
    return found;
  };
  let inputs = 0;
  const start = async (...codes: string[]) => {
    const model = answer(pal, codes);
    await (await conversation()).configure({ model: { provider: model.provider, modelId: model.id } }, context);
    await pal.chats.submit(chat.id, `approval-input-${++inputs}`, { text: "run the fixture" }, context);
  };
  const waiting = async (count = 1): Promise<CommandApproval[]> => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const pending = (await pal.approvals.view(chat.id)).approvals.filter((approval) => approval.state === "pending");
      if (pending.length >= count) return pending;
      await sleep(10);
    }
    throw new Error("no command is waiting for approval");
  };
  /** The run's tool results, once it is idle. */
  const results = async () => {
    const current = await conversation();
    await current.waitForIdle(context);
    return (await current.context(context)).messages.flatMap((message) =>
      message.role === "toolResult"
        ? [message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")]
        : [],
    );
  };
  const marker = () => readFile(join(project.root, "marker"), "utf8").catch(() => undefined);
  return {
    dataRoot,
    project,
    chat,
    start,
    waiting,
    results,
    marker,
    conversation,
    get pal() {
      return pal;
    },
    reopen: async () => {
      await pal.close();
      pal = await open();
      return pal;
    },
  };
}

describe("command approval modes", () => {
  it("asks before a new chat's command and runs exactly the approved request once", async () => {
    const fixture = await setup();
    const { pal, chat, project } = fixture;
    expect((await pal.approvals.view(chat.id)).mode).toBe("ask");
    await fixture.start(shell("printf run >> marker; printf approved-output", 7));
    const [request] = await fixture.waiting();
    expect(request).toMatchObject({
      command: "printf run >> marker; printf approved-output",
      cwd: await realpath(project.root),
      timeout: 7,
      state: "pending",
      decidedAt: null,
    });
    if (request === undefined) throw new Error("missing request");
    expect(request.expiresAt - request.createdAt).toBe(120_000);
    await sleep(100);
    expect(await fixture.marker()).toBeUndefined();
    // A decision for another digest or chat is refused and leaves the request waiting.
    await expect(pal.approvals.decide(chat.id, request.id, "approve", "0".repeat(64))).rejects.toMatchObject({
      status: 409,
      code: "approval_stale",
    });
    const other = await pal.chats.createChat("other-chat", { projectId: project.id }, context);
    await expect(pal.approvals.decide(other.id, request.id, "approve", request.digest)).rejects.toMatchObject({
      code: "approval_stale",
    });
    expect((await fixture.waiting())[0]?.id).toBe(request.id);
    await pal.approvals.decide(chat.id, request.id, "approve", request.digest);
    expect((await fixture.results()).join("\n")).toContain("approved-output");
    expect(await fixture.marker()).toBe("run");
    await expect(pal.approvals.decide(chat.id, request.id, "deny", request.digest)).rejects.toMatchObject({
      code: "approval_stale",
    });
    const view = await pal.approvals.view(chat.id);
    expect(view.approvals).toMatchObject([{ id: request.id, state: "approved" }]);
    expect(view.approvals[0]?.decidedAt).toEqual(expect.any(Number));
  });

  it("denies, expires and stops a request without dispatching it", async () => {
    const fixture = await setup({ approvalTtlMs: 1500 });
    const { pal, chat } = fixture;
    await fixture.start(shell("printf denied >> marker"));
    const [denied] = await fixture.waiting();
    if (denied === undefined) throw new Error("missing request");
    await pal.approvals.decide(chat.id, denied.id, "deny", denied.digest);
    expect((await fixture.results()).join("\n")).toMatch(/owner denied this command; nothing was run/);

    await fixture.start(shell("printf expired >> marker"));
    const [expired] = await fixture.waiting();
    if (expired === undefined) throw new Error("missing request");
    expect((await fixture.results()).join("\n")).toMatch(/no approval arrived in time; nothing was run/);
    await expect(pal.approvals.decide(chat.id, expired.id, "approve", expired.digest)).rejects.toMatchObject({
      code: "approval_stale",
    });

    await fixture.start(shell("printf stopped >> marker"));
    const [stopped] = await fixture.waiting();
    if (stopped === undefined) throw new Error("missing request");
    await (await fixture.conversation()).abort(context);
    await fixture.results();
    await expect(pal.approvals.decide(chat.id, stopped.id, "approve", stopped.digest)).rejects.toMatchObject({
      code: "approval_stale",
    });
    expect(await fixture.marker()).toBeUndefined();
    expect((await pal.approvals.view(chat.id)).approvals.map((approval) => approval.state)).toEqual([
      "denied",
      "expired",
      "stopped",
    ]);
  });

  it("runs Full access commands without prompts and never answers a pending request on a mode change", async () => {
    const fixture = await setup();
    const { pal, chat } = fixture;
    await fixture.start(shell("printf asked >> marker"));
    const [pending] = await fixture.waiting();
    if (pending === undefined) throw new Error("missing request");
    await pal.approvals.setMode(chat.id, "full");
    await sleep(100);
    expect((await fixture.waiting())[0]?.id).toBe(pending.id);
    expect(await fixture.marker()).toBeUndefined();
    await pal.approvals.decide(chat.id, pending.id, "deny", pending.digest);
    await fixture.results();

    await fixture.start(shell("printf full >> marker; printf full-output"));
    expect((await fixture.results()).join("\n")).toContain("full-output");
    expect(await fixture.marker()).toBe("full");
    expect((await pal.approvals.view(chat.id)).approvals).toHaveLength(1);

    await pal.approvals.setMode(chat.id, "ask");
    await fixture.start(shell("printf again >> marker"));
    const [again] = await fixture.waiting();
    if (again === undefined) throw new Error("missing request");
    await pal.approvals.decide(chat.id, again.id, "approve", again.digest);
    await fixture.results();
    expect(await fixture.marker()).toBe("fullagain");
  });

  it("bounds requests waiting per chat", async () => {
    const fixture = await setup();
    const { pal, chat } = fixture;
    const calls = Array.from({ length: 5 }, (_, index) => `tools.shell_run({ command: "printf ${index} >> marker" })`);
    await fixture.start(
      `const settled = await Promise.allSettled([${calls.join(", ")}]); return settled.map((result) => result.status === "rejected" ? String(result.reason) : JSON.stringify(result.value)).join("\\n");`,
    );
    const pending = await fixture.waiting(4);
    await sleep(100);
    expect((await fixture.waiting()).length).toBe(4);
    for (const request of pending) await pal.approvals.decide(chat.id, request.id, "deny", request.digest);
    const text = (await fixture.results()).join("\n");
    expect(text).toMatch(/at most 4 commands per chat/);
    expect(text.match(/owner denied this command/g)).toHaveLength(4);
    expect(await fixture.marker()).toBeUndefined();
  });

  it("keeps a pending request across a graceful restart and mode change, and asks the same request again", async () => {
    const fixture = await setup();
    await fixture.start(shell("printf restarted >> marker; printf after-restart"));
    const [before] = await fixture.waiting();
    if (before === undefined) throw new Error("missing request");
    // Full access applies to later requests only, even when the hook asks again after the restart.
    await fixture.pal.approvals.setMode(fixture.chat.id, "full");
    const pal = await fixture.reopen();
    answer(pal, []);
    const [after] = await fixture.waiting();
    expect(after).toMatchObject({ id: before.id, digest: before.digest, state: "pending" });
    await sleep(200);
    expect(await fixture.marker()).toBeUndefined();
    await pal.approvals.decide(fixture.chat.id, before.id, "approve", before.digest);
    expect((await fixture.results()).join("\n")).toContain("after-restart");
    expect(await fixture.marker()).toBe("restarted");
  });

  it("asks again after SIGKILL while waiting and never repeats an approved dispatch after SIGKILL", async () => {
    const child = async (command: string, approve: boolean) => {
      const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-approvals-kill-")));
      cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
      const process_ = spawn(
        process.execPath,
        [
          ...process.execArgv,
          join(import.meta.dirname, "fixtures/approvals-child.ts"),
          dataRoot,
          command,
          approve ? "approve" : "",
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      cleanups.push(async () => {
        if (process_.exitCode === null && process_.signalCode === null) {
          process_.kill("SIGKILL");
          await once(process_, "exit");
        }
      });
      const [line] = await Promise.race([
        once(createInterface({ input: process_.stdout }), "line"),
        once(process_, "exit").then(() => {
          throw new Error("fixture exited before ready");
        }),
      ]);
      const ready = JSON.parse(String(line)) as { root: string; chatId: string; approval: string };
      return { dataRoot, ready, kill: async () => (process_.kill("SIGKILL"), await once(process_, "exit")) };
    };
    const reopen = async (dataRoot: string) => {
      const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
      cleanups.push(() => pal.close());
      answer(pal, []);
      return pal;
    };

    const waiting = await child("printf once >> marker; printf killed-output", false);
    await waiting.kill();
    let pal = await reopen(waiting.dataRoot);
    const { approvals } = await pal.approvals.view(waiting.ready.chatId);
    expect(approvals).toMatchObject([{ id: waiting.ready.approval, state: "pending" }]);
    const request = approvals[0];
    if (request === undefined) throw new Error("missing request");
    await pal.approvals.decide(waiting.ready.chatId, request.id, "approve", request.digest);
    const chat = await pal.chats.get(waiting.ready.chatId);
    const conversation = chat === undefined ? undefined : await pal.harness.conversation(chat.conversationId, context);
    await conversation?.waitForIdle(context);
    expect(await readFile(join(waiting.ready.root, "marker"), "utf8")).toBe("once");

    const dispatched = await child("printf once >> marker; sleep 30", true);
    await expect
      .poll(() => readFile(join(dispatched.ready.root, "marker"), "utf8").catch(() => ""), { timeout: 5000 })
      .toBe("once");
    await dispatched.kill();
    pal = await reopen(dispatched.dataRoot);
    await pal.harness.waitForIdle(context);
    expect(await readFile(join(dispatched.ready.root, "marker"), "utf8")).toBe("once");
    expect((await pal.approvals.view(dispatched.ready.chatId)).approvals).toMatchObject([
      { id: dispatched.ready.approval, state: "approved" },
    ]);
  });

  it("serves modes and decisions only to the owner from Pal's own page, and streams changes", async () => {
    const fixture = await setup();
    const { pal, chat } = fixture;
    const server = await startServer({ host: "127.0.0.1", port: 0, version: "test", api: createApi(pal) });
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let session = "";
    const api = async (method: string, path: string, body?: unknown, origin = base) => {
      const response = await fetch(`${base}/api/${path}`, {
        method,
        headers: { origin, cookie: session, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const cookie = response.headers.get("set-cookie");
      if (cookie !== null) session = cookie.split(";")[0] ?? "";
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    expect((await api("GET", `chats/${chat.id}/approvals`)).status).toBe(401);
    await api("POST", "setup", { token: pal.owner.setupToken, passphrase: "correct horse battery" });
    expect((await api("GET", `chats/${chat.id}`)).body).toMatchObject({ chat: { commandMode: "ask" } });
    expect((await api("PUT", `chats/${chat.id}/command-mode`, { mode: "yolo" })).status).toBe(400);
    expect((await api("PUT", `chats/${chat.id}/command-mode`, { mode: "full" }, "http://evil.example")).status).toBe(
      403,
    );
    expect((await api("PUT", `chats/${chat.id}/command-mode`, { mode: "ask" })).body).toMatchObject({
      chat: { commandMode: "ask" },
    });

    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    const events = await fetch(`${base}/api/chats/${chat.id}/events`, {
      headers: { cookie: session },
      signal: controller.signal,
    });
    const reader = events.body?.pipeThrough(new TextDecoderStream()).getReader();
    let streamed = "";
    const streamedView = async (done: (text: string) => boolean) => {
      while (!done(streamed)) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) throw new Error("event stream ended");
        streamed += chunk.value;
      }
    };
    await streamedView((text) => text.includes("event: approvals"));

    await fixture.start(shell("printf api >> marker"));
    const [request] = await fixture.waiting();
    if (request === undefined) throw new Error("missing request");
    await streamedView((text) => text.includes(`"id":"${request.id}"`));
    const decision = { decision: "approve", digest: request.digest };
    expect(
      (await api("POST", `chats/${chat.id}/approvals/${request.id}`, decision, "http://evil.example")).status,
    ).toBe(403);
    expect(
      (await api("POST", `chats/${chat.id}/approvals/${request.id}`, { ...decision, digest: "f".repeat(64) })).body,
    ).toMatchObject({ error: "approval_stale" });
    expect((await api("POST", `chats/${chat.id}/approvals/${request.id}`, decision)).status).toBe(200);
    await fixture.results();
    expect(await fixture.marker()).toBe("api");
    await streamedView((text) => text.includes('"state":"approved"'));
  });
});
