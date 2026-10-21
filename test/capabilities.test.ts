import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleCapability } from "../src/capabilities/example.ts";
import { memoryCapability } from "../src/capabilities/memory.ts";
import {
  capabilityIdentity,
  capabilityManifest,
  CompiledCapabilities,
  type CapabilityHost,
  type CompiledCapability,
} from "../src/capabilities/contract.ts";
import { openPal, type Pal } from "../src/core/app.ts";
import type { Chat } from "../src/core/chats.ts";
import { BuiltinExtensions } from "../src/core/extensions.ts";
import { FileAccessError } from "../src/core/files.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(definitions: readonly CompiledCapability[] = [memoryCapability, exampleCapability]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-capability-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const options = {
    dataRoot: join(root, "data"),
    installRoot: "/nonexistent-install",
    guidanceHome: join(root, "home"),
  };
  let pal = await openPal(options, context, definitions);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("capability-project", { name: "Capability fixture" });
  let sequence = 0;
  async function run(chat: Chat, code: string) {
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
      fauxAssistantMessage("fixture finished"),
    ]);
    const conversation = await pal.harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing fixture conversation");
    const model = faux.getModel();
    await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    const admission = await pal.chats.submit(
      chat.id,
      `capability-input-${++sequence}`,
      { text: "Run fixture" },
      context,
    );
    await conversation.waitForIdle(context);
    return {
      conversation,
      admission,
      output: JSON.stringify(
        (await conversation.context(context)).messages.filter((message) => message.role === "toolResult"),
      ),
    };
  }
  return {
    root,
    options,
    project,
    run,
    get pal() {
      return pal;
    },
    async reopen(next = definitions) {
      await pal.close();
      pal = await openPal(options, context, next);
    },
  };
}
function host(pal: Pal): CapabilityHost {
  return {
    database: pal.store.database,
    storage: pal.store.storage,
    folders: pal.folders,
    deny: [],
    project: async (conversation) => {
      const workspace = await pal.workspaces.forConversation(conversation);
      return workspace?.state === "ready" ? { id: workspace.projectId, workspace: workspace.id } : undefined;
    },
    authorize: (api, ctx) => pal.folders.forTool(api, ctx),
  };
}
function traced(base: CompiledCapability, events: string[], output?: string): CompiledCapability {
  return {
    ...base,
    open: async (ports) => {
      events.push(`open:${base.manifest.id}`);
      const runtime = await base.open(ports);
      return {
        ...runtime,
        tools: runtime.tools.map((tool) => ({
          ...tool,
          execute: async (args, api, ctx) => {
            events.push(`execute:${base.manifest.id}`);
            return output === undefined ? tool.execute(args, api, ctx) : { output: [{ type: "text", text: output }] };
          },
        })),
        dispose: async () => {
          events.push(`dispose:${base.manifest.id}`);
          await runtime.dispose?.();
        },
      };
    },
  };
}

