import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ImageContent, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import {
  type Agent,
  type AgentChange,
  configure,
  type ConversationId,
  defineDocFamily,
  type Harness,
  InboxDoc,
  LiveDoc,
  type ModelRef,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { type Static, Type } from "typebox";
import { InvalidRequest, normalize, RequestConflict, validate } from "./requests.ts";
import { extensionScope, selectedExtensions, type ExtensionScope } from "./extensions.ts";
import { WorkspaceMode, workspaceMode } from "./workspaces.ts";
import { HttpError } from "./http.ts";
import type { Changes } from "./changes.ts";
import { type AttachmentLabel, UploadError } from "./uploads.ts";
import { MAX_INPUT_ATTACHMENTS, MAX_INPUT_CHARS } from "../protocol/limits.ts";

export const ChatBody = Type.Object(
  {
    projectId: Type.String({ minLength: 1, maxLength: 64 }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    workspace: Type.Optional(WorkspaceMode),
  },
  { additionalProperties: false },
);
const RenameBody = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    expectedTitle: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export const ConfigurationRevision = Type.String({ pattern: "^[a-f0-9]{64}$" });
const FeedbackBody = Type.Object(
  {
    ids: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 200, uniqueItems: true }),
    scope: Type.Union([Type.Literal("normal"), Type.Literal("include-ignored")]),
  },
  { additionalProperties: false },
);
export const InputBody = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: MAX_INPUT_CHARS }),
    whenBusy: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")])),
    /** Upload IDs from this chat's project, in the order shown. */
    attachments: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: MAX_INPUT_ATTACHMENTS }),
    ),
    configuration: Type.Optional(ConfigurationRevision),
    feedback: Type.Optional(FeedbackBody),
  },
  { additionalProperties: false },
);
export type ChatBody = Static<typeof ChatBody>;
export type InputBody = Static<typeof InputBody>;

export class ChatNotFound extends Error {}
/** The chat's project does not exist or is not ready. */
export class ProjectUnavailable extends Error {}
/** Admission stopped after a storage failure; the process must restart and reconcile before admitting again. */
export class AdmissionStopped extends Error {}
/** A recorded input whose attachments cannot be read; it blocks only its own chat, and later inputs wait behind it. */
export class InputBlocked extends Error {}
/** A new input refused, not recorded, because an earlier one in its chat is blocked. */
export class InputHeld extends Error {}

/** Crash points between Pal's and Pi's commits, for deterministic recovery tests. */
export type Barrier = "chat-recorded" | "chat-created" | "input-recorded" | "input-submitted" | "input-admitted";

export type Chat = { readonly id: string; readonly conversationId: ConversationId };
export type ChatSummary = Chat & {
  readonly projectId: string;
  readonly title: string | null;
  readonly createdAt: number;
  readonly extensions: ExtensionScope["selected"];
  /** The input holding this chat back, until the owner retries or withdraws it. */
  readonly blocked: BlockedInput | null;
};
export type BlockedInput = { readonly requestId: string; readonly text: string; readonly reason: string };
export type Admission = { readonly chatId: string; readonly requestId: string; readonly submissionId: SubmissionId };
export type InputRecord =
  { readonly state: "admitted"; readonly admission: Admission } | { readonly state: "admitting" | "withdrawn" };

/**
 * The Pal chat each Pi conversation was created for, written in the commit that creates the conversation: Pi has no
 * caller-chosen conversation IDs, so this is how a crash before Pal records the mapping is found again.
 */
const ChatDoc = defineDocFamily({
  kind: "pal.chat",
  version: 1,
  checkpointWhen: () => false,
  scope: "session",
  family: true,
  initial: (conversationId: ConversationId) => ({ conversationId }),
});

class AlreadyProvisioned extends Error {}

