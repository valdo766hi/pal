import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHATGPT_PROVIDER,
  ChatGPTConnection,
  type ChatGPTCredential,
  type ChatGPTEndpoints,
  chatGPTProvider,
  classifyChatGPTError,
  listChatGPTModels,
  refreshChatGPT,
} from "../src/pi/chatgpt.ts";
import { loadMasterKey, SqliteCredentialStore } from "../src/storage/credentials.ts";
import { openStore } from "../src/storage/store.ts";
import { browse, DIRECT_SCOPE, startOpenAIFixture } from "./fixtures/openai-server.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(endpoints?: (fixture: ChatGPTEndpoints) => ChatGPTEndpoints) {
  const fixture = await startOpenAIFixture();
  cleanups.push(fixture.close);
  const dataRoot = await mkdtemp(join(tmpdir(), "pal-chatgpt-test-"));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  cleanups.push(() => store.close());
  const keyPath = join(dataRoot, "credentials.key");
  const credentials = new SqliteCredentialStore(store.database, await loadMasterKey(keyPath), store.installationId);
  const configured = endpoints?.(fixture.endpoints) ?? fixture.endpoints;
  const connection = new ChatGPTConnection(credentials, {
    endpoints: configured,
    installationId: store.installationId,
    agentName: "Pal",
  });
  const models = createModels({ credentials });
  models.setProvider(chatGPTProvider(configured));
  return { fixture, dataRoot, keyPath, store, credentials, connection, models };
}

/** The owner's side of one sign-in: the browser link it is shown, and optionally an address it pastes back. */
function owner(paste?: (authUrl: URL) => string | Promise<string>) {
  const controller = new AbortController();
  let announce: (url: string) => void = () => {};
  const authUrl = new Promise<string>((resolve) => (announce = resolve));
  const interaction: ProviderAuthInteraction = {
    signal: controller.signal,
    notify: (event) => {
      if (event.type === "auth_url") announce(event.url);
    },
    prompt: (prompt) =>
      new Promise((resolve, reject) => {
        if (paste !== undefined) void authUrl.then((url) => paste(new URL(url))).then(resolve, reject);
        prompt.signal?.addEventListener("abort", () => reject(new Error("prompt closed")), { once: true });
      }),
  };
  return { interaction, authUrl, cancel: () => controller.abort() };
}

