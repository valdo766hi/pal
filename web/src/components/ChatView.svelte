<script lang="ts">
  import { untrack } from "svelte";
  import {
    api,
    ApiError,
    type ChatSummary,
    type CommandMode as Approval,
    type Effort,
    type Project,
    requestId,
    type WorkspaceMode as Mode,
  } from "../lib/api.ts";
  import { ChatStream, type CommandApproval } from "../lib/chat.svelte.ts";
  import Icon from "../lib/Icon.svelte";
  import type { IconName } from "../lib/icons.ts";
  import CommandMode from "./CommandMode.svelte";
  import Composer from "./Composer.svelte";
  import ModelControl, { type Group } from "./ModelControl.svelte";
  import ProjectMcpSettings from "./ProjectMcpSettings.svelte";
  import Transcript from "./Transcript.svelte";
  import WorkspaceMode from "./WorkspaceMode.svelte";
  import { drafts, type PendingInput } from "../lib/drafts.svelte.ts";
  import type { ReviewFeedback } from "../../../src/core/feedback.ts";
  import { copyText } from "../lib/copy.ts";
  import { app, navigate, refreshChatGPT, refreshProjects, viewport } from "../lib/state.svelte.ts";
  import { loadFailures, renderer, slots } from "../lib/plugins.ts";
  import { build, group, type PieceFor, place } from "../lib/projection.ts";

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
  const toolPieces = $derived(slots("composer-tools", chat.extensions));
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
  let composer: { focus(): void } | undefined = $state();
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
  const pieceFor: PieceFor = (kind) => renderer(kind, chat.extensions, available);
  const historyItems = $derived(build(stream?.entries ?? [], undefined, stream?.approvals ?? [], pieceFor));
  const items = $derived(historyItems.concat(build([], stream?.partial, [], pieceFor)));
  /**
   * Failed model attempts Pi retried: a later attempt answered in the same turn, or the running turn is retrying. Kept
   * as a string so the history's rows are rebuilt only when this changes, not on every streamed update.
   */
  const retriedIds = $derived.by(() => {
    const ids: string[] = [];
    items.forEach((item, index) => {
      if (item.kind !== "assistant" || item.error === undefined || item.live) return;
      const rest = items.slice(index + 1);
      const next = rest.findIndex((later) => later.kind === "user");
      const turn = next < 0 ? rest : rest.slice(0, next);
      if (turn.some((later) => later.kind === "assistant") || (next < 0 && stream?.running === true)) ids.push(item.id);
    });
    return ids.join(" ");
  });
  const retried = $derived(new Set(retriedIds.split(" ")));
  const historyRows = $derived(group(historyItems, retried));
  // Only the last line changes while a turn streams; the rows before it keep their identity.
  const rows = $derived(
    build([], stream?.partial, [], pieceFor).reduce((rows, item) => place(rows, item, retried), [...historyRows]),
  );
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
      } else if (
        failure instanceof ApiError &&
        (failure.code === "upload_not_found" || failure.code === "upload_not_ready")
      ) {
        // Refused before Pal recorded it, so nothing was sent: the draft stays editable to remove or replace the file.
        if (writing.pending !== undefined) writing.reject(writing.pending);
        writing.error =
          failure.code === "upload_not_found"
            ? "An attached file is no longer available. Remove it, then send again."
            : failure.message;
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

  function refreshApprovals() {
    const shown = stream;
    void api.approvals(chat.id).then(
      (view) => {
        if (stream === shown) shown?.showApprovals(view);
      },
      () => {},
    );
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

{#snippet composerTools()}
  {#each toolPieces as piece (piece.key)}
    <!-- A piece that fails to load is left out; the composer works without it. -->
    {#await piece.load() then { default: Piece }}
      <Piece {chat} running={stream?.running ?? false} revision={stream?.entries.length ?? 0} {onPanel} />
    {/await}
  {/each}
{/snippet}

{#snippet diagnosticsButton()}
  <button class="b sm" disabled={diagnostics === "copying"} onclick={copyDiagnostics}>
    {diagnostics === "copied" ? "Copied" : "Copy diagnostics"}
  </button>
{/snippet}

{#snippet busySwitch()}
  <div class="seg" role="radiogroup" aria-label="While the agent is running">
    <button
      class="segb"
      role="radio"
      aria-checked={writing.whenBusy === "steer"}
      onclick={() => (writing.whenBusy = "steer")}
    >
      Steer
    </button>
    <button
      class="segb"
      role="radio"
      aria-checked={writing.whenBusy === "followUp"}
      onclick={() => (writing.whenBusy = "followUp")}
    >
      Queue
    </button>
  </div>
{/snippet}

{#snippet composerRow()}
  {#if phone}{@render composerTools()}
  {:else}
    {#if workspace?.mode !== "read-only"}<CommandMode
        mode={stream?.mode}
        auto={stream?.auto}
        onChoose={chooseMode}
        onOpen={refreshApprovals}
      />{/if}
    <WorkspaceMode {workspace} {onNewChat} />
    <span class="grow"></span>
    {@render composerTools()}
    {@render modelControl()}
    {#if stream?.running}{@render busySwitch()}{/if}
  {/if}
{/snippet}

{#snippet emptyState()}
  <div class="empty">
    <h2>Start the conversation</h2>
    {#if ready}<p>Ask a question or describe what you need.</p>
      <p class="wsitem" title={root}><Icon name="folder" /><span class="ellipsis">{root}</span></p>
    {:else}<p>This chat's folder is not ready. No local folder was substituted.</p>{/if}
    {#if workspace?.mode === "worktree" && ready}<p>
        Detached worktree from <span class="mono">{workspace.base?.slice(0, 12)}</span>. Source dirt was not copied; {workspace.submodules}
        submodules left uninitialized. Not a sandbox.
      </p>{/if}
    {#if workspace?.mode === "read-only"}<p>
        Agent file writes and shell are disabled. Human Terminal and MCP grants are separate. This is a tool policy, not
        a sandbox.
      </p>{/if}
  </div>
{/snippet}

<section aria-label="Chat" class:phone>
  <div class="scroller">
    <Transcript
      {stream}
      chatId={chat.id}
      {rows}
      {retried}
      {activeWork}
      {phone}
      {reserved}
      {deciding}
      onDecide={decide}
      empty={stream?.loaded && items.length === 0 ? emptyState : undefined}
    />
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
          {#if workspace?.state === "provisioning"}<button class="b sm" disabled={preparing} onclick={prepare}>
              {preparing ? "Checking…" : "Check workspace"}
            </button>{/if}
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
          <span class="grow">
            <strong>{providerName ?? effective.provider} isn't enabled.</strong> Enable it in Settings or choose another model;
            Pal won't send this chat anywhere else on its own.
          </span>
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
          <span class="grow ellipsis">
            {awaiting ? "Waiting for your approval" : "Running"}
            <span class="dim">
              · {modelName}{providerName !== undefined && effective?.provider !== "openai" ? ` · ${providerName}` : ""}
            </span>
          </span>
          <button class="b t sm" disabled={stopping} onclick={stop}>Stop</button>
        </div>
        {#if stopError !== undefined}
          <div class="callout er" role="alert">
            <span class="grow">
              Stop didn't reach Pal: {stopError} The run may still be going; press Stop to try again.
            </span>
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
          <span class="grow">
            <strong>A message couldn't be sent.</strong>
            {chat.blocked.reason} Later messages in this chat wait until you retry or withdraw it.
          </span>
          <button class="b sm" disabled={resolving} onclick={() => resolveBlocked("retry")}>Retry</button>
          <button class="b sm" disabled={resolving} onclick={() => resolveBlocked("withdraw")}>Withdraw</button>
        </div>
        <details class="activity">
          <summary class="acth" title={`Request ${chat.blocked.requestId}`}>
            Blocked message<Icon name="chevR" size={13} />
          </summary>
          <pre class="out">{chat.blocked.text}</pre>
        </details>
        {#if resolveError !== undefined}<div class="callout er" role="alert">{resolveError}</div>{/if}
      {/if}
      {#if writing.pending !== undefined && !writing.sending && !writing.recovered && writing.pending.requestId !== chat.blocked?.requestId}
        <div class="callout wa" role="alert">
          <span class="grow">
            This send isn't confirmed. {writing.error} Retry its saved message and destination before sending another.
            <span class="mono dim">Request {writing.pending.requestId}</span>
          </span>
          {@render diagnosticsButton()}
          <button class="b sm" onclick={retrySaved}>Retry saved send</button>
        </div>
        <details class="activity">
          <summary class="acth" title={`Request ${writing.pending.requestId}`}>
            Saved message · {writing.pending.body.attachments.length} attached<Icon name="chevR" size={13} />
          </summary>
          <pre class="out">{writing.pending.body.text}</pre>
        </details>
      {:else if writing.error !== undefined}<div class="callout er" role="alert">{writing.error}</div>{/if}
      {#if writing.notice !== undefined}<div class="callout ac" role="status">{writing.notice}</div>{/if}
      {#if !writing.saved}<div class="callout wa" role="status">
          This tab couldn't save your draft, so reloading would lose it.
        </div>{/if}
      {#if phone && stream?.running}{@render busySwitch()}{/if}

      <Composer
        bind:this={composer}
        bind:typing
        {writing}
        projectId={project.id}
        {phone}
        running={stream?.running ?? false}
        {canSend}
        onSend={send}
        onSchedule={() => (scheduling = true)}
        tools={composerRow}
      />
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
        >
          <Icon name={item.icon} />{item.id}{#if item.id === "Changes" && changeCount}<span
              class="n"
              aria-hidden="true"
            >
              {changeCount}
            </span>{/if}
        </button>
      {/each}
      <button
        class="tile"
        onclick={() => {
          sheet?.close();
          navigate({ view: "settings", tab: "general" });
        }}
      >
        <Icon name="settings" />Settings
      </button>
    </div>
    <div class="list">
      <div class="li"><span class="lab">Model</span>{@render modelControl()}</div>
      {#if workspace?.mode !== "read-only"}
        <div class="li">
          <span class="lab">Commands</span><CommandMode
            mode={stream?.mode}
            auto={stream?.auto}
            onChoose={chooseMode}
            onOpen={refreshApprovals}
          />
        </div>
      {/if}
      <div class="li"><span class="lab">Workspace</span><WorkspaceMode {workspace} {onNewChat} /></div>
      <div class="li"><span class="lab">Internet tools</span><ProjectMcpSettings {project} row /></div>
    </div>
  </dialog>
{/if}

<style>
  .dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    background: var(--wa);
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
  .activity {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  details.activity[open] .acth :global(svg) {
    transform: rotate(90deg);
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
  .dockin > .seg {
    align-self: flex-start;
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
