import { access, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { validate } from "../src/core/requests.ts";
import exampleCapability from "./fixtures/plugins/example/server.ts";
import {
  capabilityIdentity,
  capabilityManifest,
  CompiledCapabilities,
  type KernelServices,
  type CompiledCapability,
  type PluginSettings,
} from "../src/capabilities/contract.ts";
import { openPal, type Pal } from "../src/core/app.ts";
import type { Chat } from "../src/core/chats.ts";
import { BuiltinExtensions } from "../src/core/extensions.ts";
import { FileAccessError } from "../src/core/files.ts";
import { PrivateFiles } from "../src/core/file-policy.ts";
import * as inventory from "../plugins/index.ts";
import { fakeAdvisor, withAdvisor } from "./fixtures/advisor.ts";
import { ICONS } from "../web/src/lib/icons.ts";
import memoryCapability, { projectMemory } from "../plugins/memory/server.ts";

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
const publicFiles = await PrivateFiles.open([]);
function host(pal: Pal): KernelServices {
  return {
    database: pal.store.database,
    storage: pal.store.storage,
    folders: pal.folders,
    deny: [],
    privateFiles: publicFiles,
    project: async (conversation) => {
      const workspace = await pal.workspaces.forConversation(conversation);
      return workspace?.state === "ready" ? { id: workspace.projectId, workspace: workspace.id } : undefined;
    },
    authorize: (api, ctx) => pal.folders.forTool(api, ctx),
    credentials: new InMemoryCredentialStore(),
    endpoint: (url) => url,
    now: Date.now,
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
        tools: (runtime.tools ?? []).map((tool) => ({
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
  it("keeps every plugin folder valid, with its components, and only server plugins in the server inventory", async () => {
    const root = join(import.meta.dirname, "../plugins");
    const servers = Object.values(inventory).map((plugin) => plugin.manifest.id);
    const folders = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    expect(folders.map((entry) => entry.name)).toEqual(expect.arrayContaining(["memory", "helpers", "pets"]));
    for (const folder of folders) {
      const module: { default: unknown } = await import(pathToFileURL(join(root, folder.name, "manifest.ts")).href);
      const manifest = capabilityManifest(module.default);
      expect(manifest.id).toBe(folder.name);
      expect(servers.includes(manifest.id)).toBe(manifest.scope !== "browser");
      const { slots = [], settings = [], panels = [], renderers = [] } = manifest.ui ?? {};
      for (const item of [...slots, ...settings, ...panels, ...renderers])
        await access(join(root, folder.name, "ui", `${item.component}.svelte`));
      for (const item of [...settings, ...panels]) expect(Object.keys(ICONS)).toContain(item.icon);
    }
    const { id, version, native, name, description, core, order } = exampleCapability.manifest;
    const bare = { id, version, native, name, description, core, order, scope: "browser" };
    for (const extra of [
      { tools: exampleCapability.manifest.tools },
      { ui: exampleCapability.manifest.ui },
      { ui: { slots: [{ slot: "context", component: "Section", order: 1 }] } },
    ])
      expect(() => capabilityManifest({ ...bare, ...extra })).toThrow("browser-only");
    const pieces = { slots: [{ slot: "composer-tools", component: "Gauge", order: 1 }] };
    expect(capabilityManifest({ ...bare, core: { min: 3, max: 3 }, ui: pieces }).ui).toEqual(pieces);
    expect(() =>
      capabilityManifest({ ...bare, ui: { slots: [{ slot: "toolbar", component: "Gauge", order: 1 }] } }),
    ).toThrow();
    const f = await fixture([]);
    await expect(
      CompiledCapabilities.open([{ manifest: capabilityManifest(bare), open: () => ({}) }], host(f.pal)),
    ).rejects.toThrow("no server part");
  });

  it("keeps the kernel's own record kinds out of plugin IDs", async () => {
    const source = join(import.meta.dirname, "../src");
    const plugins = await readdir(join(import.meta.dirname, "../plugins"));
    const kinds = new Set<string>();
    for (const file of await readdir(source, { recursive: true }))
      if (file.endsWith(".ts"))
        for (const [, id] of (await readFile(join(source, file), "utf8")).matchAll(
          /kind: "pal\.([a-z][a-z0-9-]*)[".]/g,
        ))
          if (id !== undefined && !plugins.includes(id)) kinds.add(id);
    expect([...kinds]).toEqual(expect.arrayContaining(["user", "chat", "working-state"]));
    const { version, name, description, core, order } = exampleCapability.manifest;
    for (const id of kinds)
      expect(
        () => capabilityManifest({ id, version, native: `pal.${id}`, name, description, core, order }),
        id,
      ).toThrow("core contribution");
  });

  it("registers the bounded opt-in template with host-owned grants, settings and implementation identities", async () => {
    const events: string[] = [];
    const f = await fixture([traced(exampleCapability, events)]);
    const initial = await f.pal.extensions.view();
    const item = initial.catalog.find((item) => item.id === "example");
    expect(item).toMatchObject({
      available: true,
      capability: {
        core: { min: 2, max: 3 },
        order: 70,
        tools: [{ name: "example_echo", replay: "safe", callers: ["tools"], permissions: ["project.read"] }],
      },
    });
    expect(item?.implementation).toBe(capabilityIdentity(exampleCapability.manifest, initial.release).digest);
    expect(initial.selected.map((choice) => choice.id)).not.toContain("example");
    expect(initial.catalog.map((item) => item.id)).not.toContain("memory");
    expect(() => projectMemory(f.pal.capabilities)).toThrow("Memory is not included");
    await f.pal.extensions.select({ selected: [{ id: "example", version: 1 }], digest: initial.digest });
    const chat = await f.pal.chats.createChat("template-chat", { projectId: f.project.id }, context);
    const { conversation, output } = await f.run(
      chat,
      'return await tools.example_echo({text:"bounded template 界"});',
    );
    expect(output).toContain("bounded template 界");
    const recorded = (await conversation.entries({}, 100, undefined, context)).items.filter(
      (entry) => entry.kind === "pal.example",
    );
    expect(recorded.map((entry) => entry.data)).toEqual([{ text: "bounded template 界" }]);
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
    // The owner's setting, saved through the plugin's own route, reaches its tool after a restart.
    const settings = (method: string, body?: unknown) =>
      f.pal.capabilities.request(
        "example",
        { method, path: ["settings"], query: new URLSearchParams(), body },
        context,
      );
    expect(await settings("GET")).toEqual({ prefix: "" });
    await expect(settings("PUT", { prefix: "x".repeat(33) })).rejects.toThrow();
    await settings("PUT", { prefix: "» " });
    await f.reopen();
    expect(await settings("GET")).toEqual({ prefix: "» " });
    expect((await f.pal.extensions.view()).selected).toEqual([{ id: "example", version: 1 }]);
    expect(await f.pal.extensions.pins(chat.conversationId, f.pal.harness, context)).toEqual(pins);
    expect((await f.run(chat, 'return await tools.example_echo({text:"after restart"});')).output).toContain(
      "» after restart",
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

  it("keeps native request pin records readable by the previous release", async () => {
    const f = await fixture([memoryCapability]);
    const chat = await f.pal.chats.createChat("legacy-pin-wire", { projectId: f.project.id }, context);
    const { conversation } = await f.run(chat, 'return "pin wire fixture";');
    const legacy = Type.Object(
      {
        task: Type.Integer({ minimum: 1 }),
        release: Type.String({ maxLength: 64 }),
        selected: Type.Array(
          Type.Object(
            {
              id: Type.Enum(["files", "shell", "memory", "browser", "compact"]),
              version: Type.Literal(1),
            },
            { additionalProperties: false },
          ),
          { maxItems: 5, uniqueItems: true },
        ),
      },
      { additionalProperties: false },
    );
    const page = await conversation.entries({}, 100, undefined, context);
    const pins = page.items.filter((entry) => entry.kind === "pal.extensions");
    expect(pins).toHaveLength(2);
    for (const pin of pins) expect(() => validate(legacy, pin.data)).not.toThrow();
    expect(page.items.filter((entry) => entry.kind === "pal.capabilities")).toHaveLength(2);
    for (const pin of await f.pal.extensions.pins(chat.conversationId, f.pal.harness, context)) {
      expect(pin.implementations?.map(({ id, version }) => ({ id, version }))).toEqual(pin.selected);
      expect(pin.implementations?.every((item) => /^[a-f0-9]{64}$/.test(item.digest))).toBe(true);
    }
  });

  it("refuses inconsistent identity receipts rather than inventing a joined request pin", async () => {
    const f = await fixture([memoryCapability]);
    const release = (await f.pal.extensions.view()).release;
    for (const mismatch of ["release", "selection"] as const) {
      const chat = await f.pal.chats.createChat(`mismatched-${mismatch}`, { projectId: f.project.id }, context);
      await f.pal.harness.commit(async (tx) => {
        await tx.appendEntry(chat.conversationId, {
          kind: "pal.extensions",
          data: { task: 999998, release, selected: [{ id: "memory", version: 1 }] },
        });
        await tx.appendEntry(chat.conversationId, {
          kind: "pal.capabilities",
          data: {
            task: 999998,
            release: mismatch === "release" ? "wrong-release" : release,
            implementations: [
              { id: mismatch === "selection" ? "example" : "memory", version: 1, digest: "a".repeat(64) },
            ],
          },
        });
      }, context);
      await expect(f.pal.extensions.pins(chat.conversationId, f.pal.harness, context)).rejects.toThrow(
        "does not match its request pin",
      );
    }
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
              builder.onLoad({ filter: /\/plugins\/index\.ts$/ }, (args) => ({
                contents: template
                  ? 'export { default as example } from "../test/fixtures/plugins/example/server.ts";'
                  : "export {};",
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
      expect(Object.keys(result.metafile.inputs).some((path) => path.includes("plugins/memory/"))).toBe(false);
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
      expect(() => projectMemory(pal.capabilities)).toThrow("Memory is not included");
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
    expect(view.selected.map((item) => item.id)).not.toContain("helpers");
    expect(f.pal.capabilities.namespaces).toEqual([]);
    expect(() => projectMemory(f.pal.capabilities)).toThrow("Memory is not included");
    const chat = await f.pal.chats.createChat("without-memory", { projectId: f.project.id }, context);
    const { conversation, output } = await f.run(
      chat,
      'try { return await tools.memory_search({query:"absent"}); } catch(error) { return String(error); }',
    );
    const agent = await conversation.agent(context);
    expect(agent.callable.map((tool) => tool.name)).not.toContain("memory_search");
    expect(agent.callable.map((tool) => tool.name)).not.toContain("agents_delegate");
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
    await projectMemory(f.pal.capabilities).save(
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
    expect((await projectMemory(f.pal.capabilities).list(f.project.id, context)).map((item) => item.body)).toEqual([
      "EXTRACTED-MEMORY",
    ]);
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

  it("keeps installation plugins out of chats and allows one advisor that declares itself", async () => {
    const advisor = fakeAdvisor();
    const { manifest } = advisor.capability;
    for (const extra of [
      { tools: exampleCapability.manifest.tools },
      { namespace: exampleCapability.manifest.namespace },
      { ui: { slots: [{ slot: "composer-tools", component: "Gauge", order: 1 }] } },
      { ui: { panels: [{ id: "Advice", icon: "layers", component: "Panel", order: 1 }] } },
    ])
      expect(() => capabilityManifest({ ...manifest, ...extra })).toThrow("serves the installation");
    expect(() => capabilityManifest({ ...manifest, scope: undefined })).toThrow("must serve the installation");
    expect(() => capabilityManifest({ ...manifest, scope: "browser" })).toThrow("browser-only");
    const f = await fixture([]);
    const second = { ...advisor.capability, manifest: { ...manifest, id: "other", native: "pal.other" } };
    await expect(CompiledCapabilities.open([advisor.capability, second], host(f.pal))).rejects.toThrow(
      "at most one advisor",
    );
    await expect(CompiledCapabilities.open([{ manifest, open: () => ({}) }], host(f.pal))).rejects.toThrow(
      "advisor declaration differs",
    );
    const opened = await CompiledCapabilities.open([advisor.capability], host(f.pal));
    expect(opened.advisor?.label).toBe("Fixture");
    await opened.close();
    expect(opened.advisor).toBeUndefined();
    const installed = await fixture(withAdvisor(advisor.capability));
    const view = await installed.pal.extensions.view();
    expect(view.catalog.map((item) => item.id)).not.toContain("fixture-advisor");
    await expect(
      installed.pal.extensions.select({ selected: [{ id: "fixture-advisor", version: 1 }], digest: view.digest }),
    ).rejects.toThrow();
  });

  it("validates compatibility, names, permissions and collisions before opening code", async () => {
    const f = await fixture([]);
    const open = vi.fn(exampleCapability.open);
    const manifest = exampleCapability.manifest;
    for (const invalid of [
      { ...manifest, core: { min: 4, max: 4 } },
      { ...manifest, core: { min: 1, max: 2 } },
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
      { ...manifest, tools: manifest.tools.map((tool) => ({ ...tool, callers: [] })) },
      // A plugin cannot give itself direct model access or own a kernel table.
      { ...manifest, tools: manifest.tools.map((tool) => ({ ...tool, callers: ["model", "tools"] })) },
      { ...manifest, storage: { owns: ["pal_chats"], reads: [] } },
      { ...manifest, core: { min: 0, max: 1 } },
      { ...manifest, credentialStore: "ambient" },
    ])
      expect(() => capabilityManifest(invalid)).toThrow();
    // History names a plugin by its native name; its panels and renderers stay out of the kernel's and others'.
    const panel = { id: "Context", icon: "layers", component: "ExamplePanel", order: 10 };
    const renderer = (entry: string) => ({
      ...manifest,
      ui: { renderers: [{ entry, component: "ExampleResult", order: 10 }] },
    });
    for (const [invalid, message] of [
      [{ ...manifest, native: "pal.echo" }, "native name pal.example"],
      [{ ...manifest, ui: { panels: [panel] } }, "kernel panel"],
      [{ ...manifest, ui: { settings: [{ ...panel, id: "general", label: "General" }] } }, "kernel settings tab"],
      [renderer("pal.memory"), "its own entries"],
      [renderer("pal.examples"), "its own entries"],
    ] as const)
      expect(() => capabilityManifest(invalid)).toThrow(message);
    expect(capabilityManifest(renderer("pal.example.result")).ui?.renderers?.[0]?.entry).toBe("pal.example.result");
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
        open: (services) => {
          const runtime = exampleCapability.open(services);
          return {
            tools: runtime.tools.map((tool) => ({
              ...tool,
              ...(drift === "callers" ? { callers: ["model"] as const } : { replay: "unsafe" as const }),
            })),
            dispose,
          };
        },
      };
      await expect(CompiledCapabilities.open([definition], host(f.pal))).rejects.toThrow("declared replay and callers");
      expect(dispose).toHaveBeenCalledTimes(1);
    }
    let tools: ReturnType<typeof exampleCapability.open>["tools"] = [];
    const opened = await CompiledCapabilities.open(
      [{ ...exampleCapability, open: (services) => ({ tools: (tools = exampleCapability.open(services).tools) }) }],
      host(f.pal),
    );
    cleanups.push(() => opened.close());
    const registry = createRegistry();
    const kernel = defineExtension({ name: "pal.policy", tools });
    registry.install(kernel);
    expect(() => opened.install(registry)).toThrow("collides");
    expect(registry.snapshot().installed()).toEqual([kernel]);
  });

  it("keeps a plugin's settings bounded and under its own prefix", async () => {
    const f = await fixture([]);
    let settings: PluginSettings | undefined;
    const opened = await CompiledCapabilities.open(
      [
        {
          ...exampleCapability,
          open: (services) => {
            settings = services.settings;
            return exampleCapability.open(services);
          },
        },
      ],
      host(f.pal),
    );
    cleanups.push(() => opened.close());
    if (settings === undefined) throw new Error("missing plugin settings");
    expect(await settings.get("echo")).toBeUndefined();
    await settings.set("echo", { prefix: "» " });
    expect(await settings.get("echo")).toEqual({ prefix: "» " });
    expect(await f.pal.store.database.all("SELECT key FROM pal_settings WHERE key LIKE 'plugin:%'")).toEqual([
      { key: "plugin:example:echo" },
    ]);
    for (const name of ["", "Echo", ":extensions:selection", "x".repeat(65)])
      await expect(settings.get(name)).rejects.toThrow("invalid setting name");
    for (const value of ["x".repeat(16 * 1024), undefined])
      await expect(settings.set("echo", value)).rejects.toThrow("at most 16 KiB");
    expect(await settings.get("echo")).toEqual({ prefix: "» " });
    // A corrupt row names the plugin and setting, never its stored value.
    await f.pal.store.database.run(
      "UPDATE pal_settings SET value = '{\"secret-value' WHERE key = 'plugin:example:echo'",
    );
    const corrupt = await settings.get("echo").catch((error: unknown) => error);
    expect(corrupt).toBeInstanceOf(Error);
    expect((corrupt as Error).message).toBe("Capability example setting echo is corrupt.");
    expect(JSON.stringify(corrupt, Object.getOwnPropertyNames(corrupt))).not.toContain("secret-value");
  });

  it("keeps a plugin's SQL to its declared tables and its requests to its own ID", async () => {
    const f = await fixture([]);
    let sql: SqliteDatabase | undefined;
    const scoped: CompiledCapability = {
      manifest: { ...exampleCapability.manifest, storage: { owns: ["pal_example_notes"], reads: ["pal_projects"] } },
      open: (services) => {
        sql = services.sql;
        return exampleCapability.open(services);
      },
    };
    const opened = await CompiledCapabilities.open([scoped], host(f.pal));
    cleanups.push(() => opened.close());
    if (sql === undefined) throw new Error("missing scoped SQL");
    expect(await sql.all("SELECT id FROM pal_projects")).toHaveLength(1);
    await expect(sql.all("SELECT id FROM pal_chats")).rejects.toThrow("no access to pal_chats");
    await expect(sql.run("DELETE FROM pal_projects")).rejects.toThrow("no access to pal_projects");
    await expect(sql.transaction((tx) => tx.run("UPDATE pal_chats SET title = NULL"))).rejects.toThrow(
      "no access to pal_chats",
    );
    await expect(sql.exec("SELECT 1")).rejects.toThrow("may only query and change rows");
    await expect(sql.run("DROP TABLE pal_example_notes")).rejects.toThrow("may only query and change rows");
    await expect(sql.close()).rejects.toThrow("cannot close");
    expect(await f.pal.store.database.get("SELECT COUNT(*) AS n FROM pal_projects")).toEqual({ n: 1 });
    const request = { method: "GET", path: [], query: new URLSearchParams(), body: undefined };
    await expect(opened.request("example", request, context)).rejects.toMatchObject({ status: 404 });
    await expect(opened.request("missing", request, context)).rejects.toMatchObject({ status: 404 });
  });

  it("rechecks live grants around execution and enforces output and parameter bounds", async () => {
    const events: string[] = [];
    const bounded = traced(exampleCapability, events, "X".repeat(8000));
    bounded.manifest = {
      ...bounded.manifest,
      tools: (bounded.manifest.tools ?? []).map((tool) => ({ ...tool, maxOutputBytes: 64 })),
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
        ui: {},
      },
      open: () => {
        throw new Error("fixture second open failed");
      },
    };
    await expect(CompiledCapabilities.open([first, second], host(f.pal))).rejects.toThrow("second open failed");
    expect(events).toEqual(["open:example", "dispose:example"]);
    const dispose = vi.fn();
    second.open = (services) => ({
      tools: exampleCapability.open(services).tools.map((tool) => ({ ...tool, name: "second_echo" })),
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
        [{ ...exampleCapability, open: (host) => ({ ...exampleCapability.open(host), dispose }) }],
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
