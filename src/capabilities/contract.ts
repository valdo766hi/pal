import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type ConversationId,
  type Extension,
  type Registry,
  type Storage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { Type, type Static } from "typebox";
import type { FolderGrants, FolderLease } from "../core/folders.ts";
import { HttpError } from "../core/http.ts";
import type { PrivateFiles } from "../core/file-policy.ts";
import { validate } from "../core/requests.ts";
import { MODEL_TOOLS } from "../pi/codemode.ts";

export const CAPABILITY_API = 3;
const Order = Type.Integer({ minimum: 0, maximum: 1000 });
const Table = Type.String({ pattern: "^pal_[a-z0-9_]{1,59}$" });
const Component = Type.String({ pattern: "^[A-Z][A-Za-z0-9]{0,63}$" });
const Manifest = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }),
    version: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    native: Type.String({ pattern: "^pal\\.[a-z][a-z0-9.-]{0,59}$" }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ minLength: 1, maxLength: 1000 }),
    core: Type.Object(
      { min: Type.Integer({ minimum: 1 }), max: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
    /** Its place among the kernel's contributions and other plugins. */
    order: Order,
    /**
     * `browser`: interface pieces every chat shows, switched in the browser: no tools, storage or server part, and
     * never selected per chat. `installation`: a server part for the whole installation, such as an advisor, with
     * settings tabs and owner requests but no tools, namespace or chat pieces, and never selected per chat.
     */
    scope: Type.Optional(Type.Enum(["browser", "installation"])),
    /**
     * Model providers it offers (installation plugins only): listed in Settings → Models, off until the owner enables
     * one, and never chosen or substituted automatically.
     */
    providers: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }),
            name: Type.String({ minLength: 1, maxLength: 80 }),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 4 },
      ),
    ),
    /** A decision model the kernel may consult before an agent command in Auto mode; installation plugins only. */
    advisor: Type.Optional(
      Type.Object({ label: Type.String({ minLength: 1, maxLength: 40 }) }, { additionalProperties: false }),
    ),
    namespace: Type.Optional(
      Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 40 }),
          prefix: Type.String({ minLength: 2, maxLength: 41 }),
          description: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
          instructions: Type.Optional(Type.String({ maxLength: 4000 })),
        },
        { additionalProperties: false },
      ),
    ),
    optIn: Type.Optional(Type.Boolean()),
    tools: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }),
            replay: Type.Enum(["safe", "unsafe"]),
            /** `model` only for tools on the kernel's direct list; `tools` needs the plugin's Code Mode namespace. */
            callers: Type.Array(Type.Enum(["model", "tools"]), { minItems: 1, maxItems: 2, uniqueItems: true }),
            /** `project.read` leases the conversation's granted folders around every call. */
            permissions: Type.Array(Type.Literal("project.read"), { maxItems: 1 }),
            maxOutputBytes: Type.Integer({ minimum: 1, maximum: 64 * 1024 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 16 },
      ),
    ),
    /** Tables its SQL may change (its own, named after it) and the others it may read. */
    storage: Type.Optional(
      Type.Object(
        {
          owns: Type.Array(Table, { maxItems: 16, uniqueItems: true }),
          reads: Type.Array(Table, { maxItems: 16, uniqueItems: true }),
        },
        { additionalProperties: false },
      ),
    ),
    /**
     * Svelte components under ui/; chat slots show only in chats that selected the plugin. `composer` pieces sit above
     * the message box, `composer-tools` pieces in its tool row.
     */
    ui: Type.Optional(
      Type.Object(
        {
          /** Settings tabs; `id` is the tab's route. */
          settings: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }),
                  label: Type.String({ minLength: 1, maxLength: 40 }),
                  icon: Type.String({ pattern: "^[a-z][a-zA-Z0-9]{0,31}$" }),
                  component: Component,
                  order: Order,
                },
                { additionalProperties: false },
              ),
              { maxItems: 4 },
            ),
          ),
          slots: Type.Optional(
            Type.Array(
              Type.Object(
                { slot: Type.Enum(["context", "composer", "composer-tools"]), component: Component, order: Order },
                { additionalProperties: false },
              ),
              { maxItems: 8 },
            ),
          ),
          /** Workspace panels beside the kernel's; `id` is the panel's name. */
          panels: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  id: Type.String({ pattern: "^[A-Z][A-Za-z ]{0,23}$" }),
                  icon: Type.String({ pattern: "^[a-z][a-zA-Z0-9]{0,31}$" }),
                  component: Component,
                  order: Order,
                },
                { additionalProperties: false },
              ),
              { maxItems: 4 },
            ),
          ),
          /** Components that show the plugin's own transcript entries, by entry kind. */
          renderers: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  entry: Type.String({ pattern: "^pal\\.[a-z][a-z0-9.-]{0,59}$" }),
                  component: Component,
                  order: Order,
                },
                { additionalProperties: false },
              ),
              { maxItems: 8 },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type CapabilityManifest = Static<typeof Manifest>;