/** Start a sign-in and complete it in the "browser"; the returned promise is already guarded against unhandled rejection. */
async function signIn(connection: ChatGPTConnection) {
  const { interaction, authUrl } = owner();
  const result = connection.signIn(interaction);
  result.catch(() => {});
  const url = new URL(await authUrl);
  const callback = await browse(url.toString());
  return { result, url, callback };
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const ask = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

describe("Sign in with ChatGPT", () => {
  it("registers a new client and stores the verified account's credential encrypted", async () => {
    const { fixture, dataRoot, keyPath, store, credentials, connection } = await setup();
    const { result, url, callback } = await signIn(connection);
    expect(callback.status).toBe(200);
    expect(await result).toEqual({ accountId: "user-1", email: "owner@example.test" });

    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      response_type: "code",
      client_id: "dynamic_agent_client",
      agent_name_hint: "Pal",
      ext_agent_host_id: `urn:uuid:${store.installationId}`,
      scope: DIRECT_SCOPE,
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
    });
    expect(params.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(params.state).toHaveLength(43);
    expect(params.nonce).toHaveLength(43);
    const exchange = Object.fromEntries(fixture.tokenRequests[0] ?? []);
    expect(exchange).toMatchObject({ client_id: "oaiapp_fixture", redirect_uri: params.redirect_uri });

    const stored = (await credentials.read(CHATGPT_PROVIDER)) as ChatGPTCredential;
    expect(stored).toMatchObject({
      type: "oauth",
      clientId: "oaiapp_fixture",
      accountId: "user-1",
      access: "access-2",
    });
    expect(stored.scopes).toContain("chatgpt.tokens.use.direct");
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);

    await store.close();
    for (const file of ["pal.sqlite", "pal.sqlite-wal"]) {
      const bytes = await readFile(join(dataRoot, file)).catch(() => Buffer.alloc(0));
      for (const secret of [stored.access, stored.refresh, stored.idToken]) expect(bytes.includes(secret)).toBe(false);
    }
    const reopened = await openStore(dataRoot);
    cleanups.push(() => reopened.close());
    const wrongKey = new SqliteCredentialStore(reopened.database, Buffer.alloc(32, 7), reopened.installationId);
    await expect(wrongKey.read(CHATGPT_PROVIDER)).rejects.toThrow();
    await chmod(keyPath, 0o644);
    await expect(loadMasterKey(keyPath)).rejects.toThrow(/chmod 600/);
  });

  it("returns to the saved registration after sign-out and refuses another account", async () => {
    const { fixture, credentials, connection } = await setup();
    await (
      await signIn(connection)
    ).result;
    await connection.signOut();
    expect(await credentials.read(CHATGPT_PROVIDER)).toBeUndefined();

    // Reauthorization may omit the client ID; the saved one is used.
    fixture.behavior.callback = "omit_client";
    const returning = await signIn(connection);
    await returning.result;
    const params = Object.fromEntries(returning.url.searchParams);
    expect(params).toMatchObject({ client_id: "oaiapp_fixture", login_hint: "owner@example.test" });
    expect(params).not.toHaveProperty("agent_name_hint");
    // Signed out in between, so no ID-token hint.
    expect(params).not.toHaveProperty("id_token_hint");

    // While signed in, the hint is the last verified ID token.
    const { idToken } = (await credentials.read(CHATGPT_PROVIDER)) as ChatGPTCredential;
    const hinted = await signIn(connection);
    await hinted.result;
    expect(hinted.url.searchParams.get("id_token_hint")).toBe(idToken);

    const before = await credentials.read(CHATGPT_PROVIDER);
    fixture.behavior.callback = "other_client";
    await expect((await signIn(connection)).result).rejects.toMatchObject({ code: "invalid_response" });
    fixture.behavior.callback = "ok";
    fixture.behavior.accountId = "user-2";
    await expect((await signIn(connection)).result).rejects.toMatchObject({ code: "account_changed" });
    expect(await credentials.read(CHATGPT_PROVIDER)).toEqual(before);
    // Signed out, the retained registration still decides which account may return.
    await connection.signOut();
    await expect((await signIn(connection)).result).rejects.toMatchObject({ code: "account_changed" });
    expect(await credentials.read(CHATGPT_PROVIDER)).toBeUndefined();
    expect(await credentials.retained(CHATGPT_PROVIDER)).toMatchObject({ accountId: "user-1" });

    // Forgetting the registration allows a different account.
    await connection.forget();
    await expect((await signIn(connection)).result).resolves.toMatchObject({ accountId: "user-2" });
  });

  it.each([
    ["a nonce from another sign-in", { nonce: "replayed" }],
    ["another issuer", { issuer: "https://issuer.invalid" }],
    ["another audience", { audience: "oaiapp_other" }],
    ["an expired token", { expiresIn: -120 }],
    ["an unpublished signing key", { stranger: true }],
  ])("rejects an ID token with %s and stores nothing", async (_, idToken) => {
    const { fixture, credentials, connection } = await setup();
    fixture.behavior.idToken = idToken;
    await expect((await signIn(connection)).result).rejects.toMatchObject({ code: "invalid_response" });
    expect(await credentials.read(CHATGPT_PROVIDER)).toBeUndefined();
  });

  it("stops on declined consent without exchanging a code", async () => {
    const { fixture, connection } = await setup();
    fixture.behavior.callback = "deny";
    await expect((await signIn(connection)).result).rejects.toMatchObject({ code: "denied" });
    expect(fixture.tokenRequests).toEqual([]);
  });

  it("refuses a grant without plan use but keeps the verified registration", async () => {
    const { fixture, credentials, connection } = await setup();
    fixture.behavior.scope = "openid profile email offline_access resource.invoke";
    await expect((await signIn(connection)).result).rejects.toMatchObject({ code: "plan_not_enabled" });
    expect(await credentials.read(CHATGPT_PROVIDER)).toBeUndefined();
    expect(await credentials.retained(CHATGPT_PROVIDER)).toEqual({
      clientId: "oaiapp_fixture",
      accountId: "user-1",
      email: "owner@example.test",
    });
  });

  it("ignores callbacks for other sign-ins and checks a pasted address", async () => {
    const { fixture, connection } = await setup();
    const { interaction, authUrl } = owner();
    const pending = connection.signIn(interaction);
    const url = new URL(await authUrl);
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    expect((await fetch(`${redirect}?code=stolen&state=other`)).status).toBe(400);
    expect((await fetch(`${new URL(redirect).origin}/elsewhere?state=${url.searchParams.get("state")}`)).status).toBe(
      400,
    );
    expect((await browse(url.toString())).status).toBe(200);
    await expect(pending).resolves.toMatchObject({ accountId: "user-1" });

    for (const paste of [
      (auth: URL) => `${auth.searchParams.get("redirect_uri")}?code=x&state=not-this-sign-in`,
      (auth: URL) => `http://127.0.0.1:1/auth/callback?code=x&state=${auth.searchParams.get("state")}`,
      () => "not an address",
    ]) {
      await expect(connection.signIn(owner(paste).interaction)).rejects.toMatchObject({ code: "invalid_response" });
    }
    expect(fixture.tokenRequests).toHaveLength(1);
  });

  it("completes from a pasted address when the browser cannot reach the server", async () => {
    const { fixture, connection } = await setup();
    // The phone's browser ends on 127.0.0.1 of the phone; the owner copies that address into Pal instead.
    const paste = owner(async (auth) => (await fetch(auth, { redirect: "manual" })).headers.get("location") ?? "");
    await expect(connection.signIn(paste.interaction)).resolves.toMatchObject({ accountId: "user-1" });
    expect(fixture.tokenRequests).toHaveLength(1);
  });

  it("allows one sign-in at a time, cancels cleanly and reports a busy callback port", async () => {
    const port = await freePort();
    const { fixture, connection } = await setup((endpoints) => ({ ...endpoints, callbackPort: port }));
    const first = owner();
    const pending = connection.signIn(first.interaction);
    await first.authUrl;
    await expect(connection.signIn(owner().interaction)).rejects.toMatchObject({ code: "busy" });
    first.cancel();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(fixture.tokenRequests).toEqual([]);

    // The port was released: the next sign-in listens on it again.
    await expect((await signIn(connection)).result).resolves.toMatchObject({ accountId: "user-1" });

    const squatter = createServer().listen(port, "127.0.0.1");
    await once(squatter, "listening");
    cleanups.push(() => new Promise((resolve) => squatter.close(resolve)));
    await expect(connection.signIn(owner().interaction)).rejects.toMatchObject({ code: "port_in_use" });
  });

  it("never saves a sign-in cancelled, signed out or forgotten while its ID token is verified", async () => {
    for (const interrupt of ["cancel", "sign-out", "forget"] as const) {
      // A fresh fixture per case: verified keys are cached by their JWKS address.
      const { fixture, connection } = await setup();
      const gate = Promise.withResolvers<undefined>();
      fixture.behavior.jwks = gate.promise;
      const attempt = owner();
      const result = connection.signIn(attempt.interaction);
      result.catch(() => {});
      await browse(await attempt.authUrl);
      await expect.poll(() => fixture.jwksRequests()).toBe(1);
      if (interrupt === "cancel") attempt.cancel();
      else if (interrupt === "sign-out") await connection.signOut();
      else await connection.forget();
      gate.resolve(undefined);
      await expect(result, interrupt).rejects.toMatchObject({ code: "cancelled" });
      expect(await connection.account(), interrupt).toBeUndefined();

      // A sign-in started afterwards is not fenced by the earlier one.
      delete fixture.behavior.jwks;
      await expect((await signIn(connection)).result, interrupt).resolves.toMatchObject({ accountId: "user-1" });
      expect(await connection.account(), interrupt).toMatchObject({ accountId: "user-1" });
    }
  });

  it("refreshes once under the store lock, rotating the refresh token", async () => {
    const { fixture, credentials, connection, models } = await setup();
    await (
      await signIn(connection)
    ).result;
    const before = (await credentials.read(CHATGPT_PROVIDER)) as ChatGPTCredential;
    await credentials.modify(CHATGPT_PROVIDER, async (current) => current && { ...current, expires: 0 });

    const [a, b] = await Promise.all([models.getAuth(CHATGPT_PROVIDER), models.getAuth(CHATGPT_PROVIDER)]);
    expect(fixture.tokenRequests.filter((form) => form.get("grant_type") === "refresh_token")).toHaveLength(1);
    const after = (await credentials.read(CHATGPT_PROVIDER)) as ChatGPTCredential;
    expect(a?.auth.apiKey).toBe(after.access);
    expect(b?.auth.apiKey).toBe(after.access);
    expect(after.refresh).not.toBe(before.refresh);
    expect(after).toMatchObject({ clientId: before.clientId, accountId: before.accountId });

    // The consumed refresh token is now unusable: sign in again rather than retry.
    await expect(refreshChatGPT(fixture.endpoints, before, AbortSignal.timeout(5_000))).rejects.toMatchObject({
      code: "reauthorize",
    });
  });

  it("never falls back to an ambient API key", async () => {
    const { fixture, connection, models } = await setup();
    const ambient = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-ambient-must-not-be-used";
    cleanups.push(async () => {
      if (ambient === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = ambient;
    });
    const model = models.getModel(CHATGPT_PROVIDER, "gpt-5.5");
    if (model === undefined) throw new Error("Pi's catalog lacks gpt-5.5");

    expect(await models.getAuth(CHATGPT_PROVIDER)).toBeUndefined();
    const signedOut = await models.complete(model, ask);
    expect(signedOut.stopReason).toBe("error");
    expect(signedOut.errorMessage).toMatch(/not configured/);
    expect(fixture.apiRequests).toEqual([]);

    await (
      await signIn(connection)
    ).result;
    await models.complete(model, ask);
    expect(fixture.apiRequests.map((request) => request.authorization)).toEqual(["Bearer access-2"]);
  });

  it("sends stateless streaming requests and succeeds only on a terminal event", async () => {
    const { fixture, connection, models } = await setup();
    await (
      await signIn(connection)
    ).result;
    const model = models.getModel(CHATGPT_PROVIDER, "gpt-5.5");
    if (model === undefined) throw new Error("Pi's catalog lacks gpt-5.5");

    const answer = await models.complete(model, ask);
    expect(answer.stopReason).toBe("stop");
    expect(answer.content).toEqual([expect.objectContaining({ type: "text", text: "Hello" })]);
    expect(fixture.apiRequests[0]).toMatchObject({
      path: "/v1/responses",
      body: { model: "gpt-5.5", stream: true, store: false },
    });

    fixture.behavior.responses = "truncated";
    const cut = await models.complete(model, ask);
    expect(cut.stopReason).toBe("error");
    expect(cut.errorMessage).toMatch(/terminal response event/);
  });

  it("pauses a durable run on the usage limit without retrying it", async () => {
    const { fixture, connection, models } = await setup();
    await (
      await signIn(connection)
    ).result;
    fixture.behavior.responses = "usage_limit";
    const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
    cleanups.push(() => harness.close(context));
    const root = await harness.root(context, { agent: { model: { provider: CHATGPT_PROVIDER, modelId: "gpt-5.5" } } });
    await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);

    const responses = fixture.apiRequests.filter((request) => request.path === "/v1/responses");
    expect(responses).toHaveLength(1);
    // The failed answer stays in the transcript but out of the model context.
    const { entries } = await root.context(context);
    const failed = entries.at(-1)?.model?.[0];
    expect(failed?.role === "assistant" && failed.stopReason).toBe("error");
    expect(failed?.role === "assistant" && classifyChatGPTError(failed.errorMessage)).toBe("usage_limited");
  });

  it("lists the account's listed models in server order, marking unknown capabilities unsupported", async () => {
    const { connection, models } = await setup();
    await expect(listChatGPTModels(models)).rejects.toMatchObject({ code: "reauthorize" });
    await (
      await signIn(connection)
    ).result;
    expect(await listChatGPTModels(models)).toEqual([
      { slug: "gpt-5.5", displayName: "GPT-5.5", supported: true, efforts: ["off", "low", "medium", "high", "xhigh"] },
      { slug: "gpt-unknown-next", displayName: "Next", supported: false, efforts: [] },
      {
        slug: "gpt-5.4-mini",
        displayName: "GPT-5.4 mini",
        supported: true,
        efforts: ["off", "low", "medium", "high", "xhigh"],
      },
    ]);
  });
});
