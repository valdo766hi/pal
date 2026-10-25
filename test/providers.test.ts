import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../src/core/api.ts";
import { openPal, type Pal } from "../src/core/app.ts";
import { startServer } from "../src/core/server.ts";
import { apiKeyProvider } from "../src/pi/providers.ts";
import { startOpenAIFixture } from "./fixtures/openai-server.ts";
import { GOOD_KEY as GOOD, startProviderFixture } from "./fixtures/provider-server.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const OPENROUTER_MODEL = "~deepseek/deepseek-flash-latest";

async function setup() {
  const chatgpt = await startOpenAIFixture();
  cleanups.push(chatgpt.close);
  const provider = await startProviderFixture();
  cleanups.push(provider.close);
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-providers-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const open = () =>
    openPal(
      { dataRoot, installRoot: "/nonexistent-install", endpoints: chatgpt.endpoints, providerOrigin: provider.origin },
      context,
    );
  let pal: Pal = await open();
  cleanups.push(() => pal.close());
  let server = await serve(pal);
  let session = "";
  const api = async (method: string, path: string, body?: unknown, origin?: string) => {
    const response = await fetch(`${server.base}/api/${path}`, {
      method,
      headers: {
        origin: origin ?? server.base,
        cookie: session,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie !== null) session = cookie.split(";")[0] ?? "";
    const text = await response.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  await api("POST", "setup", { token: pal.owner.setupToken, passphrase: "correct horse battery" });
  const project = await pal.projects.create("provider-project", { name: "Providers" });
  let inputs = 0;
  /** Send a message and wait for its run; returns the run's last assistant message. */
  const send = async (chatId: string, text = "hello") => {
    const sent = await api("POST", `chats/${chatId}/inputs`, { requestId: `provider-input-${++inputs}`, text });
    if (sent.status !== 200) return { status: sent.status, error: sent.body.error as string };
    const chat = await pal.chats.get(chatId);
    const conversation = chat === undefined ? undefined : await pal.harness.conversation(chat.conversationId, context);
    await conversation?.waitForIdle(context);
    // Failed responses stay in the transcript but not in model context, so read entries.
    const entries = (await conversation?.context(context))?.entries ?? [];
    const last = entries.findLast((entry) => entry.kind === "pi.assistant")?.model?.[0];
    return { status: sent.status, message: last?.role === "assistant" ? last : undefined };
  };
  const chat = async (key: string) => (await pal.chats.createChat(key, { projectId: project.id }, context)).id;
  return {
    chatgpt,
    provider,
    api,
    send,
    chat,
    get pal() {
      return pal;
    },
    reopen: async () => {
      server.close();
      await pal.close();
      pal = await open();
      server = await serve(pal);
      return pal;
    },
  };
}

async function serve(pal: Pal) {
  const server = await startServer({ host: "127.0.0.1", port: 0, version: "test", api: createApi(pal) });
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  cleanups.push(close);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
}

describe("API-key model providers", () => {
  it("never resolves an ambient environment key, only the key saved in Pal", async () => {
    const credentials = new InMemoryCredentialStore();
    const models = createModels({
      credentials,
      authContext: { env: async () => "sk-ambient", fileExists: async () => false },
    });
    models.setProvider(apiKeyProvider("openrouter"));
    models.setProvider(apiKeyProvider("deepseek"));
    expect(await models.getAuth("openrouter")).toBeUndefined();
    expect(await models.getAuth("deepseek")).toBeUndefined();
    await credentials.modify("openrouter", async () => ({ type: "api_key", key: GOOD }));
    expect(await models.getAuth("openrouter")).toMatchObject({ auth: { apiKey: GOOD }, source: "stored credential" });
    expect(models.getProvider("openrouter")?.auth.oauth).toBeUndefined();
  });

  it("stays off until the owner saves and enables a key, and removal disables it", async () => {
    const { pal, api } = await setup();
    const view = await api("GET", "providers");
    expect(view.body.providers.map((entry: { id: string }) => entry.id)).toEqual([
      "openrouter",
      "opencode",
      "opencode-go",
      "openai-api",
      "anthropic",
      "deepseek",
      "compatible",
    ]);
    expect(
      view.body.providers.every((entry: { enabled: boolean; hasKey: boolean }) => !entry.enabled && !entry.hasKey),
    ).toBe(true);
    expect(pal.models.getProvider("openrouter")).toBeUndefined();
    expect((await api("PUT", "providers/openrouter/enabled", { enabled: true })).body.error).toBe("provider_config");
    expect((await api("PUT", "providers/openrouter/key", { key: "short" })).body.error).toBe("provider_config");
    expect((await api("PUT", "providers/openrouter/key", { key: GOOD }, "http://evil.example")).status).toBe(403);
    const saved = await api("PUT", "providers/openrouter/key", { key: ` ${GOOD} ` });
    expect(saved.text).not.toContain(GOOD);
    expect(saved.body.providers[0]).toMatchObject({ hasKey: true, enabled: false, models: [] });
    expect(pal.models.getProvider("openrouter")).toBeUndefined();
    const enabled = await api("PUT", "providers/openrouter/enabled", { enabled: true });
    expect(enabled.text).not.toContain(GOOD);
    expect(enabled.body.providers[0].models.some((model: { id: string }) => model.id === OPENROUTER_MODEL)).toBe(true);
    expect((await api("PUT", "providers/unknown/enabled", { enabled: true })).status).toBe(404);
    const removed = await api("DELETE", "providers/openrouter/key");
    expect(removed.body.providers[0]).toMatchObject({ hasKey: false, enabled: false });
    expect(pal.models.getProvider("openrouter")).toBeUndefined();
  });

  it("checks an OpenRouter key without a model request and says OpenCode has no such check", async () => {
    const { api, provider } = await setup();
    await api("PUT", "providers/openrouter/key", { key: GOOD });
    expect((await api("POST", "providers/openrouter/check")).body.check).toMatchObject({ ok: true });
    await api("PUT", "providers/openrouter/key", { key: "sk-or-fixture-revoked" });
    expect((await api("POST", "providers/openrouter/check")).body.check).toMatchObject({
      ok: false,
      detail: "OpenRouter rejected this key.",
    });
    await api("PUT", "providers/opencode/key", { key: "sk-opencode-fixture" });
    expect((await api("POST", "providers/opencode/check")).body.check).toMatchObject({ ok: false });
    expect(provider.requests.every((request) => request.path === "/api/v1/key")).toBe(true);
    await provider.close();
    expect((await api("POST", "providers/openrouter/check")).body.check).toEqual({
      ok: false,
      detail: "Pal couldn't reach OpenRouter to check this key.",
    });
  });

  it("sends a chat only to the provider the owner chose, with the current key, and never falls back", async () => {
    const fixture = await setup();
    const { api, send, provider, chatgpt } = fixture;
    const chatId = await fixture.chat("provider-chat");
    expect(
      (await api("PUT", `chats/${chatId}/model`, { provider: "openrouter", model: OPENROUTER_MODEL })).body.error,
    ).toBe("provider_unavailable");
    await api("PUT", "providers/openrouter/key", { key: GOOD });
    await api("PUT", "providers/openrouter/enabled", { enabled: true });
    expect(
      (await api("PUT", `chats/${chatId}/model`, { provider: "openrouter", model: "no/such-model" })).body.error,
    ).toBe("unknown_model");
    const switched = await api("PUT", `chats/${chatId}/model`, { provider: "openrouter", model: OPENROUTER_MODEL });
    expect(switched.body).toMatchObject({ provider: "openrouter", model: OPENROUTER_MODEL });
    const first = await send(chatId);
    expect(JSON.stringify(first.message?.content)).toContain("Hello from the provider fixture");
    expect(provider.requests.at(-1)).toMatchObject({ path: "/api/v1/chat/completions" });
    expect(provider.requests.at(-1)?.headers.authorization).toBe(`Bearer ${GOOD}`);

    await api("PUT", "providers/openrouter/key", { key: "sk-or-fixture-rotated" });
    await send(chatId);
    expect(provider.requests.at(-1)?.headers.authorization).toBe("Bearer sk-or-fixture-rotated");

    const before = provider.requests.length;
    await api("PUT", "providers/openrouter/enabled", { enabled: false });
    expect(await send(chatId)).toMatchObject({ status: 409, error: "provider_unavailable" });
    expect(provider.requests.length).toBe(before);

    await api("PUT", "providers/openrouter/enabled", { enabled: true });
    provider.behavior.reject = true;
    const failed = await send(chatId);
    expect(failed.message?.stopReason).toBe("error");
    expect(failed.message?.errorMessage).toContain("invalid key Bearer [redacted key]");
    expect(JSON.stringify(failed.message)).not.toContain("sk-or-fixture-rotated");
    const history = JSON.stringify((await api("GET", `chats/${chatId}`)).body);
    expect(history).not.toContain("sk-or-fixture-rotated");
    expect(chatgpt.apiRequests.filter((request) => request.path === "/v1/responses")).toEqual([]);

    provider.behavior.reject = false;
    const reopened = await fixture.reopen();
    expect((await reopened.providers.list())[0]).toMatchObject({ id: "openrouter", hasKey: true, enabled: true });
    expect((await api("GET", `chats/${chatId}`)).body).toMatchObject({
      provider: "openrouter",
      model: OPENROUTER_MODEL,
    });
    expect((await send(chatId)).status).toBe(200);
    expect(provider.requests.at(-1)?.headers.authorization).toBe("Bearer sk-or-fixture-rotated");
  });

  it("routes OpenCode Zen and Go to their own endpoints with the session header", async () => {
    const fixture = await setup();
    const { api, send, provider } = fixture;
    for (const id of ["opencode", "opencode-go"]) {
      await api("PUT", `providers/${id}/key`, { key: "sk-opencode-fixture" });
      await api("PUT", `providers/${id}/enabled`, { enabled: true });
      const chatId = await fixture.chat(`opencode-chat-${id}`);
      expect((await api("PUT", `chats/${chatId}/model`, { provider: id, model: "glm-5.3" })).status).toBe(200);
      expect((await send(chatId)).status).toBe(200);
      const request = provider.requests.at(-1);
      expect(request?.path).toBe(
        id === "opencode" ? "/inference/v1/chat/completions" : "/inference/go/v1/chat/completions",
      );
      expect(request?.headers.authorization).toBe("Bearer sk-opencode-fixture");
      expect(request?.headers["x-opencode-session"]).toEqual(expect.any(String));
    }
  });

  it("routes OpenAI API and Anthropic API keys to their own endpoints, apart from the ChatGPT subscription", async () => {
    const fixture = await setup();
    const { api, send, provider, chatgpt } = fixture;
    for (const [id, model, path] of [
      ["openai-api", "gpt-4.1", "/v1/responses"],
      ["anthropic", "claude-haiku-4-5", "/v1/messages"],
    ] as const) {
      await api("PUT", `providers/${id}/key`, { key: "sk-fixture-rejected" });
      expect((await api("POST", `providers/${id}/check`)).body.check).toMatchObject({ ok: false });
      await api("PUT", `providers/${id}/key`, { key: GOOD });
      expect((await api("POST", `providers/${id}/check`)).body.check).toMatchObject({ ok: true });
      await api("PUT", `providers/${id}/enabled`, { enabled: true });
      const chatId = await fixture.chat(`api-key-chat-${id}`);
      expect((await api("PUT", `chats/${chatId}/model`, { provider: id, model })).body).toMatchObject({
        provider: id,
        model,
      });
      const sent = await send(chatId);
      expect(JSON.stringify(sent.message?.content)).toContain("Hello from the provider fixture");
      const request = provider.requests.at(-1);
      expect(request?.path).toBe(path);
      if (id === "anthropic") expect(request?.headers["x-api-key"]).toBe(GOOD);
      else expect(request?.headers.authorization).toBe(`Bearer ${GOOD}`);
    }
    // The OpenAI API key is its own provider: ChatGPT stays signed out and its fixture saw no model request.
    expect(await fixture.pal.chatgpt.account()).toBeUndefined();
    expect(
      fixture.pal.models
        .getProvider("openai-api")
        ?.getModels()
        .every((model) => model.provider === "openai-api"),
    ).toBe(true);
    expect(chatgpt.apiRequests.filter((request) => request.path === "/v1/responses")).toEqual([]);
  });

  it("checks a DeepSeek API key against its balance and chats on DeepSeek's own endpoint", async () => {
    const fixture = await setup();
    const { api, send, provider, chatgpt } = fixture;
    await api("PUT", "providers/deepseek/key", { key: "sk-fixture-rejected" });
    expect((await api("POST", "providers/deepseek/check")).body.check).toEqual({
      ok: false,
      detail: "DeepSeek API rejected this key.",
    });
    await api("PUT", "providers/deepseek/key", { key: GOOD });
    expect((await api("POST", "providers/deepseek/check")).body.check).toEqual({
      ok: true,
      detail: "DeepSeek API accepted this key. Balance: 4.20 USD.",
    });
    expect(provider.requests.map((request) => request.path)).toEqual(["/user/balance", "/user/balance"]);
    const enabled = await api("PUT", "providers/deepseek/enabled", { enabled: true });
    const deepseek = enabled.body.providers.find((entry: { id: string }) => entry.id === "deepseek");
    expect(deepseek).toMatchObject({ name: "DeepSeek API", hasKey: true, enabled: true, checkable: true });
    expect(deepseek.models.map((model: { id: string }) => model.id)).toEqual(
      expect.arrayContaining(["deepseek-flash", "deepseek-v4-pro"]),
    );
    const chatId = await fixture.chat("deepseek-chat");
    expect(
      (await api("PUT", `chats/${chatId}/model`, { provider: "deepseek", model: "deepseek-flash", effort: "high" }))
        .body,
    ).toMatchObject({ provider: "deepseek", model: "deepseek-flash", effort: "high" });
    const sent = await send(chatId);
    expect(JSON.stringify(sent.message?.content)).toContain("Hello from the provider fixture");
    const request = provider.requests.at(-1);
    // The reasoning level reaches DeepSeek in its own thinking format.
    expect(request).toMatchObject({
      path: "/chat/completions",
      body: { model: "deepseek-flash", thinking: { type: "enabled" }, reasoning_effort: "high" },
    });
    expect(request?.headers.authorization).toBe(`Bearer ${GOOD}`);
    expect(chatgpt.apiRequests).toEqual([]);
  });

  it("describes an OpenAI-compatible endpoint, keyless or keyed, and refuses models it no longer offers", async () => {
    const fixture = await setup();
    const { api, send, provider } = fixture;
    const endpoint = {
      name: "Local models",
      baseUrl: `${provider.origin}/compat/v1/`,
      models: ["local-a", "local-b", "local-a"],
      contextWindow: 32_768,
      maxTokens: 4096,
      images: false,
      keyless: true,
    };
    for (const bad of [
      { baseUrl: "ftp://models.example/v1" },
      { baseUrl: "http://user:secret@models.example/v1" },
      { baseUrl: "http://models.example/v1?key=secret" },
      { maxTokens: 65_536 },
    ]) {
      expect((await api("PUT", "providers/compatible/config", { ...endpoint, ...bad })).body.error).toBe(
        "provider_config",
      );
    }
    expect((await api("PUT", "providers/compatible/enabled", { enabled: true })).body.error).toBe("provider_config");
    const saved = await api("PUT", "providers/compatible/config", endpoint);
    const compatible = () => saved.body.providers.find((entry: { id: string }) => entry.id === "compatible");
    expect(compatible().config).toMatchObject({
      baseUrl: `${provider.origin}/compat/v1`,
      models: ["local-a", "local-b"],
    });
    const enabled = await api("PUT", "providers/compatible/enabled", { enabled: true });
    expect(enabled.body.providers.at(-1)).toMatchObject({ name: "Local models", enabled: true });
    expect(enabled.body.providers.at(-1).models.map((model: { id: string }) => model.id)).toEqual([
      "local-a",
      "local-b",
    ]);
    expect((await api("POST", "providers/compatible/check")).body.check).toMatchObject({ ok: true });
    const chatId = await fixture.chat("compatible-chat");
    expect((await api("PUT", `chats/${chatId}/model`, { provider: "compatible", model: "local-a" })).status).toBe(200);
    expect((await send(chatId)).status).toBe(200);
    expect(provider.requests.at(-1)?.path).toBe("/compat/v1/chat/completions");

    // Requiring a key without one saved disables the endpoint until a key arrives.
    const keyed = await api("PUT", "providers/compatible/config", { ...endpoint, keyless: false });
    expect(keyed.body.providers.at(-1)).toMatchObject({ enabled: false, hasKey: false });
    expect(await send(chatId)).toMatchObject({ status: 409, error: "provider_unavailable" });
    await api("PUT", "providers/compatible/key", { key: GOOD });
    await api("PUT", "providers/compatible/enabled", { enabled: true });
    expect((await send(chatId)).status).toBe(200);
    expect(provider.requests.at(-1)?.headers.authorization).toBe(`Bearer ${GOOD}`);

    await api("PUT", "providers/compatible/config", { ...endpoint, keyless: false, models: ["local-b"] });
    expect(await send(chatId)).toMatchObject({ status: 409, error: "model_unavailable" });

    // A corrupt stored description leaves the endpoint unusable after restart instead of stopping Pal.
    await fixture.pal.store.database.run(
      "UPDATE pal_settings SET value = '{not json' WHERE key = 'provider:compatible:config'",
    );
    const reopened = await fixture.reopen();
    expect((await reopened.providers.list()).at(-1)).toMatchObject({ enabled: false, config: null });
    expect(await send(chatId)).toMatchObject({ status: 409, error: "provider_unavailable" });
  });

  it("binds the compatible endpoint's key and enablement to its destination", async () => {
    const fixture = await setup();
    const { api, send, provider } = fixture;
    const other = await startProviderFixture();
    cleanups.push(other.close);
    const endpoint = {
      name: "Local models",
      baseUrl: `${provider.origin}/compat/v1`,
      models: ["local-a"],
      contextWindow: 32_768,
      maxTokens: 4096,
      images: false,
      keyless: false,
    };
    const state = async () =>
      (await api("GET", "providers")).body.providers.find((entry: { id: string }) => entry.id === "compatible");
    await api("PUT", "providers/compatible/config", endpoint);
    await api("PUT", "providers/compatible/key", { key: GOOD });
    await api("PUT", "providers/compatible/enabled", { enabled: true });
    const chatId = await fixture.chat("compatible-destination");
    await api("PUT", `chats/${chatId}/model`, { provider: "compatible", model: "local-a" });

    // The same destination, however written, and edits that do not move it keep the key and the consent.
    for (const baseUrl of [`${provider.origin}/compat/v1/`, `${provider.origin.toUpperCase()}/compat/v1//`]) {
      await api("PUT", "providers/compatible/config", { ...endpoint, baseUrl, name: "Renamed", models: ["local-a"] });
      expect(await state(), baseUrl).toMatchObject({ enabled: true, hasKey: true, name: "Renamed" });
    }
    expect((await send(chatId)).status).toBe(200);

    // Another origin, or another path on the same origin, is a new destination: off, and without the old key.
    for (const baseUrl of [`${other.origin}/compat/v1`, `${provider.origin}/elsewhere/v1`]) {
      await api("PUT", "providers/compatible/config", { ...endpoint, baseUrl });
      expect(await state(), baseUrl).toMatchObject({ enabled: false, hasKey: false });
      expect(await send(chatId)).toMatchObject({ status: 409, error: "provider_unavailable" });
      expect((await api("POST", "providers/compatible/check")).body.error, baseUrl).toBe("provider_config");
      expect((await api("PUT", "providers/compatible/enabled", { enabled: true })).body.error).toBe("provider_config");
      // Back to the approved destination: it still needs its key saved and enabling again.
      await api("PUT", "providers/compatible/config", { ...endpoint, baseUrl: `${provider.origin}/compat/v1` });
      await api("PUT", "providers/compatible/key", { key: GOOD });
      await api("PUT", "providers/compatible/enabled", { enabled: true });
    }
    expect(other.requests).toEqual([]);

    // A keyless endpoint needs no key at its new destination, only the owner's explicit enablement.
    await api("PUT", "providers/compatible/config", { ...endpoint, keyless: true });
    await api("PUT", "providers/compatible/config", {
      ...endpoint,
      keyless: true,
      baseUrl: `${other.origin}/compat/v1`,
    });
    expect(await state()).toMatchObject({ enabled: false });
    expect((await api("PUT", "providers/compatible/enabled", { enabled: true })).status).toBe(200);
    expect((await send(chatId)).status).toBe(200);
    // A keyless endpoint gets the placeholder; the key saved for the earlier destination never reaches this one.
    expect(other.requests.map((request) => request.headers.authorization)).not.toContain(`Bearer ${GOOD}`);
  });

  it("starts new chats on the owner's chosen default provider model", async () => {
    const fixture = await setup();
    const { api } = fixture;
    expect((await api("PUT", "default-model", { provider: "openrouter", model: OPENROUTER_MODEL })).body.error).toBe(
      "provider_unavailable",
    );
    await api("PUT", "providers/openrouter/key", { key: GOOD });
    await api("PUT", "providers/openrouter/enabled", { enabled: true });
    const chosen = await api("PUT", "default-model", { provider: "openrouter", model: OPENROUTER_MODEL });
    expect(chosen.body.default).toEqual({ provider: "openrouter", modelId: OPENROUTER_MODEL });
    const chatId = await fixture.chat("default-provider-chat");
    expect((await api("GET", `chats/${chatId}`)).body).toMatchObject({
      provider: "openrouter",
      model: OPENROUTER_MODEL,
    });
    expect((await api("GET", "providers")).status).toBe(200);

    // Without any ChatGPT account the choice survives a restart, and revoking the provider keeps it instead of
    // substituting another model.
    await fixture.reopen();
    const expected = { provider: "openrouter", modelId: OPENROUTER_MODEL };
    expect((await api("GET", "providers")).body.default).toEqual(expected);
    expect((await api("GET", "chatgpt")).body).toMatchObject({ account: null, default: expected });
    await api("PUT", "providers/openrouter/enabled", { enabled: false });
    expect((await api("GET", "chatgpt")).body.default).toEqual(expected);
    const later = await fixture.chat("default-after-revoke");
    expect((await api("GET", `chats/${later}`)).body).toMatchObject({ provider: "openrouter" });
    expect(await fixture.send(later)).toMatchObject({ status: 409, error: "provider_unavailable" });
    expect([fixture.chatgpt.authorizations, fixture.chatgpt.tokenRequests, fixture.chatgpt.apiRequests]).toEqual([
      [],
      [],
      [],
    ]);
  });
});