export type CapabilityIdentity = { id: string; version: number; digest: string };

/**
 * Services the kernel gives one plugin. Plugins are trusted code in Pal's process: these are its interface, not a
 * sandbox or a code installer.
 */
export type CapabilityHost = {
  /** SQL limited to the manifest's declared tables, a policy check on trusted code. */
  sql: SqliteDatabase;
  /** The Harness clock, which also times script deadlines. */
  now(): number;
  /** This plugin's options from the embedding, such as lower test bounds; the plugin validates them. */
  options?: unknown;
  storage: Storage;
  /** This plugin's own settings, kept in Pal's database and readable by its tools and owner requests. */
  settings: PluginSettings;
  folders: FolderGrants;
  deny: readonly string[];
  privateFiles: PrivateFiles;
  project(conversation: ConversationId): Promise<{ id: string; workspace: string } | undefined>;
  authorize(api: ToolExecutionApi, context: Context): Promise<FolderLease>;
  /** This plugin's secrets, sealed in Pal's credential store; only owner requests should set them. */
  secrets: PluginSecrets;
  /** A provider endpoint as this installation reaches it: unchanged, except that tests point it at a loopback origin. */
  endpoint(url: string): string;
};
/** What the kernel opens a plugin with: its services, before they are narrowed to that plugin. */
export type KernelServices = Omit<CapabilityHost, "sql" | "options" | "settings" | "secrets"> & {
  database: SqliteDatabase;
  credentials: CredentialStore;
  /** Options by plugin ID. */
  options?: Readonly<Record<string, unknown>>;
};
/** JSON values by name (`^[a-z][a-z0-9.-]{0,63}$`), at most 16 KiB each; `get` returns undefined until set. */
export type PluginSettings = {
  get(name: string): Promise<unknown>;
  set(name: string, value: unknown): Promise<void>;
};
/**
 * Secret strings by name (`^[a-z][a-z0-9.-]{0,63}$`), kept apart from settings and never sent to the browser by the
 * kernel; `has` is what a settings tab should show.
 */
