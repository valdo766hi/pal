import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  getSupportedThinkingLevels,
  type Models,
  type ModelThinkingLevel,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { SqliteCredentialStore } from "../storage/credentials.ts";

/** Pi provider ID that model refs and credentials use for ChatGPT subscription access. */
export const CHATGPT_PROVIDER = "openai";

export type ChatGPTEndpoints = {
  readonly issuer: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
  /** Base of the Responses and model-listing routes. */
  readonly apiBaseUrl: string;
  /** Loopback callback port; tests pass 0 for a free one. */
  readonly callbackPort: number;
};

/** https://developers.openai.com/siwc/token-sharing-open-source/sign-in and auth.openai.com's OIDC discovery. */
export const OPENAI_CHATGPT: ChatGPTEndpoints = {
  issuer: "https://auth.openai.com",
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
  tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
  jwksUrl: "https://auth.openai.com/.well-known/jwks.json",
  apiBaseUrl: "https://api.openai.com/v1",
  callbackPort: 1455,
};

const RESOURCE = "https://api.openai.com/v1";
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const CALLBACK_PATH = "/auth/callback";
// Refresh this long before the real expiry, so no request starts with a token about to expire.
const EXPIRY_MARGIN_MS = 3 * 60_000;
/** Token errors after which the code or refresh token is unusable and the user must sign in again. */
const UNUSABLE_GRANT = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

/** What a sign-in returns to: the issued client and the verified account it belongs to. */
export type ChatGPTRegistration = { readonly clientId: string; readonly accountId: string; readonly email?: string };

export type ChatGPTCredential = OAuthCredential &
  ChatGPTRegistration & {
    readonly scopes: readonly string[];
    /** `id_token_hint` for the next sign-in; dropped with the tokens at sign-out. */
    readonly idToken: string;
  };

export type ChatGPTAuthErrorCode =
  | "denied"
  | "plan_not_enabled"
  | "account_changed"
  | "reauthorize"
  | "invalid_response"
  | "port_in_use"
  | "busy"
  | "cancelled";

/** Why sign-in or refresh stopped, in terms the UI acts on. */
export class ChatGPTAuthError extends Error {
  readonly code: ChatGPTAuthErrorCode;
  /** Set when the account was verified but plan use was not granted: keep it to return to the same client. */
  readonly registration: ChatGPTRegistration | undefined;

  constructor(
    code: ChatGPTAuthErrorCode,
    message: string,
    options?: ErrorOptions & { registration?: ChatGPTRegistration },
  ) {
    super(message, options);
    this.code = code;
    this.registration = options?.registration;
  }
}

export type SignInOptions = {
  readonly endpoints: ChatGPTEndpoints;
  readonly interaction: ProviderAuthInteraction;
  /** Stable installation UUID, OpenAI's agent host ID. */
  readonly installationId: string;
  readonly agentName: string;
  /** The registration to return to; absent registers a new client. */
  readonly registration?: ChatGPTRegistration;
  readonly idTokenHint?: string;
};

/**
 * Sign in with ChatGPT (authorization code + PKCE on a loopback callback). Unlike Pi 1.3.0's flow, this verifies the
 * ID token (signature, issuer, audience, expiry, nonce), returns to a saved registration instead of registering again,
 * and refuses a different account than the one being returned to.
 */
