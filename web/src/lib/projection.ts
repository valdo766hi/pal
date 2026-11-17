// A chat's transcript as rows to show, from its entries and live turn alone: no component state.
import {
  type Attachment,
  type Block,
  type CommandApproval,
  type Entry,
  type McpReceipt,
  type Message,
  type NestedCall,
  type ShellReceipt,
  textOf,
} from "./chat.svelte.ts";
import type { Piece, RendererProps } from "./plugins.ts";

export type Step = {
  id: string;
  name: string;
  code: string | undefined;
  /** A direct call's arguments, as a script's calls record theirs. */
  args: string | undefined;
  latest: boolean;
  result: { text: string; isError: boolean; calls: NestedCall[]; task: number | undefined } | undefined;
};
export type Work = Extract<Item, { kind: "assistant" | "shell" | "mcp" | "helper" | "approval" }>;
/** A run's tool activity between two things the owner reads, shown as one line until opened. */
export type Row = Item | { kind: "work"; id: string; items: Work[] };
export type Item =
  | { kind: "user"; id: string; text: string; at: number | undefined; attachments: Attachment[] }
  | {
      kind: "assistant";
      id: string;
      texts: string[];
      steps: Step[];
      at: number | undefined;
      error: string | undefined;
      stopped: boolean;
      live: boolean;
    }
  | { kind: "note"; id: string; text: string }
  | { kind: "plugin"; id: string; entry: Entry; piece: Piece<RendererProps> | "missing" }
  | { kind: "shell"; id: string; receipt: ShellReceipt }
  | { kind: "mcp"; id: string; receipt: McpReceipt }
  | { kind: "helper"; id: string; task: number; purpose: string; status: "answered" | "unanswered" | undefined }
  | { kind: "approval"; id: string; approval: CommandApproval };

/** How a chat shows an entry a plugin wrote (see `renderer` in plugins.ts). */
export type PieceFor = (kind: string) => Piece<RendererProps> | "missing" | undefined;

/**
 * What a chat shows for its `entries`, then the live `partial` turn. Command requests sit under the assistant turn that
 * asked; `pieceFor` is how this chat shows a plugin's entry.
 */