export type PluginSecrets = {
  has(name: string): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  clear(name: string): Promise<void>;
};
/** One agent command an advisor judges: exactly what its settings tab says is sent. */
export type AdviceRequest = {
  readonly tool: "shell_run";
  readonly command: string;
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly folderAccess: "write";
};
/** An advisor's answer: the kernel lets the command skip the owner only for `run` at or above `threshold`. */
export type Advice = {
  readonly verdict: "run" | "ask";
  readonly confidence: number;
  readonly threshold: number;
  readonly reason?: string;
  readonly model?: string;
  /** The connection or account the request went through, as the owner knows it. */
  readonly via?: string;
  readonly tokens?: number;
  readonly costUsd?: number;
  readonly latencyMs?: number;
};
export type CapabilityAdvisor = {
  /** Whether Auto may use it now, and what the owner reads: what it sends where, or how to make it ready. */
  status(): Promise<{ ready: boolean; note: string }>;
  /** Judge one command; throw when no answer can be given. The kernel bounds the wait and never retries. */
  advise(request: AdviceRequest, signal: AbortSignal): Promise<Advice>;
};
/** A model provider a plugin offers; the kernel registers `provider` only while the owner keeps it enabled. */
export type CapabilityProvider = {
  readonly id: string;
  /** What using it costs the owner, as Settings → Models shows it. */
  readonly billing: string;
  readonly provider: Provider;
  /** Whether it can take requests now, and why not; asked only by the owner or while it is enabled. */
  status(): Promise<{ ready: boolean; detail: string }>;
  /** Called when the owner disables it: end its processes, connections and timers. */
  stop?(): Promise<void>;
};
/** One owner request under `/api/plugins/<id>/`; `path` is what follows the plugin's ID. */
export type CapabilityRequest = {
  readonly method: string;
  readonly path: readonly string[];
  readonly query: URLSearchParams;
  readonly body: unknown;
};
export type CapabilityRuntime = {
  tools?: NonNullable<Extension["tools"]>;
  /** Answers the owner's requests to this plugin; it validates its own input and throws `HttpError` to refuse. */
  api?(request: CapabilityRequest, context: Context): Promise<unknown>;
  /** What other trusted code, such as tests, reaches through `CompiledCapabilities.service`. */
  service?: unknown;
  /** The decision model its manifest's `advisor` declares. */
  advisor?: CapabilityAdvisor;
  /** The model providers its manifest's `providers` declares, in that order. */
  providers?: readonly CapabilityProvider[];
  /** Called after durable work stops; release ephemeral resources, never mutate durable state here. */
  dispose?(): void | Promise<void>;
};
export type CompiledCapability = {
  manifest: CapabilityManifest;
  /** A failed open must release anything it acquired before throwing. */
  open(host: CapabilityHost): CapabilityRuntime | Promise<CapabilityRuntime>;
};
const KERNEL_PANELS = new Set(["Files", "Changes", "Terminal", "Browser", "Context"]);
const KERNEL_SETTINGS = new Set(["general", "models", "mcp", "extensions"]);
const reserved = new Set([
  "files",
  "shell",
  "browser",
  "compact",
  "context",
  "policy",
  "extensions",
  "approvals",
  "instructions",
  "skills",
  "codemode",
  "mcp",
  // The kernel's own records: an entry named pal.<id> or pal.<id>.* belongs to plugin <id>.
  "user",
  "chat",
  "capabilities",
  "helper",
  "helper-slots",
  "release",
  "working-allowance",
  "working-checks",
  "working-review",
  "working-state",
  "evaluation-budget",
  "evaluation-checkpoint",
]);