export async function signInWithChatGPT(options: SignInOptions): Promise<ChatGPTCredential> {
  const { endpoints, interaction, registration } = options;
  const verifier = randomValue();
  const state = randomValue();
  const nonce = randomValue();
  const callback = await listenForCallback(endpoints.callbackPort, state);
  const manual = new AbortController();
  try {
    const authorize = new URL(endpoints.authorizeUrl);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: registration?.clientId ?? DYNAMIC_CLIENT_ID,
      // The name hint belongs to registration only; returning sign-ins identify the account instead.
      ...(registration === undefined ? { agent_name_hint: options.agentName } : {}),
      ...(registration?.email === undefined ? {} : { login_hint: registration.email }),
      ...(registration === undefined || options.idTokenHint === undefined
        ? {}
        : { id_token_hint: options.idTokenHint }),
      ext_agent_host_id: `urn:uuid:${options.installationId}`,
      redirect_uri: callback.redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    interaction.notify({
      type: "auth_url",
      url: authorize.toString(),
      instructions:
        "Sign in with ChatGPT in your browser. If it cannot reach this server, paste the final address here.",
    });
    const pasted = interaction
      .prompt({
        type: "manual_code",
        message: "Paste the address your browser ended on:",
        placeholder: callback.redirectUri,
        signal: AbortSignal.any([manual.signal, interaction.signal]),
      })
      .then((input) => pastedCallback(input, callback.redirectUri, state));
    const aborted = new Promise<never>((_, reject) => {
      if (interaction.signal.aborted) reject(interaction.signal.reason);
      interaction.signal.addEventListener("abort", () => reject(interaction.signal.reason), { once: true });
    });
    const url = await Promise.race([callback.url, pasted, aborted]);

    const error = url.searchParams.get("error");
    if (error === "access_denied") throw new ChatGPTAuthError("denied", "ChatGPT sign-in was declined");
    if (error !== null) throw new ChatGPTAuthError("invalid_response", `ChatGPT sign-in failed: ${error}`);
    const code = url.searchParams.get("code");
    if (code === null) throw new ChatGPTAuthError("invalid_response", "the callback has no authorization code");
    const clientId = issuedClientId(url.searchParams.get("client_id"), registration);

    interaction.notify({ type: "progress", message: "Verifying your ChatGPT account…" });
    const token = await requestToken(
      endpoints,
      {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: callback.redirectUri,
        resource: RESOURCE,
      },
      interaction.signal,
    );
    if (token.idToken === undefined)
      throw new ChatGPTAuthError("invalid_response", "the token response has no ID token");
    const identity = await verifyIdToken(endpoints, token.idToken, clientId, nonce);
    // Verification can outlast a cancellation; a cancelled attempt never yields a credential.
    interaction.signal.throwIfAborted();
    if (registration !== undefined && identity.accountId !== registration.accountId) {
      throw new ChatGPTAuthError("account_changed", "ChatGPT signed in a different account than this connection's");
    }
    return credential(token, { clientId, ...identity }, token.idToken);
  } catch (error) {
    if (interaction.signal.aborted)
      throw new ChatGPTAuthError("cancelled", "ChatGPT sign-in was cancelled", { cause: error });
    throw error;
  } finally {
    manual.abort();
    callback.close();
  }
}

/** Exchange the refresh token. Tokens rotate, so the caller must persist the whole result before releasing its lock. */
export async function refreshChatGPT(
  endpoints: ChatGPTEndpoints,
  current: OAuthCredential,
  signal: AbortSignal,
): Promise<ChatGPTCredential> {
  const { clientId, accountId, email, idToken } = current as Partial<ChatGPTCredential>;
  if (typeof clientId !== "string" || typeof accountId !== "string" || typeof idToken !== "string") {
    throw new ChatGPTAuthError("reauthorize", "the stored ChatGPT credential is incomplete; sign in again");
  }
  const token = await requestToken(
    endpoints,
    { grant_type: "refresh_token", client_id: clientId, refresh_token: current.refresh, resource: RESOURCE },
    signal,
  );
  if (token.idToken === undefined) {
    return credential(token, { clientId, accountId, ...(email === undefined ? {} : { email }) }, idToken);
  }
  const identity = await verifyIdToken(endpoints, token.idToken, clientId, undefined);
  if (identity.accountId !== accountId) {
    throw new ChatGPTAuthError("account_changed", "the refreshed ChatGPT token belongs to a different account");
  }
  return credential(token, { clientId, ...identity }, token.idToken);
}