export type ChatServiceOptions = {
  readonly database: SqliteDatabase;
  readonly harness: Harness;
  /** Agent settings for a new conversation in a project; undefined while the project is missing or not ready. */
  readonly agentFor: (
    projectId: string,
    chatId?: string,
    mode?: WorkspaceMode,
    extensions?: string,
  ) => Promise<AgentChange | undefined>;
  /** Frozen with the chat record, before Pi conversation creation, so recovery cannot adopt newer defaults. */
  readonly extensions?: () => Promise<string>;
  /** Validate new inputs without changing already admitted receipts or reconciliation. */
  readonly checkExtensions?: (selected: ExtensionScope["selected"]) => void;
  /** Device uploads a message may attach: checked before admission, turned into model content at submission. */
  readonly attachments?: {
    check(
      projectId: string,
      ids: readonly string[],
    ): Promise<readonly { id: string; name: string; size: number; mediaType: string }[]>;
    content(
      projectId: string,
      ids: readonly string[],
    ): Promise<{ content: (TextContent | ImageContent)[]; labels: AttachmentLabel[] }>;
  };
  readonly feedback?: Pick<Changes, "checkFeedback" | "admitFeedback">;
  /** Host authority frozen with the admission, not recomputed during retry or restart. */
  readonly folderScope?: (projectId: string, chatId: string) => Promise<string>;
  /** Notify the owning host once admission requires restart and reconciliation. */
  readonly onStopped?: () => void;
  readonly barrier?: (point: Barrier) => void | Promise<void>;
};

/**
 * Chats and input admission across Pal's tables and Pi's store, which commit separately. Every request is first
 * recorded with its normalized body, then completed in Pi with stable keys, so a crash between the two commits is
 * finished by `open()` instead of duplicated or lost. A request is acknowledged only once Pi has admitted it.
 */
export class ChatService {
  readonly #options: ChatServiceOptions;
  readonly #configurations = new Map<string, Promise<unknown>>();
  #stopped = false;

  private constructor(options: ChatServiceOptions) {
    this.#options = options;
  }

