import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ConversationId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { McpClient } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPalCodemode } from "../src/pi/codemode.ts";
import { type HttpAuth, McpConfigError, McpManager, PRESETS } from "../src/pi/mcp.ts";
import { loadMasterKey, SqliteCredentialStore } from "../src/storage/credentials.ts";
import { openStore } from "../src/storage/store.ts";
import { startMcpFixture } from "./fixtures/mcp-server.ts";
import { Projects } from "../src/core/projects.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = await startMcpFixture();
  cleanups.push(fixture.close);
  const dataRoot = await mkdtemp(join(tmpdir(), "pal-mcp-test-"));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  cleanups.push(() => store.close());
  const credentials = new SqliteCredentialStore(
    store.database,
    await loadMasterKey(join(dataRoot, "credentials.key")),
    store.installationId,
  );
  const projects = await Projects.open({ database: store.database, dataRoot, installRoot: "/nonexistent" });
  const project = await projects.create("mcp-project-fixture", { name: "Fixture" });
  const registry = createRegistry();
  // The policy closure exists before the manager it asks.
  const ref: { manager?: McpManager } = {};
  const codemode = createPalCodemode({
    allows: async (conversation, name) => (await ref.manager?.allowsInConversation(conversation, name)) === true,
  });
  cleanups.push(() => codemode.sandbox.close());
  for (const extension of codemode.extensions) registry.install(extension);
  const open = () =>
    McpManager.open({
      database: store.database,
      credentials,
      registry,
      projectId: async () => (await projects.get(project.id))?.id,
      codemode: codemode.withNamespaces,
    });
  const manager = await open();
  ref.manager = manager;
  cleanups.push(() => manager.close());
  const add = (auth: HttpAuth = { kind: "none" }, url = fixture.url) =>
    manager.add({ name: "Fixture", url, auth, private: true });

  /** Run one model turn whose script is `code`, and return the script's result text. */
  async function script(code: string): Promise<string> {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    cleanups.push(() => harness.close(context));
    const model = faux.getModel();
    const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
    await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
    const { messages } = await root.context(context);
    const result = messages.find((message): message is ToolResultMessage => message.role === "toolResult");
    return result?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
  }

  return { fixture, store, credentials, registry, manager, open, add, script, projects, project };
}

const tryCall = (call: string) => `try { return await ${call}; } catch (error) { return "error: " + error.message; }`;

