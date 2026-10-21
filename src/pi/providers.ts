import {
  type Api,
  type ApiKeyAuth,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  createProvider,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { SqliteCredentialStore } from "../storage/credentials.ts";

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

/**
 * Optional API-key providers beside the ChatGPT subscription. Each is off until the owner saves a key and enables it;
 * none is ever chosen for a chat, or substituted after a failure, without an explicit owner choice. `check` names a
 * free, documented request that tells whether a key is accepted, without a model request.
 */
const CATALOG = {
  openrouter: {
    name: "OpenRouter",
    billing: "Pay per token from your OpenRouter credits.",
    keys: "https://openrouter.ai/settings/keys",
    create: openrouterProvider,
    check: { origin: "https://openrouter.ai", path: "/api/v1/key", headers: bearer },
  },
  opencode: {
    name: "OpenCode Zen",
    billing: "Pay as you go from your OpenCode balance.",
    keys: "https://opencode.ai/auth",
    create: opencodeProvider,
  },
  "opencode-go": {
    name: "OpenCode Go",
    billing:
      "Counts against your OpenCode Go subscription limits, and your OpenCode balance only if you turned on Use balance there.",
    keys: "https://opencode.ai/auth",
    create: opencodeGoProvider,
  },
  // Pi's OpenAI provider under its own ID, so API-key models and credentials never mix with the ChatGPT subscription.
  "openai-api": {
    name: "OpenAI API",
    billing: "Pay per token on your OpenAI API account, separate from your ChatGPT subscription.",
    keys: "https://platform.openai.com/api-keys",
    create: openaiProvider,
    check: { origin: "https://api.openai.com", path: "/v1/models", headers: bearer },
  },
  anthropic: {
    name: "Anthropic API",
    billing: "Pay per token on your Anthropic API account, not a Claude subscription.",
    keys: "https://console.anthropic.com/settings/keys",
    create: anthropicProvider,
    check: {
      origin: "https://api.anthropic.com",
      path: "/v1/models",
      headers: (key: string) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    },
  },
  deepseek: {
    name: "DeepSeek API",
    billing: "Pay per token from your DeepSeek API platform balance, separate from the DeepSeek chat app.",
    keys: "https://platform.deepseek.com/api_keys",
    create: deepseekProvider,
    check: { origin: "https://api.deepseek.com", path: "/user/balance", headers: bearer },
  },
} as const satisfies Record<
  string,
  {
    name: string;
    billing: string;
    keys: string;
    create: () => Provider;
    check?: { origin: string; path: string; headers: (key: string) => Record<string, string> };
  }
>;
type CatalogId = keyof typeof CATALOG;
const COMPATIBLE = "compatible";
export type ApiProviderId = CatalogId | typeof COMPATIBLE;
export const API_PROVIDER_IDS = [...(Object.keys(CATALOG) as CatalogId[]), COMPATIBLE] as const;
export const API_PROVIDERS: Readonly<Record<ApiProviderId, { readonly name: string }>> = {
  ...CATALOG,
  [COMPATIBLE]: { name: "OpenAI-compatible endpoint" },
};

/** An owner-described server speaking OpenAI's chat completions API, such as a local model server. */
export const CompatibleBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 60 }),
    baseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
    models: Type.Array(Type.String({ pattern: "^[\\x21-\\x7e]{1,200}$" }), { minItems: 1, maxItems: 50 }),
    contextWindow: Type.Integer({ minimum: 1024, maximum: 10_000_000 }),
    maxTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    images: Type.Boolean(),
    keyless: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type CompatibleConfig = Static<typeof CompatibleBody>;

export type ProviderModel = {
  readonly id: string;
  readonly name: string;
  readonly efforts: readonly ModelThinkingLevel[];
  readonly images: boolean;
};
export type ProviderView = {
  readonly id: ApiProviderId;
  readonly name: string;
  readonly billing: string;
  readonly keys: string | null;
  readonly hasKey: boolean;
  readonly enabled: boolean;
  /** Whether "Check key" can ask the provider without a model request. */
  readonly checkable: boolean;
  /** Chat models for this provider; listed only while enabled. */
  readonly models: readonly ProviderModel[];
  /** The compatible endpoint's description; null until the owner saves one, absent for catalog providers. */
  readonly config?: CompatibleConfig | null;
};
export type KeyCheck = { readonly ok: true; readonly detail: string } | { readonly ok: false; readonly detail: string };

export class ProviderConfigError extends Error {}

