import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { contentText, type Message, type Models } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  DEFAULT_COMPACTION_POLICY,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  type Harness,
  type EntryId,
  type EntryRecord,
  type Storage,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { type Static, Type } from "typebox";
import type { Chat } from "./chats.ts";
import { HttpError } from "./http.ts";
import { MAX_UPLOAD_BYTES } from "./uploads.ts";
import { MAX_INPUT_ATTACHMENTS } from "../protocol/limits.ts";
import { validate } from "./requests.ts";

export function entryText(entry: EntryRecord): string {
  return (entry.model ?? [])
    .flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      if (typeof message.content === "string") return [message.content.slice(0, 4000)];
      return message.content.flatMap((block) => (block.type === "text" ? [block.text.slice(0, 4000)] : []));
    })
    .join("\n")
    .slice(0, 4000);
}

const BUDGETS = { pinnedTokens: 1500, pinnedBytes: 6144, previewBytes: 65536 };
const Pin = Type.Object(
  { revision: Type.Integer({ minimum: 0 }), text: Type.String({ maxLength: 6144 }) },
  { additionalProperties: false },
);
const PinnedInstructions = defineDoc({
  kind: "pal.pinnedInstructions",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ revision: 0, text: "" }),
});
const RequestPhase = Type.Object({
  phase: Type.Literal("request"),
  attempt: Type.Integer({ minimum: 0 }),
  cutoff: Type.Integer({ minimum: 1 }),
  model: Type.Object({ provider: Type.String(), modelId: Type.String() }),
  thinkingLevel: Type.String(),
});
type Prepared = {
  task: number;
  cutoff: number;
  at: number;
  attempt: number;
  model: { provider: string; modelId: string };
  thinkingLevel: string;
  digest: string;
  messages: number;
  estimatedTokens: number;
  contextWindow: number | null;
  reserveTokens: number;
};
const PreparedContext = defineDoc({
  kind: "pal.preparedContext",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "rewindable",
  fork: "initial",
  initial: () => ({ latest: null as Prepared | null }),
});
const Lookup = Type.Object(
  {
    query: Type.String({ maxLength: 200 }),
    candidates: Type.Array(
      Type.Object({ id: Type.String({ maxLength: 64 }), revision: Type.Integer({ minimum: 1 }) }),
      { maxItems: 10 },
    ),
    truncated: Type.Boolean(),
    at: Type.Number(),
  },
  { additionalProperties: false },
);
const Uploads = Type.Object({
  attachments: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64 }),
      name: Type.String({ maxLength: 255 }),
      size: Type.Integer({ minimum: 0, maximum: MAX_UPLOAD_BYTES }),
      mediaType: Type.String({ maxLength: 200 }),
    }),
    { maxItems: MAX_INPUT_ATTACHMENTS },
  ),
});
const Page = Type.Object({
  offset: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  request: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
});

/** Pi stores instructions and preparation pointers; the inspector never copies the prompt into a second journal. */
export class ChatContext {
  readonly extension;
  readonly #database: SqliteDatabase;
  readonly #harness: () => Harness;
  readonly #storage: Storage;
  #readers = 0;

