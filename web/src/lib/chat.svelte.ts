// Reconnect replaces live state from a snapshot; event offsets are not replayable.
import type {
  AgentEvent,
  AgentState,
  CompactionFailure,
  CompactionStatus,
  MessageChange,
  NestedToolSlot,
  SnapshotEvent,
  ToolSlot,
  UsageState,
} from "@earendil-works/pi-durable";
import type { ApprovalView, CommandApproval, CommandMode } from "../../../src/core/approvals.ts";
import type { McpReceipt } from "../../../src/pi/mcp-source.ts";
export type { CommandApproval, McpReceipt };

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "image" };

export type Message = {
  role: "user" | "assistant" | "toolResult";
  content: string | Block[];
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** A `codemode` result's record of the tool calls its script made. */
  details?: { calls?: NestedCall[] };
};

export type NestedCall = {
  id: number;
  name: string;
  args: string;
  status: string;
  durationMs?: number;
  error?: string;
};

export type Attachment = { id: string; name: string; size: number; mediaType: string };

export type ShellReceipt = {
  callId: string;
  command: string;
  executed?: string;
  cwd: string;
  status: string;
  output?: string;
  exitCode?: number;
  truncated?: boolean;
  timedOut?: boolean;
};
export type Entry = {
  id: number;
  kind: string;
  model?: Message[];
  data?: {
    attachments?: Attachment[];
    shell?: ShellReceipt;
    mcp?: McpReceipt;
    helper?: { task: number; purpose: string };
    result?: { task: number; status: "answered" | "unanswered" };
  };
};

type Queued = SnapshotEvent["inbox"][number];
type Event<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

export class ChatStream {
  entries: Entry[] = $state([]);
  partial: Message | undefined = $state();
  running = $state(false);
  tools: readonly ToolSlot[] = $state.raw([]);
  /** Calls the running tools made, such as a script's tool calls, related by native call and task IDs. */
  nested: readonly NestedToolSlot[] = $state.raw([]);
  inbox: readonly Queued[] = $state.raw([]);
  retry: { at: number; error: string } | undefined = $state();
  /** When Pal next asks the provider for a deferred response. */
  deferredPoll: number | undefined = $state();
  compactions: readonly CompactionStatus[] = $state.raw([]);
  compactionFailure: CompactionFailure | undefined = $state();
  /** A task of this conversation that failed since the last run started; it is never shown as success. */
  failure: { kind: string; message: string } | undefined = $state();
  usage: UsageState | undefined = $state.raw();
  agent: AgentState | undefined = $state.raw();
  connected = $state(false);
  loaded = $state(false);
  /** The browser retries a dropped stream by itself; one the server refused stays closed until replaced. */
  problem: "retrying" | "closed" | undefined = $state();
  mode: CommandMode | undefined = $state();
  approvals: readonly CommandApproval[] = $state([]);
  #source: EventSource | undefined;

  constructor(chatId: string) {
    const source = new EventSource(`/api/chats/${chatId}/events`);
    this.#source = source;
    function listen<T>(name: string, apply: (data: T) => void) {
      source.addEventListener(name, (event) => {
        let data: T;
        try {
          data = JSON.parse((event as MessageEvent<string>).data) as T;
        } catch {
          return;
        }
        apply(data);
      });
    }
    listen<SnapshotEvent>("snapshot", (snapshot) => this.#reset(snapshot));
    listen<AgentEvent>("event", (event) => this.#apply(event));
    listen<ApprovalView>("approvals", (view) => this.showApprovals(view));
    source.addEventListener("open", () => {
      this.connected = true;
      this.problem = undefined;
    });
    source.addEventListener("error", () => {
      this.connected = false;
      this.problem = source.readyState === EventSource.CLOSED ? "closed" : "retrying";
    });
  }

  close(): void {
    this.#source?.close();
  }

  showApprovals(view: ApprovalView): void {
    this.mode = view.mode;
    this.approvals = view.approvals;
  }

  /** Snapshots are authoritative: whatever one leaves out is cleared. */
  #reset(snapshot: SnapshotEvent): void {
    // Pal's own entry records, read through their view shape.
    this.entries = snapshot.entries as unknown as Entry[];
    this.running = snapshot.run !== undefined;
    this.tools = snapshot.tools;
    this.nested = snapshot.nestedTools;
    this.partial = snapshot.generation?.message as Message | undefined;
    this.retry = snapshot.generation?.retry;
    this.deferredPoll = snapshot.generation?.deferred?.pollAt;
    this.inbox = snapshot.inbox;
    this.compactions = snapshot.compactions;
    this.compactionFailure = snapshot.compactionFailure;
    this.failure = undefined;
    this.usage = snapshot.usage;
    this.agent = snapshot.agent;
    this.loaded = true;
    this.connected = true;
    this.problem = undefined;
  }

  #append(entry: Event<"entry_appended">["entry"]): void {
    if (!this.entries.some((known) => known.id === entry.id)) this.entries.push(entry as unknown as Entry);
  }

