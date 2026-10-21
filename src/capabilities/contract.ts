import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  type ConversationId,
  type Extension,
  type Registry,
  type Storage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { Type, type Static } from "typebox";
import type { FolderGrants, FolderLease } from "../core/folders.ts";
import type { ProjectMemory } from "../core/memory.ts";
import { validate } from "../core/requests.ts";

export const CAPABILITY_API = 1;
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
    panels: Type.Array(Type.Enum(["Files", "Changes", "Terminal", "Context", "Browser"]), {
      maxItems: 5,
      uniqueItems: true,
    }),
    settings: Type.Literal("new-chat-selection"),
    namespace: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 40 }),
        prefix: Type.String({ minLength: 2, maxLength: 41 }),
        description: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
        instructions: Type.Optional(Type.String({ maxLength: 4000 })),
      },
      { additionalProperties: false },
    ),
    optIn: Type.Optional(Type.Boolean()),
    tools: Type.Array(
      Type.Object(
        {
          name: Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }),
          replay: Type.Enum(["safe", "unsafe"]),
          permissions: Type.Array(Type.Literal("project.read"), { minItems: 1, maxItems: 1 }),
          maxOutputBytes: Type.Integer({ minimum: 1, maximum: 64 * 1024 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 16 },
    ),
  },
  { additionalProperties: false },
);
export type CapabilityManifest = Static<typeof Manifest>;
export type CapabilityIdentity = { id: string; version: number; digest: string };

/** Trusted compiled code shares the kernel's owner; this is not a sandbox or a code installer. */
export type CapabilityHost = {
  database: SqliteDatabase;
  storage: Storage;
  folders: FolderGrants;
  deny: readonly string[];
  project(conversation: ConversationId): Promise<{ id: string; workspace: string } | undefined>;
  authorize(api: ToolExecutionApi, context: Context): Promise<FolderLease>;
};
export type CapabilityRuntime = {
  tools: NonNullable<Extension["tools"]>;
  memory?: ProjectMemory;
  /** Called after durable work stops; release ephemeral resources, never mutate durable state here. */
  dispose?(): void | Promise<void>;
};
export type CompiledCapability = {
  manifest: CapabilityManifest;
  /** A failed open must release anything it acquired before throwing. */
  open(host: CapabilityHost): CapabilityRuntime | Promise<CapabilityRuntime>;
};
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
]);

export function capabilityManifest(input: unknown): CapabilityManifest {
  const manifest = validate(Manifest, structuredClone(input));
  if (manifest.core.min > CAPABILITY_API || manifest.core.max < CAPABILITY_API)
    throw new Error(`Capability ${manifest.id}@${manifest.version} needs a different Pal capability API.`);
  if (reserved.has(manifest.id) || reserved.has(manifest.native.slice(4)))
    throw new Error(`Capability ${manifest.id} cannot replace a core contribution.`);
  if (manifest.namespace.name !== manifest.id || manifest.namespace.prefix !== `${manifest.id.replaceAll("-", "_")}_`)
    throw new Error(`Capability ${manifest.id} has an invalid Code Mode namespace.`);
  const names = manifest.tools.map((tool) => tool.name);
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !name.startsWith(`${manifest.id.replaceAll("-", "_")}_`))
  )
    throw new Error(`Capability ${manifest.id} has duplicate or out-of-namespace tools.`);
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

export class CompiledCapabilities {
  readonly #opened: { manifest: CapabilityManifest; runtime: CapabilityRuntime; extension: Extension }[] = [];
  #closing: Promise<void> | undefined;
  private constructor() {}

  static async open(definitions: readonly CompiledCapability[], host: CapabilityHost) {
    if (definitions.length > 16) throw new Error("Too many compiled capabilities.");
    const prepared = definitions.map((definition) => ({
      definition,
      manifest: capabilityManifest(definition.manifest),
    }));
    const ids = new Set<string>(),
      natives = new Set<string>(),
      names = new Set<string>();
    for (const { manifest } of prepared) {
      if (ids.has(manifest.id) || natives.has(manifest.native)) throw new Error("Duplicate compiled capability.");
      ids.add(manifest.id);
      natives.add(manifest.native);
      for (const tool of manifest.tools) {
        if (names.has(tool.name)) throw new Error("Duplicate compiled capability tool.");
        names.add(tool.name);
      }
    }
    const opened = new CompiledCapabilities();
    try {
      for (const { definition, manifest } of prepared) {
        const runtime = await definition.open(host);
        const record = { manifest, runtime, extension: defineExtension({ name: manifest.native }) };
        opened.#opened.push(record);
        if ((runtime.memory !== undefined) !== (manifest.id === "memory"))
          throw new Error("The memory service must be provided by memory, and only memory.");
        if (runtime.tools.length !== manifest.tools.length)
          throw new Error(`Capability ${manifest.id} tool declarations differ.`);
        const tools = manifest.tools.map((declared) => {
          const matches = runtime.tools.filter((tool) => tool.name === declared.name);
          const tool = matches[0];
          if (
            matches.length !== 1 ||
            tool === undefined ||
            tool.replay !== declared.replay ||
            tool.callers?.length !== 1 ||
            tool.callers[0] !== "tools"
          )
            throw new Error(`Capability ${manifest.id} must retain its declared replay and Code Mode-only tools.`);
          return {
            ...tool,
            outputLimits: {
              ...tool.outputLimits,
              maxBytes: Math.min(tool.outputLimits?.maxBytes ?? declared.maxOutputBytes, declared.maxOutputBytes),
            },
            execute: async (args, api, context) => {
              const lease = await host.authorize(api, context);
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
    return this.#opened.map(({ manifest }) => manifest.namespace);
  }
  allows(name: string) {
    return (
      this.#closing === undefined &&
      this.#opened.some(({ manifest }) => manifest.tools.some((tool) => tool.name === name))
    );
  }
  get memory() {
    return this.#opened.find(({ manifest }) => manifest.id === "memory")?.runtime.memory;
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