describe("MCP connections", () => {
  it.each(["credential", "schema", "endpoint"])("pins a prepared tool binding across a %s change", async (change) => {
    const { manager, add, registry, fixture, script } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    const prepared = registry
      .snapshot()
      .tools()
      .find(({ tool }) => tool.name === `mcp__${server.id}__search`)?.tool;
    if (prepared === undefined) throw new Error("missing prepared tool");
    if (change === "credential") await manager.setKey(server.id, "fixture-new-prepared-key");
    if (change === "schema") {
      const listed = fixture.state.tools[0];
      if (listed === undefined) throw new Error("missing fixture tool");
      listed.description = "New definition";
      await manager.test(server.id);
      await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    }
    if (change === "endpoint") {
      await manager.update(server.id, {
        name: server.name,
        url: fixture.url + "?new-recipient",
        auth: { kind: "none" },
        private: true,
      });
      await manager.test(server.id);
      await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
      await manager.setEnabled(server.id, true);
    }
    await expect(
      prepared.execute({ query: "durable" }, { conversationId: 1 as ConversationId } as ToolExecutionApi, context),
    ).rejects.toThrow(/not granted|changed/);
    expect(fixture.calls).toEqual([]);
    expect(
      await script(`return (await tools.mcp__${server.id}__search({query:"durable"})).results[0].title;`),
    ).toContain("Durable agents");
    expect(fixture.calls).toHaveLength(1);
  });

  it("does not revive an in-flight result when an owner removes then restores the same tool approval", async () => {
    const { manager, add, script, fixture } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    const entered = Promise.withResolvers<undefined>(),
      release = Promise.withResolvers<undefined>();
    fixture.state.beforeCall = async () => {
      entered.resolve(undefined);
      await release.promise;
    };
    const pending = script(tryCall(`tools.mcp__${server.id}__search({query:"durable"})`));
    try {
      await entered.promise;
      await manager.approve(server.id, [], (await manager.get(server.id)).catalog);
      await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    } finally {
      release.resolve(undefined);
    }
    const outcome = await pending;
    expect(outcome).toMatch(/changed|aborted|revoked/);
    expect(outcome).not.toContain("Durable agents");
    fixture.state.beforeCall = undefined;
    expect(
      await script(`return (await tools.mcp__${server.id}__search({query:"durable"})).results[0].title;`),
    ).toContain("Durable agents");
    expect(fixture.calls).toHaveLength(2);
  });

  it("keeps an unchanged approval idempotent without cancelling a permitted in-flight call", async () => {
    const { manager, add, script, fixture, project } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    const before = await manager.grants.decision(project.id, server.id, "search");
    const entered = Promise.withResolvers<undefined>(),
      release = Promise.withResolvers<undefined>();
    fixture.state.beforeCall = async () => {
      entered.resolve(undefined);
      await release.promise;
    };
    const pending = script(tryCall(`tools.mcp__${server.id}__search({query:"durable"})`));
    try {
      await entered.promise;
      await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
      expect(await manager.grants.decision(project.id, server.id, "search")).toEqual(before);
    } finally {
      release.resolve(undefined);
    }
    expect(await pending).toContain("Durable agents");
    expect(fixture.calls).toHaveLength(1);
  });

  it.each(["credential", "endpoint"])(
    "rejects catalog consent during and after a concurrent %s change",
    async (change) => {
      const { manager, add, credentials, fixture, store } = await setup();
      const server = await add();
      const a = await manager.test(server.id);
      await manager.approve(server.id, ["fetch"], a.catalog);
      const entered = Promise.withResolvers<undefined>(),
        release = Promise.withResolvers<undefined>();
      const erase = vi.spyOn(credentials, "delete").mockImplementationOnce(async () => {
        entered.resolve(undefined);
        await release.promise;
      });
      const changing =
        change === "credential"
          ? manager.setKey(server.id, null)
          : manager.update(server.id, {
              name: server.name,
              url: fixture.url + "?changed=1",
              auth: { kind: "none" },
              private: true,
            });
      try {
        await entered.promise;
        expect((await manager.get(server.id)).catalog).toBeNull();
        await expect(manager.approve(server.id, ["search"], a.catalog)).rejects.toThrow(/changing/);
      } finally {
        release.resolve(undefined);
        await changing;
        erase.mockRestore();
      }
      const b = await manager.test(server.id);
      expect(b.catalog).not.toBe(a.catalog);
      const before = await store.database.get("SELECT approved FROM pal_mcp_servers WHERE id = ?", server.id);
      await expect(manager.approve(server.id, ["search"], a.catalog)).rejects.toThrow(/catalog.*changed/);
      expect(await store.database.get("SELECT approved FROM pal_mcp_servers WHERE id = ?", server.id)).toEqual(before);
      await manager.approve(server.id, ["search"], b.catalog);
      expect(fixture.calls).toEqual([]);
    },
  );

  it("does not publish a concurrent rediscovery over the definitions being approved", async () => {
    const { manager, add, fixture, store } = await setup();
    const server = await add();
    const a = await manager.test(server.id);
    const search = fixture.state.tools[0];
    if (search === undefined) throw new Error("missing fixture tool");
    search.description = "Rediscovered definition B";
    const entered = Promise.withResolvers<undefined>(),
      release = Promise.withResolvers<undefined>();
    fixture.state.beforeList = async () => {
      entered.resolve(undefined);
      await release.promise;
    };
    const refresh = manager.test(server.id);
    let approving: Promise<unknown> | undefined;
    try {
      await entered.promise;
      approving = manager.approve(server.id, ["search"], a.catalog);
      await expect
        .poll(async () => {
          const row = await store.database.get<{ approved: string }>(
            "SELECT approved FROM pal_mcp_servers WHERE id = ?",
            server.id,
          );
          return row?.approved;
        })
        .toContain(a.tools.find((tool) => tool.name === "search")?.fingerprint);
    } finally {
      release.resolve(undefined);
      await approving;
      await refresh;
    }
    const approved = await manager.get(server.id);
    expect(approved.catalog).toBe(a.catalog);
    expect(approved.tools.find((tool) => tool.name === "search")).toMatchObject({
      approved: true,
      changed: false,
      definition: a.tools.find((tool) => tool.name === "search")?.definition,
    });
    fixture.state.beforeList = undefined;
    const b = await manager.test(server.id);
    expect(b.catalog).not.toBe(a.catalog);
    expect(b.tools.find((tool) => tool.name === "search")?.changed).toBe(true);
    expect(fixture.calls).toEqual([]);
  });

  it("clears a saved key before publishing a changed recipient, including interrupted credential deletion", async () => {
    const { manager, add, credentials, open, fixture } = await setup();
    const server = await add({ kind: "header", header: "x-api-key" });
    await manager.setKey(server.id, "fixture-bound-recipient-key");
    const erase = vi.spyOn(credentials, "delete").mockRejectedValueOnce(new Error("interrupted key deletion"));
    const input = {
      name: "Moved",
      url: fixture.url + "?recipient=changed",
      auth: { kind: "header" as const, header: "x-api-key" },
      private: true,
    };
    await expect(manager.update(server.id, input)).rejects.toThrow("interrupted key deletion");
    expect(await manager.get(server.id)).toMatchObject({ url: fixture.url, enabled: false, keyConfigured: true });
    const reopened = await open();
    cleanups.push(() => reopened.close());
    expect(await reopened.get(server.id)).toMatchObject({ url: fixture.url, enabled: false });
    erase.mockRestore();
    expect(await reopened.update(server.id, input)).toMatchObject({
      url: input.url,
      enabled: false,
      keyConfigured: false,
    });
    expect(await credentials.read(`mcp:${server.id}`)).toBeUndefined();
  });

  it("seeds the Exa and Context7 presets once, disabled until the owner's first-run review", async () => {
    const { manager, open } = await setup();
    const servers = await manager.list();
    expect(servers.map(({ id, enabled, state }) => ({ id, enabled, state }))).toEqual([
      { id: "exa", enabled: false, state: "disabled" },
      { id: "context7", enabled: false, state: "disabled" },
    ]);
    // Exa's tools are pinned in the URL so a key cannot turn on its separate research agent.
    expect(servers[0]?.url).toBe("https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa");
    expect(servers[0]?.auth).toEqual({ kind: "header", header: "x-api-key" });
    expect(servers[1]?.auth).toEqual({ kind: "bearer" });
    expect(PRESETS.map((preset) => preset.tools)).toEqual([
      ["web_search_exa", "web_fetch_exa"],
      ["resolve-library-id", "query-docs"],
    ]);
    expect(await manager.reviewPending()).toBe(true);
    await manager.finishReview(false);
    await manager.setEnabled("context7", false);
    const reopened = await open();
    cleanups.push(() => reopened.close());
    expect(await reopened.reviewPending()).toBe(false);
    expect((await reopened.list()).map((server) => server.id)).toEqual(["exa", "context7"]);
  });

  it("persists exact-preset fake-IP consent and revokes approvals when routing changes", async () => {
    const { manager, store, open, fixture, add } = await setup();
    const sample = await add();
    await manager.test(sample.id);
    await manager.approve(sample.id, ["search"], (await manager.get(sample.id)).catalog);
    const row = await store.database.get<{ approved: string }>(
      "SELECT approved FROM pal_mcp_servers WHERE id = ?",
      sample.id,
    );
    if (row === undefined) throw new Error("fixture approval is missing");
    await store.database.run("UPDATE pal_mcp_servers SET enabled = 1, approved = ? WHERE id = 'exa'", row.approved);
    const restored = await open();
    cleanups.push(() => restored.close());
    expect((await restored.get("exa")).tools[0]?.approved).toBe(true);
    const requests = fixture.requests.length;
    expect(await restored.setFakeIp("exa", true)).toMatchObject({
      fakeIp: true,
      private: false,
      enabled: false,
      tools: [],
      url: PRESETS[0]?.url,
    });
    const again = await open();
    cleanups.push(() => again.close());
    expect((await again.get("exa")).fakeIp).toBe(true);
    expect((await again.setFakeIp("exa", false)).fakeIp).toBe(false);
    await expect(manager.setFakeIp(sample.id, true)).rejects.toBeInstanceOf(McpConfigError);
    expect(fixture.requests).toHaveLength(requests);
  });

  it("keeps keys write-only and sends them only in the configured header", async () => {
    const { fixture, manager, add } = await setup();
    const header = await add({ kind: "header", header: "x-api-key" });
    const keyed = await manager.setKey(header.id, "secret-key-123");
    expect(keyed.keyConfigured).toBe(true);
    expect(JSON.stringify(await manager.list())).not.toContain("secret-key-123");
    await manager.test(header.id);
    expect(fixture.requests.at(-1)?.headers["x-api-key"]).toBe("secret-key-123");
    expect(fixture.requests.every((request) => !request.path.includes("secret"))).toBe(true);

    const bearer = await add({ kind: "bearer" });
    await manager.setKey(bearer.id, "secret-bearer-456");
    await manager.test(bearer.id);
    expect(fixture.requests.at(-1)?.headers.authorization).toBe("Bearer secret-bearer-456");
    expect((await manager.setKey(bearer.id, null)).keyConfigured).toBe(false);
  });

  it("tests without calling tools; scripts reach only approved tools of enabled servers", async () => {
    const { fixture, manager, add, script } = await setup();
    const server = await add();
    const tested = await manager.test(server.id);
    expect(tested).toMatchObject({ enabled: false, state: "ready" });
    expect(tested.tools.map((tool) => [tool.name, tool.approved])).toEqual([
      ["search", false],
      ["fetch", false],
      ["delete_everything", false],
    ]);
    expect(fixture.calls).toEqual([]);

    await manager.approve(server.id, ["search", "fetch"], (await manager.get(server.id)).catalog);
    // Approved but not enabled: the tool is not installed, so the script cannot call it.
    expect(await script(tryCall(`tools.mcp__${server.id}__search({ query: "x" })`))).toMatch(/error: /);
    await manager.setEnabled(server.id, true);
    const output = await script(`
      const found = await tools.mcp__${server.id}__search({ query: "durable" });
      let destroy;
      try { destroy = await tools.mcp__${server.id}__delete_everything({}); } catch (error) { destroy = "error: " + error.message; }
      return { first: found.results[0].title, destroy };
    `);
    expect(output).toContain('"first":"Durable agents"');
    expect(output).toMatch(/"destroy":"error: /);
    expect(fixture.calls.map((call) => call.name)).toEqual(["search"]);
    expect((await manager.get(server.id)).state).toBe("ready");
  });

  it("stops a running script's next call once the server is disabled", async () => {
    const { fixture, manager, add, script } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search", "fetch"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    let disabling: Promise<unknown> | undefined;
    fixture.state.beforeCall = async (call) => {
      if (call.name === "search") {
        disabling = manager.setEnabled(server.id, false);
        expect(manager.allows(`mcp__${server.id}__fetch`)).toBe(false);
        await disabling;
      }
    };
    // Disabling closes the connection, so the call in flight may end too; the next one never reaches the server.
    const output = await script(`
      let first, second;
      try { first = (await tools.mcp__${server.id}__search({ query: "x" })).results.length; } catch (error) { first = "error"; }
      try { second = await tools.mcp__${server.id}__fetch({ url: "https://fixture.invalid/durable" }); }
      catch (error) { second = "error: " + error.message; }
      return { first, second };
    `);
    expect(output).toMatch(/"second":"error: [^"]*(not granted|not available)/);
    expect(fixture.calls.map((call) => call.name)).toEqual(["search"]);
    await disabling;
  });

  it("refuses a tool the server now describes differently until it is approved again", async () => {
    const { fixture, manager, add, script } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    const search = fixture.state.tools[0];
    if (search === undefined) throw new Error("fixture has no tools");
    (search.inputSchema as { properties: Record<string, unknown> }).properties = {
      query: { type: "string" },
      everything: { type: "boolean" },
    };
    const changed = await manager.test(server.id);
    expect(changed.state).toBe("changed");
    expect(changed.tools.find((tool) => tool.name === "search")?.changed).toBe(true);
    expect(await script(tryCall(`tools.mcp__${server.id}__search({ query: "x" })`))).toMatch(/error: .*does not exist/);
    expect(fixture.calls).toEqual([]);

    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    expect(await script(tryCall(`tools.mcp__${server.id}__search({ query: "x" })`))).not.toMatch(/error: /);
    expect(fixture.calls.map((call) => call.name)).toEqual(["search"]);
  });

  it("narrows one project's exact tools, hides ungranted discovery metadata, and persists the decision", async () => {
    const { manager, add, script, project, projects, open } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search", "fetch"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    const grant = (await manager.grants.view(project.id)).servers.find((candidate) => candidate.id === server.id);
    if (grant === undefined) throw new Error("missing grant");
    await manager.grants.set(project.id, server.id, { revision: grant.revision, mode: "subset", tools: ["search"] });
    expect(await script("return ALL_TOOLS.map(tool => tool.name);")).toContain(`mcp__${server.id}__search`);
    expect(await script("return ALL_TOOLS.map(tool => tool.name);")).not.toContain(`mcp__${server.id}__fetch`);
    expect(await script(tryCall(`tools.mcp__${server.id}__fetch({ url: "https://fixture.invalid/durable" })`))).toMatch(
      /does not exist/,
    );
    const other = await projects.create("another-project", { name: "Other" });
    expect(await manager.grants.decision(other.id, server.id, "fetch")).toMatchObject({ allowed: true });
    const restored = await open();
    cleanups.push(() => restored.close());
    expect(await restored.grants.decision(project.id, server.id, "search")).toMatchObject({ allowed: true });
    expect(await restored.grants.decision(project.id, server.id, "fetch")).toMatchObject({ allowed: false });
    await projects.remove(project.id);
    expect(await restored.grants.decision(project.id, server.id, "search")).toMatchObject({ allowed: false });
  });

  it("requires project re-approval after schema, endpoint or credential authority changes", async () => {
    const { manager, add, script, project, fixture, open } = await setup();
    const server = await add({ kind: "header", header: "x-api-key" });
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    const select = async () => {
      const current = (await manager.grants.view(project.id)).servers.find((candidate) => candidate.id === server.id);
      if (current === undefined) throw new Error("missing grant");
      await manager.grants.set(project.id, server.id, {
        revision: current.revision,
        mode: "subset",
        tools: ["search"],
      });
    };
    await select();
    await manager.setKey(server.id, "new-fixture-key");
    expect(await manager.grants.decision(project.id, server.id, "search")).toMatchObject({ allowed: false });
    expect(
      (await manager.grants.view(project.id)).servers.find((candidate) => candidate.id === server.id)?.authorityStale,
    ).toBe(true);
    await select();
    const tool = fixture.state.tools[0];
    if (tool === undefined) throw new Error("missing fixture tool");
    tool.description = "Changed capability";
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    expect(await manager.grants.decision(project.id, server.id, "search")).toMatchObject({ allowed: false });
    await select();
    await manager.update(server.id, {
      name: "Moved",
      url: fixture.url + "?changed=1",
      auth: { kind: "header", header: "x-api-key" },
      private: true,
    });
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    const restored = await open();
    cleanups.push(() => restored.close());
    expect(await restored.grants.decision(project.id, server.id, "search")).toMatchObject({ allowed: false });
    expect(await script(tryCall(`tools.mcp__${server.id}__search({ query: "not approved" })`))).toMatch(
      /does not exist/,
    );
  });

  it("cancels in-flight and queued project calls; re-enabling cannot release their old grant", async () => {
    const { manager, add, script, project, fixture } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    const release = Promise.withResolvers<undefined>();
    fixture.state.beforeCall = async () => {
      await release.promise;
    };
    try {
      const running = script(
        `return await Promise.all([0,1,2].map(async n => { try { await tools.mcp__${server.id}__search({ query: String(n) }); return "leaked"; } catch { return "revoked"; } }));`,
      );
      await expect.poll(() => fixture.calls.length).toBe(2);
      let current = (await manager.grants.view(project.id)).servers.find((candidate) => candidate.id === server.id);
      if (current === undefined) throw new Error("missing grant");
      await manager.grants.set(project.id, server.id, { revision: current.revision, mode: "subset", tools: [] });
      current = (await manager.grants.view(project.id)).servers.find((candidate) => candidate.id === server.id);
      if (current === undefined) throw new Error("missing grant");
      await manager.grants.set(project.id, server.id, { revision: current.revision, mode: "inherit", tools: [] });
      release.resolve(undefined);
      const output = await running;
      expect(output).toContain('["revoked","revoked","revoked"]');
      expect(fixture.calls).toHaveLength(2);
      expect(await script(tryCall(`tools.mcp__${server.id}__search({ query: "new grant" })`))).not.toContain("error:");
      expect(fixture.calls).toHaveLength(3);
    } finally {
      release.resolve(undefined);
    }
  });

  it("bounds queued calls and releases the queue without admitting over-limit work", async () => {
    const { manager, registry, add, fixture } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    const tool = registry
      .snapshot()
      .tools()
      .find((entry) => entry.tool.name === `mcp__${server.id}__search`)?.tool;
    if (tool === undefined) throw new Error("missing tool");
    const release = Promise.withResolvers<undefined>();
    let active = 0,
      peak = 0;
    fixture.state.beforeCall = async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        await release.promise;
      } finally {
        active--;
      }
    };
    let rejected = 0;
    const catalog = Promise.withResolvers<undefined>();
    fixture.state.beforeList = () => catalog.promise;
    // This fixture isolates queue admission; API integration checks the real durable receipt commits.
    const executorApi = { conversationId: 2 as ConversationId } as ToolExecutionApi;
    executorApi.commit = vi.fn();
    try {
      const pending = Array.from({ length: 12 }, (_, n) =>
        tool.execute({ query: String(n) }, executorApi, context).then(
          () => true,
          () => {
            rejected++;
            return false;
          },
        ),
      );
      await expect.poll(() => rejected).toBe(2);
      expect(fixture.calls).toHaveLength(0);
      catalog.resolve(undefined);
      await expect.poll(() => fixture.calls.length).toBe(2);
      release.resolve(undefined);
      const results = await Promise.all(pending);
      expect(results.filter(Boolean)).toHaveLength(10);
      expect(fixture.calls).toHaveLength(10);
      expect(peak).toBe(2);
      expect(active).toBe(0);
    } finally {
      catalog.resolve(undefined);
      release.resolve(undefined);
    }
  });

  it("drops a completed result revoked while its transport is still closing", async () => {
    const { manager, add, script, project } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    const closing = Promise.withResolvers<undefined>(),
      release = Promise.withResolvers<undefined>();
    const close = McpClient.prototype.close;
    const delayed = vi.spyOn(McpClient.prototype, "close").mockImplementationOnce(async function (this: McpClient) {
      closing.resolve(undefined);
      await release.promise;
      await close.call(this);
    });
    try {
      const running = script(
        `try { await tools.mcp__${server.id}__search({ query: "closing" }); return "leaked"; } catch { return "revoked"; }`,
      );
      await closing.promise;
      const grant = (await manager.grants.view(project.id)).servers.find((candidate) => candidate.id === server.id);
      if (grant === undefined) throw new Error("missing grant");
      await manager.grants.set(project.id, server.id, { revision: grant.revision, mode: "subset", tools: [] });
      release.resolve(undefined);
      expect(await running).toContain("revoked");
    } finally {
      release.resolve(undefined);
      delayed.mockRestore();
    }
  });

  it("redacts a saved key from successful text and structured results before durable delivery", async () => {
    const { manager, add, script, fixture } = await setup();
    const server = await add({ kind: "header", header: "x-api-key" });
    const key = 'fixture-key-"129\\secret';
    await manager.setKey(server.id, key);
    await manager.test(server.id);
    await manager.approve(server.id, ["search", "fetch"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    fixture.state.result = {
      content: [{ type: "text", text: key }],
      structuredContent: { results: [{ title: key, url: "https://fixture.invalid/", score: 129 }] },
    };
    const structured = await script(`return await tools.mcp__${server.id}__search({ query: "redaction" });`);
    expect(structured).toContain("[redacted]");
    expect(structured).toContain("129");
    expect(structured).not.toContain("fixture-key-");
    const text = await script(`return await tools.mcp__${server.id}__fetch({ url: "https://fixture.invalid/" });`);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("fixture-key-");
  });

  it("refuses discovery metadata that echoes the saved key", async () => {
    const { manager, add, fixture } = await setup();
    const server = await add({ kind: "header", header: "x-api-key" });
    const key = 'catalog-credential-"private';
    await manager.setKey(server.id, key);
    const tool = fixture.state.tools[0];
    if (tool === undefined) throw new Error("missing fixture tool");
    tool.description = `Server echoed ${key}`;
    const tested = await manager.test(server.id);
    expect(tested.state).toBe("error");
    expect(tested.detail).toContain("catalog contains the saved credential");
    expect(JSON.stringify(tested)).not.toContain("catalog-credential-");
    expect(tested.tools).toEqual([]);
  });

  it("rejects an oversized structured result instead of bypassing output bounds", async () => {
    const { manager, add, script, fixture } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    fixture.state.result = {
      content: [{ type: "text", text: "small text is not a bound on structured data" }],
      structuredContent: { results: [{ title: "x".repeat(256 * 1024), url: "https://fixture.invalid/", score: 1 }] },
    };
    expect(await script(tryCall(`tools.mcp__${server.id}__search({ query: "large" })`))).toContain(
      "MCP result exceeds",
    );
  });

  it("enforces HTTPS, public addresses and no redirects for public endpoints", async () => {
    const { fixture, manager } = await setup();
    const add = (url: string, isPrivate = false) =>
      manager.add({ name: "Remote", url, auth: { kind: "none" }, private: isPrivate });
    await expect(add("http://example.com/mcp")).rejects.toBeInstanceOf(McpConfigError);
    await expect(add("https://user:pass@example.com/mcp")).rejects.toBeInstanceOf(McpConfigError);

    // Names and literals that reach this machine are refused before any request is sent.
    for (const url of [`https://localhost:${fixture.port}/mcp`, `https://127.0.0.1:${fixture.port}/mcp`]) {
      const server = await add(url);
      const tested = await manager.test(server.id);
      expect(tested.state).toBe("blocked");
    }
    expect(fixture.requests).toEqual([]);

    // A redirect is refused rather than followed, so a key could not travel with it.
    const redirected = await add(`http://127.0.0.1:${fixture.port}/redirect`, true);
    expect(await manager.test(redirected.id)).toMatchObject({
      state: "blocked",
      detail: expect.stringMatching(/redirect/),
    });
    expect(fixture.requests.map((request) => request.path)).toEqual(["/redirect"]);
  });

  it("reports rate limits and missing keys as states", async () => {
    const { fixture, manager, add } = await setup();
    const server = await add();
    fixture.state.status = 429;
    expect(await manager.test(server.id)).toMatchObject({ state: "rate_limited", detail: "forced 429" });
    fixture.state.status = 401;
    expect(await manager.test(server.id)).toMatchObject({
      state: "key_required",
      detail: "This server needs an API key.",
    });
  });

  it("clears approvals and disables a server whose endpoint changes", async () => {
    const { fixture, manager, add } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search"], (await manager.get(server.id)).catalog);
    await manager.setEnabled(server.id, true);
    const moved = await manager.update(server.id, {
      name: "Fixture",
      url: `${fixture.url}?v=2`,
      auth: { kind: "none" },
      private: true,
    });
    expect(moved.enabled).toBe(false);
    expect(moved.tools.filter((tool) => tool.approved)).toEqual([]);
    await expect(
      manager.update("exa", { name: "Exa", url: "https://evil.example/mcp", auth: { kind: "none" }, private: false }),
    ).rejects.toBeInstanceOf(McpConfigError);
  });
});