const KEY = /^[\x21-\x7e]{8,4096}$/;
const SETTING = (id: ApiProviderId) => `provider:${id}`;
const CONFIG = `provider:${COMPATIBLE}:config`;
const CHECK_TIMEOUT_MS = 10_000;
/** The fields Pal shows from OpenRouter's `GET /api/v1/key`; `limit` is null for an unlimited key. */
const KeyUsage = Type.Object({
  data: Type.Object({
    usage: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  }),
});
/** The fields Pal shows from DeepSeek's `GET /user/balance`; amounts are decimal strings. */
const Balance = Type.Object({
  is_available: Type.Boolean(),
  balance_infos: Type.Array(
    Type.Object({ currency: Type.String({ maxLength: 8 }), total_balance: Type.String({ maxLength: 40 }) }),
    { maxItems: 8 },
  ),
});

export function isApiProvider(id: string): id is ApiProviderId {
  return (API_PROVIDER_IDS as readonly string[]).includes(id);
}

/** Only the key the owner saved in Pal: never a process environment variable, so nothing ambient is picked up. */
function storedKeyOnly(name: string): ApiKeyAuth {
  return {
    name,
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted();
      return credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined;
    },
  };
}

/** An endpoint the owner marked keyless; OpenAI's client still requires some key, which such servers ignore. */
const KEYLESS: ApiKeyAuth = {
  name: "No key",
  resolve: async ({ signal }) => {
    signal.throwIfAborted();
    return { auth: { apiKey: "no-key" }, source: "keyless endpoint" };
  },
};

/**
 * Pi's provider under Pal's ID with stored-key auth only (no OAuth or environment). `origin` replaces each model's
 * scheme and host, so tests reach a loopback fixture through the provider's real request code.
 */
export function apiKeyProvider(id: CatalogId, origin?: string): Provider {
  const base = CATALOG[id].create() as Provider<Api>;
  const adapt = <T extends { baseUrl?: string; provider?: string }>(model: T): T => ({
    ...model,
    provider: id,
    ...(origin === undefined || model.baseUrl === undefined
      ? {}
      : { baseUrl: model.baseUrl.replace(/^https:\/\/[^/]+/, origin) }),
  });
  return scrubbed({
    ...base,
    id,
    auth: { apiKey: storedKeyOnly(`${CATALOG[id].name} key`) },
    getModels: () => base.getModels().map(adapt),
    ...(base.getAllModels === undefined ? {} : { getAllModels: () => (base.getAllModels?.() ?? []).map(adapt) }),
  });
}

