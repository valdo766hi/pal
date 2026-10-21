import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  ToolTask,
  hook,
  type AgentChange,
  type ConversationId,
  type Extension,
  type Harness,
  type Registry,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { type Static, Type } from "typebox";
import { HttpError } from "./http.ts";
import { validate } from "./requests.ts";
import { unfinishedWork } from "./release-state.ts";
import { COMPILED_CAPABILITIES } from "../capabilities/compiled.ts";
import {
  capabilityIdentity,
  capabilityManifest,
  type CapabilityIdentity,
  type CapabilityManifest,
  type CompiledCapability,
} from "../capabilities/contract.ts";

const KERNEL_BUILTINS = [
  {
    id: "files",
    version: 1,
    name: "Files and changes",
    native: "pal.files",
    panels: ["Files", "Changes"],
    description: "Project file tools and revision-bound review. Folder grants still apply.",
  },
  {
    id: "shell",
    version: 1,
    name: "Host commands and Terminal",
    native: "pal.shell",
    panels: ["Terminal"],
    description: "Agent commands and the separate human terminal. Not sandboxed; command approvals still apply.",
  },
  {
    id: "browser",
    version: 1,
    name: "Project browser",
    native: "pal.browser",
    panels: ["Browser"],
    description:
      "Sandboxed project browser. Agent access still needs an explicit, expiring handoff and action approvals.",
  },
  {
    id: "compact",
    version: 1,
    name: "Compact command output",
    native: "pal.compact",
    panels: [],
    // Off until chosen: it changes which command runs, not only what the model reads.
    optIn: true,
    description:
      "In Full access, agent commands with an rtk equivalent run as it, so the model reads condensed output. Approved commands, pipes and redirects run unchanged. Needs rtk on PATH; receipts show what ran.",
  },
] as const;
export type BuiltinId = string;
export type PanelId = CapabilityManifest["panels"][number];
export type Contribution = Pick<CapabilityManifest, "id" | "version" | "name" | "native" | "description" | "optIn"> & {
  panels: readonly PanelId[];
  available: boolean;
  implementation: string;
  capability?: CapabilityManifest;
};
function catalogFor(definitions: readonly CompiledCapability[]) {
  const capabilities = definitions.map(({ manifest }) => capabilityManifest(manifest));
  const catalog = [...KERNEL_BUILTINS.slice(0, 2), ...capabilities, ...KERNEL_BUILTINS.slice(2)];
  if (
    new Set(catalog.map((item) => item.id)).size !== catalog.length ||
    new Set(catalog.map((item) => item.native)).size !== catalog.length
  )
    throw new Error("Duplicate compiled contribution.");
  return catalog;
}
/** Only compiled contributions; retaining a manifest does not install code or grant authority. */
export const BUILTINS = catalogFor(COMPILED_CAPABILITIES);
const Choice = Type.Object(
  { id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }), version: Type.Integer({ minimum: 1, maximum: 1_000_000 }) },
  { additionalProperties: false },
);
const Choices = Type.Array(Choice, { maxItems: 32, uniqueItems: true });
const Scope = Type.Object({ selected: Choices }, { additionalProperties: false });
const Implementations = Type.Array(
  Type.Object(
    { ...Choice.properties, digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
    { additionalProperties: false },
  ),
  { maxItems: 32 },
);
const RequestPin = Type.Object(
  {
    task: Type.Integer({ minimum: 1 }),
    release: Type.String({ maxLength: 64 }),
    selected: Choices,
    implementations: Type.Optional(Implementations),
  },
  { additionalProperties: false },
);
export type ExtensionRequestPin = Static<typeof RequestPin>;
export type ExtensionScope = Static<typeof Scope>;
export type ExtensionView = {
  release: string;
  digest: string;
  selected: ExtensionScope["selected"];
  catalog: readonly Contribution[];
};
export const ExtensionSelection = Type.Object(
  { selected: Choices, digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false },
);
const RunPin = defineDoc({
  kind: "pal.extensionRun",
  version: 1,
  scope: "task",
  initial: () => ({
    release: "",
    selected: [] as ExtensionScope["selected"],
    implementations: null as CapabilityIdentity[] | null,
  }),
});

export function extensionScope(intent: string): string | undefined {
  let body: { extensions?: unknown };
  try {
    body = JSON.parse(intent);
  } catch {
    throw new Error("the chat's extension scope is corrupt");
  }
  if (body.extensions === undefined) return undefined;
  if (typeof body.extensions !== "string") throw new Error("the chat's extension scope is corrupt");
  selectedExtensions(body.extensions);
  return body.extensions;
}
export function selectedExtensions(
  scope: string | undefined,
  catalog: readonly Pick<CapabilityManifest, "id" | "version" | "optIn">[] = BUILTINS,
): ExtensionScope["selected"] {
  if (scope === undefined)
    return catalog.flatMap((item) =>
      "optIn" in item && item.optIn === true ? [] : [{ id: item.id, version: item.version }],
    );
  let value: unknown;
  try {
    value = JSON.parse(scope);
  } catch {
    throw new Error("the chat's extension scope is corrupt");
  }
  return validate(Scope, value).selected;
}

/** Pin immutable outputs directly; verify mutable runtime bytes before any unfinished work can resume. */
export async function releaseIdentity(installRoot: string, dataRoot?: string): Promise<string> {
  const root = await realpath(installRoot).catch(() => installRoot);
  const output = /^\/nix\/store\/[a-z0-9]{32}-[^/]+/.exec(root)?.[0];
  if (output !== undefined) return createHash("sha256").update(output).digest("hex");
  const { mutableIdentity } = await import("./implementation.ts");
  return mutableIdentity(root, dataRoot);
}

export class BuiltinExtensions {
  readonly extension: Extension;
  readonly release: string;
  readonly #database: SqliteDatabase;
  readonly #registry: Registry;
  readonly #catalog: readonly Contribution[];

  private constructor(
    database: SqliteDatabase,
    registry: Registry,
    harness: () => Harness,
    release: string,
    catalog: ReturnType<typeof catalogFor>,
  ) {
    this.#database = database;
    this.#registry = registry;
    this.release = release;
    this.#catalog = catalog.map((item) => ({
      ...item,
      available: true,
      implementation:
        "core" in item
          ? capabilityIdentity(item, release).digest
          : createHash("sha256")
              .update(JSON.stringify([release, item]))
              .digest("hex"),
      ...("core" in item ? { capability: item } : {}),
    }));
    this.extension = defineExtension({
      name: "pal.extensions",
      hooks: [
        hook(ToolTask, {
          beforeTool: async (_call, api, context) => {
            const pinned = await api.memo("pal.extensionRelease", release, context);
            if (pinned !== release)
              return { block: "This tool needs its retained Pal release; its implementation pin changed." };
            const missing = await this.#conversationMismatch(api.conversationId);
            return missing === undefined ? undefined : { block: missing };
          },
        }),
        // Request hooks are metadata; the startup check and blocking tool hook enforce implementation pins.
        hook(GenerationTask, {
          beforeRequest: async (_request, api, context) => {
            const missing = await this.#conversationMismatch(api.conversationId);
            if (missing !== undefined) throw new Error(missing);
            const running = harness();
            const conversation = await running.conversation(api.conversationId, context);
            if (conversation === undefined) throw new Error("the pinned conversation is missing");
            const agent = await conversation.agent(context);
            const names = new Set(agent.extensions.map((extension) => extension.name));
            const selected = this.#catalog.flatMap(({ id, version, native }) =>
              names.has(native) ? [{ id, version }] : [],
            );
            const implementations = this.#identities(selected);
            await running.commit(async (tx) => {
              const pin = await tx.doc(RunPin, api.taskId);
              if (
                pin.release !== "" &&
                (pin.release !== release ||
                  JSON.stringify(pin.selected) !== JSON.stringify(selected) ||
                  (pin.implementations !== null &&
                    JSON.stringify(pin.implementations) !== JSON.stringify(implementations)))
              )
                throw new Error("the active extension pin changed; resume with the retained release instead");
              if (pin.release === "") {
                pin.release = release;
                pin.selected = selected;
                pin.implementations = implementations;
                await tx.appendEntry(api.conversationId, {
                  kind: "pal.extensions",
                  data: { task: api.taskId, release, selected, implementations },
                });
              }
            }, context);
          },
        }),
      ],
    });
  }

  static async open(
    database: SqliteDatabase,
    registry: Registry,
    harness: () => Harness,
    release: string,
    definitions: readonly CompiledCapability[] = COMPILED_CAPABILITIES,
  ) {
    const catalog = catalogFor(definitions);
    const identity = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
    await database.transaction(async (tx) => {
      const previous = await tx.get<{ value: string }>(
        "SELECT value FROM pal_settings WHERE key = 'extensions:release'",
      );
      const saved = await tx.get<{ value: string }>("SELECT value FROM pal_settings WHERE key = 'extensions:catalog'");
      if (previous?.value === release && saved?.value === identity) return;
      if ((await unfinishedWork(tx)) > 0)
        throw new Error("unfinished work needs its retained Pal release; refusing to change extension implementations");
      for (const [key, value] of [
        ["extensions:release", release],
        ["extensions:catalog", identity],
      ] as const)
        await tx.run(
          "INSERT INTO pal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          key,
          value,
        );
    });
    return new BuiltinExtensions(database, registry, harness, release, catalog);
  }

  async view(): Promise<ExtensionView> {
    const row = await this.#database.get<{ value: string }>(
      "SELECT value FROM pal_settings WHERE key = 'extensions:selection'",
    );
    const selected = selectedExtensions(row?.value, this.#catalog);
    const missing = selected.filter((choice) => !this.#catalog.some((item) => item.id === choice.id));
    const catalog: Contribution[] = [
      ...this.#catalog,
      ...missing.map((choice) => ({
        ...choice,
        name: `Unavailable ${choice.id}`,
        native: `pal.${choice.id}`,
        panels: [],
        available: false,
        implementation: "",
        description:
          "Not included in this build. Disable this default for new chats; existing chats require their retained release.",
      })),
    ];
    return { release: this.release, selected, digest: this.#digest(selected), catalog };
  }
  check(selected: ExtensionScope["selected"]) {
    const missing = this.#mismatch(selected);
    if (missing !== undefined) throw new HttpError(409, "capability_unavailable", missing);
  }
  async select(input: unknown): Promise<ExtensionView> {
    const body = validate(ExtensionSelection, input);
    this.check(body.selected);
    await this.#database.transaction(async (tx) => {
      const row = await tx.get<{ value: string }>("SELECT value FROM pal_settings WHERE key = 'extensions:selection'");
      if (this.#digest(selectedExtensions(row?.value, this.#catalog)) !== body.digest)
        throw new HttpError(409, "extensions_stale", "Extension defaults changed; reload before saving.");
      await tx.run(
        "INSERT INTO pal_settings (key, value) VALUES ('extensions:selection', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        JSON.stringify({ selected: body.selected }),
      );
    });
    return this.view();
  }
  async capture(): Promise<string> {
    return JSON.stringify({ selected: (await this.view()).selected });
  }
  agent(scope: string | undefined): AgentChange {
    const choices = selectedExtensions(scope, this.#catalog);
    this.check(choices);
    const selected = new Set(choices.map((item) => item.id));
    const excluded = new Set<string>(this.#catalog.flatMap((item) => (selected.has(item.id) ? [] : [item.native])));
    return {
      extensions: this.#registry
        .snapshot()
        .installed()
        .filter((extension) => !excluded.has(extension.name)),
    };
  }
  #mismatch(selected: ExtensionScope["selected"]) {
    const choice = selected.find(
      (choice) => !this.#catalog.some((item) => item.id === choice.id && item.version === choice.version),
    );
    return choice === undefined
      ? undefined
      : `Capability ${choice.id}@${choice.version} is not available in this build; use this chat's retained Pal release.`;
  }
  async #conversationMismatch(conversation: ConversationId) {
    const row = await this.#database.get<{ intent: string }>(
      "SELECT intent FROM pal_chats WHERE conversation_id = ?",
      conversation,
    );
    return row === undefined ? undefined : this.#mismatch(selectedExtensions(extensionScope(row.intent)));
  }
  #identities(selected: ExtensionScope["selected"]): CapabilityIdentity[] {
    return selected.map((choice) => {
      const item = this.#catalog.find((item) => item.id === choice.id && item.version === choice.version);
      if (item === undefined) throw new Error("Missing capability implementation.");
      return { ...choice, digest: item.implementation };
    });
  }
  #digest(selected: ExtensionScope["selected"]): string {
    return createHash("sha256")
      .update(JSON.stringify([this.release, this.#catalog, selected]))
      .digest("hex");
  }
  async pins(conversation: ConversationId, harness: Harness, context: Context): Promise<ExtensionRequestPin[]> {
    const page = await (await harness.conversation(conversation, context))?.entries({}, 100, undefined, context);
    return (
      page?.items.flatMap((entry) => (entry.kind === "pal.extensions" ? [validate(RequestPin, entry.data)] : [])) ?? []
    );
  }
}