export function build(
  entries: readonly Entry[],
  partial: Message | undefined,
  approvals: readonly CommandApproval[],
  pieceFor: PieceFor,
): Item[] {
  // A result belongs to the call of that ID in the latest assistant message before it; IDs may repeat across turns.
  const results: Record<string, NonNullable<Step["result"]>> = {};
  const caller: Record<string, number> = {};
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === "pi.assistant" && message !== undefined && typeof message.content !== "string") {
      for (const block of message.content) if (block.type === "toolCall") caller[block.id] = entry.id;
    } else if (entry.kind === "pi.tool-result" && message?.toolCallId !== undefined) {
      results[`${caller[message.toolCallId]}/${message.toolCallId}`] = {
        text: textOf(message),
        isError: message.isError === true,
        calls: message.details?.calls ?? [],
        task: entry.byTaskId,
      };
    }
  }
  const assistant = (id: number | "live", message: Message, live: boolean): Item => {
    const blocks: Block[] =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    return {
      kind: "assistant",
      id: String(id),
      texts: blocks.flatMap((block) => (block.type === "text" && block.text !== "" ? [block.text] : [])),
      steps: blocks.flatMap((block) =>
        block.type === "toolCall"
          ? [
              {
                id: block.id,
                name: block.name,
                code: typeof block.arguments.code === "string" ? block.arguments.code : undefined,
                args: block.name === "codemode" ? undefined : JSON.stringify(block.arguments),
                latest: caller[block.id] === id,
                result: results[`${id}/${block.id}`],
              },
            ]
          : [],
      ),
      at: message.timestamp,
      error: message.stopReason === "error" ? (message.errorMessage ?? "The model request failed.") : undefined,
      stopped: message.stopReason === "aborted",
      live,
    };
  };
  const receipts = new Map(
    entries.flatMap((entry) =>
      entry.kind === "pal.shell" && entry.data?.shell?.status === "finished"
        ? [[entry.data.shell.callId, entry.data.shell] as const]
        : [],
    ),
  );
  const answers = new Map(
    entries.flatMap((entry) =>
      entry.kind === "pal.helper" && entry.data?.result
        ? [[entry.data.result.task, entry.data.result.status] as const]
        : [],
    ),
  );
  const internet = new Map(
    entries.flatMap((entry) =>
      entry.kind === "pal.mcp" && entry.data?.mcp ? [[entry.data.mcp.callId, entry.id] as const] : [],
    ),
  );
  // Each command request sits under the assistant turn whose script asked; others close the transcript.
  const placed = new Set(entries.map((entry) => entry.id));
  const asked = (assistant: number | null) =>
    approvals.flatMap((approval): Item[] =>
      approval.assistant === assistant ? [{ kind: "approval", id: `approval-${approval.id}`, approval }] : [],
    );
  const built: Item[] = [];
  for (const entry of entries) {
    if (entry.kind === "pal.mcp" && entry.data?.mcp !== undefined) {
      if (internet.get(entry.data.mcp.callId) === entry.id)
        built.push({ kind: "mcp", id: String(entry.id), receipt: entry.data.mcp });
      continue;
    }
    if (entry.kind === "pal.helper") {
      if (entry.data?.helper !== undefined)
        built.push({
          kind: "helper",
          id: String(entry.id),
          task: entry.data.helper.task,
          purpose: entry.data.helper.purpose,
          status: answers.get(entry.data.helper.task),
        });
      continue;
    }
    if (entry.kind === "pal.shell" && entry.data?.shell?.status === "started") {
      built.push({
        kind: "shell",
        id: String(entry.id),
        receipt: receipts.get(entry.data.shell.callId) ?? entry.data.shell,
      });
      continue;
    }
    const piece = pieceFor(entry.kind);
    if (piece !== undefined) {
      built.push({ kind: "plugin", id: String(entry.id), entry, piece });
      continue;
    }
    const message = entry.model?.[0];
    if ((entry.kind === "pi.user" || entry.kind === "pal.user") && message !== undefined) {
      // An input with attachments shows its own text; the attachments' contents went to the model, not the bubble.
      const content = typeof message.content === "string" ? message.content : message.content[0];
      const text = typeof content === "string" ? content : content?.type === "text" ? content.text : "";
      built.push({
        kind: "user",
        id: String(entry.id),
        text,
        at: message.timestamp,
        attachments: entry.data?.attachments ?? [],
      });
    } else if (entry.kind === "pi.assistant" && message !== undefined) {
      built.push(assistant(entry.id, message, false), ...asked(entry.id));
    } else if (entry.kind === "pi.compaction") {
      built.push({
        kind: "note",
        id: String(entry.id),
        text: "Earlier messages were summarized to keep the chat within the model's context.",
      });
    }
  }
  for (const approval of approvals) {
    if (approval.assistant === null || !placed.has(approval.assistant))
      built.push({ kind: "approval", id: `approval-${approval.id}`, approval });
  }
  if (partial !== undefined) built.push(assistant("live", partial, true));
  return built;
}

const works = (item: Item, retried: ReadonlySet<string>): item is Work =>
  item.kind === "shell" ||
  item.kind === "mcp" ||
  item.kind === "helper" ||
  (item.kind === "approval" && item.approval.state !== "pending") ||
  (item.kind === "assistant" && (item.steps.length > 0 || retried.has(item.id)));
/**
 * Adds `item` to `rows`: tool activity joins the run's line before it; what the owner reads or answers stands alone.
 * `retried` names assistant turns whose failed attempts Pi retried.
 */
export function place(rows: Row[], item: Item, retried: ReadonlySet<string>): Row[] {
  const last = rows.at(-1);
  if (!works(item, retried)) rows.push(item);
  else if (last?.kind === "work") rows[rows.length - 1] = { ...last, items: [...last.items, item] };
  // Named for what precedes it, so the line stays the same one when its first live step commits.
  else rows.push({ kind: "work", id: `work-${last?.id ?? "start"}`, items: [item] });
  // A step's turn that failed or was stopped says so below its line.
  if (
    item.kind === "assistant" &&
    item.steps.length > 0 &&
    !retried.has(item.id) &&
    (item.error !== undefined || item.stopped)
  )
    rows.push({ ...item, id: `${item.id}-end`, texts: [], steps: [] });
  return rows;
}