export function capabilityManifest(input: unknown): CapabilityManifest {
  const manifest = validate(Manifest, structuredClone(input));
  if (manifest.core.min > CAPABILITY_API || manifest.core.max < CAPABILITY_API)
    throw new Error(`Capability ${manifest.id}@${manifest.version} needs a different Pal capability API.`);
  if (reserved.has(manifest.id) || reserved.has(manifest.native.slice(4)))
    throw new Error(`Capability ${manifest.id} cannot replace a core contribution.`);
  // Entries a plugin writes carry its native name, so history can name the plugin even when a build lacks it.
  if (manifest.native !== `pal.${manifest.id}`)
    throw new Error(`Capability ${manifest.id} must use the native name pal.${manifest.id}.`);
  const panels = manifest.ui?.panels ?? [];
  if (panels.some((panel) => KERNEL_PANELS.has(panel.id)))
    throw new Error(`Capability ${manifest.id} cannot replace a kernel panel.`);
  if (manifest.ui?.settings?.some((tab) => KERNEL_SETTINGS.has(tab.id)) === true)
    throw new Error(`Capability ${manifest.id} cannot replace a kernel settings tab.`);
  if (
    manifest.ui?.renderers?.some(
      (renderer) => renderer.entry !== manifest.native && !renderer.entry.startsWith(`${manifest.native}.`),
    ) === true
  )
    throw new Error(`Capability ${manifest.id} can only render its own entries.`);
  const own = manifest.id.replaceAll("-", "_");
  const { namespace, tools = [], storage } = manifest;
  if (
    manifest.scope === "browser" &&
    (namespace !== undefined ||
      tools.length > 0 ||
      storage !== undefined ||
      panels.length > 0 ||
      manifest.advisor !== undefined ||
      manifest.ui?.renderers !== undefined ||
      manifest.ui?.slots?.some((slot) => slot.slot === "context") === true)
  )
    throw new Error(`Capability ${manifest.id} is browser-only: settings and composer pieces, nothing else.`);
  if (
    manifest.scope === "installation" &&
    (namespace !== undefined ||
      tools.length > 0 ||
      panels.length > 0 ||
      manifest.ui?.renderers !== undefined ||
      manifest.ui?.slots !== undefined)
  )
    throw new Error(`Capability ${manifest.id} serves the installation: no tools, namespace or chat pieces.`);
  if ((manifest.advisor !== undefined || manifest.providers !== undefined) && manifest.scope !== "installation")
    throw new Error(`Capability ${manifest.id} must serve the installation to advise or offer providers.`);
  if (namespace !== undefined && (namespace.name !== manifest.id || namespace.prefix !== `${own}_`))
    throw new Error(`Capability ${manifest.id} has an invalid Code Mode namespace.`);
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
    throw new Error(`Capability ${manifest.id} has duplicate tools.`);
  for (const tool of tools) {
    if (tool.callers.includes("model") && !MODEL_TOOLS.has(tool.name))
      throw new Error(`Capability ${manifest.id} cannot let the model call ${tool.name} directly.`);
    if (tool.callers.includes("tools") && (namespace === undefined || !tool.name.startsWith(namespace.prefix)))
      throw new Error(`Capability ${manifest.id} has a Code Mode tool outside its namespace.`);
  }
  if (storage?.owns.some((table) => table !== `pal_${own}` && !table.startsWith(`pal_${own}_`)))
    throw new Error(`Capability ${manifest.id} can only own tables named after it.`);
  return manifest;
}
export function capabilityIdentity(manifest: CapabilityManifest, release: string): CapabilityIdentity {
  return {
    id: manifest.id,
    version: manifest.version,
    digest: createHash("sha256")
      .update(JSON.stringify([CAPABILITY_API, release, manifest]))
      .digest("hex"),
  };
}

/**
 * SQL a plugin's statements may run: reads name only its declared tables, changes only its own. A check that keeps
 * trusted code to its contract, not a sandbox; anything else, including multi-statement `exec`, is refused.
 */
const SETTING_NAME = /^[a-z][a-z0-9.-]{0,63}$/;
const MAX_SETTING_BYTES = 16 * 1024;

/** A plugin's settings live in `pal_settings` under `plugin:<id>:`, a prefix no kernel setting uses. */
function pluginSettings(database: SqliteDatabase, id: string): PluginSettings {
  const key = (name: string) => {
    if (!SETTING_NAME.test(name)) throw new Error(`Capability ${id} used an invalid setting name.`);
    return `plugin:${id}:${name}`;
  };
  return {
    async get(name) {
      const row = await database.get<{ value: string }>("SELECT value FROM pal_settings WHERE key = ?", key(name));
      if (row === undefined) return undefined;
      try {
        return JSON.parse(row.value);
      } catch {
        // Neither the stored value nor the parser's message, which can quote it, belongs in an error.
        throw new Error(`Capability ${id} setting ${name} is corrupt.`);
      }
    },
    async set(name, value) {
      const text = JSON.stringify(value);
      if (text === undefined || Buffer.byteLength(text) > MAX_SETTING_BYTES)
        throw new Error(`Capability ${id} setting ${name} must be JSON of at most 16 KiB.`);
      await database.run(
        "INSERT INTO pal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        key(name),
        text,
      );
    },
  };
}

/** A plugin's secrets live in `pal_credentials` under `plugin:<id>:`, sealed like provider keys. */
function pluginSecrets(credentials: CredentialStore, id: string): PluginSecrets {
  const key = (name: string) => {
    if (!SETTING_NAME.test(name)) throw new Error(`Capability ${id} used an invalid secret name.`);
    return `plugin:${id}:${name}`;
  };
  const read = async (name: string) => {
    const credential = await credentials.read(key(name));
    return credential?.type === "api_key" ? credential.key : undefined;
  };
  return {
    has: async (name) => (await read(name)) !== undefined,
    get: read,
    async set(name, value) {
      if (value === "" || Buffer.byteLength(value) > 4096)
        throw new Error(`Capability ${id} secret ${name} must be 1 byte to 4 KiB.`);
      await credentials.modify(key(name), async () => ({ type: "api_key", key: value }));
    },
    clear: (name) => credentials.delete(key(name)),
  };
}