  /** Complete every chat and input recorded before a crash, in recorded order, before admitting anything new. */
  static async open(options: ChatServiceOptions, context: Context): Promise<ChatService> {
    const service = new ChatService(options);
    await service.abortDeleted(context);
    const chats = await service.#guard((db) =>
      db.all<{ id: string }>(
        "SELECT id FROM pal_chats WHERE state = 'provisioning' AND deleted_at IS NULL ORDER BY rowid",
      ),
    );
    for (const { id } of chats) await service.#provision(id, context);
    const inputs = await service.#guard((db) =>
      db.all<{ chat_id: string; request_id: string; intent: string }>(
        "SELECT a.chat_id, a.request_id, a.intent FROM pal_admissions a JOIN pal_chats c ON c.id = a.chat_id WHERE a.state = 'admitting' AND c.deleted_at IS NULL ORDER BY a.seq",
      ),
    );
    for (const row of inputs) {
      try {
        await service.#admit(row.chat_id, row.request_id, service.#input(row.intent), context);
      } catch (error) {
        if (!(error instanceof InputBlocked)) throw error;
      }
    }
    return service;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  async list(projectId: string): Promise<ChatSummary[]> {
    const rows = await this.#guard((db) =>
      db.all<{
        id: string;
        title: string | null;
        conversation_id: ConversationId;
        created_at: number;
        intent: string;
        blocked: string | null;
      }>(
        `SELECT id, title, conversation_id, created_at, intent, ${BLOCKED} FROM pal_chats WHERE project_id = ? AND state = 'ready' AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC`,
        projectId,
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      projectId,
      title: row.title,
      conversationId: row.conversation_id,
      createdAt: row.created_at,
      extensions: selectedExtensions(extensionScope(row.intent)),
      blocked: blockedInput(row.blocked),
    }));
  }

  /** The project a conversation's chat belongs to. */
  async projectOf(conversationId: ConversationId): Promise<string | undefined> {
    const row = await this.#guard((db) =>
      db.get<{ project_id: string }>(
        "SELECT project_id FROM pal_chats WHERE conversation_id = ? AND deleted_at IS NULL",
        conversationId,
      ),
    );
    return row?.project_id;
  }

  async get(chatId: string): Promise<ChatSummary | undefined> {
    const row = await this.#guard((db) =>
      db.get<{
        project_id: string;
        title: string | null;
        conversation_id: ConversationId;
        created_at: number;
        intent: string;
        blocked: string | null;
      }>(
        `SELECT project_id, title, conversation_id, created_at, intent, ${BLOCKED} FROM pal_chats WHERE id = ? AND state = 'ready' AND deleted_at IS NULL`,
        chatId,
      ),
    );
    return row === undefined
      ? undefined
      : {
          id: chatId,
          projectId: row.project_id,
          title: row.title,
          conversationId: row.conversation_id,
          createdAt: row.created_at,
          extensions: selectedExtensions(extensionScope(row.intent)),
          blocked: blockedInput(row.blocked),
        };
  }

  async rename(chatId: string, input: unknown): Promise<ChatSummary> {
    const body = validate(RenameBody, input);
    const title = body.title.trim();
    if (title === "") throw new InvalidRequest("enter a chat name");
    const renamed = await this.#guard((db) =>
      db.get<Omit<ChatSummary, "extensions" | "blocked"> & { intent: string }>(
        "UPDATE pal_chats SET title = ? WHERE id = ? AND state = 'ready' AND deleted_at IS NULL AND title IS ? RETURNING id, project_id AS projectId, conversation_id AS conversationId, title, created_at AS createdAt, intent",
        title,
        chatId,
        body.expectedTitle,
      ),
    );
    if (renamed !== undefined) {
      const { intent, ...chat } = renamed;
      return {
        ...chat,
        extensions: selectedExtensions(extensionScope(intent)),
        blocked: (await this.get(chatId))?.blocked ?? null,
      };
    }
    if ((await this.get(chatId)) === undefined) throw new ChatNotFound("no such chat");
    throw new RequestConflict("The chat name changed. Close and reopen this dialog before trying again.");
  }

  /** Keep Pi history, but revoke admission and future tool calls before aborting the run. */
  async remove(chatId: string, context: Context): Promise<void> {
    await this.#guard((db) =>
      db.run("UPDATE pal_chats SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?", Date.now(), chatId),
    );
    await this.abortDeleted(context);
  }

  /** Also reconciles a crash after a chat/project tombstone was committed but before its abort completed. */
  async abortDeleted(context: Context): Promise<void> {
    const rows = await this.#guard((db) =>
      db.all<{ conversation_id: ConversationId }>(
        "SELECT conversation_id FROM pal_chats WHERE deleted_at IS NOT NULL AND conversation_id IS NOT NULL",
      ),
    );
    for (const row of rows) {
      const conversation = await this.#options.harness.conversation(row.conversation_id, context);
      await conversation?.abort(context, { background: true });
    }
  }

  async createChat(requestId: unknown, body: unknown, context: Context): Promise<Chat> {
    const { key, intent, digest } = normalize(requestId, ChatBody, body, chatIntent);
    const { projectId, title } = body as ChatBody;
    if ((await this.#options.agentFor(projectId)) === undefined) {
      throw new ProjectUnavailable(`project ${projectId} does not exist or is not ready`);
    }
    const extensions = await this.#options.extensions?.();
    if (extensions !== undefined && this.#options.checkExtensions !== undefined) {
      const existing = await this.#guard((db) => db.get("SELECT id FROM pal_chats WHERE request_id = ?", key));
      if (existing === undefined) this.#options.checkExtensions(selectedExtensions(extensions));
    }
    const storedIntent =
      extensions === undefined ? intent : JSON.stringify({ ...chatIntent(body as ChatBody), extensions });
    const row = await this.#guard((db) =>
      db.transaction(async (tx) => {
        const existing = await tx.get<ChatRow>(
          "SELECT id, digest, conversation_id, deleted_at FROM pal_chats WHERE request_id = ?",
          key,
        );
        if (existing !== undefined) return existing;
        const id = randomUUID();
        await tx.run(
          "INSERT INTO pal_chats (id, request_id, digest, intent, state, project_id, title, created_at) VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?)",
          id,
          key,
          digest,
          storedIntent,
          projectId,
          title ?? null,
          Date.now(),
        );
        return { id, digest, conversation_id: null, deleted_at: null };
      }),
    );
    if (row.digest !== digest) throw new RequestConflict(`request ${key} created a different chat`);
    if (row.deleted_at !== null) throw new ChatNotFound("this chat was deleted");
    if (row.conversation_id !== null) return { id: row.id, conversationId: row.conversation_id };
    await this.#options.barrier?.("chat-recorded");
    return this.#provision(row.id, context);
  }

  async configure(
    chatId: string,
    selection: { model: ModelRef; thinkingLevel: ModelThinkingLevel; expected?: string },
    context: Context,
  ): Promise<string> {
    return this.#withConfiguration(chatId, async () => {
      const chat = await this.get(chatId);
      const conversation =
        chat === undefined ? undefined : await this.#options.harness.conversation(chat.conversationId, context);
      if (conversation === undefined) throw new ChatNotFound("no such chat");
      const current = chatConfiguration(await conversation.agent(context));
      if (selection.expected !== undefined && selection.expected !== current) throw configurationChanged();
      const next = chatConfiguration(selection);
      if (next === current) return current;
      await conversation.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, conversation.id);
        const inbox = await tx.doc(InboxDoc, conversation.id);
        if (live.run !== undefined || (live.compactions?.length ?? 0) > 0 || inbox.items.length > 0)
          throw new HttpError(
            409,
            "configuration_busy",
            "Wait for this chat's pending work to finish before changing models.",
          );
        await configure(tx, conversation.id, { model: selection.model, thinkingLevel: selection.thinkingLevel });
      }, context);
      return next;
    });
  }

  /** Admit one input; repeating a request ID with the same body returns the same submission. */
  async submit(chatId: string, requestId: unknown, body: unknown, context: Context): Promise<Admission> {
    return this.#withConfiguration(chatId, () => this.#submit(chatId, requestId, body, context));
  }

  /** What became of one input request: undefined if Pal never recorded it, so its sender may safely send it again. */
  async input(chatId: string, requestId: string): Promise<InputRecord | undefined> {
    const row = await this.#guard((db) =>
      db.get<Pick<AdmissionRow, "state" | "submission_id">>(
        "SELECT state, submission_id FROM pal_admissions WHERE chat_id = ? AND request_id = ?",
        chatId,
        requestId,
      ),
    );
    if (row === undefined) return undefined;
    return row.submission_id === null
      ? { state: row.state === "withdrawn" ? "withdrawn" : "admitting" }
      : { state: "admitted", admission: { chatId, requestId, submissionId: row.submission_id } };
  }

  /** Admit a blocked input again with its recorded body, in turn with the chat's other admissions. */
  async retry(chatId: string, requestId: string, context: Context): Promise<Admission> {
    return this.#withConfiguration(chatId, async () => {
      const row = await this.#recorded(chatId, requestId);
      if (row.submission_id !== null) return { chatId, requestId, submissionId: row.submission_id };
      if (row.state === "withdrawn") throw new RequestConflict(`request ${requestId} was withdrawn`);
      return this.#admit(chatId, requestId, this.#input(row.intent), context);
    });
  }

  /** Settle a blocked input as never sent, so the chat's later inputs can proceed. One Pi already admitted is kept. */
  async withdraw(chatId: string, requestId: string, context: Context): Promise<void> {
    return this.#withConfiguration(chatId, async () => {
      const row = await this.#recorded(chatId, requestId);
      if (row.state === "withdrawn") return;
      const chat = await this.get(chatId);
      if (chat === undefined) throw new ChatNotFound(`chat ${chatId} does not exist`);
      if (row.state === "admitting") {
        if ((await this.#piSubmission(chat.conversationId, requestId, context)) === undefined) {
          await this.#guard((db) =>
            db.run(
              "UPDATE pal_admissions SET state = 'withdrawn', blocked = NULL WHERE chat_id = ? AND request_id = ? AND state = 'admitting'",
              chatId,
              requestId,
            ),
          );
          return;
        }
        await this.#admit(chatId, requestId, this.#input(row.intent), context);
      }
      throw new RequestConflict("this message was already sent; it cannot be withdrawn");
    });
  }

  async #recorded(chatId: string, requestId: string): Promise<AdmissionRow> {
    const row = await this.#guard((db) =>
      db.get<AdmissionRow>(
        "SELECT digest, intent, state, submission_id FROM pal_admissions WHERE chat_id = ? AND request_id = ?",
        chatId,
        requestId,
      ),
    );
    if (row === undefined) throw new ChatNotFound(`no input ${requestId} in this chat`);
    return row;
  }

  async #withConfiguration<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#configurations.get(chatId) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(work);
    this.#configurations.set(chatId, job);
    try {
      return await job;
    } finally {
      if (this.#configurations.get(chatId) === job) this.#configurations.delete(chatId);
    }
  }

  async #submit(chatId: string, requestId: unknown, body: unknown, context: Context): Promise<Admission> {
    const { key, intent, digest } = normalize(requestId, InputBody, body, (value) => ({
      text: value.text,
      whenBusy: value.whenBusy ?? "followUp",
      attachments: value.attachments ?? [],
      configuration: value.configuration,
      feedback: value.feedback === undefined ? undefined : { ids: value.feedback.ids, scope: value.feedback.scope },
    }));
    const chat = await this.get(chatId);
    if (chat === undefined) throw new ChatNotFound(`chat ${chatId} does not exist`);
    const previous = await this.#guard((db) =>
      db.get<AdmissionRow>(
        "SELECT digest, intent, state, submission_id FROM pal_admissions WHERE chat_id = ? AND request_id = ?",
        chatId,
        key,
      ),
    );
    if (previous !== undefined && previous.digest !== digest)
      throw new RequestConflict(`request ${key} was admitted with a different body`);
    if (previous?.state === "withdrawn") throw new RequestConflict(`request ${key} was withdrawn`);
    // An acknowledged request answers from its receipt, even if its attachments are gone since.
    if (previous?.submission_id != null) return { chatId, requestId: key, submissionId: previous.submission_id };
    const attached = (body as InputBody).attachments ?? [];
    if (previous === undefined && attached.length > 0) {
      if (this.#options.attachments === undefined) throw new ChatNotFound(`chat ${chatId} cannot take attachments`);
      await this.#options.attachments.check(chat.projectId, attached);
    }
    if (previous === undefined) this.#options.checkExtensions?.(chat.extensions);
    const expected = (body as InputBody).configuration;
    if (expected !== undefined) {
      const conversation = await this.#options.harness.conversation(chat.conversationId, context);
      if (conversation === undefined) throw new ChatNotFound("the chat's conversation is missing");
      if (chatConfiguration(await conversation.agent(context)) !== expected) throw configurationChanged();
    }
    const feedback = (body as InputBody).feedback;
    if (previous === undefined && feedback !== undefined) {
      if (this.#options.feedback === undefined) throw new InvalidRequest("review feedback is not available");
      await this.#options.feedback.checkFeedback(chatId, feedback, (body as InputBody).text);
    }
    const scope = previous === undefined ? await this.#options.folderScope?.(chat.projectId, chatId) : undefined;
    const row = await this.#guard((db) =>
      db.transaction(async (tx) => {
        const chat = await tx.get<{ state: string }>(
          "SELECT state FROM pal_chats WHERE id = ? AND deleted_at IS NULL",
          chatId,
        );
        if (chat?.state !== "ready") return undefined;
        const existing = await tx.get<AdmissionRow>(
          "SELECT digest, intent, state, submission_id FROM pal_admissions WHERE chat_id = ? AND request_id = ?",
          chatId,
          key,
        );
        if (existing !== undefined) return existing;
        // Inputs of one chat are admitted in order, so a blocked one holds back every later one.
        const blocked = await tx.get("SELECT 1 FROM pal_admissions WHERE chat_id = ? AND state = 'admitting'", chatId);
        if (blocked !== undefined) return "blocked";
        await tx.run(
          "INSERT INTO pal_admissions (chat_id, request_id, digest, intent, folder_scope, state, created_at) VALUES (?, ?, ?, ?, ?, 'admitting', ?)",
          chatId,
          key,
          digest,
          intent,
          scope ?? null,
          Date.now(),
        );
        return { digest, intent, state: "admitting" as const, submission_id: null };
      }),
    );
    if (row === undefined) throw new ChatNotFound(`chat ${chatId} does not exist`);
    if (row === "blocked")
      throw new InputHeld("An earlier message in this chat couldn't be sent yet. Retry or withdraw it first.");
    if (row.digest !== digest) throw new RequestConflict(`request ${key} was admitted with a different body`);
    if (row.state === "withdrawn") throw new RequestConflict(`request ${key} was withdrawn`);
    if (row.submission_id !== null) return { chatId, requestId: key, submissionId: row.submission_id };
    await this.#options.barrier?.("input-recorded");
    return this.#admit(chatId, key, this.#input(row.intent), context);
  }

  #stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#options.onStopped?.();
  }

  #input(intent: string): InputBody {
    try {
      return validate(InputBody, JSON.parse(intent));
    } catch (error) {
      this.#stop();
      throw new AdmissionStopped("a saved input is corrupt; admission cannot safely resume", { cause: error });
    }
  }

  /** Create the chat's conversation unless an earlier attempt did, then record the mapping. */
  async #provision(chatId: string, context: Context): Promise<Chat> {
    const row = await this.#guard((db) =>
      db.get<{ project_id: string; intent: string }>("SELECT project_id, intent FROM pal_chats WHERE id = ?", chatId),
    );
    const agent =
      row === undefined
        ? undefined
        : await this.#options.agentFor(row.project_id, chatId, workspaceMode(row.intent), extensionScope(row.intent));
    if (agent === undefined) throw new ProjectUnavailable(`chat ${chatId}'s project is not available`);
    const conversationId = await this.#guard(async () => {
      try {
        const conversation = await this.#options.harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent,
            init: async (tx, id) => {
              // Pi serializes commits, so this check and the creation it rolls back are atomic.
              if ((await tx.doc(ChatDoc, chatId, id)).conversationId !== id) throw new AlreadyProvisioned();
            },
          },
          context,
        );
        return conversation.id;
      } catch (error) {
        if (!(error instanceof AlreadyProvisioned)) throw error;
        const existing = await this.#options.harness.snapshot(ChatDoc, chatId, context);
        if (existing === undefined) throw new Error(`chat ${chatId} lost its conversation`, { cause: error });
        return existing.conversationId;
      }
    });
    await this.#options.barrier?.("chat-created");
    await this.#guard((db) =>
      db.run("UPDATE pal_chats SET state = 'ready', conversation_id = ? WHERE id = ?", conversationId, chatId),
    );
    return { id: chatId, conversationId };
  }

  /** Submit under the same request ID, which Pi deduplicates per conversation, then record the acknowledgement. */
  async #admit(chatId: string, requestId: string, intent: InputBody, context: Context): Promise<Admission> {
    if ((await this.get(chatId)) === undefined) throw new ChatNotFound("this chat was deleted before admission");
    const { conversation, projectId } = await this.#guard(async (db) => {
      const row = await db.get<{ conversation_id: ConversationId; project_id: string }>(
        "SELECT conversation_id, project_id FROM pal_chats WHERE id = ?",
        chatId,
      );
      const conversation =
        row === undefined ? undefined : await this.#options.harness.conversation(row.conversation_id, context);
      if (row === undefined || conversation === undefined) throw new Error(`chat ${chatId} has no conversation`);
      return { conversation, projectId: row.project_id };
    });
    let submissionId = await this.#piSubmission(conversation.id, requestId, context);
    if (submissionId === undefined) {
      const withFiles = await this.#attachments(projectId, intent).catch(async (error: unknown) => {
        if (error instanceof InputBlocked)
          await this.#guard((db) =>
            db.run(
              "UPDATE pal_admissions SET blocked = ? WHERE chat_id = ? AND request_id = ? AND state = 'admitting'",
              error.message,
              chatId,
              requestId,
            ),
          );
        throw error;
      });
      submissionId = await this.#guard(
        async () =>
          (
            await conversation.submit(
              { type: "input", requestId, content: intent.text, whenBusy: intent.whenBusy ?? "followUp", ...withFiles },
              context,
            )
          ).id,
      );
    }
    await this.#options.barrier?.("input-submitted");
    if ((await this.get(chatId)) === undefined) {
      await this.abortDeleted(context);
      throw new ChatNotFound("this chat was deleted during admission");
    }
    await this.#guard((db) =>
      db.transaction(async (tx) => {
        await tx.run(
          "UPDATE pal_admissions SET state = 'admitted', submission_id = ?, blocked = NULL WHERE chat_id = ? AND request_id = ?",
          submissionId,
          chatId,
          requestId,
        );
        if (intent.feedback !== undefined) {
          if (this.#options.feedback === undefined) throw new Error("saved review feedback has no receipt handler");
          await this.#options.feedback.admitFeedback(tx, chatId, intent.feedback, submissionId);
        }
        await tx.run(
          "UPDATE pal_chats SET title = ? WHERE id = ? AND title IS NULL",
          untitledName(intent.text),
          chatId,
        );
      }),
    );
    await this.#options.barrier?.("input-admitted");
    return { chatId, requestId, submissionId };
  }

  /** Pi may have admitted an input before a crash lost its acknowledgement: adopt that, never resubmit. */
  async #piSubmission(conversationId: ConversationId, requestId: string, context: Context) {
    const submission = await this.#guard(() =>
      this.#options.harness.commit((tx) => tx.submissionByRequest(conversationId, requestId), context),
    );
    return submission?.id;
  }

  /** The model content of an input's attachments. An unreadable payload blocks this input, not admission. */
  async #attachments(projectId: string, intent: InputBody) {
    const attached = intent.attachments ?? [];
    const uploads = this.#options.attachments;
    if (attached.length === 0 || uploads === undefined) return {};
    try {
      const { content, labels } = await uploads.content(projectId, attached);
      return {
        content: [{ type: "text" as const, text: intent.text }, ...content],
        // The transcript entry carries the labels the UI shows, with what of each the model saw above.
        entry: { kind: "pal.user", data: { attachments: labels } },
      };
    } catch (error) {
      if (error instanceof UploadError) throw new InputBlocked(error.message, { cause: error });
      this.#stop();
      throw new AdmissionStopped("admission stopped after a storage failure", { cause: error });
    }
  }

  /**
   * Run storage work, Pal's or Pi's. The first failure stops admission: a failed commit's outcome is unknown, and Pi
   * closes its Session on one. Restarting reconciles, since every step is keyed and safe to complete again.
   */
  async #guard<T>(work: (db: SqliteDatabase) => Promise<T>): Promise<T> {
    if (this.#stopped) throw new AdmissionStopped("admission stopped after a storage failure");
    try {
      return await work(this.#options.database);
    } catch (error) {
      this.#stop();
      throw new AdmissionStopped("admission stopped after a storage failure", { cause: error });
    }
  }
}

