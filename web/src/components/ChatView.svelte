<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    api,
    ApiError,
    type ChatSummary,
    type CommandMode as Approval,
    type Effort,
    type HelperView,
    type Project,
    requestId,
    type WorkspaceMode as Mode,
  } from "../lib/api.ts";
  import {
    type Attachment,
    type Block,
    ChatStream,
    type CommandApproval,
    type Entry,
    type Message,
    type McpReceipt,
    type NestedCall,
    type ShellReceipt,
    textOf,
  } from "../lib/chat.svelte.ts";
  import Icon from "../lib/Icon.svelte";
  import type { IconName } from "../lib/icons.ts";
  import AddMenu from "./AddMenu.svelte";
  import CommandMode from "./CommandMode.svelte";
  import InternetSources from "./InternetSources.svelte";
  import ModelControl, { type Group } from "./ModelControl.svelte";
  import ProjectMcpSettings from "./ProjectMcpSettings.svelte";
  import WorkspaceMode from "./WorkspaceMode.svelte";
  import { drafts, type PendingInput } from "../lib/drafts.svelte.ts";
  import { MAX_INPUT_ATTACHMENTS, MAX_INPUT_CHARS } from "../../../src/protocol/limits.ts";
  import type { ReviewFeedback } from "../../../src/core/feedback.ts";
  import { type Call, describe, summarize, toolLabel } from "../lib/activity.ts";
  import { codeCopy, copyText } from "../lib/copy.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { rise } from "../lib/motion.ts";
  import { app, navigate, refreshChatGPT, refreshProjects, viewport } from "../lib/state.svelte.ts";
  import { loadFailures, type Piece, type RendererProps, renderer, slots } from "../lib/plugins.ts";

  let {
    chat,
    project,
    onNewChat,
    panels,
    onPanel,
    changeCount,
    onAdmitted,
  }: {
    chat: ChatSummary;
    project: Project;
    onNewChat: (mode: Mode) => Promise<void>;
    /** The workspace panels this chat offers; on a phone they open from the tools sheet. */
    panels: readonly { id: string; icon: IconName }[];
    onPanel: (id: string) => void;
    changeCount?: number | undefined;
    onAdmitted?: () => void;
  } = $props();
  const workspace = $derived(chat.workspace);
  const composerPieces = $derived(slots("composer", chat.extensions));
  /**
   * This build's contributions as `id@version`, once known: entries of a plugin a chat pinned at a version this build
   * lacks get a plain note.
   */
  const available = $derived(
    app.extensions === undefined
      ? undefined
      : new Set(
          app.extensions.catalog.filter((item) => item.available !== false).map((item) => `${item.id}@${item.version}`),
        ),
  );
  /** Room each composer piece asks for above the transcript's end. */
  let spaces: Record<string, number> = $state({});
  const reserved = $derived(Math.max(0, ...Object.values(spaces)));
  const root = $derived(workspace?.root ?? project.root);
  const ready = $derived(workspace == null || workspace.state === "ready");
  let preparing = $state(false);
  async function prepare() {
    preparing = true;
    try {
      await api.prepareWorkspace(chat.id);
      await refreshProjects();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      preparing = false;
    }
  }

  type Step = {
    id: string;
    name: string;
    code: string | undefined;
    /** A direct call's arguments, as a script's calls record theirs. */
    args: string | undefined;
    latest: boolean;
    result: { text: string; isError: boolean; calls: NestedCall[]; task: number | undefined } | undefined;
  };
  type Work = Extract<Item, { kind: "assistant" | "shell" | "mcp" | "helper" | "approval" }>;
  /** A run's tool activity between two things the owner reads, shown as one line until opened. */
  type Row = Item | { kind: "work"; id: string; items: Work[] };
  type Item =
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

  const USAGE_URL = "https://chatgpt.com/settings/usage";

  let stream: ChatStream | undefined = $state();
  let model: string | null = $state(null);
  let provider: string | null = $state(null);
  let effort: Effort = $state("off");
  let configuration = $state("");
  let metadata = $state<"loading" | "unset" | "configured" | "failed">("loading");
  let metadataChat = $state("");
  let metadataError: string | undefined = $state();
  let loadEpoch = 0;
  const hydrated = $derived(metadataChat === chat.id && (metadata === "unset" || metadata === "configured"));
  let choosing = $state(false);
  // Workspace keys this component by chat.id; the shared cells outlive observation of that chat.
  const writing = drafts.open(untrack(() => chat.id));
  let typing = $state(false);
  let composer: HTMLTextAreaElement | undefined = $state();
  let scheduling = $state(false);
  /** Add text the owner chose elsewhere (a terminal selection, a file reference) to the draft; never sends it. */
  export function insertText(text: string): boolean {
    const added = writing.append(text);
    if (added) composer?.focus();
    return added;
  }
  export function insertFeedback(text: string, feedback: ReviewFeedback): boolean {
    const added = writing.appendFeedback(text, feedback);
    if (added) composer?.focus();
    return added;
  }
  export function hasFeedback(id: string): boolean {
    return writing.feedback?.ids.includes(id) ?? false;
  }
  let error: string | undefined = $state();
  let openSteps: Record<string, boolean> = $state({});
  /** Texts this page queued, by submission, so a queued item can show what it says. */
  let queuedTexts: Record<number, string> = $state({});
  const phone = $derived(viewport() === "phone");
  /** A phone's tools sheet: panels, then the composer's model, approval and workspace choices. A modal dialog, so it
   * traps focus, closes on Escape and gives focus back to its opener. */
  let tools = $state(false);
  let sheet: HTMLDialogElement | undefined = $state();
  /** Whether Escape found a popover open in the sheet; it closes that popover before the dialog sees `cancel`. */
  let escaping = false;
  export function openTools() {
    tools = true;
  }
  // Wider screens have no sheet, so it doesn't reappear on the next phone-width layout.
  $effect(() => {
    if (!phone) tools = false;
  });
  /** Set once the history has rendered, so only items arriving afterwards animate in. */
  let settled = $state(false);
  $effect(() => {
    if (stream?.loaded && !settled) void tick().then(() => (settled = true));
  });

  async function loadMetadata(id: string) {
    const epoch = ++loadEpoch;
    metadataChat = id;
    metadata = "loading";
    metadataError = undefined;
    choosing = false;
    model = null;
    provider = null;
    effort = "off";
    configuration = "";
    try {
      const loaded = await api.chat(id);
      if (epoch !== loadEpoch) return;
      model = loaded.model;
      provider = loaded.provider;
      effort = loaded.effort;
      configuration = loaded.configuration;
      metadata = loaded.model === null ? "unset" : "configured";
    } catch (failure) {
      if (epoch !== loadEpoch) return;
      metadataError = failure instanceof Error ? failure.message : String(failure);
      metadata = "failed";
    }
  }

  /** Replaces a stream the server closed; the browser itself retries one that merely dropped. */
  let reconnect = () => {};
  $effect(() => {
    const id = chat.id;
    let current = new ChatStream(id);
    stream = current;
    reconnect = () => {
      current.close();
      current = new ChatStream(id);
      stream = current;
    };
    void loadMetadata(id);
    return () => {
      loadEpoch++;
      current.close();
    };
  });

  let diagnostics: "idle" | "copying" | "copied" = $state("idle");
  /** Copies this chat's redacted run state, request IDs and effect outcomes for support. */
  async function copyDiagnostics() {
    diagnostics = "copying";
    try {
      const report = { ...(await api.chatDiagnostics(chat.id)), interface: { pluginLoadFailures: loadFailures } };
      const copied = await copyText(JSON.stringify(report, null, 2));
      diagnostics = copied ? "copied" : "idle";
      if (!copied) error = "The browser refused to copy diagnostics.";
    } catch (failure) {
      diagnostics = "idle";
      error = `Couldn't copy diagnostics: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
  }

  let stopping = $state(false);
  let stopError: string | undefined = $state();
  let resolving = $state(false);
  let resolveError: string | undefined = $state();
  async function stop() {
    stopping = true;
    stopError = undefined;
    try {
      await api.stop(chat.id);
    } catch (failure) {
      stopError = failure instanceof Error ? failure.message : String(failure);
    } finally {
      stopping = false;
    }
  }

  // Live text changes often; keep committed history from being rebuilt for each partial update.
  const historyItems = $derived(build(stream?.entries ?? [], undefined, stream?.approvals ?? []));
  /** Durable helper status, including calls left with unknown outcomes; refreshed as helpers and runs change. */
  let helpers: HelperView[] = $state([]);
  let helpersError: string | undefined = $state();
  let helpersPending = $state(false);
  let helpersRefresh = $state(0);
  const helperUpdates = $derived((stream?.entries ?? []).filter((entry) => entry.kind === "pal.helper").length);
  $effect(() => {
    const id = chat.id;
    const running = stream?.running;
    void helpersRefresh;
    if (helperUpdates === 0 || running === undefined) return;
    let current = true;
    helpersPending = true;
    helpersError = undefined;
    api.helpers(id).then(
      (loaded) => {
        if (!current) return;
        helpers = loaded.helpers;
        helpersPending = false;
      },
      (failure) => {
        if (!current) return;
        helpersError = failure instanceof Error ? failure.message : String(failure);
        helpersPending = false;
      },
    );
    return () => {
      current = false;
    };
  });
  function helperStatus(status: "answered" | "unanswered" | undefined, view: HelperView | undefined) {
    if (status === "answered" || view?.status === "answered") return { text: "answered", failed: false };
    if (status === "unanswered" || view?.status === "unanswered" || view?.status === "stopped")
      return { text: view?.reason ? `stopped: ${view.reason}` : "stopped", failed: true };
    if (view?.status === "running")
      return { text: helpersError || helpersPending ? "last observed working" : "working", failed: false };
    return { text: helpersPending ? "checking status" : "status unavailable", failed: true };
  }
  const items = $derived(historyItems.concat(build([], stream?.partial, [])));
  const works = (item: Item): item is Work =>
    item.kind === "shell" ||
    item.kind === "mcp" ||
    item.kind === "helper" ||
    (item.kind === "approval" && item.approval.state !== "pending") ||
    (item.kind === "assistant" && item.steps.length > 0);
  /** Adds `item` to `rows`: tool activity joins the run's line before it; what the owner reads or answers stands alone. */
  function place(rows: Row[], item: Item): Row[] {
    const last = rows.at(-1);
    if (!works(item)) rows.push(item);
    else if (last?.kind === "work") rows[rows.length - 1] = { ...last, items: [...last.items, item] };
    // Named for what precedes it, so the line stays the same one when its first live step commits.
    else rows.push({ kind: "work", id: `work-${last?.id ?? "start"}`, items: [item] });
    // A step's turn that failed or was stopped says so below its line.
    if (item.kind === "assistant" && item.steps.length > 0 && (item.error !== undefined || item.stopped))
      rows.push({ ...item, id: `${item.id}-end`, texts: [], steps: [] });
    return rows;
  }
  const historyRows = $derived(historyItems.reduce(place, []));
  // Only the last line changes while a turn streams; the rows before it keep their identity.
  const rows = $derived(build([], stream?.partial, []).reduce(place, [...historyRows]));
  /** The line the current run is adding to: the last one, unless the answer has begun after it. */
  const activeWork = $derived.by(() => {
    if (!stream?.running) return undefined;
    const last = rows.findLast((row) => row.kind !== "approval");
    return last?.kind === "work" ? last.id : undefined;
  });
  const awaiting = $derived((stream?.approvals ?? []).some((approval) => approval.state === "pending"));
  const connected = $derived(app.chatgpt?.account != null);
  const effective = $derived.by(() => {
    if (!hydrated) return null;
    if (model === null) return app.chatgpt?.default ?? null;
    return provider === null ? null : { provider, modelId: model };
  });
  /** ChatGPT once connected (or while it is this chat's provider), then each API-key provider the owner enabled. */
  const groups = $derived<Group[]>([
    ...(connected || effective?.provider === "openai"
      ? [
          {
            provider: "openai",
            name: "ChatGPT",
            billing: "Your ChatGPT subscription.",
            choices: (app.chatgpt?.models ?? [])
              .filter((choice) => choice.supported)
              .map((choice) => ({
                provider: "openai",
                id: choice.slug,
                name: choice.displayName,
                efforts: choice.efforts,
              })),
          },
        ]
      : []),
    ...(app.providers?.providers ?? [])
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        provider: entry.id,
        name: entry.name,
        billing: entry.billing,
        choices: entry.models.map((choice) => ({
          provider: entry.id,
          id: choice.id,
          name: choice.name,
          efforts: choice.efforts as Effort[],
        })),
      })),
  ]);
  const current = $derived(
    groups
      .flatMap((group) => group.choices)
      .find((choice) => choice.provider === effective?.provider && choice.id === effective.modelId),
  );
  const providerName = $derived(groups.find((group) => group.provider === effective?.provider)?.name);
  const modelName = $derived(current?.name ?? effective?.modelId ?? "Choose model");
  /** The chat's provider can take a message now: signed-in ChatGPT, or an enabled API-key provider. */
  const usable = $derived(
    effective !== null &&
      (effective.provider === "openai"
        ? connected
        : (app.providers?.providers ?? []).some((entry) => entry.id === effective.provider && entry.enabled)),
  );
  const isDefault = $derived(
    effective !== null &&
      app.chatgpt?.default?.provider === effective.provider &&
      app.chatgpt.default.modelId === effective.modelId,
  );
  const canSend = $derived(
    hydrated &&
      ready &&
      writing.active &&
      !writing.blocked &&
      !writing.sending &&
      writing.pending === undefined &&
      !choosing &&
      writing.uploading === 0 &&
      writing.text.trim() !== "" &&
      usable,
  );

  function build(
    entries: readonly Entry[],
    partial: Message | undefined,
    approvals: readonly CommandApproval[],
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
      const piece = renderer(entry.kind, chat.extensions, available);
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

  async function attempt(work: (epoch: number) => Promise<void>) {
    if (!writing.active || writing.blocked || writing.sending) return;
    const epoch = loadEpoch;
    writing.sending = true;
    writing.error = undefined;
    writing.notice = undefined;
    error = undefined;
    try {
      await work(epoch);
    } catch (failure) {
      if (!writing.active) return;
      if (failure instanceof ApiError && failure.code === "configuration_stale") {
        if (writing.pending !== undefined) writing.reject(writing.pending);
        if (epoch === loadEpoch) settingsFailure(failure);
        else writing.error = failure.message;
      } else if (failure instanceof ApiError && failure.code === "input_blocked") {
        // Pal keeps this input as blocked; the chat's blocked notice offers Retry and Withdraw.
        void refreshProjects();
      } else if (failure instanceof ApiError && failure.code === "input_held") {
        if (writing.pending !== undefined) writing.reject(writing.pending);
        writing.error = failure.message;
        void refreshProjects();
      } else {
        if (
          failure instanceof ApiError &&
          ["feedback_stale", "feedback_mismatch", "ignored_permission"].includes(failure.code) &&
          writing.pending !== undefined
        ) {
          writing.unlinkFeedback(writing.pending.body.feedback?.ids ?? []);
          writing.reject(writing.pending);
        }
        writing.error = failure instanceof Error ? failure.message : String(failure);
      }
    } finally {
      writing.sending = false;
    }
  }

  async function deliver(envelope: PendingInput, epoch: number) {
    const { text, whenBusy, attachments, configuration, feedback } = envelope.body;
    const { admission } = await api.send(
      envelope.chatId,
      envelope.requestId,
      text,
      whenBusy,
      attachments,
      configuration,
      writing.signal,
      feedback,
    );
    writing.confirm(envelope, admission);
    if (epoch !== loadEpoch) return;
    if (feedback !== undefined) onAdmitted?.();
    if (stream?.running) queuedTexts[admission.submissionId] = text;
    if (chat.title === null) void refreshProjects();
  }

  async function send() {
    if (!canSend) return;
    const snapshot = writing.snapshot(stream?.running === true);
    const destination = effective;
    let selected = configuration;
    await attempt(async (epoch) => {
      if (model === null && destination !== null) {
        const chosen = await api.setChatModel(
          writing.chatId,
          destination.modelId,
          undefined,
          destination.provider,
          selected,
        );
        selected = chosen.configuration;
        if (epoch === loadEpoch) {
          model = chosen.model;
          provider = chosen.provider;
          effort = chosen.effort;
          configuration = chosen.configuration;
          metadata = "configured";
        }
      }
      if (writing.active) await deliver(writing.stage(requestId(), snapshot, selected), epoch);
    });
  }

  /** Retry or withdraw the input Pal holds as blocked, in turn with this chat's other inputs. */
  async function resolveBlocked(action: "retry" | "withdraw") {
    const blocked = chat.blocked;
    if (blocked === null || resolving) return;
    const id = chat.id;
    const pending = writing.pending?.requestId === blocked.requestId ? writing.pending : undefined;
    resolving = true;
    resolveError = undefined;
    try {
      if (action === "retry") {
        const { admission } = await api.retryInput(id, blocked.requestId);
        if (pending !== undefined) writing.confirm(pending, admission);
      } else {
        await api.withdrawInput(id, blocked.requestId);
        // The withdrawn text stays in this chat's draft when it is still there.
        if (pending !== undefined) writing.reject(pending);
      }
    } catch (failure) {
      resolveError = failure instanceof Error ? failure.message : String(failure);
    } finally {
      resolving = false;
      void refreshProjects();
    }
  }

  /** A send saved before a reload: cleared if Pal admitted it, otherwise kept for an explicit, idempotent retry. */
  async function recover(envelope: PendingInput) {
    try {
      const input = await api.input(envelope.chatId, envelope.requestId);
      if (input.state === "admitted") writing.confirm(envelope, input.admission);
      else if (input.state === "withdrawn") writing.reject(envelope);
      else writing.recovered = false;
    } catch (failure) {
      if (!writing.active || writing.pending !== envelope) return;
      writing.recovered = false;
      writing.error =
        failure instanceof ApiError && failure.code === "input_not_found"
          ? "It never reached Pal."
          : "Pal couldn't confirm whether it arrived; retrying won't send it twice.";
    }
  }
  $effect(() => {
    const envelope = writing.pending;
    if (writing.recovered && envelope !== undefined) untrack(() => void recover(envelope));
  });

  async function retrySaved() {
    const envelope = writing.pending;
    if (envelope !== undefined) await attempt((epoch) => deliver(envelope, epoch));
  }

  function settingsFailure(failure: unknown) {
    if (failure instanceof ApiError && failure.code === "configuration_stale") {
      metadata = "failed";
      metadataError = failure.message;
    } else error = failure instanceof ApiError ? failure.message : String(failure);
  }

  async function chooseModel(choice: { provider: string; id: string }, level?: Effort) {
    if (choosing || writing.sending || !hydrated) return;
    const id = chat.id,
      epoch = loadEpoch;
    choosing = true;
    try {
      const chosen = await api.setChatModel(id, choice.id, level, choice.provider, configuration);
      if (epoch !== loadEpoch) return;
      model = chosen.model;
      provider = chosen.provider;
      effort = chosen.effort;
      configuration = chosen.configuration;
      metadata = "configured";
    } catch (failure) {
      if (epoch === loadEpoch) settingsFailure(failure);
    } finally {
      if (epoch === loadEpoch) choosing = false;
    }
  }

  async function useForNewChats() {
    if (effective === null) return;
    try {
      app.providers = await api.setDefault(effective.provider, effective.modelId);
      await refreshChatGPT();
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    }
  }

  async function chooseMode(next: Approval) {
    try {
      const { chat: changed } = await api.setCommandMode(chat.id, next);
      if (stream !== undefined && changed.commandMode !== undefined) stream.mode = changed.commandMode;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    }
  }

  let deciding: string | undefined = $state();
  async function decide(approval: CommandApproval, decision: "approve" | "deny") {
    if (deciding !== undefined) return;
    deciding = approval.id;
    error = undefined;
    try {
      stream?.showApprovals(await api.decideCommand(chat.id, approval.id, decision, approval.digest));
    } catch (failure) {
      error =
        failure instanceof ApiError && failure.code === "approval_stale"
          ? "That request is no longer waiting for an answer. Nothing changed."
          : failure instanceof ApiError
            ? failure.message
            : String(failure);
    } finally {
      deciding = undefined;
    }
  }

  const heads = {
    pending: "Run this command?",
    approved: "Command approved",
    denied: "Command denied",
    expired: "Approval expired",
    stopped: "Approval request ended",
  } as const;
  const browserHeads = {
    ...heads,
    pending: "Approval needed for a browser action",
    approved: "Browser action approved",
    denied: "Browser action denied",
  };
  function outcome(approval: CommandApproval): string {
    const at = time(approval.decidedAt ?? undefined);
    if (approval.state === "approved")
      return `Approved once by you at ${at}. Later ${approval.tool === "browser_act" ? "browser actions" : "commands"} ask again.`;
    if (approval.state === "denied") return `Denied by you at ${at}. Nothing was run.`;
    if (approval.state === "expired") return "No answer before it expired. Nothing was run.";
    return "The run stopped before you answered. Nothing was run.";
  }

  async function upload(files: File[]) {
    const projectId = project.id;
    for (const file of files) {
      if (!writing.active || writing.blocked) return;
      if (writing.attachments.length + writing.uploading >= MAX_INPUT_ATTACHMENTS) {
        writing.error = `A draft can attach at most ${MAX_INPUT_ATTACHMENTS} files.`;
        return;
      }
      writing.touch();
      writing.uploading++;
      try {
        const attachment = await api.upload(projectId, file, writing.signal);
        writing.attachments = [...writing.attachments, attachment];
      } catch (failure) {
        if (writing.active)
          writing.error = `${file.name}: ${failure instanceof ApiError ? failure.message : String(failure)}`;
      } finally {
        writing.uploading--;
      }
    }
  }

  /**
   * Files pasted into the composer, such as a screenshot or a copied image, attach like chosen ones. A clipboard that
   * also holds plain text, as rich documents do along with an image of themselves, pastes that text instead.
   */
  function paste(event: ClipboardEvent) {
    const data = event.clipboardData;
    if (data === null || data.files.length === 0 || data.types.includes("text/plain")) return;
    event.preventDefault();
    void upload([...data.files]);
  }

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }

  /** What of a sent attachment the message gave the model, when not all of it. */
  function received(attachment: Attachment): string {
    const got = attachment.received;
    if (got?.kind === "binary") return " · contents not sent";
    return got?.kind === "text" && got.bytes < attachment.size ? ` · first ${size(got.bytes)} sent` : "";
  }

  function onKey(event: KeyboardEvent) {
    // Enter that confirms an input method's composition is not a send.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && app.sendWithEnter && !phone) {
      event.preventDefault();
      void send();
    }
  }

  function activeTool(step: Step) {
    return step.latest ? stream?.tools.find((tool) => tool.callId === step.id) : undefined;
  }
  function phase(step: Step, live: boolean) {
    if (step.result !== undefined) return step.result.isError ? "Failed" : "Done";
    if (live) return "Preparing";
    const tool = activeTool(step);
    if (tool?.status === "running") return stream?.connected ? "Running" : "Last observed running";
    if (tool?.status === "pending") return "Queued";
    return "Outcome unconfirmed";
  }

  /** A command's live slot while it runs, model-issued or from a script; its receipt names the tool task. */
  function runningCommand(receipt: ShellReceipt) {
    return [...(stream?.tools ?? []), ...(stream?.nested ?? [])].find(
      (slot) => slot.status === "running" && String(slot.taskId) === receipt.callId,
    );
  }

  /** What a step did: a direct call, or the calls its script made, including those still running. */
  function callsOf(step: Step): Call[] {
    if (step.name !== "codemode") return [{ name: step.name, args: step.args }];
    if (step.result !== undefined) return step.result.calls;
    const task = activeTool(step)?.taskId;
    return task === undefined ? [] : (stream?.nested ?? []).filter((call) => call.parentTaskId === task);
  }
  function stepLabel(step: Step) {
    // A script's commands are listed under it by their receipts.
    const calls = callsOf(step);
    const label = describe(step.name === "codemode" ? calls.filter((call) => call.name !== "shell_run") : calls);
    return label.verb === "" ? { verb: step.name === "codemode" ? "Ran a script" : toolLabel(step.name) } : label;
  }
  /** A direct command whose receipt, in the same line, already shows it. */
  function receipted(step: Step, items: Work[]): boolean {
    const task = step.result?.task ?? activeTool(step)?.taskId;
    return (
      step.name === "shell_run" &&
      task !== undefined &&
      items.some((item) => item.kind === "shell" && item.receipt.callId === String(task))
    );
  }
  /** One quiet line for a run's tool activity: what it read, ran and changed, and whether anything went wrong. */
  function headline(items: Work[], active: boolean): string {
    const turns = items.filter((item) => item.kind === "assistant");
    const steps = turns.flatMap((turn) => turn.steps);
    // Commands count by their finished receipts: one that was denied or is still going has not run.
    const calls = items.flatMap((item): Call[] =>
      item.kind === "assistant"
        ? item.steps.flatMap(callsOf).filter((call) => call.name !== "shell_run")
        : item.kind === "shell" && item.receipt.status === "finished"
          ? [{ name: "shell_run" }]
          : [],
    );
    const line = summarize(calls) || (steps.some((step) => step.result !== undefined) ? "Ran a script" : "");
    if (active) return line || "Working";
    const failed = steps.filter((step) => step.result?.isError).length;
    const unconfirmed = items.some((item) =>
      item.kind === "assistant"
        ? item.steps.some((step) => phase(step, item.live) === "Outcome unconfirmed")
        : item.kind === "shell"
          ? item.receipt.status !== "finished"
          : item.kind === "helper" &&
            (helpers.find((helper) => helper.task === item.task)?.unknownEffects.length ?? 0) > 0,
    );
    return [line || "Worked", failed > 0 ? `${failed} failed` : "", unconfirmed ? "outcome unconfirmed" : ""]
      .filter((part) => part !== "")
      .join(", ");
  }
  function receiptState(receipt: ShellReceipt, running: boolean): string {
    if (receipt.timedOut) return "Timed out";
    if (receipt.exitCode !== undefined) return `Exit ${receipt.exitCode}`;
    if (running) return stream?.connected ? "Running" : "Last observed running";
    return "Outcome unconfirmed";
  }

  function time(at: number | undefined): string {
    return at === undefined ? "" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
</script>

{#snippet modelControl()}
  <ModelControl
    {groups}
    {effective}
    {current}
    {effort}
    busy={choosing}
    disabled={!hydrated || writing.sending}
    {connected}
    {isDefault}
    {usable}
    onModel={(choice) => chooseModel(choice)}
    onEffort={(level) => (current === undefined ? Promise.resolve() : chooseModel(current, level))}
    onDefault={useForNewChats}
  />
{/snippet}

{#snippet diagnosticsButton()}
  <button class="b sm" disabled={diagnostics === "copying"} onclick={copyDiagnostics}
    >{diagnostics === "copied" ? "Copied" : "Copy diagnostics"}</button
  >
{/snippet}

{#snippet busySwitch()}
  <div class="seg" role="radiogroup" aria-label="While the agent is running">
    <button
      class="segb"
      role="radio"
      aria-checked={writing.whenBusy === "steer"}
      onclick={() => (writing.whenBusy = "steer")}>Steer</button
    >
    <button
      class="segb"
      role="radio"
      aria-checked={writing.whenBusy === "followUp"}
      onclick={() => (writing.whenBusy = "followUp")}>Queue</button
    >
  </div>
{/snippet}

{#snippet stepRow(key: string, step: Step, live: boolean)}
  {@const state = phase(step, live)}
  {@const tool = activeTool(step)}
  {@const label = stepLabel(step)}
  {@const open = openSteps[key] === true}
  <li>
    <button class="row" aria-expanded={open} onclick={() => (openSteps[key] = !open)}>
      {#if state === "Preparing" || state === "Running"}<span class="ring spin" aria-hidden="true"></span>{/if}
      <span class="verb">{label.verb}</span>
      {#if label.object !== undefined}<span class="obj">{label.object}</span>{/if}
      {#if state === "Done"}<span class="sr">Done</span>
      {:else}<span class={["st", state === "Failed" && "er"]}>{state}</span>{/if}
      <Icon name={open ? "chevD" : "chevR"} size={13} />
    </button>
    {#if open}
      <div class="detail">
        {#if step.result === undefined}
          <div class="dim small">
            <span>Call {step.id}</span>{#if tool?.taskId !== undefined}
              · <span>Task {tool.taskId}</span>{/if}
          </div>
          {#if state === "Outcome unconfirmed"}<p class="dim small">
              No result was recorded. Inspect the workspace before repeating an action.
            </p>{/if}
          {#if tool?.taskId !== undefined}
            {#each stream?.nested.filter((call) => call.parentTaskId === tool.taskId) ?? [] as call (call.callId)}
              <div class="steprow">
                {#if call.status !== "done"}<span class="ring spin" aria-hidden="true"></span><span class="sr"
                    >Running</span
                  >
                {:else if call.summary?.isError !== false}<span class="tick er" aria-hidden="true">✕</span><span
                    class="sr">Failed</span
                  >
                {:else}<span class="tick ok" aria-hidden="true">✓</span><span class="sr">Done</span>{/if}
                <span>{toolLabel(call.name)}</span>
              </div>
            {/each}
          {/if}
        {/if}
        {#if step.code !== undefined}<pre class="out">{step.code}</pre>{/if}
        {#each step.result?.calls ?? [] as call (call.id)}
          <div class="steprow">
            {#if call.status === "ok"}<span class="tick ok" aria-hidden="true">✓</span><span class="sr">Done</span>
            {:else}<span class="tick" class:er={call.status !== "running"} aria-hidden="true"
                >{call.status === "running" ? "–" : "✕"}</span
              >{/if}
            <span>{toolLabel(call.name)}</span>
            <span class="args">{call.args}</span>
            {#if call.status !== "ok"}<span class="state"
                >{call.status === "running"
                  ? "Interrupted"
                  : call.status === "cancelled"
                    ? "Cancelled"
                    : "Failed"}</span
              >{/if}
          </div>
          {#if call.error}<div class="dim small">{call.error}</div>{/if}
        {/each}
        {#if step.result !== undefined}<pre class="out">{step.result.text}</pre>{/if}
      </div>
    {/if}
  </li>
{/snippet}

{#snippet shellRow(key: string, receipt: ShellReceipt, sub: boolean)}
  {@const running = receipt.status === "finished" ? undefined : runningCommand(receipt)}
  {@const open = openSteps[key] === true}
  <li class:under={sub}>
    <button class="row" aria-expanded={open} onclick={() => (openSteps[key] = !open)}>
      {#if running !== undefined}<span class="ring spin" aria-hidden="true"></span>{/if}
      <span class="obj mono">{receipt.command}</span>
      <span class={["st", (receipt.timedOut || (receipt.exitCode ?? 0) !== 0) && "er"]}
        >{receiptState(receipt, running !== undefined)}</span
      >
      <Icon name={open ? "chevD" : "chevR"} size={13} />
    </button>
    {#if open}
      <div class="detail">
        <div class="small dim">Host command, not sandboxed · <span>Call {receipt.callId}</span></div>
        <div class="small dim mono ellipsis" title={receipt.cwd}>{receipt.cwd}</div>
        <pre class="out">{receipt.command}</pre>
        {#if receipt.executed !== undefined}<p class="small dim">
            Ran as <code>{receipt.executed}</code>; output condensed by rtk.
          </p>{/if}
        {#if receipt.output !== undefined}<pre class="out">{receipt.output}</pre>{/if}
        {#if running?.output !== undefined}<pre class="out">{running.output}</pre>{/if}
        {#if receipt.truncated}<p class="small dim">Output truncated to the last 64 KiB.</p>{/if}
        {#if receipt.status !== "finished" && running === undefined}<p class="small dim">
            No completion receipt yet. If interrupted, inspect the workspace before retrying.
          </p>{/if}
      </div>
    {/if}
  </li>
{/snippet}

<section aria-label="Chat" class:phone>
  <div class="scroller">
    <div
      class="transcript"
      style:padding-inline={phone ? "18px" : "24px"}
      style:padding-bottom={reserved > 0 ? `${reserved}px` : undefined}
    >
      {#if helperUpdates > 0 && helpersError !== undefined}
        <div class="callout er" role="alert">
          Couldn't load helper status: {helpersError}
          <button class="b sm" disabled={helpersPending} onclick={() => helpersRefresh++}>Retry helper status</button>
        </div>
      {/if}
      {#if stream?.loaded && items.length === 0}
        <div class="empty">
          <h2>Start the conversation</h2>
          {#if ready}<p>Ask a question or describe what you need.</p>
            <p class="wsitem" title={root}><Icon name="folder" /><span class="ellipsis">{root}</span></p>
          {:else}<p>This chat's folder is not ready. No local folder was substituted.</p>{/if}
          {#if workspace?.mode === "worktree" && ready}<p>
              Detached worktree from <span class="mono">{workspace.base?.slice(0, 12)}</span>. Source dirt was not
              copied; {workspace.submodules} submodules left uninitialized. Not a sandbox.
            </p>{/if}
          {#if workspace?.mode === "read-only"}<p>
              Agent file writes and shell are disabled. Human Terminal and MCP grants are separate. This is a tool
              policy, not a sandbox.
            </p>{/if}
        </div>
      {/if}
      {#each rows as item (item.id)}
        <div class="item" in:rise={{ enabled: settled && (item.kind !== "assistant" || item.live) }}>
          {#if item.kind === "user"}
            <div class="user">
              <div class="bubble">{item.text}</div>
              {#if item.attachments.length > 0}
                <div class="chips end">
                  {#each item.attachments as attachment (attachment.id)}
                    <span class="chip plain"
                      ><Icon name="file" />{attachment.name}<span class="dim"
                        >{size(attachment.size)}{received(attachment)}</span
                      ></span
                    >
                  {/each}
                </div>
              {/if}
              <span class="at">{time(item.at)}</span>
            </div>
          {:else if item.kind === "note"}
            <div class="note"><Icon name="info" /><span>{item.text}</span></div>
          {:else if item.kind === "plugin"}
            {#if item.piece === "missing"}
              <div class="note"><Icon name="info" /><span>Recorded by a plugin this build doesn't include.</span></div>
            {:else}
              {@const piece = item.piece}
              {#await piece.load() then { default: Renderer }}<Renderer entry={item.entry} />{:catch failure}<p
                  class="dim small"
                  role="alert"
                >
                  Couldn't show {piece.name}'s result: {String(failure)}
                </p>{/await}
            {/if}
          {:else if item.kind === "work"}
            {@const open = openSteps[item.id] === true}
            {@const active = item.id === activeWork}
            <div class="activity">
              <button class="acth" aria-expanded={open} onclick={() => (openSteps[item.id] = !open)}>
                {#if active}<span class="ring spin" aria-hidden="true"></span>{/if}
                <span>{headline(item.items, active)}</span>
                <Icon name={open ? "chevD" : "chevR"} size={13} />
              </button>
              {#if open}
                <ul class="rows">
                  {#each item.items as part, index (part.id)}
                    {@const nested = item.items.slice(0, index).findLast((before) => before.kind === "assistant")}
                    {#if part.kind === "assistant"}
                      {#each part.texts as text, at (at)}<li class="say">{text}</li>{/each}
                      {#each part.steps.filter((step) => !receipted(step, item.items)) as step (step.id)}
                        {@render stepRow(`${part.id}/${step.id}`, step, part.live)}
                      {/each}
                    {:else if part.kind === "shell"}
                      {@render shellRow(
                        part.id,
                        part.receipt,
                        nested?.steps.some((step) => step.name === "codemode") === true,
                      )}
                    {:else if part.kind === "mcp"}
                      {@const shown = openSteps[part.id] === true}
                      <li class="under source">
                        <button class="row" aria-expanded={shown} onclick={() => (openSteps[part.id] = !shown)}>
                          <span class="verb">{part.receipt.serverName}</span>
                          <span class="obj">{part.receipt.query || part.receipt.tool}</span>
                          {#if part.receipt.isError}<span class="st er">Server error</span>{/if}
                          <Icon name={shown ? "chevD" : "chevR"} size={13} />
                        </button>
                        {#if shown}<div class="detail"><InternetSources receipt={part.receipt} /></div>{/if}
                      </li>
                    {:else if part.kind === "helper"}
                      {@const view = helpers.find((helper) => helper.task === part.task)}
                      {@const status = helperStatus(part.status, view)}
                      <li class="under plain helper">
                        <span class="verb">Research helper</span>
                        <span class="obj">{part.purpose}</span>
                        <span class={["st", status.failed && "er"]}>{status.text}</span>
                        {#if view !== undefined && view.unknownEffects.length > 0}
                          <span class="st er wide"
                            >Outcome unknown for {view.unknownEffects.map((effect) => effect.tool).join(", ")}; check
                            before repeating.</span
                          >
                        {/if}
                      </li>
                    {:else}
                      {@const approval = part.approval}
                      <li class="plain" role="group" aria-label="Approval request">
                        <span class="verb"
                          >{(approval.tool === "browser_act" ? browserHeads : heads)[approval.state]}</span
                        >
                        <code class="obj mono">{approval.command}</code>
                        <span class="st wide">{outcome(approval)}</span>
                      </li>
                    {/if}
                  {/each}
                </ul>
              {/if}
            </div>
          {:else if item.kind === "approval"}
            {@const approval = item.approval}
            {@const browser = approval.tool === "browser_act"}
            <div class="appr" role="group" aria-label="Approval request">
              <div class="apph">
                <span class="dot" aria-hidden="true"></span>
                <span class="grow">{(browser ? browserHeads : heads).pending}</span>
                <span class="meta">{browser ? "project browser" : "not sandboxed"} · timeout {approval.timeout} s</span>
              </div>
              <code class="mono cmd">{approval.command}</code>
              <p class="why">
                {#if browser}
                  Browser page <span class="mono">{approval.cwd}</span> · exact action in the sandboxed project browser. Inspect
                  after any interruption.
                {:else}
                  In <span class="mono">{approval.cwd}</span>, as the Pal host user.
                {/if}
                Waits until {time(approval.expiresAt)} at most; Stop ends it. Nothing runs until you approve.
              </p>
              <div class="acts">
                <button class="b p" disabled={deciding !== undefined} onclick={() => decide(approval, "approve")}
                  >Approve once</button
                >
                <button class="b" disabled={deciding !== undefined} onclick={() => decide(approval, "deny")}
                  >Deny</button
                >
              </div>
            </div>
          {:else if item.kind === "assistant"}
            {#if item.texts.length > 0 || item.error !== undefined || item.stopped || item.live}
              <div class="assistant">
                {#each item.texts as text, index (index)}
                  <!-- Sanitized by renderMarkdown: no raw HTML from the model survives. -->
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                  <div class="md" {@attach codeCopy}>{@html renderMarkdown(text)}</div>
                {/each}
                {#if item.live && item.texts.length === 0 && item.steps.length === 0}
                  <div class="thinking"><span class="ring spin" aria-hidden="true"></span>Thinking…</div>
                {/if}
                {#if item.error !== undefined}
                  {#if item.error.includes("subscription_sharing_usage_limit_exceeded")}
                    <div class="callout wa" role="alert">
                      <strong>ChatGPT usage limit reached.</strong> Pal paused instead of retrying. Check
                      <a href={USAGE_URL} target="_blank" rel="noopener noreferrer">ChatGPT settings → Usage</a>, then
                      send again.
                    </div>
                  {:else}
                    <div class="callout er" role="alert"><strong>The model request failed.</strong> {item.error}</div>
                  {/if}
                {/if}
                {#if item.stopped}<div class="note"><Icon name="stop" /><span>Stopped.</span></div>{/if}
                {#if !item.live}<span class="at">{time(item.at)}</span>{/if}
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <div class="dock">
    <div class="dockin">
      {#each composerPieces as piece (piece.key)}
        <!-- A piece that fails to load is left out; the composer works without it. -->
        {#await piece.load() then { default: Piece }}
          <Piece
            running={stream?.running ?? false}
            active={typing || writing.text !== ""}
            onSpace={(pixels) => (spaces[piece.key] = pixels)}
          />
        {/await}
      {/each}
      {#if !ready}
        <div class="callout wa" role="status">
          {workspace?.error ?? "Preparing this chat's working folder. Messages stay disabled until it is ready."}
          {#if workspace?.state === "provisioning"}<button class="b sm" disabled={preparing} onclick={prepare}
              >{preparing ? "Checking…" : "Check workspace"}</button
            >{/if}
        </div>
      {/if}
      {#if !hydrated}
        {#if metadata === "failed" && metadataChat === chat.id}
          <div class="callout er" role="alert">
            <span class="grow">Couldn't load saved chat settings. {metadataError}</span>
            <button class="b sm" onclick={() => loadMetadata(chat.id)}>Try again</button>
          </div>
        {:else}
          <div class="callout ac" role="status">Loading saved chat settings…</div>
        {/if}
      {:else if effective === null}
        <div class="callout wa nowrap" role="status">
          <span class="grow"><strong>No model is chosen.</strong> Connect a provider and choose a model to send.</span>
          <button class="b sm" onclick={() => navigate({ view: "settings", tab: "models" })}>Connect</button>
        </div>
      {:else if effective.provider === "openai" && !connected}
        <div class="callout wa nowrap" role="status">
          <span class="grow"><strong>ChatGPT isn't connected.</strong> Messages need your ChatGPT subscription.</span>
          <button class="b sm" onclick={() => navigate({ view: "settings", tab: "models" })}>Connect</button>
        </div>
      {:else if effective !== null && !usable}
        <div class="callout wa nowrap" role="status">
          <span class="grow"
            ><strong>{providerName ?? effective.provider} isn't enabled.</strong> Enable it in Settings or choose another
            model; Pal won't send this chat anywhere else on its own.</span
          >
          <button class="b sm" onclick={() => navigate({ view: "settings", tab: "models" })}>Settings</button>
        </div>
      {/if}
      {#if stream?.loaded === false && stream.problem === undefined}
        <div class="callout wa" role="status">Loading saved conversation… Your draft is kept.</div>
      {:else if stream?.problem === "closed"}
        <div class="callout er" role="alert">
          <span class="grow">Pal stopped sending this chat's updates. The chat and your draft are kept.</span>
          {@render diagnosticsButton()}
          <button class="b sm" onclick={() => reconnect()}>Reconnect</button>
        </div>
      {:else if stream?.problem === "retrying"}
        <div class="callout wa" role="status">
          {stream.loaded
            ? "Reconnecting to Pal… The chat keeps running on the server."
            : "Can't reach Pal yet; retrying. Your draft is kept."}
        </div>
      {/if}
      {#if stream?.retry !== undefined}
        <div class="callout wa" role="status">The model request failed; Pal retries shortly. {stream.retry.error}</div>
      {:else if stream?.running && stream.deferredPoll !== undefined}
        <div class="callout wa" role="status">
          The provider is still preparing its answer; Pal checks again shortly.
        </div>
      {/if}
      {#if (stream?.compactions.length ?? 0) > 0}
        <div class="callout ac" role="status">Summarizing earlier messages to make room…</div>
      {:else if stream?.compactionFailure !== undefined}
        <div class="callout er" role="alert">Summarizing earlier messages failed. {stream.compactionFailure.error}</div>
      {/if}
      {#if stream?.failure !== undefined}
        <div class="callout er" role="alert">
          <span class="grow">Part of this chat's work failed. {stream.failure.message}</span>
          {@render diagnosticsButton()}
        </div>
      {/if}
      {#if stream?.running}
        <div class="running" role="status">
          <!-- One spinner at a time: the transcript's last line or streaming answer already shows the run moving. -->
          {#if awaiting}<span class="dot" aria-hidden="true"></span>
          {:else if activeWork === undefined && stream.partial === undefined}<span class="ring spin" aria-hidden="true"
            ></span>{/if}
          <span class="grow ellipsis"
            >{awaiting ? "Waiting for your approval" : "Running"}
            <span class="dim"
              >· {modelName}{providerName !== undefined && effective?.provider !== "openai"
                ? ` · ${providerName}`
                : ""}</span
            ></span
          >
          <button class="b t sm" disabled={stopping} onclick={stop}>Stop</button>
        </div>
        {#if stopError !== undefined}
          <div class="callout er" role="alert">
            <span class="grow"
              >Stop didn't reach Pal: {stopError} The run may still be going; press Stop to try again.</span
            >
            {@render diagnosticsButton()}
          </div>
        {/if}
      {/if}
      {#if (stream?.inbox.length ?? 0) > 0}
        <div class="queue">
          <div class="dim small">Sent when the current run reaches a stopping point.</div>
          {#each stream?.inbox ?? [] as queued (queued.id)}
            <div class="queued">
              <span class="pill">{queued.mode === "steer" ? "Steering" : "Queued"}</span>
              <span class="grow ellipsis">{queuedTexts[queued.id] ?? "Queued message"}</span>
            </div>
          {/each}
        </div>
      {/if}
      {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
      {#if chat.blocked !== null}
        <div class="callout er" role="alert">
          <span class="grow"
            ><strong>A message couldn't be sent.</strong>
            {chat.blocked.reason} Later messages in this chat wait until you retry or withdraw it.</span
          >
          <button class="b sm" disabled={resolving} onclick={() => resolveBlocked("retry")}>Retry</button>
          <button class="b sm" disabled={resolving} onclick={() => resolveBlocked("withdraw")}>Withdraw</button>
        </div>
        <details class="activity">
          <summary class="acth" title={`Request ${chat.blocked.requestId}`}
            >Blocked message<Icon name="chevR" size={13} /></summary
          >
          <pre class="out">{chat.blocked.text}</pre>
        </details>
        {#if resolveError !== undefined}<div class="callout er" role="alert">{resolveError}</div>{/if}
      {/if}
      {#if writing.pending !== undefined && !writing.sending && !writing.recovered && writing.pending.requestId !== chat.blocked?.requestId}
        <div class="callout wa" role="alert">
          <span class="grow"
            >This send isn't confirmed. {writing.error} Retry its saved message and destination before sending another.
            <span class="mono dim">Request {writing.pending.requestId}</span></span
          >
          {@render diagnosticsButton()}
          <button class="b sm" onclick={retrySaved}>Retry saved send</button>
        </div>
        <details class="activity">
          <summary class="acth" title={`Request ${writing.pending.requestId}`}
            >Saved message · {writing.pending.body.attachments.length} attached<Icon name="chevR" size={13} /></summary
          >
          <pre class="out">{writing.pending.body.text}</pre>
        </details>
      {:else if writing.error !== undefined}<div class="callout er" role="alert">{writing.error}</div>{/if}
      {#if writing.notice !== undefined}<div class="callout ac" role="status">{writing.notice}</div>{/if}
      {#if !writing.saved}<div class="callout wa" role="status">
          This tab couldn't save your draft, so reloading would lose it.
        </div>{/if}
      {#if phone && stream?.running}{@render busySwitch()}{/if}

      <div class="cbx" class:oneline={phone}>
        {#if writing.attachments.length > 0 || writing.uploading > 0}
          <div class="chips">
            {#each writing.attachments as attachment (attachment.id)}
              <span class="chip">
                <Icon name="file" /><span class="ellipsis">{attachment.name}</span>
                <button
                  class="chipx"
                  aria-label={`Remove ${attachment.name}`}
                  onclick={() =>
                    (writing.attachments = writing.attachments.filter((kept) => kept.id !== attachment.id))}
                  ><Icon name="x" size={12} /></button
                >
              </span>
            {/each}
            {#if writing.uploading > 0}<span class="chip plain"
                ><span class="ring spin" aria-hidden="true"></span>Uploading…</span
              >{/if}
          </div>
        {/if}
        <label for="composer" class="sr">Message</label>
        <textarea
          id="composer"
          bind:this={composer}
          class="cta"
          rows={phone ? 1 : 2}
          placeholder={stream?.running
            ? phone
              ? "Steer or queue"
              : "Steer the run or queue a follow-up"
            : "Message Pal"}
          maxlength={MAX_INPUT_CHARS}
          disabled={writing.blocked || !writing.active}
          title="Drafts stay in this tab, across reloads, until you send them or sign out."
          bind:value={writing.text}
          onpaste={paste}
          onfocus={() => (typing = true)}
          onblur={() => (typing = false)}
          onkeydown={onKey}></textarea>
        <div class="tools">
          {#if writing.active && !writing.blocked}<AddMenu
              onFiles={upload}
              onSchedule={() => (scheduling = true)}
            />{/if}
          {#if !phone}
            {#if workspace?.mode !== "read-only"}<CommandMode mode={stream?.mode} onChoose={chooseMode} />{/if}
            <WorkspaceMode {workspace} {onNewChat} />
            <span class="grow"></span>
            {@render modelControl()}
            {#if stream?.running}{@render busySwitch()}{/if}
          {/if}
          <button
            class={["b p send", stream?.running && "busy"]}
            aria-label={stream?.running ? undefined : "Send"}
            title={stream?.running ? undefined : "Send"}
            onclick={send}
            disabled={!canSend}
          >
            <Icon
              name={stream?.running && writing.whenBusy === "steer" ? "steer" : "send"}
              size={stream?.running ? 16 : phone ? 18 : 15}
            />{#if stream?.running}{writing.whenBusy === "steer" ? "Steer" : "Queue"}{/if}
          </button>
        </div>
      </div>
    </div>
  </div>
</section>

{#if scheduling}
  {#await import("./ScheduleDialog.svelte") then { default: ScheduleDialog }}
    <ScheduleDialog chatId={chat.id} draft={writing.text} onClose={() => (scheduling = false)} />
  {:catch failure}<div class="callout er" role="alert">Couldn't open scheduling: {String(failure)}</div>{/await}
{/if}

{#if phone && tools}
  <dialog
    class="sheet"
    aria-label="Workspace tools"
    bind:this={sheet}
    {@attach (node: HTMLDialogElement) => node.showModal()}
    onclose={() => (tools = false)}
    onkeydowncapture={(event) => {
      if (event.key === "Escape") escaping = sheet?.querySelector(".pop") != null;
    }}
    oncancel={(event) => {
      if (escaping) event.preventDefault();
      escaping = false;
    }}
    onclick={(event) => {
      if (event.target === sheet) sheet.close();
    }}
  >
    <span class="grip" aria-hidden="true"></span>
    <div class="tiles">
      {#each panels as item (item.id)}
        <button
          class="tile"
          onclick={() => {
            sheet?.close();
            onPanel(item.id);
          }}
          ><Icon name={item.icon} />{item.id}{#if item.id === "Changes" && changeCount}<span
              class="n"
              aria-hidden="true">{changeCount}</span
            >{/if}</button
        >
      {/each}
      <button
        class="tile"
        onclick={() => {
          sheet?.close();
          navigate({ view: "settings", tab: "general" });
        }}><Icon name="settings" />Settings</button
      >
    </div>
    <div class="list">
      <div class="li"><span class="lab">Model</span>{@render modelControl()}</div>
      {#if workspace?.mode !== "read-only"}
        <div class="li">
          <span class="lab">Commands</span><CommandMode mode={stream?.mode} onChoose={chooseMode} />
        </div>
      {/if}
      <div class="li"><span class="lab">Workspace</span><WorkspaceMode {workspace} {onNewChat} /></div>
      <div class="li"><span class="lab">Internet tools</span><ProjectMcpSettings {project} row /></div>
    </div>
  </dialog>
{/if}

<style>
  .appr {
    border: 1px solid var(--line2);
    background: var(--bg2);
    border-radius: var(--radius-md);
    padding: 14px 14px 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .apph {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13.5px;
  }
  .apph .grow {
    font-weight: 550;
  }
  .meta {
    font-size: 12px;
    color: var(--tx3);
    white-space: nowrap;
  }
  .dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    background: var(--wa);
  }
  .cmd {
    display: block;
    font-size: 12.5px;
    color: color-mix(in srgb, var(--tx) 90%, transparent);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .why {
    margin: 0;
    font-size: 12.5px;
    color: var(--tx3);
    overflow-wrap: anywhere;
  }
  .acts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  section {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .scroller {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column-reverse;
  }
  .transcript {
    width: 100%;
    max-width: 720px;
    margin: 0 auto;
    padding-top: 32px;
    padding-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .item {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .empty {
    padding: 56px 0 16px;
    color: var(--tx2);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .empty h2 {
    margin: 0 0 4px;
    font-size: 22px;
    color: var(--tx);
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .empty p {
    margin: 0;
    max-width: 520px;
  }
  .empty .wsitem {
    max-width: 100%;
  }
  .user {
    align-self: flex-end;
    max-width: 80%;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
  .bubble {
    background: var(--bubble);
    border-radius: var(--radius-lg);
    padding: 10px 15px;
    font-size: 14.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* Times stay in the accessible text; on hover-capable screens they appear with the message they belong to. */
  .at {
    position: absolute;
    top: calc(100% + 2px);
    font-size: 11.5px;
    line-height: 1.2;
    color: var(--tx3);
    font-variant-numeric: tabular-nums;
    transition: opacity var(--fast) var(--ease);
  }
  .user .at {
    right: 0;
  }
  @media (hover: hover) {
    .at {
      opacity: 0;
    }
    .item:hover .at,
    .item:focus-within .at {
      opacity: 1;
    }
  }
  .note {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 12.5px;
    color: var(--tx2);
  }
  .activity {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  details.activity[open] .acth :global(svg) {
    transform: rotate(90deg);
  }
  /* An opened line lists what the run did, one row each; a row opens to its code, output and receipts. */
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line2);
    border-radius: var(--radius-md);
    font-size: 13px;
    color: var(--tx3);
    overflow: hidden;
  }
  .rows li + li {
    border-top: 1px solid var(--line);
  }
  .row,
  .plain,
  .say {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    min-height: 36px;
    padding: 8px 12px;
    box-sizing: border-box;
  }
  .row {
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--fast) var(--ease);
  }
  .row:hover,
  .row[aria-expanded="true"] {
    background: var(--bg2);
  }
  .row :global(svg),
  .row .ring {
    flex: none;
    align-self: center;
  }
  .plain {
    flex-wrap: wrap;
  }
  .say {
    color: var(--tx2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* A script's commands and lookups sit under the step that made them. */
  .under > .row,
  .under.plain {
    padding-left: 28px;
  }
  .verb {
    flex: none;
  }
  .obj {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: color-mix(in srgb, var(--tx) 90%, transparent);
  }
  .obj.mono {
    font-size: 12.5px;
  }
  .st {
    flex: none;
    margin-left: auto;
    font-size: 12px;
  }
  .st.wide {
    flex: 1 1 100%;
    margin: 0;
  }
  .st.er {
    color: var(--er);
  }
  .row > :global(svg:last-child) {
    margin-left: auto;
  }
  .st + :global(svg:last-child) {
    margin-left: 0;
  }
  .detail {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 12px 12px;
    background: var(--bg2);
    font: 12.5px/1.6 var(--mono);
    color: var(--tx2);
    min-width: 0;
  }
  .detail .out {
    margin: 0;
    max-height: 320px;
    overflow: auto;
  }
  .detail p {
    margin: 0;
    font-family: var(--sans);
  }
  .steprow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .steprow .ring {
    width: 10px;
    height: 10px;
  }
  .tick {
    width: 12px;
    flex: none;
    text-align: center;
    color: var(--tx3);
  }
  .tick.ok {
    color: var(--ok);
  }
  .tick.er,
  .state {
    color: var(--er);
  }
  .args {
    color: var(--tx3);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .dim {
    color: var(--tx3);
  }
  .small {
    font-size: 12px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .assistant {
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: 14.5px;
    line-height: 1.7;
    color: color-mix(in srgb, var(--tx) 90%, transparent);
  }
  .thinking {
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--tx2);
    font-size: 13px;
  }
  .md {
    overflow-wrap: anywhere;
  }
  .md :global(p) {
    margin: 0 0 12px;
  }
  .md :global(:is(h1, h2, h3, h4)) {
    margin: 18px 0 8px;
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: 1.3;
  }
  .md :global(:is(h1, h2)) {
    font-size: 18px;
  }
  .md :global(:is(h3, h4)) {
    font-size: 15.5px;
  }
  .md :global(:first-child) {
    margin-top: 0;
  }
  .md :global(blockquote) {
    margin: 0 0 10px;
    padding-left: 12px;
    border-left: 2px solid var(--line2);
    color: var(--tx2);
  }
  .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .md :global(ul),
  .md :global(ol) {
    margin: 0 0 8px;
    padding-left: 22px;
  }
  .md :global(code) {
    font-family: var(--mono);
    font-size: 0.86em;
    background: var(--bg3);
    padding: 1px 5px;
    border-radius: 5px;
  }
  .md :global(.code) {
    margin: 0 0 12px;
    background: var(--bg2);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  /* The language and Copy stay in view while a long block scrolls past, on the block's own surface. */
  .md :global(.codehead) {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 8px 0 18px;
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    background: var(--bg2);
    color: var(--tx3);
    font-family: var(--mono);
    font-size: 12px;
  }
  .md :global(.codecopy) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--tx3);
    font: 12.5px var(--sans);
    cursor: pointer;
    transition:
      background-color var(--fast) var(--ease),
      color var(--fast) var(--ease);
  }
  .md :global(.codecopy:hover) {
    background: var(--bg4);
    color: var(--tx);
  }
  .md :global(.codecopy svg) {
    width: 14px;
    height: 14px;
  }
  .md :global(pre) {
    margin: 0;
    padding: 4px 18px 16px;
    overflow-x: auto;
  }
  .md :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: 12.5px;
    line-height: 1.75;
    color: color-mix(in srgb, var(--tx) 85%, transparent);
    tab-size: 4;
  }
  .md :global(.hl-k) {
    color: var(--syn-k);
  }
  .md :global(.hl-s) {
    color: var(--syn-s);
  }
  .md :global(.hl-n) {
    color: var(--syn-n);
  }
  .md :global(.hl-c) {
    color: var(--syn-c);
    font-style: italic;
  }
  .md :global(.hl-f) {
    color: var(--syn-f);
  }
  .md :global(.hl-t) {
    color: var(--syn-t);
  }
  .md :global(.hl-p) {
    color: var(--syn-p);
  }
  .md :global(.hl-m) {
    color: var(--syn-m);
  }
  .md :global(.hl-a) {
    color: var(--addtx);
    background: var(--addbg);
  }
  .md :global(.hl-d) {
    color: var(--deltx);
    background: var(--delbg);
  }
  .md :global(a),
  .callout a {
    color: var(--ac);
  }
  .dock {
    flex: 0 0 auto;
    padding: 8px 24px 20px;
  }
  .phone .dock {
    padding: 6px 12px max(12px, env(safe-area-inset-bottom));
  }
  .dockin {
    max-width: 672px;
    margin: 0 auto;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .nowrap {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .running {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 0 0 4px;
    font-size: 12.5px;
    color: var(--tx2);
    animation: rise var(--mid) var(--ease);
  }
  .cbx {
    position: relative;
  }
  .queue {
    border: 1px dashed var(--line2);
    border-radius: 12px;
    padding: 6px 6px 6px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .queued {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    flex-wrap: wrap;
  }
  .tools .seg {
    margin-left: 4px;
  }
  .send {
    margin-left: 4px;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 50%;
  }
  .send :global(svg) {
    stroke-width: 2.1;
  }
  .send.busy {
    width: auto;
    padding: 0 12px;
    border-radius: 16px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 2px 2px 0;
  }
  .chips.end {
    justify-content: flex-end;
  }
  .plain {
    padding-right: 8px;
  }
  /* Phone: the composer is one pill with "+" and Send either side; model and approval live in the tools sheet. */
  .cbx.oneline {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 4px;
    padding: 5px;
    border-radius: 24px;
  }
  .oneline .tools {
    display: contents;
  }
  .oneline .chips {
    order: -1;
    flex-basis: 100%;
    padding: 4px 6px 0;
  }
  .oneline .cta {
    order: 1;
    flex: 1;
    min-width: 0;
    padding: 11px 2px;
    font-size: 15.5px;
  }
  .oneline .send {
    order: 2;
    width: 44px;
    height: 44px;
    margin: 0;
  }
  .oneline .send.busy {
    width: auto;
    padding: 0 14px;
    border-radius: 22px;
  }
  .oneline :global(.plus) {
    width: 44px;
    height: 44px;
    margin: 0;
    border-radius: 50%;
  }
  .dockin > .seg {
    align-self: flex-start;
  }
  .phone .transcript {
    gap: 18px;
    padding-top: 16px;
  }
  .phone .bubble {
    border-radius: 18px;
    padding: 10px 14px;
    font-size: 15px;
  }
  .phone .assistant {
    font-size: 15px;
    line-height: 1.65;
  }
  .phone .appr {
    border-radius: 14px;
    padding: 14px;
  }
  .phone .appr .acts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .phone .appr .acts .b {
    height: 44px;
    border-radius: var(--radius-md);
    font-size: 14px;
  }
  .phone .appr .acts .p {
    order: 2;
  }
  .phone :is(.row, .plain, .say) {
    min-height: 44px;
  }
  .phone .running {
    min-height: 32px;
    padding: 0 8px;
    font-size: 13px;
  }
  /* Pinned to the bottom edge; a click outside it lands on the dialog's backdrop and closes it. */
  .sheet[open] {
    inset: auto 0 0;
    width: 100%;
    max-width: none;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 10px 16px max(20px, env(safe-area-inset-bottom));
    border: 0;
    border-top: 1px solid var(--line2);
    border-radius: 24px 24px 0 0;
    animation: rise var(--mid) var(--ease);
  }
  .grip {
    align-self: center;
    width: 40px;
    height: 5px;
    border-radius: 3px;
    background: var(--line3);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .tile {
    position: relative;
    height: 84px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 0;
    border-radius: var(--radius-lg);
    background: var(--bg3);
    color: var(--tx);
    font-size: 13px;
  }
  .tile .n {
    position: absolute;
    top: 10px;
    right: 12px;
    font: 11.5px var(--mono);
    color: var(--ac);
  }
  .list {
    display: flex;
    flex-direction: column;
    border-radius: var(--radius-lg);
    background: var(--bg3);
  }
  /* Each row anchors its control's popover, so it opens across the sheet's width. */
  .li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 0 8px 0 16px;
  }
  .li + .li {
    border-top: 1px solid var(--line2);
  }
  .lab {
    flex: 1;
  }
  .li :global(.model) {
    position: static;
  }
</style>