function scopedSql(database: SqliteDatabase, manifest: CapabilityManifest): SqliteDatabase {
  const owns = new Set(manifest.storage?.owns ?? []);
  const reads = new Set([...owns, ...(manifest.storage?.reads ?? [])]);
  const check = (sql: string) => {
    if (!/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(sql))
      throw new Error(`Capability ${manifest.id} may only query and change rows.`);
    const allowed = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql) ? owns : reads;
    for (const [table] of sql.matchAll(/\b(?:pal|pi)_[a-z0-9_]+/gi))
      if (!allowed.has(table.toLowerCase())) throw new Error(`Capability ${manifest.id} has no access to ${table}.`);
  };
  const executor = (target: SqliteExecutor): SqliteExecutor => ({
    exec: async () => {
      throw new Error(`Capability ${manifest.id} may only query and change rows.`);
    },
    run: async (sql: string, ...params: SqliteValue[]) => {
      check(sql);
      return target.run(sql, ...params);
    },
    runCounted: async (sql: string, ...params: SqliteValue[]) => {
      check(sql);
      return target.runCounted(sql, ...params);
    },
    get: async <T extends object>(sql: string, ...params: SqliteValue[]) => {
      check(sql);
      return target.get<T>(sql, ...params);
    },
    all: async <T extends object>(sql: string, ...params: SqliteValue[]) => {
      check(sql);
      return target.all<T>(sql, ...params);
    },
  });
  return {
    ...executor(database),
    transaction: (work) => database.transaction((tx) => work(executor(tx))),
    close: async () => {
      throw new Error(`Capability ${manifest.id} cannot close the database.`);
    },
  };
}

export class CompiledCapabilities {
  readonly #opened: { manifest: CapabilityManifest; runtime: CapabilityRuntime; extension: Extension }[] = [];
  #closing: Promise<void> | undefined;
  private constructor() {}