export function chatConfiguration(agent: Pick<Agent, "model" | "thinkingLevel">): string {
  return createHash("sha256")
    .update(JSON.stringify([agent.model?.provider ?? null, agent.model?.modelId ?? null, agent.thinkingLevel]))
    .digest("hex");
}

function configurationChanged(): HttpError {
  return new HttpError(
    409,
    "configuration_stale",
    "Chat settings changed elsewhere. Reload the saved settings before trying again.",
  );
}

function chatIntent(value: ChatBody) {
  return {
    projectId: value.projectId,
    title: value.title ?? null,
    ...(value.workspace === undefined || value.workspace === "local" ? {} : { workspace: value.workspace }),
  };
}

type ChatRow = { id: string; digest: string; conversation_id: ConversationId | null; deleted_at: number | null };
type AdmissionRow = {
  digest: string;
  intent: string;
  state: "admitting" | "admitted" | "withdrawn";
  submission_id: SubmissionId | null;
};
/** Inputs are admitted in order, so at most one per chat is blocked. */
const BLOCKED =
  "(SELECT json_object('requestId', a.request_id, 'text', json_extract(a.intent, '$.text'), 'reason', a.blocked) FROM pal_admissions a WHERE a.chat_id = pal_chats.id AND a.state = 'admitting' AND a.blocked IS NOT NULL) AS blocked";
const blockedInput = (raw: string | null) => (raw === null ? null : (JSON.parse(raw) as BlockedInput));

/** A chat's first input names it: its first line, shortened at a word boundary. */
function untitledName(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
}