  #apply(event: AgentEvent): void {
    switch (event.type) {
      case "snapshot":
        return this.#reset(event);
      case "run_start":
        this.running = true;
        this.failure = undefined;
        return;
      case "run_end":
        this.running = false;
        this.tools = [];
        this.nested = [];
        this.partial = undefined;
        this.retry = undefined;
        this.deferredPoll = undefined;
        return;
      // Presentation only: rounds show through their messages and tool calls.
      case "turn_start":
      case "turn_end":
      case "submission":
        return;
      case "message_start":
        if (event.message.role === "assistant") this.partial = event.message as Message;
        return;
      case "message_update":
        for (const change of event.changes) this.#change(change);
        return;
      case "message_end":
        this.#append(event.entry);
        this.partial = undefined;
        return;
      case "tool_execution_start":
        return this.#start(event);
      case "tool_execution_update":
        return this.#update(event);
      case "tool_execution_end":
        return this.#end(event);
      case "inbox_update":
        this.inbox = event.items;
        return;
      case "auto_retry_start":
        this.retry = { at: event.at, error: event.errorMessage };
        this.deferredPoll = undefined;
        return;
      case "auto_retry_end":
        this.retry = undefined;
        return;
      case "deferred_poll":
        this.deferredPoll = event.pollAt;
        return;
      case "entry_appended":
        return this.#append(event.entry);
      case "agent_changed":
        this.agent = event.agent;
        return;
      case "usage_changed":
        this.usage = event.usage;
        return;
      case "task_failed":
        this.failure = { kind: event.kind, message: event.message };
        return;
      case "compaction_start": {
        // Compaction events name compaction tasks.
        const taskId = event.taskId as CompactionStatus["taskId"];
        this.compactions = [
          ...this.compactions.filter((compaction) => compaction.taskId !== event.taskId),
          { taskId, reason: event.reason, blocking: event.blocking, attempt: 1 },
        ];
        return;
      }
      case "compaction_end": {
        const taskId = event.taskId as CompactionStatus["taskId"];
        this.compactions = this.compactions.filter((compaction) => compaction.taskId !== taskId);
        this.compactionFailure =
          event.error === undefined ? undefined : { taskId, reason: event.reason, error: event.error };
        return;
      }
      default: {
        // A Pi event this projection does not handle fails the typecheck here.
        const unhandled: never = event;
        return unhandled;
      }
    }
  }

  #start(event: Event<"tool_execution_start">): void {
    if (event.parentToolCallId === undefined) {
      const tool: ToolSlot = { callId: event.toolCallId, name: event.toolName, status: "running" };
      if (event.taskId !== undefined) tool.taskId = event.taskId;
      this.tools = [...this.tools.filter((known) => known.callId !== event.toolCallId), tool];
    } else if (event.taskId !== undefined && event.parentTaskId !== undefined) {
      const call: NestedToolSlot = {
        callId: event.toolCallId,
        name: event.toolName,
        status: "running",
        parentCallId: event.parentToolCallId,
        parentTaskId: event.parentTaskId,
        taskId: event.taskId,
        arguments: event.args,
      };
      this.nested = [...this.nested.filter((known) => known.callId !== event.toolCallId), call];
    }
  }

  /** Bounded running output: a front trim and an append of the retained window, or its replacement. */
  #update(event: Event<"tool_execution_update">): void {
    const apply = <T extends ToolSlot | NestedToolSlot>(slot: T): T => {
      if (slot.callId !== event.toolCallId) return slot;
      const next = { ...slot };
      if (event.output !== undefined)
        next.output =
          "set" in event.output
            ? event.output.set
            : (slot.output ?? "").slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
      if (event.details === null) delete next.details;
      else if (event.details !== undefined) next.details = event.details;
      if (event.diagnostics !== undefined) next.diagnostics = [...event.diagnostics];
      return next;
    };
    if (event.parentToolCallId === undefined) this.tools = this.tools.map(apply);
    else this.nested = this.nested.map(apply);
  }

  /** Without a result entry the call faulted or was orphaned: it shows as unconfirmed, never as done. */
  #end(event: Event<"tool_execution_end">): void {
    if (event.parentToolCallId === undefined) {
      this.tools = this.tools.filter((tool) => tool.callId !== event.toolCallId);
      this.nested = this.nested.filter((call) => call.parentCallId !== event.toolCallId);
      if (event.entry !== undefined) this.#append(event.entry);
      return;
    }
    this.nested = this.nested.map((call) =>
      call.callId === event.toolCallId
        ? {
            ...call,
            status: "done",
            summary: {
              isError: event.result?.isError ?? true,
              ...(event.result?.durationMs === undefined ? {} : { durationMs: event.result.durationMs }),
            },
          }
        : call,
    );
  }

  #change(change: MessageChange): void {
    if (change.type === "message") {
      this.partial = change.message as Message;
      return;
    }
    const partial = this.partial;
    if (partial === undefined || typeof partial.content === "string") return;
    const block = partial.content[change.contentIndex];
    switch (change.type) {
      case "text_start":
      case "thinking_start":
      case "toolcall_start":
      case "block":
        partial.content[change.contentIndex] = change.block as Block;
        return;
      case "text_delta":
      case "thinking_delta":
        if (block?.type === "text") block.text += change.delta;
        else if (block?.type === "thinking") block.thinking += change.delta;
        return;
      case "toolcall_delta":
        if (block?.type === "toolCall") appendAt(block.arguments, change.path, change.delta);
        return;
      default: {
        const unhandled: never = change;
        return unhandled;
      }
    }
  }
}

/** Append to the string at `path` within a tool call's streamed arguments. */
function appendAt(target: Record<string, unknown>, path: readonly (string | number)[], delta: string): void {
  let node: Record<string | number, unknown> = target;
  for (const [index, key] of path.entries()) {
    if (index === path.length - 1) {
      node[key] = (typeof node[key] === "string" ? node[key] : "") + delta;
      return;
    }
    const next = node[key];
    if (typeof next !== "object" || next === null) return;
    node = next as Record<string | number, unknown>;
  }
}

export function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}
