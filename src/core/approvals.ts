import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  type ConversationId,
  defineExtension,
  type Extension,
  hook,
  type HookApi,
  type TaskId,
  type TaskRecord,
  type ToolHookCall,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { COMMAND_TIMEOUT } from "./execution.ts";
import { HttpError } from "./http.ts";

export type CommandMode = "ask" | "full";
export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "stopped";
export type CommandApproval = {
  readonly id: string;
  /** The assistant entry that called the command or the script that asked, so the card sits under that turn. */
  readonly assistant: number | null;
  readonly tool: "shell_run" | "browser_act";
  readonly command: string;
  readonly cwd: string;
  readonly timeout: number;
  /** Binds a decision to exactly the request the owner saw. */
  readonly digest: string;
  readonly state: ApprovalState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
};
export type ApprovalView = { readonly mode: CommandMode; readonly approvals: readonly CommandApproval[] };

/** A script's wall-clock deadline also ends its wait, so an approval cannot usefully outlive the script cap. */
export const APPROVAL_TTL_MS = 120_000;
const MAX_PENDING_PER_CHAT = 4;
const MAX_PENDING = 16;
const KEPT_PER_CHAT = 100;
const SHOWN = 50;

export const CommandModeBody = Type.Object({ mode: Type.Enum(["ask", "full"]) }, { additionalProperties: false });
export const ApprovalDecision = Type.Object(
  { decision: Type.Enum(["approve", "deny"]), digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false },
);

/** What one `shell_run` call asks to do, and where; `cwd` is undefined when the chat has no writable folder. */
type Request = {
  readonly conversation: ConversationId;
  readonly task: TaskId;
  readonly tool: "shell_run" | "browser_act";
  readonly command: string;
  readonly cwd: string | undefined;
  readonly timeout: number;
};
const ShellArguments = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) });
/** A model-issued tool task's input names the assistant entry that made the call. */
const ModelCall = Type.Object({ kind: Type.Literal("model"), assistant: Type.Integer() });

type Row = {
  id: string;
  chat_id: string;
  assistant: number | null;
  tool: "shell_run" | "browser_act";
  command: string;
  cwd: string;
  timeout: number;
  digest: string;
  state: ApprovalState;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
};

/**
 * Per-chat command approval. In Ask mode every agent `shell_run` waits in Pi's `beforeTool` hook, before the tool
 * task records its intent, until the owner approves or denies that exact command, folder and timeout. A crash while
 * waiting leaves the task before intent, so a restart asks the same stored request again; once intent is recorded,
 * Pi's unsafe-replay rule keeps the command from running twice. Full access skips only the prompt.
 */
export class CommandApprovals {
  readonly extension: Extension;
  readonly #database: SqliteDatabase;
  readonly #root: (conversation: ConversationId) => Promise<string | undefined>;
  readonly #task: (id: TaskId, context: Context) => Promise<TaskRecord<JsonValue, JsonValue, unknown> | undefined>;
  readonly #browser:
    | ((
        conversation: ConversationId,
        args: unknown,
      ) => Promise<{ command: string; cwd: string; timeout: number } | undefined>)
    | undefined;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #listeners = new Map<string, Set<() => void>>();
  #closing = false;