  constructor(database: SqliteDatabase, harness: () => Harness, models: Models, storage: Storage) {
    this.#database = database;
    this.#harness = harness;
    this.#storage = storage;
    this.extension = defineExtension({
      name: "pal.context",
      sections: [
        {
          key: "pinned",
          render: async (input, context) => {
            const pin = await input.read.snapshot(PinnedInstructions, input.conversationId, context);
            return pin === undefined || pin.text === "" ? undefined : this.#pin(pin).text;
          },
        },
      ],
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (request, api, context) => {
            const harness = this.#harness();
            const task = await harness.getTask(api.taskId, context);
            if (task?.state.status !== "running") return;
            const phase = validate(RequestPhase, task.state.checkpoint);
            const model = models.getModel(phase.model.provider, phase.model.modelId);
            const prepared: Prepared = {
              task: api.taskId,
              cutoff: phase.cutoff,
              at: Date.now(),
              attempt: phase.attempt,
              model: phase.model,
              thinkingLevel: phase.thinkingLevel,
              digest: digest(request.messages),
              messages: request.messages.length,
              estimatedTokens: estimateContextTokens(request.messages).tokens,
              contextWindow: model?.contextWindow ?? null,
              reserveTokens: DEFAULT_COMPACTION_POLICY.reserveTokens,
            };
            await harness.commit(async (tx) => {
              const doc = await tx.doc(PreparedContext, api.conversationId);
              if (doc.latest === null || doc.latest.task <= prepared.task) doc.latest = prepared;
            }, context);
          },
        }),
      ],
    });
  }

  #pin(value: unknown) {
    const pin = validate(Pin, value);
    if (Buffer.byteLength(pin.text) > BUDGETS.pinnedBytes || estimateTextTokens(pin.text) > BUDGETS.pinnedTokens)
      throw new HttpError(400, "context_budget", "Pinned instructions exceed 1,500 estimated tokens or 6 KiB UTF-8.");
    return pin;
  }
  async #ready(chat: Chat) {
    const live = await this.#database.get(
      "SELECT c.id FROM pal_chats c JOIN pal_projects p ON p.id = c.project_id WHERE c.id = ? AND c.conversation_id = ? AND c.deleted_at IS NULL AND p.removed_at IS NULL AND p.state = 'ready'",
      chat.id,
      chat.conversationId,
    );
    if (live === undefined) throw new HttpError(404, "not_found", "the chat or project was removed");
  }
  async #conversation(chat: Chat, context: Context) {
    await this.#ready(chat);
    const conversation = await this.#harness().conversation(chat.conversationId, context);
    if (conversation === undefined) throw new HttpError(404, "not_found", "the conversation is missing");
    return conversation;
  }

  async inspect(chat: Chat, context: Context) {
    const conversation = await this.#conversation(chat, context);
    const harness = this.#harness();
    const [agent, history, pin, prepared, marker] = await Promise.all([
      conversation.agent(context),
      conversation.entries({}, 20, undefined, context),
      harness.snapshot(PinnedInstructions, chat.conversationId, context),
      harness.snapshot(PreparedContext, chat.conversationId, context),
      this.#storage.findLatestHeadMarker(chat.conversationId, undefined, context),
    ]);
    const sources = history.items.flatMap((entry) => {
      const text = entryText(entry);
      return text === "" ? [] : [{ entry: entry.id as number, kind: entry.kind, text }];
    });
    const lookups = history.items.flatMap((entry) =>
      entry.kind === "pal.memory" ? [{ entry: entry.id as number, ...validate(Lookup, entry.data) }] : [],
    );
    const attachments = new Map<string, Static<typeof Uploads>["attachments"][number]>();
    for (const entry of history.items) {
      if (entry.kind !== "pal.user") continue;
      for (const item of validate(Uploads, entry.data).attachments)
        if (!attachments.has(item.id) && attachments.size < 50) attachments.set(item.id, item);
    }
    await this.#ready(chat);
    const pinned = this.#pin(pin ?? { revision: 0, text: "" });
    return {
      instructions: agent.instructions ?? "",
      model: agent.model ?? null,
      head: (marker?.id as number | undefined) ?? null,
      sources,
      lookups,
      moreHistory: history.next !== undefined,
      pinned: { ...pinned, estimatedTokens: estimateTextTokens(pinned.text), bytes: Buffer.byteLength(pinned.text) },
      prepared: prepared?.latest ?? null,
      attachments: [...attachments.values()],
      budgets: BUDGETS,
    };
  }

  async pin(chat: Chat, input: unknown, context: Context) {
    const pin = this.#pin(input);
    await this.#harness().commit(async (tx) => {
      await this.#ready(chat);
      const doc = await tx.doc(PinnedInstructions, chat.conversationId);
      if (doc.revision !== pin.revision)
        throw new HttpError(409, "context_stale", "Instructions changed elsewhere. Refresh and review before saving.");
      if (doc.text !== pin.text) {
        doc.text = pin.text;
        doc.revision++;
      }
    }, context);
  }

  async prompt(chat: Chat, input: unknown, context: Context) {
    const page = validate(Page, input);
    if (this.#readers >= 2) throw new HttpError(429, "context_busy", "Two prompt inspections are already running.");
    this.#readers++;
    try {
      const conversation = await this.#conversation(chat, context);
      const saved = (await this.#harness().snapshot(PreparedContext, chat.conversationId, context))?.latest;
      if (saved == null) throw new HttpError(409, "context_missing", "No model request has been prepared yet.");
      if (page.request !== undefined && page.request !== saved.digest)
        throw new HttpError(409, "context_stale", "A newer prompt was prepared. Refresh the inspection.");
      const view = await conversation.context(context, { at: saved.cutoff as EntryId });
      if (digest(view.messages) !== saved.digest)
        throw new HttpError(
          409,
          "context_changed",
          "The retained context differs from this preparation; not showing a guessed prompt.",
        );
      const sections = sectionPreviews(view.messages);
      const previews: { index: number; role: string; text: string; truncated: boolean }[] = [];
      let remaining = BUDGETS.previewBytes - sections.items.reduce((n, item) => n + Buffer.byteLength(item.text), 0);
      for (let i = page.offset; i < Math.min(view.messages.length, page.offset + 20) && remaining > 0; i++) {
        const message = view.messages[i];
        if (message === undefined) break;
        const bytes = Buffer.from(JSON.stringify(previewMessage(message), null, 2));
        const shown = bytes.subarray(0, Math.min(4096, remaining));
        remaining -= shown.byteLength;
        previews.push({
          index: i,
          role: message.role,
          text: new TextDecoder().decode(shown, { stream: true }),
          truncated: shown.byteLength < bytes.byteLength,
        });
      }
      await this.#ready(chat);
      return {
        request: saved,
        previews,
        sections: sections.items,
        sectionsLimited: sections.limited,
        next: page.offset + previews.length < view.messages.length ? page.offset + previews.length : null,
        offset: page.offset,
      };
    } finally {
      this.#readers--;
    }
  }
}

function sectionPreviews(messages: readonly Message[]) {
  const current = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) current.delete(name);
      else current.set(name, value);
    }
  }
  const items: { name: string; text: string; truncated: boolean }[] = [];
  let remaining = BUDGETS.previewBytes / 2;
  for (const [name, value] of current) {
    if (items.length >= 32 || remaining === 0) break;
    const bytes = Buffer.from(value);
    const shown = bytes.subarray(0, Math.min(4096, remaining));
    remaining -= shown.byteLength;
    items.push({
      name,
      text: new TextDecoder().decode(shown, { stream: true }),
      truncated: shown.byteLength < bytes.byteLength,
    });
  }
  return { items, limited: items.length < current.size };
}

function previewMessage(message: Message) {
  if (message.role === "system")
    return {
      role: message.role,
      content: contentText(message.content),
      sections: Object.entries(message.sections ?? {}).map(([name, value]) => ({ name, removed: value === null })),
      toolsAdded: message.toolsAdded,
      toolsRemoved: message.toolsRemoved,
    };
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content.map((block) => {
          if (block.type === "image") return { type: block.type, mimeType: block.mimeType, body: "Image body omitted" };
          if (block.type === "thinking") return { type: block.type, body: "Reasoning body/signature omitted" };
          if (block.type === "text") return { type: block.type, text: block.text };
          return { type: block.type, name: block.name, arguments: block.arguments };
        });
  return {
    role: message.role,
    content,
    ...(message.role === "toolResult"
      ? { tool: message.toolName, call: message.toolCallId, isError: message.isError }
      : {}),
  };
}

function digest(messages: readonly Message[]) {
  const hash = createHash("sha256");
  for (const message of messages) hash.update(JSON.stringify(message)).update("\n");
  return hash.digest("hex");
}
export type ContextInfo = Awaited<ReturnType<ChatContext["inspect"]>>;
export type PromptInfo = Awaited<ReturnType<ChatContext["prompt"]>>;
