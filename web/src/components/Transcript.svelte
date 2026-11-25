<script lang="ts">
  import { type Snippet, tick } from "svelte";
  import { type AdviceRecord, api, type HelperView } from "../lib/api.ts";
  import type { Attachment, ChatStream, CommandApproval, ShellReceipt } from "../lib/chat.svelte.ts";
  import Icon from "../lib/Icon.svelte";
  import InternetSources from "./InternetSources.svelte";
  import { type Call, describe, summarize, toolLabel } from "../lib/activity.ts";
  import { codeCopy } from "../lib/copy.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { rise } from "../lib/motion.ts";
  import type { Row, Step, Work } from "../lib/projection.ts";

  let {
    stream,
    chatId,
    rows,
    retried,
    activeWork,
    phone,
    reserved,
    deciding,
    onDecide,
    empty,
  }: {
    stream: ChatStream | undefined;
    chatId: string;
    rows: Row[];
    /** Failed model attempts Pi retried. */
    retried: Set<string>;
    /** The work line the current run is adding to. */
    activeWork: string | undefined;
    phone: boolean;
    /** Room the composer's pieces ask for above the transcript's end. */
    reserved: number;
    /** The approval whose answer is on its way. */
    deciding: string | undefined;
    onDecide: (approval: CommandApproval, decision: "approve" | "deny") => void;
    /** Shown where the conversation starts, while it has none. */
    empty?: Snippet | undefined;
  } = $props();

  const USAGE_URL = "https://chatgpt.com/settings/usage";
  let openSteps: Record<string, boolean> = $state({});
  /** Set once the history has rendered, so only items arriving afterwards animate in. */
  let settled = $state(false);
  $effect(() => {
    if (stream?.loaded && !settled) void tick().then(() => (settled = true));
  });

  /** Durable helper status, including calls left with unknown outcomes; refreshed as helpers and runs change. */
  let helpers: HelperView[] = $state([]);
  let helpersError: string | undefined = $state();
  let helpersPending = $state(false);
  let helpersRefresh = $state(0);
  const helperUpdates = $derived((stream?.entries ?? []).filter((entry) => entry.kind === "pal.helper").length);
  $effect(() => {
    const id = chatId;
    const running = stream?.running;
    void helpersRefresh;
    if (helperUpdates === 0 || running === undefined) return;
    let current = true;
    helpersPending = true;
    helpersError = undefined;
    // Every page, each bounded, so a chat's later helpers keep their status.
    (async () => {
      const all: HelperView[] = [];
      for (let after: string | null | undefined; after !== null;) {
        const page = await api.helpers(id, after);
        all.push(...page.helpers);
        after = page.next ?? null;
      }
      return all;
    })().then(
      (loaded) => {
        if (!current) return;
        helpers = loaded;
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
  let olderError: string | undefined = $state();
  async function showOlder() {
    olderError = undefined;
    try {
      await stream?.loadOlder();
    } catch (failure) {
      olderError = failure instanceof Error ? failure.message : String(failure);
    }
  }

  const heads = {
    pending: "Run this command?",
    approved: "Command approved",
    denied: "Command denied",
    expired: "Approval expired",
    stopped: "Approval request ended",
    skipped: "Command skipped",
  } as const;
  const browserHeads = {
    ...heads,
    pending: "Approval needed for a browser action",
    approved: "Browser action approved",
    denied: "Browser action denied",
  };
  const sure = (confidence: number) => `${Math.round(confidence * 100)}%`;
  /** Why Auto mode asked the owner about this command; undefined outside Auto. */
  function escalation(advice: AdviceRecord | null): string | undefined {
    if (advice === null) return undefined;
    if (advice.by === "rule") return `Always asks: ${advice.reason}`;
    if (advice.by === "unavailable") return advice.reason;
    return advice.verdict === "run"
      ? `${advice.advisor} wasn't sure (${sure(advice.confidence)})`
      : `${advice.advisor} suggested asking (${sure(advice.confidence)} sure)`;
  }
  function outcome(approval: CommandApproval): string {
    const at = time(approval.decidedAt ?? undefined);
    if (approval.decidedBy === "advisor" && approval.advice?.by === "advisor")
      return `Approved by ${approval.advice.advisor} · ${sure(approval.advice.confidence)} sure, at ${at}.`;
    const why = escalation(approval.advice);
    if (approval.state === "skipped")
      return `${why ?? "Not judged safe"}. Pal didn't run it and carried on; run it yourself, or ask Pal to run it with your approval.`;
    if (why !== undefined && approval.state !== "pending") return `${why}. ${outcome({ ...approval, advice: null })}`;
    if (approval.state === "approved")
      return `Approved once by you at ${at}. Later ${approval.tool === "browser_act" ? "browser actions" : "commands"} ask again.`;
    if (approval.state === "denied") return `Denied by you at ${at}. Nothing was run.`;
    if (approval.state === "expired") return "No answer before it expired. Nothing was run.";
    return "The run stopped before you answered. Nothing was run.";
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
    const retries = turns.filter((turn) => retried.has(turn.id)).length;
    if (active) return line || (retries > 0 ? "Retrying" : "Working");
    const again = retries === 0 ? "" : retries === 1 ? "retried once" : `retried ${retries} times`;
    const failed = steps.filter((step) => step.result?.isError).length;
    const unconfirmed = items.some((item) =>
      item.kind === "assistant"
        ? item.steps.some((step) => phase(step, item.live) === "Outcome unconfirmed")
        : item.kind === "shell"
          ? item.receipt.status !== "finished"
          : item.kind === "helper" &&
            (helpers.find((helper) => helper.task === item.task)?.unknownEffects.length ?? 0) > 0,
    );
    const parts = [line, failed > 0 ? `${failed} failed` : "", unconfirmed ? "outcome unconfirmed" : "", again];
    const said = parts.filter((part) => part !== "").join(", ");
    return said === "" ? "Worked" : said.charAt(0).toUpperCase() + said.slice(1);
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
                {#if call.status !== "done"}<span class="ring spin" aria-hidden="true"></span><span class="sr">
                    Running
                  </span>
                {:else if call.summary?.isError !== false}<span class="tick er" aria-hidden="true">✕</span><span
                    class="sr"
                  >
                    Failed
                  </span>
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
            {:else}<span class="tick" class:er={call.status !== "running"} aria-hidden="true">
                {call.status === "running" ? "–" : "✕"}
              </span>{/if}
            <span>{toolLabel(call.name)}</span>
            <span class="args">{call.args}</span>
            {#if call.status !== "ok"}<span class="state">
                {call.status === "running" ? "Interrupted" : call.status === "cancelled" ? "Cancelled" : "Failed"}
              </span>{/if}
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
      <span class={["st", (receipt.timedOut || (receipt.exitCode ?? 0) !== 0) && "er"]}>
        {receiptState(receipt, running !== undefined)}
      </span>
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

<div
  class={["transcript", phone && "phone"]}
  style:padding-inline={phone ? "18px" : "24px"}
  style:padding-bottom={reserved > 0 ? `${reserved}px` : undefined}
>
  {#if helperUpdates > 0 && helpersError !== undefined}
    <div class="callout er" role="alert">
      Couldn't load helper status: {helpersError}
      <button class="b sm" disabled={helpersPending} onclick={() => helpersRefresh++}>Retry helper status</button>
    </div>
  {/if}
  {#if stream?.older != null}
    <div class="older">
      <button class="b sm" disabled={stream.loadingOlder} onclick={showOlder}>
        {stream.loadingOlder ? "Loading earlier messages…" : "Show earlier messages"}
      </button>
    </div>
  {/if}
  {#if olderError !== undefined}<div class="callout er" role="alert">{olderError}</div>{/if}
  {@render empty?.()}
  {#each rows as item (item.id)}
    <div class="item" in:rise={{ enabled: settled && (item.kind !== "assistant" || item.live) }}>
      {#if item.kind === "user"}
        <div class="user">
          <div class="bubble">{item.text}</div>
          {#if item.attachments.length > 0}
            <div class="chips end">
              {#each item.attachments as attachment (attachment.id)}
                <span class="chip plain">
                  <Icon name="file" />{attachment.name}<span class="dim">
                    {size(attachment.size)}{received(attachment)}
                  </span>
                </span>
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
                  {#if retried.has(part.id)}
                    <li class="plain">
                      <span class="verb">Model request failed</span>
                      <span class="obj">{part.error}</span>
                      <span class="st">{index === item.items.length - 1 ? "Retrying" : "Retried"}</span>
                    </li>
                  {/if}
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
                      <span class="st er wide">
                        Outcome unknown for {view.unknownEffects.map((effect) => effect.tool).join(", ")}; check before
                        repeating.
                      </span>
                    {/if}
                  </li>
                {:else}
                  {@const approval = part.approval}
                  <li class="plain" role="group" aria-label="Approval request">
                    <span class="verb">{(approval.tool === "browser_act" ? browserHeads : heads)[approval.state]}</span>
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
          {#if escalation(approval.advice) !== undefined}<p class="why auto">
              {escalation(approval.advice)}
            </p>{/if}
          <div class="acts">
            <button class="b p" disabled={deciding !== undefined} onclick={() => onDecide(approval, "approve")}>
              Approve once
            </button>
            <button class="b" disabled={deciding !== undefined} onclick={() => onDecide(approval, "deny")}>Deny</button>
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
                  <a href={USAGE_URL} target="_blank" rel="noopener noreferrer">ChatGPT settings → Usage</a>, then send
                  again.
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
  .why.auto {
    color: var(--wa);
  }
  .acts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .older {
    display: flex;
    justify-content: center;
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
    display: flex;
    flex-direction: column;
    gap: 10px;
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
    font-size: 11.5px;
    color: var(--tx3);
    font-variant-numeric: tabular-nums;
    transition: opacity var(--fast) var(--ease);
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
  .transcript.phone {
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
</style>