  static async open(definitions: readonly CompiledCapability[], kernel: KernelServices) {
    if (definitions.length > 16) throw new Error("Too many compiled capabilities.");
    const prepared = definitions.map((definition) => ({
      definition,
      manifest: capabilityManifest(definition.manifest),
    }));
    const ids = new Set<string>(),
      natives = new Set<string>(),
      names = new Set<string>();
    if (prepared.filter(({ manifest }) => manifest.advisor !== undefined).length > 1)
      throw new Error("A Pal build has at most one advisor.");
    const offered = prepared.flatMap(({ manifest }) => (manifest.providers ?? []).map(({ id }) => id));
    if (new Set(offered).size !== offered.length) throw new Error("Duplicate plugin provider.");
    for (const { manifest } of prepared) {
      if (manifest.scope === "browser")
        throw new Error(`Capability ${manifest.id} is browser-only and has no server part.`);
      if (ids.has(manifest.id) || natives.has(manifest.native)) throw new Error("Duplicate compiled capability.");
      ids.add(manifest.id);
      natives.add(manifest.native);
      for (const tool of manifest.tools ?? []) {
        if (names.has(tool.name)) throw new Error("Duplicate compiled capability tool.");
        names.add(tool.name);
      }
    }
    const { database, options, credentials, ...services } = kernel;
    const opened = new CompiledCapabilities();
    try {
      for (const { definition, manifest } of prepared) {
        const runtime = await definition.open({
          ...services,
          sql: scopedSql(database, manifest),
          settings: pluginSettings(database, manifest.id),
          secrets: pluginSecrets(credentials, manifest.id),
          options: options?.[manifest.id],
        });
        const record = { manifest, runtime, extension: defineExtension({ name: manifest.native }) };
        opened.#opened.push(record);
        if ((manifest.advisor === undefined) !== (runtime.advisor === undefined))
          throw new Error(`Capability ${manifest.id} advisor declaration differs.`);
        if (
          JSON.stringify((manifest.providers ?? []).map(({ id }) => id)) !==
          JSON.stringify((runtime.providers ?? []).map(({ id }) => id))
        )
          throw new Error(`Capability ${manifest.id} provider declarations differ.`);
        const declarations = manifest.tools ?? [];
        if ((runtime.tools ?? []).length !== declarations.length)
          throw new Error(`Capability ${manifest.id} tool declarations differ.`);
        const tools = declarations.map((declared) => {
          const matches = (runtime.tools ?? []).filter((tool) => tool.name === declared.name);
          const tool = matches[0];
          if (
            matches.length !== 1 ||
            tool === undefined ||
            tool.replay !== declared.replay ||
            JSON.stringify([...(tool.callers ?? [])].sort()) !== JSON.stringify([...declared.callers].sort())
          )
            throw new Error(`Capability ${manifest.id} must retain its declared replay and callers.`);
          const leased = declared.permissions.includes("project.read");
          return {
            ...tool,
            outputLimits: {
              ...tool.outputLimits,
              maxBytes: Math.min(tool.outputLimits?.maxBytes ?? declared.maxOutputBytes, declared.maxOutputBytes),
            },
            execute: async (args, api, context) => {
              if (!leased) return tool.execute(args, api, context);
              const lease = await services.authorize(api, context);
              await lease.check();
              const result = await tool.execute(args, api, context);
              await lease.check();
              return result;
            },
          } satisfies NonNullable<Extension["tools"]>[number];
        });
        record.extension = defineExtension({ name: manifest.native, tools });
      }
      return opened;
    } catch (error) {
      await opened.close().catch(() => {});
      throw error;
    }
  }
  install(registry: Registry) {
    const snapshot = registry.snapshot();
    const tools = new Set(snapshot.tools().map(({ tool }) => tool.name));
    for (const { extension } of this.#opened) {
      if (snapshot.extension(extension.name) !== undefined || extension.tools?.some((tool) => tools.has(tool.name)))
        throw new Error(`Capability ${extension.name} collides with the kernel registry.`);
    }
    for (const { extension } of this.#opened) registry.install(extension);
  }
  get namespaces(): readonly CodemodeNamespace[] {
    return this.#opened.flatMap(({ manifest }) => (manifest.namespace === undefined ? [] : [manifest.namespace]));
  }
  allows(name: string) {
    return (
      this.#closing === undefined &&
      this.#opened.some(({ manifest }) => manifest.tools?.some((tool) => tool.name === name) === true)
    );
  }
  /** The build's advisor while open, labelled as its manifest names it. */
  get advisor(): (CapabilityAdvisor & { label: string }) | undefined {
    if (this.#closing !== undefined) return undefined;
    for (const { manifest, runtime } of this.#opened)
      if (manifest.advisor !== undefined && runtime.advisor !== undefined)
        return { label: manifest.advisor.label, status: runtime.advisor.status, advise: runtime.advisor.advise };
    return undefined;
  }
  /** The providers plugins offer while open, each named as its manifest declares it. */
  get providers(): readonly (CapabilityProvider & { name: string; plugin: string })[] {
    if (this.#closing !== undefined) return [];
    return this.#opened.flatMap(({ manifest, runtime }) =>
      (runtime.providers ?? []).map((offered) => ({
        id: offered.id,
        billing: offered.billing,
        provider: offered.provider,
        status: () => offered.status(),
        stop: async () => await offered.stop?.(),
        name: manifest.providers?.find(({ id }) => id === offered.id)?.name ?? offered.id,
        plugin: manifest.id,
      })),
    );
  }
  service<T>(id: string): T | undefined {
    return this.#opened.find(({ manifest }) => manifest.id === id)?.runtime.service as T | undefined;
  }
  /** Route an owner request to the plugin it names. */
  async request(id: string, request: CapabilityRequest, context: Context): Promise<unknown> {
    const api = this.#opened.find(({ manifest }) => manifest.id === id)?.runtime.api;
    if (api === undefined || this.#closing !== undefined)
      throw new HttpError(404, "not_found", `no plugin ${id} answers requests in this build`);
    return api(request, context);
  }
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      const failures: unknown[] = [];
      for (const { runtime } of this.#opened.toReversed()) {
        try {
          await runtime.dispose?.();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Capability disposal failed.");
    })());
  }
}
