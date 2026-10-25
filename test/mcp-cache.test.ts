import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { McpClient, type CallToolResult } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpQueryCache, responseCacheTtl } from "../src/pi/mcp-cache.ts";
import { McpProvenance, type McpReceipt } from "../src/pi/mcp-source.ts";
import { openStore } from "../src/storage/store.ts";
import { startCachedMcp } from "./fixtures/cached-mcp.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const value = (text = "fixture source"): CallToolResult => ({ content: [{ type: "text", text }], isError: false });
const scope = (key = "opaque-key", project = "project", server = "server") => ({ key, project, server });
async function temp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-mcp-cache-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function cacheFixture() {
  const store = await openStore(await temp());
  cleanups.push(() => store.close());
  let now = 1_800_000_000_000;
  const cache = new McpQueryCache(store.database, () => now);
  return {
    store,
    cache,
    get now() {
      return now;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("bounded MCP query cache", () => {
  it.each(["inserted", "committed"])("recovers a whole derived cache row after SIGKILL at %s", async (phase) => {
    const root = await temp();
    const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/mcp-cache-child.ts"), root, phase], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    const lines = createInterface({ input: child.stdout });
    const [line] = await Promise.race([
      once(lines, "line"),
      once(child, "exit").then(() => {
        throw new Error("cache fixture exited before barrier");
      }),
    ]);
    lines.close();
    expect(line).toBe("cache barrier");
    child.kill("SIGKILL");
    await once(child, "exit");
    const store = await openStore(root);
    cleanups.push(() => store.close());
    expect(await store.database.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
    const now = Date.now();
    const cache = new McpQueryCache(store.database, () => now);
    const key = scope("recovery-cache-key", "fixture-project", "fixture-server");
    expect((await cache.get(key))?.result).toEqual(phase === "committed" ? value("committed source") : undefined);
    await cache.put(key, value("new response"), now, 1000);
    expect((await cache.get(key))?.result).toEqual(value("new response"));
  });

  it("persists detached values, scopes reads and never extends freshness on a hit", async () => {
    const f = await cacheFixture();
    await f.cache.put(scope(), value(), f.now, 1000);
    const hit = await f.cache.get(scope());
    expect(hit).toMatchObject({ fetchedAt: f.now, expiresAt: f.now + 1000, result: value() });
    if (hit === undefined) throw new Error("missing fixture hit");
    hit.result.content.length = 0;
    expect((await f.cache.get(scope()))?.result).toEqual(value());
    expect(await f.cache.get(scope("opaque-key", "foreign"))).toBeUndefined();
    expect(await f.cache.get(scope("opaque-key", "project", "foreign"))).toBeUndefined();
    f.advance(900);
    expect((await f.cache.get(scope()))?.expiresAt).toBe(f.now + 100);
    f.cache.close();
    const reopened = new McpQueryCache(f.store.database, () => f.now);
    expect((await reopened.get(scope()))?.fetchedAt).toBe(f.now - 900);
    f.advance(100);
    expect(await reopened.get(scope())).toBeUndefined();
    expect(await f.store.database.get("SELECT count(*) AS n FROM pal_mcp_cache")).toEqual({ n: 0 });
  });

  it("does not store errors, oversized/binary results, future timestamps or source-policy refusals", async () => {
    const f = await cacheFixture();
    await f.cache.put(scope(), { ...value(), isError: true }, f.now, 1000);
    await f.cache.put(scope(), value("x".repeat(256 * 1024)), f.now, 1000);
    await f.cache.put(scope(), { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }, f.now, 1000);
    await f.cache.put(scope(), value(), f.now + 1, 1000);
    expect(await f.cache.get(scope())).toBeUndefined();
    await f.cache.put(scope(), value(), f.now, 1000);
    await f.cache.put(scope(), { ...value(), isError: true }, f.now, 0);
    expect(await f.cache.get(scope())).toBeUndefined();
    await f.cache.put(scope(), value(), f.now, 999_999_999);
    expect((await f.cache.get(scope()))?.expiresAt).toBe(f.now + 86_400_000);
    f.advance(-1);
    expect(await f.cache.get(scope())).toBeUndefined();
  });

  it("discards corrupt derived JSON/schema instead of returning it as evidence", async () => {
    const f = await cacheFixture();
    for (const raw of [
      "bad JSON",
      JSON.stringify({ content: [], isError: true }),
      JSON.stringify({ content: [{ type: "script", text: "unsafe" }], isError: false }),
    ]) {
      await f.cache.put(scope(), value(), f.now, 1000);
      f.cache.close();
      await f.store.database.run("UPDATE pal_mcp_cache SET value = ?, bytes = ?", raw, Buffer.byteLength(raw));
      expect(await f.cache.get(scope())).toBeUndefined();
      expect(await f.store.database.get("SELECT count(*) AS n FROM pal_mcp_cache")).toEqual({ n: 0 });
    }
  });

  it("evicts least-recently used entries and keeps persistent payload/count bounds", async () => {
    const f = await cacheFixture();
    for (let i = 0; i < 513; i++) {
      await f.cache.put(scope(`key-${i}`), value(), f.now, 60_000);
      f.advance(1);
    }
    expect(await f.cache.get(scope("key-0"))).toBeUndefined();
    expect(await f.cache.get(scope("key-1"))).toBeDefined();
    f.advance(1);
    await f.cache.put(scope("newest"), value(), f.now, 60_000);
    expect(await f.cache.get(scope("key-2"))).toBeUndefined();
    expect(await f.cache.get(scope("key-1"))).toBeDefined();
    const totals = await f.store.database.get<{ n: number; bytes: number }>(
      "SELECT count(*) AS n, sum(bytes) AS bytes FROM pal_mcp_cache",
    );
    expect(totals?.n).toBe(512);
    expect(totals?.bytes).toBeLessThanOrEqual(128 * 1024 * 1024);
    await f.cache.clear("server");
    expect(await f.cache.get(scope("newest"))).toBeUndefined();
  });

  it("keeps only an 8 MiB RAM LRU and reloads an evicted value from SQLite", async () => {
    const f = await cacheFixture();
    for (let i = 0; i < 40; i++) await f.cache.put(scope(`large-${i}`), value("x".repeat(220 * 1024)), f.now, 1000);
    const read = vi.spyOn(f.store.database, "get");
    expect(await f.cache.get(scope("large-0"))).toBeDefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect(await f.cache.get(scope("large-39"))).toBeDefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("honors HTTP no-store/no-cache, age, expiry and stricter source TTLs", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00Z"));
    for (const headers of [
      { "cache-control": "no-store" },
      { "cache-control": 'private, no-cache="field"' },
      { pragma: "no-cache" },
      { vary: "*" },
      { "cache-control": "max-age=-1" },
      { "cache-control": "max-age=3600, max-age=1" },
      { "cache-control": "max-age=60", date: "Wed, 31 Dec 2025 23:59:00 GMT" },
      { age: "invalid" },
      { expires: "invalid" },
    ])
      expect.soft(responseCacheTtl(new Headers(headers), 300_000)).toBe(0);
    expect(responseCacheTtl(new Headers(), 300_000)).toBe(300_000);
    expect(responseCacheTtl(new Headers({ "cache-control": 'max-age="60"', age: "10" }), 300_000)).toBe(50_000);
    expect(responseCacheTtl(new Headers({ "cache-control": "max-age=3600" }), 300_000)).toBe(300_000);
    expect(
      responseCacheTtl(
        new Headers({ date: "Thu, 01 Jan 2026 00:00:00 GMT", expires: "Thu, 01 Jan 2026 00:01:00 GMT", age: "10" }),
        300_000,
      ),
    ).toBe(50_000);
  });
});

async function integration(preset = "exa") {
  const dataRoot = await temp();
  const f = await startCachedMcp(dataRoot, undefined, preset);
  cleanups.push(f.close);
  const project = await f.pal.projects.create("cached-project", { name: "Cache fixture" });
  let sequence = 0;
  const agent = async (projectId = project.id) => {
    const chat = await f.pal.chats.createChat(`cached-chat-${++sequence}`, { projectId }, context);
    const run = async (code = 'return await tools.mcp__exa__web_search_exa({query:"durable"});') => {
      const faux = fauxProvider();
      (f.pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
      const model = faux.getModel();
      const conversation = await f.pal.harness.conversation(chat.conversationId, context);
      if (conversation === undefined) throw new Error("missing cache conversation");
      await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      await f.pal.chats.submit(chat.id, `cached-input-${++sequence}`, { text: "exercise the scoped cache" }, context);
      await conversation.waitForIdle(context);
      const history = await conversation.context(context);
      const text =
        history.messages
          .findLast((message) => message.role === "toolResult")
          ?.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("") ?? "";
      const receipts = history.entries.flatMap((entry) =>
        entry.kind === "pal.mcp" ? [(entry.data as { mcp: McpReceipt }).mcp] : [],
      );
      return { text, history, receipt: receipts.at(-1), conversation };
    };
    return { chat, run };
  };
  return { f, project, agent };
}

describe("native Code Mode cache policy and provenance", () => {
  it("uses a one-day docs TTL, shortened by the service's response policy", async () => {
    const { f, agent } = await integration("context7");
    const a = await agent();
    const code = 'return await tools.mcp__context7__query_docs({query:"versioned docs"});';
    const first = await a.run(code);
    expect(first.text).toContain("Fixture durable source");
    const ttl = (first.receipt?.cache?.expiresAt ?? 0) - (first.receipt?.cache?.fetchedAt ?? 0);
    expect(ttl).toBeGreaterThan(86_398_000);
    expect(ttl).toBeLessThanOrEqual(86_400_000);
    expect((await a.run(code)).receipt?.cache?.hit).toBe(true);
    expect(f.fixture.calls).toHaveLength(1);
    f.fixture.state.headers = { "cache-control": "max-age=60", age: "10" };
    const shorter = await a.run(code);
    expect(shorter.receipt?.cache?.expiresAt).toBe((first.receipt?.cache?.fetchedAt ?? 0) + 50_000);
    expect(shorter.receipt?.cache?.hit).toBe(true);
    f.fixture.state.headers = { "cache-control": "no-cache" };
    expect((await a.run(code)).receipt?.cache?.hit).toBe(false);
    expect(f.fixture.calls).toHaveLength(2);
  });

  it("caches reviewed reads across chats/reopen, keeps original freshness and informs the model", async () => {
    const { f, agent } = await integration();
    const a = await agent();
    const first = await a.run();
    expect(first.text).toContain("Fixture durable source");
    expect(first.receipt?.cache).toMatchObject({ hit: false, bypassed: false });
    const second = await a.run();
    expect(second.receipt?.cache).toMatchObject({ hit: true, fetchedAt: first.receipt?.cache?.fetchedAt });
    expect(f.fixture.calls).toHaveLength(1);
    expect(JSON.stringify(second.history)).toContain("mcp__exa__web_search_exa: Pal cache hit");
    expect((await f.pal.harness.snapshot(McpProvenance, a.chat.conversationId, context))?.lookups.at(-1)?.hit).toBe(
      true,
    );
    expect((await (await agent()).run()).receipt?.cache?.hit).toBe(true);
    await f.reopen();
    expect((await a.run()).receipt?.cache?.hit).toBe(true);
    expect(f.fixture.calls).toHaveLength(1);
    expect(
      (await a.run('return await tools.mcp__exa__web_search_exa({objective:"durable",query:"durable"});')).receipt
        ?.cache?.hit,
    ).toBe(true);
    for (let i = 0; i < 6; i++) await a.run();
    expect((await f.pal.harness.snapshot(McpProvenance, a.chat.conversationId, context))?.lookups).toHaveLength(6);
    const live = await a.run('return await tools.mcp__exa__web_search_exa({query:"durable",_pal_freshness:"live"});');
    expect(live.receipt?.cache).toMatchObject({ hit: false, bypassed: true });
    expect(f.fixture.calls).toHaveLength(2);
    expect(f.fixture.calls.at(-1)?.arguments).toEqual({ query: "durable", objective: "durable" });
  });

  it("isolates projects, tool/schema/credential revisions and does not leak echoed keys into cache/history", async () => {
    const { f, agent, project } = await integration();
    const a = await agent();
    await a.run();
    const other = await f.pal.projects.create("other-cache-project", { name: "Other" });
    expect((await (await agent(other.id)).run()).receipt?.cache?.hit).toBe(false);
    expect(f.fixture.calls).toHaveLength(2);
    let grant = (await f.pal.mcp.grants.view(project.id)).servers.find((server) => server.id === "exa");
    if (grant === undefined) throw new Error("missing cache grant");
    await f.pal.mcp.grants.set(project.id, "exa", { revision: grant.revision, mode: "subset", tools: [] });
    expect((await a.run()).text).not.toContain("Fixture durable source");
    grant = (await f.pal.mcp.grants.view(project.id)).servers.find((server) => server.id === "exa");
    if (grant === undefined) throw new Error("missing revised cache grant");
    await f.pal.mcp.grants.set(project.id, "exa", { revision: grant.revision, mode: "inherit", tools: [] });
    expect((await a.run()).receipt?.cache?.hit).toBe(false);
    expect(f.fixture.calls).toHaveLength(3);
    await f.pal.mcp.setKey("exa", "fixture-cache-dedicated-key");
    f.fixture.state.result = {
      content: [{ type: "text", text: "fixture-cache-dedicated-key" }],
      structuredContent: {
        results: [{ url: "https://fixture.invalid/cached", title: "fixture-cache-dedicated-key", score: 1 }],
      },
    };
    const secret = await a.run();
    expect(secret.receipt?.cache?.hit).toBe(false);
    expect(secret.text).toContain("[redacted]");
    expect(JSON.stringify(secret.history)).not.toContain("fixture-cache-dedicated-key");
    expect(JSON.stringify(await f.pal.store.database.all("SELECT value FROM pal_mcp_cache"))).not.toContain(
      "fixture-cache-dedicated-key",
    );
    const tool = f.fixture.state.tools[0];
    if (tool === undefined) throw new Error("missing fixture tool");
    tool.description = "Changed approved definition";
    expect((await a.run()).text).toMatch(/changed/);
    expect((await f.pal.mcp.get("exa")).state).toBe("changed");
    await f.pal.mcp.test("exa");
    await f.pal.mcp.approve("exa", ["web_search_exa"], (await f.pal.mcp.get("exa")).catalog);
    expect((await a.run()).receipt?.cache?.hit).toBe(false);
    expect(f.fixture.calls).toHaveLength(5);
  });

  it("never caches generic/unknown tools, errors or no-store responses, and bypasses stale entries", async () => {
    const { f, agent } = await integration();
    const a = await agent();
    f.fixture.state.result = { content: [{ type: "text", text: "expected error" }], isError: true };
    await a.run();
    await a.run();
    expect(f.fixture.calls).toHaveLength(2);
    f.fixture.state.result = {
      content: [{ type: "text", text: "fresh" }],
      structuredContent: { results: [{ url: "https://fixture.invalid/current", title: "fresh", score: 1 }] },
    };
    f.fixture.state.headers = { "cache-control": "no-store" };
    await a.run();
    await a.run();
    expect(f.fixture.calls).toHaveLength(4);
    f.fixture.state.headers = {};
    await a.run();
    await f.reopen();
    await f.pal.store.database.run(
      "UPDATE pal_mcp_cache SET fetched_at = ?, expires_at = ?",
      Date.now() - 600_000,
      Date.now() - 1,
    );
    expect((await a.run()).receipt?.cache?.hit).toBe(false);
    const custom = await f.pal.mcp.add({ name: "Generic", url: f.fixture.url, auth: { kind: "none" }, private: true });
    await f.pal.mcp.test(custom.id);
    await f.pal.mcp.approve(custom.id, ["web_search_exa"], (await f.pal.mcp.get(custom.id)).catalog);
    await f.pal.mcp.setEnabled(custom.id, true);
    const code = `return await tools.mcp__${custom.id}__web_search_exa({query:"durable"});`;
    expect((await a.run(code)).receipt?.cache).toBeUndefined();
    await a.run(code);
    expect(f.fixture.calls).toHaveLength(8);
    await f.pal.mcp.approve("exa", ["web_search_exa", "delete_everything"], (await f.pal.mcp.get("exa")).catalog);
    const unknown = "return await tools.mcp__exa__delete_everything({});";
    expect((await a.run(unknown)).receipt?.cache).toBeUndefined();
    await a.run(unknown);
    expect(f.fixture.calls).toHaveLength(10);
    expect(f.fixture.calls.slice(-2).map((call) => call.name)).toEqual(["delete_everything", "delete_everything"]);
  });

  it("drops a cached result if credentials change during cache I/O, and cannot revive it after disable/re-enable", async () => {
    const { f, agent } = await integration();
    const a = await agent();
    await a.run();
    const get = McpQueryCache.prototype.get;
    let armed = true;
    vi.spyOn(McpQueryCache.prototype, "get").mockImplementation(async function (this: McpQueryCache, scope) {
      const hit = await get.call(this, scope);
      if (armed && hit !== undefined) {
        armed = false;
        await f.pal.mcp.setKey("exa", "fixture-new-cache-key");
      }
      return hit;
    });
    const result = await a.run(
      'try { return await tools.mcp__exa__web_search_exa({query:"durable"}); } catch (e) { return "error: " + String(e); }',
    );
    expect(result.text).toMatch(/changed|aborted/);
    expect(result.text).not.toContain("Fixture durable source");
    expect(f.fixture.calls).toHaveLength(1);
    await a.run();
    await f.pal.mcp.setEnabled("exa", false);
    await f.pal.mcp.setEnabled("exa", true);
    expect((await a.run()).receipt?.cache?.hit).toBe(false);
    expect(f.fixture.calls).toHaveLength(3);
  });

  it("rechecks cache-hit authority after the durable provenance receipt", async () => {
    const { f, agent } = await integration();
    const a = await agent();
    await a.run();
    const commit = f.pal.store.storage.commit.bind(f.pal.store.storage);
    let armed = true;
    vi.spyOn(f.pal.store.storage, "commit").mockImplementation(async (writes, ctx) => {
      const seq = await commit(writes, ctx);
      if (armed && writes.some((write) => write.type === "entry" && write.value.kind === "pal.mcp")) {
        armed = false;
        await f.pal.mcp.setEnabled("exa", false);
      }
      return seq;
    });
    const result = await a.run(
      'try { return await tools.mcp__exa__web_search_exa({query:"durable"}); } catch (e) { return "error: " + String(e); }',
    );
    expect(armed).toBe(false);
    expect(result.text).toMatch(/changed|aborted/);
    expect(result.text).not.toContain("Fixture durable source");
    expect(f.fixture.calls).toHaveLength(1);
  });

  it("rechecks cache-hit authority after async client cleanup", async () => {
    const { f, agent } = await integration();
    const a = await agent();
    await a.run();
    const close = McpClient.prototype.close;
    let armed = true;
    vi.spyOn(McpClient.prototype, "close").mockImplementation(async function (this: McpClient) {
      await close.call(this);
      if (armed) {
        armed = false;
        await f.pal.mcp.setEnabled("exa", false);
      }
    });
    const result = await a.run(
      'try { return await tools.mcp__exa__web_search_exa({query:"durable"}); } catch (e) { return "error: " + String(e); }',
    );
    expect(result.text).toMatch(/changed|aborted/);
    expect(result.text).not.toContain("Fixture durable source");
    expect(f.fixture.calls).toHaveLength(1);
  });
});