/** Pi OAuth auth whose refresh and request auth use `endpoints`. Sign-in goes through `ChatGPTConnection`. */
export function chatGPTAuth(endpoints: ChatGPTEndpoints): OAuthAuth {
  return {
    name: "ChatGPT subscription",
    isSubscription: true,
    loginLabel: "Sign in with ChatGPT",
    // Pi's `Models.login` would store a credential without checking it is the account being returned to.
    login: () => Promise.reject(new Error("sign in through Pal's ChatGPT connection")),
    refresh: (credential, signal) => refreshChatGPT(endpoints, credential, signal),
    toAuth: async (credential) => ({ apiKey: credential.access, baseUrl: endpoints.apiBaseUrl }),
  };
}

/**
 * Pi's OpenAI provider with subscription auth only. Without an API-key method, Pi never falls back to an ambient
 * OPENAI_API_KEY or a per-request key: signed out means not configured.
 */
export function chatGPTProvider(endpoints: ChatGPTEndpoints): Provider {
  return { ...openaiProvider(), auth: { oauth: chatGPTAuth(endpoints) } };
}

export type ChatGPTModel = {
  readonly slug: string;
  readonly displayName: string;
  readonly supported: boolean;
  readonly efforts: readonly ModelThinkingLevel[];
};

/**
 * The signed-in account's models in the server's order. Only listed entries are kept; one Pi has no capability
 * metadata for is shown as unsupported rather than guessed.
 */
export async function listChatGPTModels(models: Models, signal?: AbortSignal): Promise<ChatGPTModel[]> {
  const resolved = await models.getAuth(CHATGPT_PROVIDER, signal === undefined ? {} : { signal });
  const { apiKey, baseUrl } = resolved?.auth ?? {};
  if (apiKey === undefined || baseUrl === undefined)
    throw new ChatGPTAuthError("reauthorize", "ChatGPT is not signed in");
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    redirect: "error",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error(`ChatGPT model listing failed: HTTP ${response.status}`);
  const body = (await response.json()) as { models?: unknown };
  return (Array.isArray(body.models) ? (body.models as Record<string, unknown>[]) : []).flatMap((entry) => {
    if (entry.visibility !== "list" || typeof entry.slug !== "string") return [];
    const model = models.getModel(CHATGPT_PROVIDER, entry.slug);
    return [
      {
        slug: entry.slug,
        displayName: typeof entry.display_name === "string" ? entry.display_name : entry.slug,
        supported: model !== undefined,
        efforts: model === undefined ? [] : getSupportedThinkingLevels(model),
      },
    ];
  });
}

export type ChatGPTUsageState = "usage_limited" | "not_eligible" | "unavailable" | "reauthorize" | "unsupported";

/** https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery#structured-responses-errors */
const ERROR_STATES: Readonly<Record<string, ChatGPTUsageState>> = {
  subscription_sharing_usage_limit_exceeded: "usage_limited",
  subscription_sharing_user_not_eligible: "not_eligible",
  subscription_sharing_usage_unavailable: "unavailable",
  subscription_sharing_user_unavailable: "unavailable",
  subscription_sharing_invalid_user: "reauthorize",
  subscription_sharing_unsupported_capability: "unsupported",
};

/** Map a failed model response to the state the UI explains; undefined for errors that are not about the plan. */
export function classifyChatGPTError(message: string | undefined): ChatGPTUsageState | undefined {
  return Object.entries(ERROR_STATES).find(([code]) => message?.includes(code))?.[1];
}

export type ChatGPTAccount = { readonly accountId: string; readonly email?: string };

/**
 * The installation's ChatGPT connection: one sign-in at a time, returning to the retained registration, with the
 * credential replaced under the store lock only for the same account.
 */
export class ChatGPTConnection {
  readonly #store: SqliteCredentialStore;
  readonly #options: { endpoints: ChatGPTEndpoints; installationId: string; agentName: string };
  #signingIn = false;
  /** Advanced by sign-out and forget, so an attempt that started before either can never save its credential. */
  #generation = 0;

