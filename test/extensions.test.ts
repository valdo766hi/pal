import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/core/api.ts";
import { openPal, type Pal } from "../src/core/app.ts";
import { ChatService, type Chat } from "../src/core/chats.ts";
import { BUILTINS, BuiltinExtensions, releaseIdentity } from "../src/core/extensions.ts";
import { startServer } from "../src/core/server.ts";
import { fakeRtk } from "./fixtures/fake-rtk.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
async function fixture() {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-extensions-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  let pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("extension-project", { name: "Fixture" });
  return {
    project,
    dataRoot,
    get pal() {
      return pal;
    },
    reopen: async () => {
      await pal.close();
      pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
    },
  };
}
async function run(pal: Pal, chat: Chat, code: string) {
  const faux = fauxProvider();
  (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const conversation = await pal.harness.conversation(chat.conversationId, context);
  if (conversation === undefined) throw new Error("fixture conversation missing");
  const model = faux.getModel();
  await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
  await pal.chats.submit(chat.id, "extension-input", { text: "run fixture" }, context);
  return conversation;
}

describe("versioned built-in contributions", () => {
  it("persists exact new-chat selections and refuses unsupported, duplicate or stale choices", async () => {
    const f = await fixture();
    const before = await f.pal.extensions.view();
    expect(before.selected).toEqual(
      BUILTINS.flatMap((item) => ("optIn" in item ? [] : [{ id: item.id, version: item.version }])),
    );
    expect(before.selected.map((item) => item.id)).not.toContain("compact");
    for (const selected of [
      [{ id: "files", version: 2 }],
      [{ id: "downloaded", version: 1 }],
      [before.selected[0], before.selected[0]],
    ])
      await expect(f.pal.extensions.select({ selected, digest: before.digest })).rejects.toThrow();
    const first = await f.pal.chats.createChat("extension-first", { projectId: f.project.id }, context);
    await f.pal.extensions.select({ selected: [], digest: before.digest });
    await expect(f.pal.extensions.select({ selected: before.selected, digest: before.digest })).rejects.toMatchObject({
      code: "extensions_stale",
    });
    const next = await f.pal.chats.createChat("extension-next", { projectId: f.project.id }, context);
    const agent = await (await f.pal.harness.conversation(next.conversationId, context))?.agent(context);
    for (const name of ["shell_run", "memory_search", "files_list", "browser_act"])
      expect(agent?.callable.map((tool) => tool.name)).not.toContain(name);
    expect(agent?.extensions.map((extension) => extension.name)).toEqual(
      expect.arrayContaining(["pal.approvals", "pal.context", "pal.extensions"]),
    );
    expect((await f.pal.chats.get(first.id))?.extensions).toEqual(before.selected);
    expect((await f.pal.chats.get(next.id))?.extensions).toEqual([]);
    await f.reopen();
    expect((await f.pal.extensions.view()).selected).toEqual([]);
    expect((await f.pal.chats.get(first.id))?.extensions).toEqual(before.selected);
    const renamed = await f.pal.chats.rename(next.id, { title: "renamed", expectedTitle: null });
    expect(renamed.extensions).toEqual([]);
  });

  it("removes disabled tools at the native Code Mode boundary and records exact request pins", async () => {
    const open = Harness.open;
    const reports: unknown[] = [];
    vi.spyOn(Harness, "open").mockImplementation((storage, options, context) =>
      open(storage, { ...options, onReport: (error) => reports.push(error) }, context),
    );
    const f = await fixture();
    const view = await f.pal.extensions.view();
    await f.pal.extensions.select({ selected: [{ id: "memory", version: 1 }], digest: view.digest });
    const chat = await f.pal.chats.createChat("restricted", { projectId: f.project.id }, context);
    const conversation = await run(
      f.pal,
      chat,
      'try { return await tools.shell_run({command:"printf no > extension-marker"}); } catch(error) { return String(error); }',
    );
    await conversation.waitForIdle(context);
    expect(reports).toEqual([]);
    expect((await conversation.context(context)).messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(await readFile(join(f.project.root, "extension-marker"), "utf8").catch(() => undefined)).toBeUndefined();
    expect((await f.pal.approvals.view(chat.id)).approvals).toEqual([]);
    const release = (await f.pal.extensions.view()).release;
    expect(release).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.pal.extensions.pins(chat.conversationId, f.pal.harness, context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          release,
          selected: [{ id: "memory", version: 1 }],
          task: expect.any(Number),
        }),
      ]),
    );
  });

  it("keeps active tools and their implementation, and refuses a different release while work is unfinished", async () => {
    const f = await fixture();
    const chat = await f.pal.chats.createChat("extension-active", { projectId: f.project.id }, context);
    const conversation = await run(
      f.pal,
      chat,
      'return await tools.shell_run({command:"printf once > extension-marker"});',
    );
    let pending;
    for (let i = 0; i < 400 && pending === undefined; i++) {
      pending = (await f.pal.approvals.view(chat.id)).approvals.find((item) => item.state === "pending");
      if (pending === undefined) await sleep(10);
    }
    if (pending === undefined) throw new Error("no native approval");
    const current = await f.pal.extensions.view();
    await f.pal.extensions.select({ selected: [], digest: current.digest });
    expect((await conversation.agent(context)).callable.map((tool) => tool.name)).toContain("shell_run");
    await expect(
      BuiltinExtensions.open(f.pal.store.database, createRegistry(), () => f.pal.harness, "different-release"),
    ).rejects.toThrow("unfinished work needs its retained Pal release");
    await f.pal.approvals.decide(chat.id, pending.id, "approve", pending.digest);
    await conversation.waitForIdle(context);
    expect(await readFile(join(f.project.root, "extension-marker"), "utf8")).toBe("once");
    const pins = await f.pal.extensions.pins(chat.conversationId, f.pal.harness, context);
    expect(pins).toEqual(
      expect.arrayContaining([expect.objectContaining({ release: current.release, selected: current.selected })]),
    );
  });

  it("runs a chat's host commands through rtk only when compact output was selected for it", async () => {
    const rtk = await fakeRtk();
    cleanups.push(rtk.cleanup);
    const f = await fixture();
    const shell = async (id: string) => {
      const chat = await f.pal.chats.createChat(id, { projectId: f.project.id }, context);
      await f.pal.approvals.setMode(chat.id, "full");
      const conversation = await run(f.pal, chat, 'return await tools.shell_run({command:"report hello 0"});');
      await conversation.waitForIdle(context);
      return JSON.stringify((await conversation.context(context)).messages);
    };
    expect(await shell("compact-default")).not.toContain("compact:hello");
    expect(await rtk.calls()).toEqual([]);
    const view = await f.pal.extensions.view();
    await f.pal.extensions.select({ selected: [...view.selected, { id: "compact", version: 1 }], digest: view.digest });
    const compacted = await shell("compact-selected");
    expect(compacted).toContain("compact:hello");
    expect(compacted).toContain("rtk report hello 0");
  });

  it("runs exactly the command the owner approved, never its rtk equivalent", async () => {
    const rtk = await fakeRtk();
    cleanups.push(rtk.cleanup);
    const f = await fixture();
    const view = await f.pal.extensions.view();
    await f.pal.extensions.select({ selected: [...view.selected, { id: "compact", version: 1 }], digest: view.digest });
    const chat = await f.pal.chats.createChat("compact-ask", { projectId: f.project.id }, context);
    const conversation = await run(f.pal, chat, 'return await tools.shell_run({command:"report hello 0"});');
    let pending;
    for (let i = 0; i < 400 && pending === undefined; i++) {
      pending = (await f.pal.approvals.view(chat.id)).approvals.find((item) => item.state === "pending");
      if (pending === undefined) await sleep(10);
    }
    if (pending === undefined) throw new Error("no native approval");
    expect(pending.command).toBe("report hello 0");
    await f.pal.approvals.decide(chat.id, pending.id, "approve", pending.digest);
    await conversation.waitForIdle(context);
    const messages = JSON.stringify((await conversation.context(context)).messages);
    expect(messages).not.toContain("compact:hello");
    expect(messages).not.toContain("rtk report");
    expect(await rtk.calls()).toEqual([]);
  });

  it("blocks a tool with a different native implementation memo before its external effect", async () => {
    const open = Harness.open;
    vi.spyOn(Harness, "open").mockImplementation((storage, options, context) => {
      const registry = options.registry as ReturnType<typeof createRegistry>;
      const pin = registry.snapshot().extension("pal.extensions");
      if (pin === undefined) throw new Error("missing implementation hook");
      registry.uninstall(pin);
      registry.install(
        defineExtension({
          name: "fixture.oldPin",
          hooks: [
            hook(ToolTask, {
              beforeTool: async (call, api, context) => {
                if (call.name === "shell_run") await api.memo("pal.extensionRelease", "older-release", context);
              },
            }),
          ],
        }),
      );
      registry.install(pin);
      return open(storage, options, context);
    });
    const f = await fixture();
    const chat = await f.pal.chats.createChat("extension-stale-tool", { projectId: f.project.id }, context);
    await f.pal.approvals.setMode(chat.id, "full");
    const conversation = await run(
      f.pal,
      chat,
      'try { return await tools.shell_run({command:"printf no > extension-marker"}); } catch(error) { return String(error); }',
    );
    await conversation.waitForIdle(context);
    expect(JSON.stringify((await conversation.context(context)).messages)).toContain("implementation pin changed");
    expect(await readFile(join(f.project.root, "extension-marker"), "utf8").catch(() => undefined)).toBeUndefined();
    expect((await f.pal.approvals.view(chat.id)).approvals).toEqual([]);
  });

  it("freezes defaults before conversation creation, not from changed settings during reconciliation", async () => {
    const f = await fixture();
    const initial = await f.pal.extensions.view();
    await f.pal.extensions.select({ selected: [{ id: "files", version: 1 }], digest: initial.digest });
    const service = await ChatService.open(
      {
        database: f.pal.store.database,
        harness: f.pal.harness,
        extensions: () => f.pal.extensions.capture(),
        agentFor: async (_project, _chat, _mode, scope) => f.pal.extensions.agent(scope),
        barrier: async (point) => {
          if (point === "chat-recorded") {
            const view = await f.pal.extensions.view();
            await f.pal.extensions.select({ selected: [], digest: view.digest });
          }
        },
      },
      context,
    );
    const chat = await service.createChat("extension-frozen", { projectId: f.project.id }, context);
    expect((await service.get(chat.id))?.extensions).toEqual([{ id: "files", version: 1 }]);
    expect(
      (await (await f.pal.harness.conversation(chat.conversationId, context))?.agent(context))?.callable.map(
        (tool) => tool.name,
      ),
    ).toContain("files_list");
    expect(await releaseIdentity("/nonexistent-install")).toBe((await f.pal.extensions.view()).release);
  });

  it("serves selection only to the owner at Pal's own origin", async () => {
    const f = await fixture();
    const server = await startServer({ host: "127.0.0.1", port: 0, version: "test", api: createApi(f.pal) });
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const before = await f.pal.extensions.view();
    expect((await fetch(`${base}/api/extensions`)).status).toBe(401);
    const token = await f.pal.owner.setup(f.pal.owner.setupToken, "correct horse battery");
    const put = (origin: string, digest: string) =>
      fetch(`${base}/api/extensions`, {
        method: "PUT",
        headers: { origin, cookie: `pal_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ selected: [], digest }),
      });
    expect((await put("http://evil.example", before.digest)).status).toBe(403);
    expect((await put(base, before.digest)).status).toBe(200);
    expect((await put(base, before.digest)).status).toBe(409);
  });
});