function compatibleProvider(config: CompatibleConfig): Provider {
  const models: Model<"openai-completions">[] = config.models.map((id) => ({
    id,
    name: id,
    api: "openai-completions",
    provider: COMPATIBLE,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: config.images ? ["text", "image"] : ["text"],
    // Unknown prices stay zero rather than guessed.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  }));
  return scrubbed(
    createProvider({
      id: COMPATIBLE,
      name: config.name,
      baseUrl: config.baseUrl,
      auth: { apiKey: config.keyless ? KEYLESS : storedKeyOnly(`${config.name} key`) },
      models,
      api: openAICompletionsApi(),
    }) as Provider<Api>,
  );
}

/** A service that echoes the key in an error body must not get it into the transcript, retry notice or UI. */
function scrubbed(provider: Provider<Api>): Provider {
  return {
    ...provider,
    stream: (model, context, options) => scrub(provider.stream(model, context, options), options?.apiKey),
    streamSimple: (model, context, options) => scrub(provider.streamSimple(model, context, options), options?.apiKey),
  };
}

function scrub(source: AssistantMessageEventStream, key: string | undefined): AssistantMessageEventStream {
  if (key === undefined || key === "") return source;
  const clean = (message: AssistantMessage): AssistantMessage =>
    message.errorMessage?.includes(key) === true
      ? { ...message, errorMessage: message.errorMessage.replaceAll(key, "[redacted key]") }
      : message;
  const scrubbedStream = createAssistantMessageEventStream();
  void (async () => {
    let terminal = false;
    for await (const event of source) {
      terminal ||= event.type === "done" || event.type === "error";
      scrubbedStream.push(event.type === "error" ? { ...event, error: clean(event.error) } : event);
    }
    scrubbedStream.end(terminal ? undefined : clean(await source.result()));
  })();
  return scrubbedStream;
}

/** Normalize and check an endpoint description; the URL may be private, since the owner chose it. */
export function compatibleConfig(body: CompatibleConfig): CompatibleConfig {
  let url: URL;
  try {
    url = new URL(body.baseUrl.trim());
  } catch {
    throw new ProviderConfigError("the base URL must be an http(s) address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ProviderConfigError("the base URL must be an http(s) address");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    throw new ProviderConfigError("put no credentials, query or fragment in the base URL; save a key instead");
  if (body.maxTokens > body.contextWindow)
    throw new ProviderConfigError("max output tokens cannot exceed the context window");
  const models = [...new Set(body.models.map((model) => model.trim()))];
  return { ...body, name: body.name.trim(), baseUrl: url.href.replace(/\/+$/, ""), models };
}

/** The owner's API-key providers: encrypted keys, explicit enablement and the Pi registration that follows it. */
export class ModelProviders {
  readonly #database: SqliteDatabase;
  readonly #credentials: SqliteCredentialStore;
  readonly #models: MutableModels;
  readonly #origin: string | undefined;

  private constructor(
    database: SqliteDatabase,
    credentials: SqliteCredentialStore,
    models: MutableModels,
    origin: string | undefined,
  ) {
    this.#database = database;
    this.#credentials = credentials;
    this.#models = models;
    this.#origin = origin;
  }

  /** Register the providers the owner left enabled and ready. */
  static async open(options: {
    database: SqliteDatabase;
    credentials: SqliteCredentialStore;
    models: MutableModels;
    /** Tests point every catalog provider at a loopback origin. */
    origin?: string;
  }): Promise<ModelProviders> {
    const providers = new ModelProviders(options.database, options.credentials, options.models, options.origin);
    for (const id of API_PROVIDER_IDS) if (await providers.usable(id)) await providers.#register(id);
    return providers;
  }

  async list(): Promise<ProviderView[]> {
    return Promise.all(
      API_PROVIDER_IDS.map(async (id): Promise<ProviderView> => {
        const hasKey = await this.#hasKey(id);
        const enabled = await this.usable(id);
        const models = enabled ? this.#catalog(id) : [];
        if (id === COMPATIBLE) {
          const config = (await this.#config()) ?? null;
          return {
            id,
            name: config?.name ?? API_PROVIDERS[id].name,
            billing: "Billed, if at all, by whoever runs this endpoint; Pal shows no prices.",
            keys: null,
            hasKey,
            enabled,
            checkable: config !== null,
            models,
            config,
          };
        }
        const { name, billing, keys } = CATALOG[id];
        return { id, name, billing, keys, hasKey, enabled, checkable: "check" in CATALOG[id], models };
      }),
    );
  }

  /** Whether chats may send to this provider now: ready (key, or a keyless endpoint) and enabled by the owner. */
  async usable(id: ApiProviderId): Promise<boolean> {
    return (await this.#ready(id)) && (await this.#enabled(id));
  }

  /** Save or replace a key (the next request uses it), or remove it, which also disables a provider that needs it. */
  async setKey(id: ApiProviderId, key: string | null): Promise<void> {
    if (key === null) {
      await this.#credentials.forget(id);
      if (!(await this.#ready(id))) await this.setEnabled(id, false);
      return;
    }
    const trimmed = key.trim();
    if (!KEY.test(trimmed)) throw new ProviderConfigError("the key must be 8–4096 printable characters, no spaces");
    await this.#credentials.modify(id, async () => ({ type: "api_key", key: trimmed }));
  }

  /**
   * Describe the compatible endpoint; an enabled one is re-registered with the new models at once. The saved key and
   * the owner's enablement belong to one destination, the normalized base URL: a new destination is disabled and its
   * old key forgotten before it is saved, so no key is sent to an address the owner never approved it for.
   */
  async setCompatible(body: CompatibleConfig): Promise<void> {
    const config = compatibleConfig(body);
    const previous = await this.#config();
    if (previous !== undefined && previous.baseUrl !== config.baseUrl) {
      await this.setEnabled(COMPATIBLE, false);
      await this.#credentials.forget(COMPATIBLE);
    }
    await this.#save(CONFIG, JSON.stringify(config));
    if (await this.#enabled(COMPATIBLE)) {
      if (await this.#ready(COMPATIBLE)) await this.#register(COMPATIBLE);
      else await this.setEnabled(COMPATIBLE, false);
    }
  }

  async setEnabled(id: ApiProviderId, enabled: boolean): Promise<void> {
    if (enabled && !(await this.#ready(id))) {
      throw new ProviderConfigError(
        id === COMPATIBLE
          ? "describe the endpoint, and save a key unless it needs none, before enabling it"
          : `save a ${CATALOG[id].name} key before enabling it`,
      );
    }
    await this.#save(SETTING(id), enabled ? "enabled" : "disabled");
    if (enabled) await this.#register(id);
    else this.#models.deleteProvider(id);
  }

  /** Ask the provider about the saved key without a model request, where it documents a free way to. */
  async check(id: ApiProviderId): Promise<KeyCheck> {
    const probe = await this.#probe(id);
    if ("detail" in probe) return probe;
    const { name, url, headers } = probe;
    let response: Response;
    try {
      response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    } catch {
      return { ok: false, detail: `Pal couldn't reach ${name} to check this key.` };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, detail: `${name} rejected this key.` };
    if (!response.ok) return { ok: false, detail: `${name} answered HTTP ${response.status}.` };
    if (id === "openrouter") return { ok: true, detail: usageDetail(await body(response)) };
    if (id === "deepseek") {
      const answer = await body(response);
      return { ok: true, detail: balanceDetail(Value.Check(Balance, answer) ? answer : undefined) };
    }
    return { ok: true, detail: Object.keys(headers).length === 0 ? `${name} answered.` : `${name} accepted this key.` };
  }

  /** The free request that checks this provider's saved key, or why there is none. */
  async #probe(
    id: ApiProviderId,
  ): Promise<{ name: string; url: string; headers: Record<string, string> } | { ok: false; detail: string }> {
    const credential = await this.#credentials.read(id);
    const key = credential?.type === "api_key" ? credential.key : undefined;
    if (id === COMPATIBLE) {
      const config = await this.#config();
      if (config === undefined) throw new ProviderConfigError("describe the endpoint first");
      if (config.keyless) return { name: config.name, url: `${config.baseUrl}/models`, headers: {} };
      if (key === undefined) throw new ProviderConfigError(`no ${config.name} key is saved`);
      return { name: config.name, url: `${config.baseUrl}/models`, headers: bearer(key) };
    }
    const entry: (typeof CATALOG)[CatalogId] = CATALOG[id];
    if (key === undefined) throw new ProviderConfigError(`no ${entry.name} key is saved`);
    if (!("check" in entry)) return { ok: false, detail: "OpenCode has no key check; the first message tests it." };
    const url = `${this.#origin ?? entry.check.origin}${entry.check.path}`;
    return { name: entry.name, url, headers: entry.check.headers(key) };
  }

  async #register(id: ApiProviderId): Promise<void> {
    if (id !== COMPATIBLE) {
      this.#models.setProvider(apiKeyProvider(id, this.#origin));
      return;
    }
    const config = await this.#config();
    if (config !== undefined) this.#models.setProvider(compatibleProvider(config));
  }

  async #ready(id: ApiProviderId): Promise<boolean> {
    if (id !== COMPATIBLE) return this.#hasKey(id);
    const config = await this.#config();
    return config !== undefined && (config.keyless || (await this.#hasKey(id)));
  }

  async #hasKey(id: ApiProviderId): Promise<boolean> {
    return (await this.#credentials.read(id))?.type === "api_key";
  }

  async #enabled(id: ApiProviderId): Promise<boolean> {
    return (await this.#setting(SETTING(id))) === "enabled";
  }

  async #config(): Promise<CompatibleConfig | undefined> {
    const stored = await this.#setting(CONFIG);
    if (stored === undefined) return undefined;
    // A corrupt description counts as none: the endpoint is unusable until the owner saves it again, and startup
    // still succeeds. It is never repaired by guessing.
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch {
      return undefined;
    }
    return Value.Check(CompatibleBody, parsed) ? parsed : undefined;
  }

  async #setting(key: string): Promise<string | undefined> {
    return (await this.#database.get<{ value: string }>("SELECT value FROM pal_settings WHERE key = ?", key))?.value;
  }

  async #save(key: string, value: string): Promise<void> {
    await this.#database.run(
      "INSERT INTO pal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  #catalog(id: ApiProviderId): ProviderModel[] {
    return this.#models.getModels(id).map((model: Model<Api>) => ({
      id: model.id,
      name: model.name,
      efforts: getSupportedThinkingLevels(model),
      images: model.input.includes("image"),
    }));
  }
}

async function body(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function usageDetail(answer: unknown): string {
  const usage = Value.Check(KeyUsage, answer) ? answer.data : {};
  let detail = "OpenRouter accepted this key.";
  if (usage.usage !== undefined) detail += ` Reported usage: ${usage.usage} credits`;
  if (usage.usage !== undefined && usage.limit != null) detail += ` of a ${usage.limit} credit limit.`;
  else if (usage.usage !== undefined) detail += ".";
  return detail;
}

function balanceDetail(balance: Static<typeof Balance> | undefined): string {
  let detail = "DeepSeek API accepted this key.";
  if (balance === undefined) return detail;
  const amounts = balance.balance_infos.map((info) => `${info.total_balance} ${info.currency}`);
  if (amounts.length > 0) detail += ` Balance: ${amounts.join(", ")}.`;
  if (!balance.is_available) detail += " DeepSeek says this balance can't pay for API calls.";
  return detail;
}