  constructor(
    store: SqliteCredentialStore,
    options: { endpoints: ChatGPTEndpoints; installationId: string; agentName: string },
  ) {
    this.#store = store;
    this.#options = options;
  }

  async account(): Promise<ChatGPTAccount | undefined> {
    const current = await this.#store.read(CHATGPT_PROVIDER);
    return current?.type === "oauth" ? accountOf(current as ChatGPTCredential) : undefined;
  }

  async signIn(interaction: ProviderAuthInteraction): Promise<ChatGPTAccount> {
    if (this.#signingIn) throw new ChatGPTAuthError("busy", "a ChatGPT sign-in is already in progress");
    this.#signingIn = true;
    const generation = this.#generation;
    try {
      const retained = await this.#store.retained(CHATGPT_PROVIDER);
      let registration: ChatGPTRegistration | undefined;
      if (retained?.clientId !== undefined && retained.accountId !== undefined) {
        registration = {
          clientId: retained.clientId,
          accountId: retained.accountId,
          ...(retained.email === undefined ? {} : { email: retained.email }),
        };
      }
      const current = await this.#store.read(CHATGPT_PROVIDER);
      const idTokenHint = current?.type === "oauth" ? (current as ChatGPTCredential).idToken : undefined;
      let signedIn: ChatGPTCredential;
      try {
        signedIn = await signInWithChatGPT({
          ...this.#options,
          interaction,
          ...(registration === undefined ? {} : { registration }),
          ...(idTokenHint === undefined ? {} : { idTokenHint }),
        });
      } catch (error) {
        if (error instanceof ChatGPTAuthError && error.registration !== undefined && registration === undefined) {
          await this.#store.retain(CHATGPT_PROVIDER, error.registration);
        }
        throw error;
      }
      await this.#store.modify(CHATGPT_PROVIDER, async (existing) => {
        // Decided under the store lock, where sign-out and forget also write, so no late attempt slips past them.
        if (interaction.signal.aborted || generation !== this.#generation)
          throw new ChatGPTAuthError("cancelled", "ChatGPT sign-in was cancelled");
        const holder = existing?.type === "oauth" ? (existing as ChatGPTCredential).accountId : undefined;
        if (holder !== undefined && holder !== signedIn.accountId) {
          throw new ChatGPTAuthError("account_changed", "another ChatGPT account is already connected");
        }
        return signedIn;
      });
      return accountOf(signedIn);
    } finally {
      this.#signingIn = false;
    }
  }

  /** Drop the tokens; the registration stays for the next sign-in. */
  async signOut(): Promise<void> {
    this.#generation++;
    await this.#store.delete(CHATGPT_PROVIDER);
  }

  /** Forget the registration too, so the next sign-in may choose another account. */
  async forget(): Promise<void> {
    this.#generation++;
    await this.#store.forget(CHATGPT_PROVIDER);
  }
}

function accountOf(credential: ChatGPTCredential): ChatGPTAccount {
  return { accountId: credential.accountId, ...(credential.email === undefined ? {} : { email: credential.email }) };
}

function randomValue(): string {
  return randomBytes(32).toString("base64url");
}

function issuedClientId(returned: string | null, registration: ChatGPTRegistration | undefined): string {
  if (registration !== undefined) {
    // A reauthorization callback may omit the client ID, but must not name another.
    if (returned !== null && returned !== registration.clientId) {
      throw new ChatGPTAuthError("invalid_response", "the callback names a different client than this connection's");
    }
    return registration.clientId;
  }
  if (returned === null || returned === "" || returned === DYNAMIC_CLIENT_ID) {
    throw new ChatGPTAuthError("invalid_response", "registration did not return an issued client ID");
  }
  return returned;
}

function pastedCallback(input: string, redirectUri: string, state: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ChatGPTAuthError("invalid_response", "paste the full address from the browser");
  }
  if (`${url.origin}${url.pathname}` !== redirectUri) {
    throw new ChatGPTAuthError("invalid_response", `the pasted address must start with ${redirectUri}`);
  }
  if (url.searchParams.get("state") !== state) {
    throw new ChatGPTAuthError("invalid_response", "the pasted address belongs to another sign-in");
  }
  return url;
}