  constructor(options: {
    database: SqliteDatabase;
    /** The conversation's current writable working folder; undefined when it has none. */
    root: (conversation: ConversationId) => Promise<string | undefined>;
    task: (id: TaskId, context: Context) => Promise<TaskRecord<JsonValue, JsonValue, unknown> | undefined>;
    browser?: (
      conversation: ConversationId,
      args: unknown,
    ) => Promise<{ command: string; cwd: string; timeout: number } | undefined>;
    now?: () => number;
    ttlMs?: number;
  }) {
    this.#database = options.database;
    this.#root = options.root;
    this.#task = options.task;
    this.#browser = options.browser;
    this.#now = options.now ?? Date.now;
    this.#ttl = Math.min(options.ttlMs ?? APPROVAL_TTL_MS, APPROVAL_TTL_MS);
    this.extension = defineExtension({
      name: "pal.approvals",
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call, api, context) =>
            call.name === "shell_run" || call.name === "browser_act" ? this.#gate(call, api, context) : undefined,
        }),
      ],
    });
  }

  /**
   * Call before closing the Harness: its abort then ends waits without recording a Stop, so the request stays
   * pending and is asked again after restart. Waits are not woken here; only the Harness's abort may end them.
   */
  close(): void {
    this.#closing = true;
  }

  async mode(chatId: string): Promise<CommandMode> {
    const row = await this.#database.get<{ command_mode: CommandMode }>(
      "SELECT command_mode FROM pal_chats WHERE id = ? AND deleted_at IS NULL",
      chatId,
    );
    if (row === undefined) throw new HttpError(404, "not_found", "no such chat");
    return row.command_mode;
  }

  /** Change only how later commands are asked; pending requests keep waiting for an explicit answer. */
  async setMode(chatId: string, mode: CommandMode): Promise<void> {
    await this.mode(chatId);
    await this.#database.run("UPDATE pal_chats SET command_mode = ? WHERE id = ? AND deleted_at IS NULL", mode, chatId);
    this.#changed(chatId);
  }

  async expire(): Promise<void> {
    await this.#database.run(
      "UPDATE pal_command_approvals SET state = 'expired', decided_at = ? WHERE state = 'pending' AND expires_at <= ?",
      this.#now(),
      this.#now(),
    );
    for (const id of this.#waiters.keys()) this.#wake(id);
  }

  async view(chatId: string): Promise<ApprovalView> {
    await this.expire();
    const mode = await this.mode(chatId);
    const rows = await this.#database.all<Row>(
      "SELECT * FROM pal_command_approvals WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      chatId,
      SHOWN,
    );
    const now = this.#now();
    return {
      mode,
      // A pending request past its deadline is shown expired even before its wait (or a restart) records that.
      approvals: rows
        .toReversed()
        .map((row) => present(row.state === "pending" && now >= row.expires_at ? { ...row, state: "expired" } : row)),
    };
  }

  /** The owner's answer to one pending request, bound to the digest they were shown. */
  async decide(chatId: string, id: string, decision: "approve" | "deny", shown: string): Promise<void> {
    const now = this.#now();
    const updated = await this.#database.transaction(async (tx) => {
      const row = await tx.get<Row>(
        "SELECT * FROM pal_command_approvals WHERE id = ? AND chat_id = ? AND state = 'pending'",
        id,
        chatId,
      );
      if (row === undefined || row.digest !== shown || now >= row.expires_at) return false;
      await tx.run(
        "UPDATE pal_command_approvals SET state = ?, decided_at = ? WHERE id = ?",
        decision === "approve" ? "approved" : "denied",
        now,
        id,
      );
      return true;
    });
    if (!updated) {
      throw new HttpError(409, "approval_stale", "this request is no longer waiting for an answer; nothing changed");
    }
    this.#wake(id);
    this.#changed(chatId);
  }

  /** Whether this tool call went to the owner, so it must run exactly as shown, whatever was decided. */
  async asked(task: TaskId): Promise<boolean> {
    return (await this.#database.get("SELECT 1 FROM pal_command_approvals WHERE task_id = ?", task)) !== undefined;
  }

  /** Called on every approval or mode change of the chat until the returned function is called. */
  watch(chatId: string, listener: () => void): () => void {
    const listeners = this.#listeners.get(chatId) ?? new Set();
    this.#listeners.set(chatId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(chatId);
    };
  }

  /** Block unless this exact request may run now; waits for the owner's answer in Ask mode. */
  async #gate(call: ToolHookCall, api: HookApi, context: Context): Promise<{ block: string } | undefined> {
    const chat = await this.#chat(api.conversationId);
    if (chat === undefined) return { block: "this conversation has no active chat" };
    const browser = call.name === "browser_act";
    let target: { command: string; cwd: string | undefined; timeout: number } | undefined;
    if (browser) {
      try {
        target = await this.#browser?.(api.conversationId, call.arguments);
      } catch {
        return { block: "Browser control or page changed; inspect again. Nothing was run." };
      }
    } else if (Value.Check(ShellArguments, call.arguments)) {
      target = {
        command: call.arguments.command,
        cwd: await this.#cwd(api.conversationId),
        timeout: call.arguments.timeout ?? COMMAND_TIMEOUT,
      };
    }
    if (target === undefined) return { block: "invalid arguments or missing browser authority; nothing was run" };
    const request: Request = {
      conversation: api.conversationId,
      task: api.taskId,
      tool: browser ? "browser_act" : "shell_run",
      ...target,
    };
    // A request that was already asked keeps its answer whatever the mode is now: switching to Full access never
    // approves a pending request.
    let row = await this.#database.get<Row>("SELECT * FROM pal_command_approvals WHERE task_id = ?", api.taskId);
    if (row === undefined) {
      if (!browser && chat.mode === "full") return undefined;
      const asked = await this.#ask(chat.id, call, request, context);
      if ("refused" in asked) return { block: asked.refused };
      row = asked.row;
    }
    const settled = await this.#settled(row.id, context);
    if (browser) {
      try {
        const current = await this.#browser?.(api.conversationId, call.arguments);
        if (
          current === undefined ||
          current.command !== request.command ||
          current.cwd !== request.cwd ||
          current.timeout !== request.timeout
        )
          return { block: "Browser authority changed while waiting; nothing was run" };
      } catch {
        return { block: "Browser authority changed while waiting; nothing was run" };
      }
    }
    return this.#verdict(settled, request);
  }

  /** Store a new pending request for the owner, or the reason none may be added. */
  async #ask(
    chatId: string,
    call: ToolHookCall,
    request: Request,
    context: Context,
  ): Promise<{ row: Row } | { refused: string }> {
    if (request.cwd === undefined) return { refused: "this chat has no writable working folder" };
    const input = (await this.#task(call.parent?.taskId ?? request.task, context))?.input;
    return this.#request(chatId, call.id, {
      ...request,
      cwd: request.cwd,
      assistant: Value.Check(ModelCall, input) ? input.assistant : null,
    });
  }

  async #verdict(settled: CommandApproval, request: Request): Promise<{ block: string } | undefined> {
    const nothing = "nothing was run";
    if (settled.state === "denied") return { block: `the owner denied this command; ${nothing}` };
    if (settled.state === "expired") return { block: `no approval arrived in time; ${nothing}` };
    if (settled.state === "stopped") return { block: `stopped before approval; ${nothing}` };
    if (this.#now() >= settled.expiresAt) return { block: `the approval expired before dispatch; ${nothing}` };
    // The approval covers exactly what was shown; a changed request or a replaced workspace needs a new one.
    const unchanged =
      request.cwd !== undefined &&
      settled.digest === digest({ ...request, cwd: request.cwd }) &&
      (await this.#chat(request.conversation)) !== undefined;
    return unchanged
      ? undefined
      : { block: `the approved command, folder or chat changed before dispatch; ${nothing}` };
  }

  async #chat(conversation: ConversationId): Promise<{ id: string; mode: CommandMode } | undefined> {
    const row = await this.#database.get<{ id: string; command_mode: CommandMode }>(
      "SELECT c.id, c.command_mode FROM pal_chats c JOIN pal_projects p ON p.id = c.project_id WHERE c.conversation_id = ? AND c.deleted_at IS NULL AND p.removed_at IS NULL AND p.state = 'ready'",
      conversation,
    );
    return row === undefined ? undefined : { id: row.id, mode: row.command_mode };
  }

  async #cwd(conversation: ConversationId): Promise<string | undefined> {
    const root = await this.#root(conversation);
    if (root === undefined) return undefined;
    try {
      return await realpath(root);
    } catch {
      return undefined;
    }
  }

  async #request(
    chatId: string,
    callId: string,
    request: Request & { cwd: string; assistant: number | null },
  ): Promise<{ row: Row } | { refused: string }> {
    const now = this.#now();
    const asked = await this.#database.transaction(async (tx): Promise<{ row: Row } | { refused: string }> => {
      const existing = await tx.get<Row>("SELECT * FROM pal_command_approvals WHERE task_id = ?", request.task);
      if (existing !== undefined) return { row: existing };
      const counts = await tx.get<{ chat: number; all: number }>(
        "SELECT count(*) FILTER (WHERE chat_id = ?) AS chat, count(*) AS \"all\" FROM pal_command_approvals WHERE state = 'pending' AND expires_at > ?",
        chatId,
        now,
      );
      if ((counts?.chat ?? 0) >= MAX_PENDING_PER_CHAT || (counts?.all ?? 0) >= MAX_PENDING) {
        return {
          refused: `at most ${MAX_PENDING_PER_CHAT} commands per chat (${MAX_PENDING} in all) may wait for approval; nothing was run`,
        };
      }
      const row: Row = {
        id: randomUUID(),
        chat_id: chatId,
        assistant: request.assistant,
        tool: request.tool,
        command: request.command,
        cwd: request.cwd,
        timeout: request.timeout,
        digest: digest(request),
        state: "pending",
        created_at: now,
        expires_at: now + this.#ttl,
        decided_at: null,
      };
      await tx.run(
        "INSERT INTO pal_command_approvals (id, chat_id, task_id, call_id, assistant, tool, command, cwd, timeout, digest, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        row.id,
        chatId,
        request.task,
        callId,
        row.assistant,
        row.tool,
        row.command,
        row.cwd,
        row.timeout,
        row.digest,
        row.created_at,
        row.expires_at,
      );
      await tx.run(
        "DELETE FROM pal_command_approvals WHERE chat_id = ? AND state != 'pending' AND rowid NOT IN (SELECT rowid FROM pal_command_approvals WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)",
        chatId,
        chatId,
        KEPT_PER_CHAT,
      );
      return { row };
    });
    if ("row" in asked) this.#changed(chatId);
    return asked;
  }

  /** Wait until the request is answered, expires or its run stops. */
  async #settled(id: string, context: Context): Promise<CommandApproval> {
    const signal = context.abortSignal;
    for (;;) {
      const row = await this.#database.get<Row>("SELECT * FROM pal_command_approvals WHERE id = ?", id);
      if (row === undefined) throw new Error("the approval request disappeared");
      if (row.state !== "pending") return present(row);
      const now = this.#now();
      if (now >= row.expires_at) {
        await this.#settle(row, "expired");
        continue;
      }
      if (signal?.aborted) {
        if (!this.#closing) await this.#settle(row, "stopped");
        throw signal?.reason instanceof Error ? signal.reason : new Error("the run stopped");
      }
      await new Promise<void>((resolve) => {
        const waiters = this.#waiters.get(id) ?? new Set();
        this.#waiters.set(id, waiters);
        const wake = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", wake);
          waiters.delete(wake);
          if (waiters.size === 0) this.#waiters.delete(id);
          resolve();
        };
        const timer = setTimeout(wake, row.expires_at - now);
        waiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  async #settle(row: Row, state: "expired" | "stopped"): Promise<void> {
    await this.#database.run(
      "UPDATE pal_command_approvals SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'",
      state,
      this.#now(),
      row.id,
    );
    this.#changed(row.chat_id);
  }

  #wake(id: string): void {
    for (const wake of [...(this.#waiters.get(id) ?? [])]) wake();
  }

  #changed(chatId: string): void {
    for (const listener of [...(this.#listeners.get(chatId) ?? [])]) listener();
  }
}

function digest(request: Request & { cwd: string }): string {
  const { conversation, task, command, cwd, timeout } = request;
  return createHash("sha256")
    .update(
      JSON.stringify([
        conversation,
        task,
        command,
        cwd,
        timeout,
        ...(request.tool === "browser_act" ? ["browser_act"] : []),
      ]),
    )
    .digest("hex");
}

function present(row: Row): CommandApproval {
  return {
    id: row.id,
    assistant: row.assistant,
    tool: row.tool,
    command: row.command,
    cwd: row.cwd,
    timeout: row.timeout,
    digest: row.digest,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
  };
}
