// Reconnect replaces live state from a snapshot; the changes after it apply to the view it carried.
import { applyImmutable, type Decoder, decoder } from "@earendil-works/chord/delta";
import type {
  CompactionFailure,
  CompactionStatus,
  ConversationView,
  EntryRecord,
  InboxItem,
  InboxState,
  LiveState,
  NestedToolSlot,
  RunFailureReason,
  ToolSlot,
} from "@earendil-works/pi-durable";
import type { ApprovalView, AutoStatus, CommandApproval, CommandMode } from "../../../src/core/approvals.ts";
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

export type Attachment = {
  id: string;
  name: string;
  size: number;
  mediaType: string;
  /** What of it the model got with its message; absent on drafts and older messages. */
  received?: import("../../../src/core/uploads.ts").Received;
};

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
  /** The task that wrote it; a tool result's is the call's own task. */
  byTaskId?: number;
  model?: Message[];
  data?: {
    attachments?: Attachment[];
    shell?: ShellReceipt;
    mcp?: McpReceipt;
    helper?: { task: number; purpose: string };
    result?: { task: number; status: "answered" | "unanswered" };
  };
};

/** What the server sends first, and again whenever its view no longer continues what the client has. */
export type Snapshot = { view: ConversationView; earlier: readonly EntryRecord[] };

const NONE: readonly never[] = Object.freeze([]);
/** A run that ended this way already shows: the owner stopped it, a reset began a new context, or the answer is an error. */
const SHOWN: ReadonlySet<RunFailureReason> = new Set(["aborted", "reset", "model_error"]);

export class ChatStream {
  /** Every entry the client has, oldest first: the snapshot's history, then each one the view's window adds. */
  entries: readonly Entry[] = $state.raw([]);
  partial: Message | undefined = $state.raw();
  running = $state(false);
  tools: readonly ToolSlot[] = $state.raw([]);
  /** Calls the running tools made, such as a script's tool calls, related by native call and task IDs. */
  nested: readonly NestedToolSlot[] = $state.raw([]);
  inbox: readonly InboxItem[] = $state.raw([]);
  retry: { at: number; error: string } | undefined = $state.raw();
  /** When Pal next asks the provider for a deferred response. */
  deferredPoll: number | undefined = $state();
  compactions: readonly CompactionStatus[] = $state.raw([]);
  compactionFailure: CompactionFailure | undefined = $state.raw();
  /** Why the latest run ended without an answer, when nothing else shows it; never shown as success. */
  failure: { reason: RunFailureReason; message: string } | undefined = $state.raw();
  connected = $state(false);
  loaded = $state(false);
  /** The browser retries a dropped stream by itself; one the server refused stays closed until replaced. */
  problem: "retrying" | "closed" | undefined = $state();
  mode: CommandMode | undefined = $state();
  /** Whether Auto can be chosen, as of the last approvals view. */
  auto: AutoStatus | undefined = $state.raw();
  approvals: readonly CommandApproval[] = $state([]);
  #source: EventSource | undefined;
  #view: ConversationView | undefined;
  #decoder: Decoder = decoder();

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
    listen<Snapshot>("snapshot", (snapshot) => this.#reset(snapshot));
    listen<unknown[]>("change", (ops) => this.#change(ops));
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
    this.auto = view.auto;
    this.approvals = view.approvals;
  }

  /** Snapshots are authoritative: whatever one leaves out is cleared. */
  #reset({ view, earlier }: Snapshot): void {
    this.#decoder = decoder();
    this.#view = view;
    // SAFETY: Pi entries are read through Pal's narrower view: `model` holds Pi's own messages, and every `data` field the
    // view reads is checked against the entry kind that writes it (pal.shell, pal.mcp, pal.helper, pal.user) first.
    this.entries = [...earlier, ...view.entries] as unknown as Entry[];
    this.#live(view);
    this.loaded = true;
    this.connected = true;
    this.problem = undefined;
  }

  /** A change to the view, as Chord ops; a malformed one leaves the view as it was until the next snapshot. */
  #change(wire: unknown[]): void {
    const view = this.#view;
    if (view === undefined) return;
    let next: ConversationView;
    try {
      next = applyImmutable(view, this.#decoder.decode(wire));
    } catch {
      return;
    }
    this.#view = next;
    if (next.entries !== view.entries) {
      // The window only appends; the entries it drops stay here. The server resends a snapshot instead of a gap.
      const newest = this.entries.at(-1)?.id;
      const added = next.entries.filter((entry) => newest === undefined || entry.id > newest);
      // SAFETY: as in #reset.
      if (added.length > 0) this.entries = [...this.entries, ...(added as unknown as Entry[])];
    }
    if (next.docs !== view.docs) this.#live(next);
  }

  /** Run state from the view's built-in documents, each field replaced only when its part of the view changed. */
  #live(view: ConversationView): void {
    // SAFETY: Pi keys a view's built-in documents by kind, so `pi.live` and `pi.inbox` hold their documents' values.
    const live = (view.docs["pi.live"] ?? {}) as LiveState;
    const inbox = view.docs["pi.inbox"] as InboxState | undefined;
    this.running = live.run !== undefined;
    this.tools = live.tools ?? NONE;
    this.nested = live.nestedTools ?? NONE;
    this.partial = live.generation?.message as Message | undefined;
    this.retry = live.generation?.retry;
    this.deferredPoll = live.generation?.deferred?.pollAt;
    this.inbox = inbox?.items ?? NONE;
    this.compactions = live.compactions ?? NONE;
    this.compactionFailure = live.compactionFailure;
    const failed = live.runFailure;
    this.failure =
      failed === undefined || SHOWN.has(failed.reason)
        ? undefined
        : { reason: failed.reason, message: failed.detail ?? failed.reason.replaceAll("_", " ") };
  }
}

export function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}