describe("compiled capability contract", () => {
  it("registers the bounded opt-in template with host-owned grants, settings and implementation identities", async () => {
    const events: string[] = [];
    const f = await fixture([traced(exampleCapability, events)]);
    const initial = await f.pal.extensions.view();
    const item = initial.catalog.find((item) => item.id === "example");
    expect(item).toMatchObject({
      available: true,
      capability: {
        core: { min: 1, max: 1 },
        settings: "new-chat-selection",
        panels: ["Context"],
        tools: [{ name: "example_echo", replay: "safe", permissions: ["project.read"] }],
      },
    });
    expect(item?.implementation).toBe(capabilityIdentity(exampleCapability.manifest, initial.release).digest);
    expect(initial.selected.map((choice) => choice.id)).not.toContain("example");
    expect(initial.catalog.map((item) => item.id)).not.toContain("memory");
    expect(() => f.pal.memory).toThrow("Memory is not included");
    await f.pal.extensions.select({ selected: [{ id: "example", version: 1 }], digest: initial.digest });
    const chat = await f.pal.chats.createChat("template-chat", { projectId: f.project.id }, context);
    const { conversation, output } = await f.run(
      chat,
      'return await tools.example_echo({text:"bounded template 界"});',
    );
    expect(output).toContain("bounded template 界");
    const agent = await conversation.agent(context);
    expect(agent.tools.map((tool) => tool.name)).not.toContain("example_echo");
    expect(agent.callable.map((tool) => tool.name)).toContain("example_echo");
    expect(agent.extensions.map((extension) => extension.name)).toEqual(
      expect.arrayContaining(["pal.policy", "pal.approvals", "pal.context", "pal.extensions"]),
    );
    const pins = await f.pal.extensions.pins(chat.conversationId, f.pal.harness, context);
    expect(pins).toHaveLength(2);
    expect(new Set(pins.map((pin) => pin.task)).size).toBe(2);
    for (const pin of pins)
      expect(pin).toMatchObject({
        selected: [{ id: "example", version: 1 }],
        implementations: [{ id: "example", version: 1, digest: item?.implementation }],
      });
    await f.reopen();
    expect((await f.pal.extensions.view()).selected).toEqual([{ id: "example", version: 1 }]);
    expect(await f.pal.extensions.pins(chat.conversationId, f.pal.harness, context)).toEqual(pins);
    expect((await f.run(chat, 'return await tools.example_echo({text:"after restart"});')).output).toContain(
      "after restart",
    );
    await Promise.all([f.pal.close(), f.pal.close()]);
    expect(events).toEqual([
      "open:example",
      "execute:example",
      "dispose:example",
      "open:example",
      "execute:example",
      "dispose:example",
    ]);
  });

  it("builds and starts actual artifacts by changing only the compiled selection", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-capability-build-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const source = join(import.meta.dirname, "..");
    for (const template of [false, true]) {
      const packageRoot = join(root, template ? "with-template" : "without-memory");
      const outfile = join(packageRoot, "dist/app.mjs");
      const result = await build({
        stdin: { contents: 'export { openPal } from "./src/core/app.ts";', resolveDir: source },
        outfile,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node24",
        packages: "external",
        metafile: true,
        plugins: [
          {
            name: "compiled-selection",
            setup(builder) {
              builder.onLoad({ filter: /\/capabilities\/compiled\.ts$/ }, (args) => ({
                contents: template
                  ? 'import { exampleCapability } from "./example.ts"; export const COMPILED_CAPABILITIES = [exampleCapability];'
                  : "export const COMPILED_CAPABILITIES = [];",
                loader: "ts",
                resolveDir: dirname(args.path),
              }));
            },
          },
        ],
      });
      for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
        await writeFile(join(packageRoot, file), await readFile(join(source, file)));
      await symlink(await realpath(join(source, "node_modules")), join(packageRoot, "node_modules"), "dir");
      expect(Object.keys(result.metafile.inputs).some((path) => path.endsWith("capabilities/memory.ts"))).toBe(false);
      expect(await readFile(outfile, "utf8")).not.toContain("memory_search");
      const artifact: typeof import("../src/core/app.ts") = await import(pathToFileURL(outfile).href);
      const pal = await artifact.openPal(
        {
          dataRoot: join(root, template ? "template-data" : "empty-data"),
          installRoot: packageRoot,
          guidanceHome: join(root, "home"),
        },
        context,
      );
      cleanups.push(() => pal.close());
      const view = await pal.extensions.view();
      expect(view.catalog.map((item) => item.id)).not.toContain("memory");
      expect(() => pal.memory).toThrow("Memory is not included");
      if (template)
        await pal.extensions.select({
          selected: [...view.selected, { id: "example", version: 1 }],
          digest: view.digest,
        });
      const project = await pal.projects.create("built-project", { name: "Built capability" });
      const chat = await pal.chats.createChat("built-chat", { projectId: project.id }, context);
      const agent = await (await pal.harness.conversation(chat.conversationId, context))?.agent(context);
      expect(agent?.extensions.map((extension) => extension.name)).toContain("pal.context");
      expect(agent?.callable.map((tool) => tool.name)).not.toContain("memory_search");
      expect(agent?.callable.some((tool) => tool.name === "example_echo")).toBe(template);
      await pal.close();
    }
  });

  it("removes memory at composition time without removing core guidance or the owner's other capabilities", async () => {
    const f = await fixture([]);
    const view = await f.pal.extensions.view();
    expect(view.catalog.map((item) => item.id)).toEqual(["files", "shell", "browser", "compact"]);
    expect(view.selected.map((item) => item.id)).not.toContain("memory");
    expect(f.pal.capabilities.namespaces).toEqual([]);
    expect(() => f.pal.memory).toThrow("Memory is not included");
    const chat = await f.pal.chats.createChat("without-memory", { projectId: f.project.id }, context);
    const { conversation, output } = await f.run(
      chat,
      'try { return await tools.memory_search({query:"absent"}); } catch(error) { return String(error); }',
    );
    const agent = await conversation.agent(context);
    expect(agent.callable.map((tool) => tool.name)).not.toContain("memory_search");
    expect(agent.callable.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["files_read", "instructions_scope", "skills_read"]),
    );
    expect(agent.extensions.map((extension) => extension.name)).toContain("pal.context");
    expect(output).toContain("memory_search");
    expect(output).not.toContain('"items":');
    await f.reopen([]);
    expect((await f.pal.extensions.view()).catalog.map((item) => item.id)).not.toContain("memory");
  });

  it("keeps the extracted memory's owner API, source checks and search working across restart", async () => {
    const f = await fixture([memoryCapability]);
    await f.pal.memory.save(
      f.project.id,
      "owner-memory",
      { title: "Decision", body: "EXTRACTED-MEMORY", source: { kind: "owner" } },
      context,
    );
    const chat = await f.pal.chats.createChat("memory-chat", { projectId: f.project.id }, context);
    expect((await f.run(chat, 'return await tools.memory_search({query:"EXTRACTED"});')).output).toContain(
      "EXTRACTED-MEMORY",
    );
    await f.reopen();
    expect((await f.pal.memory.list(f.project.id, context)).map((item) => item.body)).toEqual(["EXTRACTED-MEMORY"]);
    expect((await f.run(chat, 'return await tools.memory_search({query:"EXTRACTED"});')).output).toContain(
      "EXTRACTED-MEMORY",
    );
  });

  it("withholds a removed pinned capability and exposes a removable unavailable default", async () => {
    const f = await fixture([memoryCapability]);
    const before = await f.pal.extensions.view();
    await f.pal.extensions.select({ selected: before.selected, digest: before.digest });
    const chat = await f.pal.chats.createChat("old-memory-chat", { projectId: f.project.id }, context);
    const { admission } = await f.run(chat, 'return "before removal";');
    await f.reopen([]);
    const view = await f.pal.extensions.view();
    expect(view.catalog.find((item) => item.id === "memory")).toMatchObject({ available: false });
    await expect(f.pal.chats.createChat("stale-default", { projectId: f.project.id }, context)).rejects.toMatchObject({
      code: "capability_unavailable",
    });
    await f.pal.extensions.select({
      selected: view.selected.filter((item) => item.id !== "memory"),
      digest: view.digest,
    });
    expect(await f.pal.chats.submit(chat.id, admission.requestId, { text: "Run fixture" }, context)).toEqual(admission);
    await expect(
      f.run(chat, 'return await tools.shell_run({command:"printf no > unavailable-marker"});'),
    ).rejects.toMatchObject({ code: "capability_unavailable" });
    const conversation = await f.pal.harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing retained conversation");
    await conversation.submit(
      { type: "input", requestId: "native-capability-bypass", content: "run fixture" },
      context,
    );
    await conversation.waitForIdle(context);
    const output = JSON.stringify(
      (await conversation.context(context)).messages.filter((message) => message.role === "toolResult"),
    );
    expect(output).toContain("memory@1 is not available");
    expect(await readFile(join(f.project.root, "unavailable-marker"), "utf8").catch(() => undefined)).toBeUndefined();
    expect((await f.pal.approvals.view(chat.id)).approvals).toEqual([]);
    const fresh = await f.pal.chats.createChat("new-without-memory", { projectId: f.project.id }, context);
    expect((await f.pal.chats.get(fresh.id))?.extensions.map((item) => item.id)).not.toContain("memory");
  });

  it("refuses unavailable new-chat defaults before recording provisioning, preserving creation receipts", async () => {
    const f = await fixture([memoryCapability]);
    const before = await f.pal.extensions.view();
    await f.pal.extensions.select({ selected: before.selected, digest: before.digest });
    const admitted = await f.pal.chats.createChat("creation-receipt", { projectId: f.project.id }, context);
    await f.reopen([]);
    expect(await f.pal.chats.createChat("creation-receipt", { projectId: f.project.id }, context)).toEqual(admitted);
    await expect(
      f.pal.chats.createChat("unavailable-new-default", { projectId: f.project.id }, context),
    ).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(
      await f.pal.store.database.get("SELECT id FROM pal_chats WHERE request_id = ?", "unavailable-new-default"),
    ).toBeUndefined();
    expect(f.pal.status).toBe("ready");
    const view = await f.pal.extensions.view();
    await f.pal.extensions.select({
      selected: view.selected.filter((choice) => choice.id !== "memory"),
      digest: view.digest,
    });
    await f.reopen([]);
    expect(f.pal.status).toBe("ready");
  });

  it("requires explicit version upgrades and retains the identities of older chats", async () => {
    const f = await fixture([exampleCapability]);
    const before = await f.pal.extensions.view();
    await f.pal.extensions.select({ selected: [{ id: "example", version: 1 }], digest: before.digest });
    const old = await f.pal.chats.createChat("version-one", { projectId: f.project.id }, context);
    await f.run(old, 'return await tools.example_echo({text:"old version"});');
    const pins = await f.pal.extensions.pins(old.conversationId, f.pal.harness, context);
    const second = { ...exampleCapability, manifest: { ...exampleCapability.manifest, version: 2 } };
    await f.reopen([second]);
    const changed = await f.pal.extensions.view();
    expect(changed.selected).toEqual([{ id: "example", version: 1 }]);
    const current = changed.catalog.find((item) => item.id === "example");
    expect(current?.version).toBe(2);
    expect(current?.implementation).not.toBe(before.catalog.find((item) => item.id === "example")?.implementation);
    expect(await f.pal.extensions.pins(old.conversationId, f.pal.harness, context)).toEqual(pins);
    await expect(f.pal.extensions.select({ selected: changed.selected, digest: changed.digest })).rejects.toMatchObject(
      { code: "capability_unavailable" },
    );
    await expect(f.run(old, 'return await tools.example_echo({text:"must not substitute"});')).rejects.toMatchObject({
      code: "capability_unavailable",
    });
    await f.pal.extensions.select({ selected: [{ id: "example", version: 2 }], digest: changed.digest });
    const fresh = await f.pal.chats.createChat("version-two", { projectId: f.project.id }, context);
    expect((await f.run(fresh, 'return await tools.example_echo({text:"explicit version two"});')).output).toContain(
      "explicit version two",
    );
    for (const pin of await f.pal.extensions.pins(fresh.conversationId, f.pal.harness, context))
      expect(pin.implementations).toEqual([{ id: "example", version: 2, digest: current?.implementation }]);
  });

  it("validates compatibility, names, permissions and collisions before opening code", async () => {
    const f = await fixture([]);
    const open = vi.fn(exampleCapability.open);
    const manifest = exampleCapability.manifest;
    for (const invalid of [
      { ...manifest, core: { min: 2, max: 2 } },
      { ...manifest, native: "pal.policy" },
      { ...manifest, namespace: { ...manifest.namespace, prefix: "shell_" } },
      { ...manifest, tools: manifest.tools.map((tool) => ({ ...tool, name: "shell_run" })) },
    ])
      await expect(CompiledCapabilities.open([{ manifest: invalid, open }], host(f.pal))).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    await expect(
      CompiledCapabilities.open(
        [
          { ...exampleCapability, open },
          { ...exampleCapability, open },
        ],
        host(f.pal),
      ),
    ).rejects.toThrow("Duplicate");
    expect(open).not.toHaveBeenCalled();
    for (const invalid of [
      { ...manifest, tools: manifest.tools.map((tool) => ({ ...tool, permissions: ["project.write"] })) },
      { ...manifest, tools: manifest.tools.map((tool) => ({ ...tool, permissions: [] })) },
      { ...manifest, core: { min: 0, max: 1 } },
      { ...manifest, credentialStore: "ambient" },
    ])
      expect(() => capabilityManifest(invalid)).toThrow();
    expect(capabilityIdentity(manifest, "release-one").digest).not.toBe(
      capabilityIdentity(manifest, "release-two").digest,
    );
    expect(capabilityIdentity(manifest, "release-one").digest).not.toBe(
      capabilityIdentity({ ...manifest, version: 2 }, "release-one").digest,
    );
  });

  it("rejects model-direct/replay drift and preflights the registry before replacing anything", async () => {
    const f = await fixture([]);
    for (const drift of ["callers", "replay"] as const) {
      const dispose = vi.fn();
      const definition: CompiledCapability = {
        ...exampleCapability,
        open: () => {
          const runtime = exampleCapability.open();
          return {
            tools: runtime.tools.map((tool) => ({
              ...tool,
              ...(drift === "callers" ? { callers: ["model"] as const } : { replay: "unsafe" as const }),
            })),
            dispose,
          };
        },
      };
      await expect(CompiledCapabilities.open([definition], host(f.pal))).rejects.toThrow("Code Mode-only");
      expect(dispose).toHaveBeenCalledTimes(1);
    }
    const disposeMissingService = vi.fn();
    await expect(
      CompiledCapabilities.open(
        [
          {
            ...memoryCapability,
            open: async (ports) => ({
              tools: (await memoryCapability.open(ports)).tools,
              dispose: disposeMissingService,
            }),
          },
        ],
        host(f.pal),
      ),
    ).rejects.toThrow("memory service");
    expect(disposeMissingService).toHaveBeenCalledTimes(1);
    const opened = await CompiledCapabilities.open([exampleCapability], host(f.pal));
    cleanups.push(() => opened.close());
    const registry = createRegistry();
    const kernel = defineExtension({ name: "pal.policy", tools: exampleCapability.open().tools });
    registry.install(kernel);
    expect(() => opened.install(registry)).toThrow("collides");
    expect(registry.snapshot().installed()).toEqual([kernel]);
  });

  it("rechecks live grants around execution and enforces output and parameter bounds", async () => {
    const events: string[] = [];
    const bounded = traced(exampleCapability, events, "X".repeat(8000));
    bounded.manifest = {
      ...bounded.manifest,
      tools: bounded.manifest.tools.map((tool) => ({ ...tool, maxOutputBytes: 64 })),
    };
    const f = await fixture([bounded]);
    const before = await f.pal.extensions.view();
    await f.pal.extensions.select({ selected: [{ id: "example", version: 1 }], digest: before.digest });
    const chat = await f.pal.chats.createChat("bounded-chat", { projectId: f.project.id }, context);
    const first = await f.run(chat, 'return await tools.example_echo({text:"small"});');
    expect(first.output).toContain("X".repeat(32));
    expect(first.output).not.toContain("X".repeat(65));
    const calls = events.filter((event) => event === "execute:example").length;
    await f.run(chat, 'return await tools.example_echo({text:"A".repeat(257)});');
    expect(events.filter((event) => event === "execute:example")).toHaveLength(calls);
    const grants = vi.spyOn(f.pal.folders, "forTool").mockRejectedValue(new FileAccessError("fixture grant revoked"));
    expect((await f.run(chat, 'return await tools.example_echo({text:"no"});')).output).toContain(
      "fixture grant revoked",
    );
    expect(events.filter((event) => event === "execute:example")).toHaveLength(calls);
    grants.mockRestore();
    const original = f.pal.folders.forTool.bind(f.pal.folders);
    vi.spyOn(f.pal.folders, "forTool").mockImplementation(async (...args) => {
      const lease = await original(...args);
      return {
        ...lease,
        check: async () => {
          await lease.check();
          if (events.filter((event) => event === "execute:example").length > calls)
            throw new FileAccessError("fixture revoked after read");
        },
      };
    });
    expect((await f.run(chat, 'return await tools.example_echo({text:"withheld"});')).output).toContain(
      "fixture revoked after read",
    );
    expect(events.filter((event) => event === "execute:example")).toHaveLength(calls + 1);
  });

  it("disposes successful opens in reverse exactly once, including partial startup failure", async () => {
    const f = await fixture([]);
    const events: string[] = [];
    const first = traced(exampleCapability, events);
    const second: CompiledCapability = {
      ...exampleCapability,
      manifest: {
        ...exampleCapability.manifest,
        id: "second",
        native: "pal.second",
        namespace: { name: "second", prefix: "second_" },
        tools: exampleCapability.manifest.tools.map((tool) => ({ ...tool, name: "second_echo" })),
      },
      open: () => {
        throw new Error("fixture second open failed");
      },
    };
    await expect(CompiledCapabilities.open([first, second], host(f.pal))).rejects.toThrow("second open failed");
    expect(events).toEqual(["open:example", "dispose:example"]);
    const dispose = vi.fn();
    second.open = () => ({
      tools: exampleCapability.open().tools.map((tool) => ({ ...tool, name: "second_echo" })),
      dispose: () => {
        dispose();
        events.push("dispose:second");
        throw new Error("fixture dispose failed");
      },
    });
    const opened = await CompiledCapabilities.open([first, second], host(f.pal));
    const closing = opened.close();
    expect(opened.close()).toBe(closing);
    await expect(closing).rejects.toThrow("Capability disposal failed");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(events.slice(-2)).toEqual(["dispose:second", "dispose:example"]);
    expect(opened.allows("example_echo")).toBe(false);
  });

  it("does not let a failing capability disposer skip or outlive kernel cleanup", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-capability-disposal-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const dispose = vi.fn(() => {
      throw new Error("expected capability disposal failure");
    });
    const sandbox = vi.spyOn(CodemodeSandbox.prototype, "close");
    const permit = Promise.withResolvers<undefined>();
    let pal: Pal | undefined;
    try {
      pal = await openPal(
        { dataRoot: join(root, "data"), installRoot: "/nonexistent-install", guidanceHome: join(root, "home") },
        context,
        [{ ...exampleCapability, open: () => ({ ...exampleCapability.open(), dispose }) }],
      );
      const closeMcp = pal.mcp.close.bind(pal.mcp);
      const mcp = vi.spyOn(pal.mcp, "close").mockImplementation(async () => {
        await permit.promise;
        await closeMcp();
      });
      let settled = false;
      const closing = pal.close();
      void closing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await expect.poll(() => dispose.mock.calls.length).toBe(1);
      expect(mcp).toHaveBeenCalledTimes(1);
      expect(sandbox).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      permit.resolve(undefined);
      await expect(closing).rejects.toThrow("Pal resource cleanup failed");
      expect(pal.status).toBe("closed");
      expect(pal.close()).toBe(closing);
    } finally {
      permit.resolve(undefined);
      await pal?.close().catch(() => {});
    }
  });

  it("still closes the database owner when an earlier kernel stop fails", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-capability-primary-close-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const options = {
      dataRoot: join(root, "data"),
      installRoot: "/nonexistent-install",
      guidanceHome: join(root, "home"),
    };
    let pal: Pal | undefined;
    try {
      pal = await openPal(options, context, []);
      const closeHarness = vi.spyOn(pal.harness, "close");
      vi.spyOn(pal.workspaces, "close").mockRejectedValue(new Error("fixture workspace stop failed"));
      let failure: unknown;
      try {
        await pal.close();
      } catch (error) {
        failure = error;
      }
      expect(closeHarness).toHaveBeenCalledTimes(1);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        message: "Pal resource cleanup failed",
        errors: [expect.objectContaining({ message: "fixture workspace stop failed" })],
      });
      expect(pal.status).toBe("closed");
      const reopened = await openPal(options, context, []);
      await reopened.close();
    } finally {
      await pal?.harness.close(context).catch(() => {});
      await pal?.close().catch(() => {});
    }
  });

  it("refuses changed capability catalogs before unfinished work and reads historical pins without invented digests", async () => {
    const f = await fixture([memoryCapability]);
    const chat = await f.pal.chats.createChat("pending-capability", { projectId: f.project.id }, context);
    const faux = fauxProvider();
    (f.pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("codemode", { code: 'return await tools.shell_run({command:"printf pending"});' }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await f.pal.harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing pending conversation");
    const model = faux.getModel();
    await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    await f.pal.chats.submit(chat.id, "pending-capability-input", { text: "run" }, context);
    await expect
      .poll(async () => (await f.pal.approvals.view(chat.id)).approvals.some((item) => item.state === "pending"))
      .toBe(true);
    const release = (await f.pal.extensions.view()).release;
    const before = await f.pal.store.database.get("SELECT value FROM pal_settings WHERE key = 'extensions:catalog'");
    await expect(
      BuiltinExtensions.open(f.pal.store.database, createRegistry(), () => f.pal.harness, release, []),
    ).rejects.toThrow("unfinished work needs its retained");
    expect(await f.pal.store.database.get("SELECT value FROM pal_settings WHERE key = 'extensions:catalog'")).toEqual(
      before,
    );
    await BuiltinExtensions.open(f.pal.store.database, createRegistry(), () => f.pal.harness, release, [
      memoryCapability,
    ]);
    await conversation.abort(context);
    await conversation.waitForIdle(context);
    await f.pal.harness.commit(
      (tx) =>
        tx.appendEntry(chat.conversationId, {
          kind: "pal.extensions",
          data: { task: 999999, release, selected: [{ id: "memory", version: 1 }] },
        }),
      context,
    );
    expect(
      (await f.pal.extensions.pins(chat.conversationId, f.pal.harness, context)).find((pin) => pin.task === 999999),
    ).toEqual({ task: 999999, release, selected: [{ id: "memory", version: 1 }] });
  });
});