/**
 * Listen on 127.0.0.1 for the browser's redirect. Only a request carrying this attempt's state settles it; others
 * (a stale tab, another attempt) are answered and ignored.
 */
async function listenForCallback(
  port: number,
  state: string,
): Promise<{ redirectUri: string; url: Promise<URL>; close(): void }> {
  let settle: (url: URL) => void = () => {};
  const url = new Promise<URL>((resolve) => {
    settle = resolve;
  });
  const server = createServer((request, response) => {
    const received = new URL(request.url ?? "/", "http://127.0.0.1");
    const ours = received.pathname === CALLBACK_PATH && received.searchParams.get("state") === state;
    response.writeHead(ours ? 200 : 400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(
      ours ? "Return to Pal to finish signing in. You can close this tab." : "This sign-in link is not active.",
    );
    if (ours) settle(received);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new ChatGPTAuthError("port_in_use", `port ${port} is in use; finish or cancel the other sign-in first`)
          : error,
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${CALLBACK_PATH}`;
  return {
    redirectUri,
    url,
    close: () => {
      server.close();
      // Browsers keep spare connections open; a later sign-in's callback must not land on this server.
      server.closeAllConnections();
    },
  };
}

type TokenResponse = { access: string; refresh: string; expiresIn: number; scopes: string[]; idToken?: string };

async function requestToken(
  endpoints: ChatGPTEndpoints,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<TokenResponse> {
  const response = await fetch(endpoints.tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    // Codes and refresh tokens never follow a redirect.
    redirect: "error",
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new ChatGPTAuthError(
      UNUSABLE_GRANT.has(error) ? "reauthorize" : "invalid_response",
      `token request failed: ${error}`,
    );
  }
  const { access_token: access, refresh_token: refresh, scope, expires_in: expiresIn, id_token: idToken } = body;
  if (
    typeof access !== "string" ||
    typeof refresh !== "string" ||
    typeof scope !== "string" ||
    typeof expiresIn !== "number" ||
    !(expiresIn > 0) ||
    (idToken !== undefined && typeof idToken !== "string")
  ) {
    throw new ChatGPTAuthError("invalid_response", "the token response is malformed");
  }
  return {
    access,
    refresh,
    expiresIn,
    scopes: scope.split(/\s+/).filter(Boolean),
    ...(idToken === undefined ? {} : { idToken }),
  };
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyIdToken(
  endpoints: ChatGPTEndpoints,
  idToken: string,
  clientId: string,
  nonce: string | undefined,
): Promise<{ accountId: string; email?: string }> {
  let keys = keySets.get(endpoints.jwksUrl);
  if (keys === undefined) keySets.set(endpoints.jwksUrl, (keys = createRemoteJWKSet(new URL(endpoints.jwksUrl))));
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: endpoints.issuer,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp"],
    });
    if (nonce !== undefined && payload.nonce !== nonce) throw new Error("nonce does not match this sign-in");
    if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("missing subject");
    return { accountId: payload.sub, ...(typeof payload.email === "string" ? { email: payload.email } : {}) };
  } catch (error) {
    throw new ChatGPTAuthError("invalid_response", `ChatGPT ID token rejected: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function credential(token: TokenResponse, registration: ChatGPTRegistration, idToken: string): ChatGPTCredential {
  if (!token.scopes.includes(DIRECT_SCOPE)) {
    throw new ChatGPTAuthError("plan_not_enabled", "ChatGPT plan use was not granted to Pal", { registration });
  }
  return {
    type: "oauth",
    access: token.access,
    refresh: token.refresh,
    expires: Date.now() + token.expiresIn * 1000 - EXPIRY_MARGIN_MS,
    ...registration,
    scopes: token.scopes,
    idToken,
  };
}
