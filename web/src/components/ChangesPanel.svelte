<script lang="ts">
  import { onMount } from "svelte";
  import {
    api,
    ApiError,
    type Change,
    type ChangeComment,
    type ChangeSet,
    type Project,
    type Workspace,
  } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import ConfirmRemoval from "./ConfirmRemoval.svelte";
  import { commentFeedback, type ReviewFeedback } from "../../../src/core/feedback.ts";

  let {
    project,
    workspace,
    initialPath,
    onFeedback,
    composed,
    onStatus,
  }: {
    project: Project;
    workspace?: Workspace | null | undefined;
    initialPath?: string | undefined;
    onFeedback?: (text: string, feedback: ReviewFeedback) => boolean;
    composed?: (id: string) => boolean;
    /** What the panel header shows: whether a scan is running and the totals of the last one. */
    onStatus?: (status: { busy: boolean; files: number | undefined; add: number; del: number }) => void;
  } = $props();
  const root = $derived(workspace?.root ?? project.root);
  let changes: ChangeSet | undefined = $state.raw();
  let chosen: string | undefined = $state();
  // A click wins; until then, the file Files asked to see.
  const selected = $derived(chosen ?? initialPath);
  let busy = $state(false);
  let error: string | undefined = $state();
  let done: string | undefined = $state();
  let discarding: Change | undefined = $state.raw();
  let includeIgnored = $state(false);
  const scope = $derived(includeIgnored ? "include-ignored" : "normal");
  let scan = 0;
  const file = $derived(changes?.files.find((candidate) => candidate.path === selected) ?? changes?.files[0]);
  type Row = { kind: "meta" | "hunk" | "add" | "del" | "same"; text: string; old?: number; line?: number };
  // Numbers each line from its hunk header; `line` is the line in the current file, which comments refer to.
  const rows = $derived.by(() => {
    const parsed: Row[] = [];
    let old = 0;
    let line = 0;
    let hunks = false;
    for (const text of (file?.patch ?? "").replace(/\n$/, "").split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk !== null) {
        old = Number(hunk[1]);
        line = Number(hunk[2]);
        hunks = true;
        parsed.push({ kind: "hunk", text });
      } else if (!hunks || text.startsWith("\\")) parsed.push({ kind: "meta", text });
      else if (text.startsWith("+")) parsed.push({ kind: "add", text: text.slice(1), line: line++ });
      else if (text.startsWith("-")) parsed.push({ kind: "del", text: text.slice(1), old: old++ });
      else parsed.push({ kind: "same", text: text.slice(1), old: old++, line: line++ });
    }
    return parsed;
  });
  type CommentTarget = {
    project: string;
    workspace: string | undefined;
    scope: "normal" | "include-ignored";
    path: string;
    revision: string;
    line: number;
    text: string;
  };
  let composing: CommentTarget | undefined = $state.raw();
  let retarget: CommentTarget | undefined = $state.raw();
  let draft = $state("");
  const listed = $derived(new Set(changes?.files.map((candidate) => candidate.path)));
  const displayed = $derived(rows.slice(0, 5000));
  const visibleLines = $derived(new Set(displayed.flatMap((row) => (row.line === undefined ? [] : [row.line]))));
  const draftVisible = $derived(
    composing !== undefined &&
      composing.project === project.id &&
      composing.workspace === workspace?.id &&
      composing.scope === scope &&
      composing.path === file?.path &&
      composing.revision === file.revision &&
      visibleLines.has(composing.line),
  );
  const draftHidden = $derived(composing?.scope === "include-ignored" && !includeIgnored);
  const current = $derived(
    (changes?.comments ?? []).reduce<Record<number, ChangeComment[]>>((byLine, comment) => {
      if (comment.path === file?.path && !comment.outdated) (byLine[comment.line] ??= []).push(comment);
      return byLine;
    }, {}),
  );
  const unplaced = $derived(
    changes?.comments.filter(
      (comment) =>
        !listed.has(comment.path) ||
        (comment.path === file?.path && (comment.outdated || !visibleLines.has(comment.line))),
    ) ?? [],
  );
  const outdatedCount = $derived(unplaced.filter((comment) => comment.outdated).length);
  const pending = $derived(changes?.comments.filter((comment) => !comment.sent) ?? []);
  const copied = $derived(pending.some((comment) => composed?.(comment.id) === true));

  /** Added and removed lines in one file's patch, counted inside its hunks. */
  function counts(patch: string): { add: number; del: number } {
    let add = 0;
    let del = 0;
    let hunks = false;
    for (const text of patch.split("\n")) {
      if (text.startsWith("@@")) hunks = true;
      else if (hunks && text.startsWith("+")) add += 1;
      else if (hunks && text.startsWith("-")) del += 1;
    }
    return { add, del };
  }
  $effect(() => {
    const totals = (changes?.files ?? []).map((candidate) => counts(candidate.patch));
    onStatus?.({
      busy,
      files: changes?.files.length,
      add: totals.reduce((sum, total) => sum + total.add, 0),
      del: totals.reduce((sum, total) => sum + total.del, 0),
    });
  });
  /** Git's own header lines repeat the file name; other notes (modes, binary files) stay. */
  const HEADER = /^(diff --git |index |--- |\+\+\+ )/;

  export async function refresh() {
    const request = ++scan;
    busy = true;
    error = undefined;
    done = undefined;
    try {
      const loaded = await api.changes(project.id, scope, workspace?.id);
      if (request === scan) changes = loaded;
    } catch (failure) {
      if (request === scan) error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      if (request === scan) busy = false;
    }
  }
  function changeScope(checked: boolean) {
    includeIgnored = checked;
    changes = undefined;
    retarget = undefined;
    discarding = undefined;
    chosen = undefined;
    void refresh();
  }
  async function review() {
    if (file === undefined) return;
    busy = true;
    error = undefined;
    try {
      await api.review(project.id, file.path, file.revision, !file.reviewed, scope, workspace?.id);
      await refresh();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      busy = false;
    }
  }
  async function discard() {
    const target = discarding;
    if (target === undefined) return;
    try {
      await api.discard(project.id, target.path, target.revision, scope, workspace?.id);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.code === "changes_stale")) throw failure;
      discarding = undefined;
      await refresh();
      error =
        "This file changed while the dialog was open. Nothing was discarded, so newer work wasn't overwritten. Review the latest revision.";
      return;
    }
    discarding = undefined;
    await refresh();
    done = `Restored ${target.path} to the baseline.`;
  }
  async function act(work: () => Promise<unknown>) {
    busy = true;
    error = undefined;
    try {
      await work();
      await refresh();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      busy = false;
    }
  }
  function clearDraft() {
    composing = undefined;
    retarget = undefined;
    draft = "";
  }
  function open(file: Change, line: number, text: string) {
    if (draftHidden) {
      error = "Re-enable ignored-file review or cancel its draft before choosing another target.";
      return;
    }
    if (draftVisible && composing?.line === line) {
      if (draft.trim() === "") clearDraft();
      return;
    }
    const target: CommentTarget = {
      project: project.id,
      workspace: workspace?.id,
      scope,
      path: file.path,
      revision: file.revision,
      line,
      text: text.slice(0, 1000),
    };
    if (composing !== undefined && draft.trim() !== "") retarget = target;
    else {
      composing = target;
      retarget = undefined;
      draft = "";
    }
  }
  async function add() {
    const target = composing,
      text = draft;
    if (target === undefined || busy || draftHidden) return;
    await act(async () => {
      try {
        await api.comment(
          target.project,
          target.path,
          target.revision,
          target.line,
          text,
          target.scope,
          target.workspace,
        );
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === "changes_stale") {
          await refresh();
          throw new Error(
            "The original file changed. Your draft is kept; review the latest diff, choose a line and retarget it explicitly.",
            { cause: failure },
          );
        }
        throw failure;
      }
      if (composing === target && draft === text) clearDraft();
    });
  }
  function feedback() {
    const sending = pending;
    const added = onFeedback?.(
      [
        "Review feedback:",
        `Workspace: ${root}${workspace == null ? "" : ` (${workspace.mode}, ${workspace.id})`}.`,
        ...sending.map(commentFeedback),
      ].join("\n\n"),
      { ids: sending.map((comment) => comment.id), scope },
    );
    if (added !== true) {
      done = undefined;
      error =
        "Feedback could not be added to the draft. Your comments are kept; make room in the composer and copy again.";
      return;
    }
    error = undefined;
    done =
      "Feedback is in the composer, not yet admitted. Send it there, or copy again from here. Edited feedback stays recoverable in this panel.";
  }
  /** Only by the owner's choice: a commit by itself never moves the baseline, so it can't hide changes from review. */
  async function moveBaseline() {
    const seen = changes;
    if (seen?.head == null) return;
    const to = seen.head;
    await act(() => api.moveBaseline(project.id, seen.base, to, workspace?.id));
    if (error === undefined) done = `Now reviewing changes since commit ${to.slice(0, 12)}.`;
  }
  const baseline = $derived(changes?.base?.slice(0, 12) ?? "empty tree");
  onMount(() => {
    void refresh();
  });
</script>

<div class="changes" aria-busy={busy}>
  {#if error}<div class="callout er" role="alert">{error}</div>{/if}
  {#if done}<p class="notice" role="status">{done}</p>{/if}
  {#if changes?.state === "ready" && changes.head !== null && changes.head !== changes.base}
    <div class="callout ac moved" role="status">
      <p>
        The repository is now at commit <span class="mono">{changes.head.slice(0, 12)}</span>, so changes committed
        since the baseline still show here.
      </p>
      <button class="b sm" disabled={busy} onclick={moveBaseline}>Review from latest commit</button>
    </div>
  {/if}
  {#if changes?.truncated}<p class="notice warning">
      Partial scan: file, byte or time limit reached. Not all changes are shown.
    </p>{/if}
  {#if changes === undefined}
    <p class="notice" role="status">{busy ? "Reading changes…" : "Refresh to read changes."}</p>
  {:else if changes.state === "ready" && changes.files.length === 0}
    <div class="empty">
      <Icon name="check" />
      <h3>No changes found</h3>
      <p>Files match the baseline within this scan's limits.</p>
    </div>
  {:else if changes.files.length > 0}
    <ul class="files" aria-label="Changed files">
      {#each changes.files as candidate (candidate.path)}
        {@const slash = candidate.path.lastIndexOf("/")}
        {@const { add, del } = counts(candidate.patch)}
        <li>
          <button
            class="frow"
            class:done={candidate.reviewed}
            aria-current={file?.path === candidate.path ? "true" : undefined}
            onclick={() => {
              chosen = candidate.path;
              retarget = undefined;
            }}
          >
            <span class="name"
              ><span class="base">{candidate.path.slice(slash + 1)}</span>
              <span class="dir"
                >{candidate.path.slice(0, Math.max(slash, 0))}{candidate.status === "A"
                  ? " new"
                  : candidate.status === "D"
                    ? " deleted"
                    : ""}</span
              ></span
            >
            {#if candidate.ignored}<span class="flag wa">ignored</span>{/if}
            {#if candidate.problem}<Icon name="warn" />{/if}
            {#if candidate.reviewed}<span class="flag">reviewed</span>
            {:else}
              {#if add > 0}<span class="num add">+{add}</span>{/if}
              {#if del > 0}<span class="num del">−{del}</span>{/if}
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <details class="details">
    <summary title={root}
      ><span class="mono"
        >{changes === undefined
          ? "Baseline"
          : changes.state === "unavailable"
            ? "Baseline unavailable"
            : `Baseline ${changes.base?.slice(0, 12) ?? "empty tree"}`}</span
      >
      · {workspace?.mode ?? (project.mode === "managed" ? "managed" : "host folder")} · Details<Icon
        name="chevR"
        size={12}
      /></summary
    >
    <p class="mono">{root}</p>
    {#if changes !== undefined}<p>{changes.note}</p>{/if}
    <label
      ><input
        type="checkbox"
        checked={includeIgnored}
        onchange={(event) => changeScope(event.currentTarget.checked)}
      />Include ignored files for review</label
    >
    <p>
      Ignored files may contain secrets. This local review choice does not change agent folder or shell access. Excerpts
      reach chat only when you choose Send feedback.
    </p>
  </details>
  {#if unplaced.length > 0}
    <div class="outdated" role="region" aria-label="Other review comments">
      <p class="warning">
        {outdatedCount > 0
          ? `${outdatedCount} outdated comment${outdatedCount === 1 ? "" : "s"}`
          : "Comments outside the visible diff"}
      </p>
      {#each unplaced as comment (comment.id)}{@render card(comment, true)}{/each}
    </div>
  {/if}
  {#if composing && draftHidden}
    <div class="cm out">
      <p>Your ignored-file draft is kept. Re-enable ignored-file review to continue.</p>
      <button class="b sm q" onclick={clearDraft}>Cancel draft</button>
    </div>
  {:else if composing && !draftVisible}
    {@render editor(composing)}
  {/if}
  {#if file}
    {#if file.problem}<p class="notice" role="status">{file.problem}</p>
    {:else}
      {@const target = file}
      <div class="patch" role="region" aria-label="File diff">
        {#each displayed as row, i (i)}
          {#if row.kind === "meta" || row.kind === "hunk"}
            {#if !HEADER.test(row.text)}<div class="dl meta" class:hunk={row.kind === "hunk"}>
                <span class="tx">{row.text}</span>
              </div>{/if}
          {:else}
            <div class="dl" class:add={row.kind === "add"} class:del={row.kind === "del"}>
              {#if row.line === undefined}<span class="ln"></span>
              {:else}
                {@const line = row.line}
                <button
                  class="ln lnb"
                  aria-label={`Comment on line ${line}`}
                  aria-pressed={draftVisible && composing?.line === line}
                  onclick={() => open(target, line, row.text)}>{line}</button
                >
              {/if}
              <span class="sg">{row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}</span><span class="tx"
                >{row.text}</span
              >
            </div>
            {#if row.line !== undefined}
              {@const line = row.line}
              {#each current[line] ?? [] as comment (comment.id)}{@render card(comment)}{/each}
              {#if composing && draftVisible && composing.line === line}
                {@render editor(composing)}
              {/if}
            {/if}
          {/if}
        {/each}
      </div>
      {#if rows.length > 5000}<p class="notice">
          Diff display limited to 5,000 lines. Review the full file in your editor.
        </p>{/if}
    {/if}
  {/if}
  {#if file || onFeedback}
    <div class="foot">
      {#if file}
        <button
          class="b t review"
          aria-pressed={file.reviewed}
          disabled={busy || file.problem !== undefined}
          onclick={review}
          ><span class="box" aria-hidden="true"
            >{#if file.reviewed}<Icon name="check" size={12} />{/if}</span
          >{file.reviewed ? "Reviewed" : "Mark reviewed"}</button
        >
        <button
          class="b t"
          title={`Revision ${file.revision.slice(0, 12) || "unavailable"}`}
          disabled={busy || file.problem !== undefined}
          onclick={() => (discarding = file)}>Discard…</button
        >
      {/if}
      <span class="grow"></span>
      {#if onFeedback}<button class="b" disabled={busy || pending.length === 0} onclick={feedback}
          >{copied ? "Copy feedback again" : "Send feedback to chat"}{pending.length > 0
            ? ` (${pending.length})`
            : ""}</button
        >{/if}
    </div>
  {/if}
</div>

{#snippet editor(target: CommentTarget)}
  <div class="cm" class:out={!draftVisible}>
    <div class="cmhead" title={`Workspace ${target.workspace ?? target.project}; revision ${target.revision}`}>
      Original target: {target.path} · {target.revision.slice(0, 12)} · line {target.line}
    </div>
    <code class="mono quote">{target.text}</code>
    {#if !draftVisible}<p class="warning">
        Viewing another file or revision. This draft still belongs to its original target.
      </p>{/if}
    <label for="change-comment">Comment on line {target.line}</label>
    <textarea
      id="change-comment"
      class="f"
      rows="3"
      maxlength="4000"
      placeholder="Leave a review comment"
      bind:value={draft}
      {@attach (node) => node.focus()}></textarea>
    {#if retarget}
      <div class="callout wa">
        <p>Move this text to {retarget.path} · {retarget.revision.slice(0, 12)} · line {retarget.line}?</p>
        <code class="mono quote">{retarget.text}</code>
        <div class="actions">
          <button class="b sm q" onclick={() => (retarget = undefined)}>Keep original target</button>
          <button
            class="b sm"
            onclick={() => {
              composing = retarget;
              retarget = undefined;
              error = undefined;
            }}>Retarget draft</button
          >
        </div>
      </div>
    {/if}
    <div class="actions">
      <button class="b sm q" onclick={clearDraft}>Cancel</button>
      <button class="b sm p" disabled={busy || draft.trim() === ""} onclick={add}>Add comment</button>
    </div>
  </div>
{/snippet}

{#snippet card(comment: ChangeComment, detached = false)}
  <div class="cm" class:out={detached}>
    <div class="cmhead">
      <span title={`Revision ${comment.revision.slice(0, 12)}`}
        >You · {comment.path === file?.path ? "" : `${comment.path} · `}line {comment.line}</span
      >
      {#if comment.outdated}<span class="warning">Outdated</span>{/if}
      <span>·</span><span
        >{comment.sent ? "Admitted to chat" : composed?.(comment.id) ? "In composer · not admitted" : "Not sent"}</span
      >
      <span class="grow"></span>
      <button
        class="b i q sm tip end"
        disabled={busy}
        aria-label={`Delete comment on line ${comment.line}`}
        data-tip="Delete comment"
        onclick={() => act(() => api.uncomment(project.id, comment.id, workspace?.id))}
        ><Icon name="trash" size={14} /></button
      >
    </div>
    {#if detached}<code class="mono quote" class:gone={comment.outdated}>{comment.lineText.trim()}</code>{/if}
    <p>{comment.body}</p>
  </div>
{/snippet}

{#if discarding}
  <ConfirmRemoval
    title="Discard changes to this file?"
    description={`${
      discarding.status === "A"
        ? "Deletes this file, which isn't in the baseline."
        : discarding.status === "D"
          ? `Restores the deleted file from baseline ${baseline}.`
          : `Rewrites the file on disk to baseline ${baseline}.`
    } This can't be undone from here and may include changes made before Pal recorded the baseline. If the file changes before you confirm, nothing is discarded.`}
    detail={`${root}/${discarding.path} · revision ${discarding.revision.slice(0, 12)}`}
    confirmLabel="Discard changes"
    busyLabel="Discarding…"
    onCancel={() => (discarding = undefined)}
    onConfirm={discard}
  />
{/if}

<style>
  .changes {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .changes > .callout {
    margin: 10px 12px 0;
  }
  .notice {
    margin: 0;
    padding: 10px 18px;
    color: var(--tx3);
    font-size: 13px;
  }
  .warning {
    color: var(--wa);
  }
  .moved {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 12px;
    color: var(--tx2);
  }
  .moved p {
    flex: 1 1 220px;
    margin: 0;
  }
  .files {
    list-style: none;
    padding: 8px;
    margin: 0;
    max-height: 30%;
    overflow: auto;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .frow {
    width: 100%;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    color: color-mix(in srgb, var(--tx) 85%, transparent);
    background: transparent;
    text-align: left;
    font-size: 13px;
  }
  .frow:hover {
    background: var(--bg3);
  }
  .frow[aria-current="true"] {
    background: var(--bg4);
    color: var(--tx);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dir,
  .flag,
  .done {
    color: var(--tx3);
  }
  .done .base {
    text-decoration: line-through;
    text-decoration-color: var(--line3);
  }
  .flag {
    font-size: 12px;
  }
  .flag.wa,
  .frow :global(svg) {
    color: var(--wa);
  }
  .num {
    font: 12px var(--mono);
  }
  .num.add {
    color: var(--ok);
  }
  .num.del {
    color: var(--er);
  }
  .details {
    flex-shrink: 0;
    padding: 8px 18px;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    font-size: 12.5px;
    color: var(--tx3);
  }
  .details summary {
    display: flex;
    align-items: center;
    gap: 6px;
    list-style: none;
    cursor: pointer;
  }
  .details summary::-webkit-details-marker {
    display: none;
  }
  .details summary:hover {
    color: var(--tx2);
  }
  .details[open] summary :global(svg) {
    transform: rotate(90deg);
  }
  .details p {
    max-width: 72ch;
    margin: 6px 0 0;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .details label {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    margin-top: 6px;
    color: var(--tx2);
  }
  .patch {
    flex: 1;
    overflow: auto;
    min-height: 0;
    padding: 10px 0 24px;
    font: 12px/22px var(--mono);
    color: var(--tx2);
    tab-size: 2;
  }
  .dl {
    display: flex;
    min-width: max-content;
    white-space: pre;
  }
  .ln {
    flex: 0 0 44px;
    padding: 0 10px 0 0;
    color: var(--line3);
    text-align: right;
    user-select: none;
  }
  .lnb {
    border: 0;
    background: transparent;
    font: inherit;
  }
  .lnb:hover,
  .lnb:focus-visible,
  .lnb[aria-pressed="true"] {
    color: var(--ac);
  }
  .sg {
    flex: 0 0 14px;
    color: var(--tx3);
    user-select: none;
  }
  .tx {
    padding-right: 24px;
  }
  .dl.add {
    color: var(--addtx);
    background: var(--addbg);
  }
  .dl.del {
    color: var(--deltx);
    background: var(--delbg);
  }
  .add .ln,
  .add .sg {
    color: color-mix(in srgb, var(--ok) 60%, transparent);
  }
  .del .sg {
    color: color-mix(in srgb, var(--er) 60%, transparent);
  }
  .meta {
    color: var(--tx3);
  }
  .meta .tx {
    padding-left: 18px;
  }
  .hunk .tx {
    padding-bottom: 6px;
  }
  .cm {
    position: sticky;
    left: 0;
    overflow-wrap: anywhere;
    max-width: 540px;
    margin: 8px 16px 8px 44px;
    padding: 10px 12px;
    border: 1px solid var(--line2);
    border-radius: 10px;
    background: var(--bg3);
    font: 13px/1.5 var(--sans);
    color: color-mix(in srgb, var(--tx) 90%, transparent);
    white-space: normal;
  }
  .cm.out {
    margin: 0;
    max-width: none;
  }
  .cm p {
    margin: 4px 0 0;
    white-space: pre-wrap;
  }
  .cm label {
    color: var(--tx3);
    font-size: 12px;
  }
  .cm textarea {
    margin-top: 4px;
    resize: vertical;
  }
  .cmhead {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    min-height: 26px;
    color: var(--tx3);
    font-size: 12px;
  }
  .grow {
    flex: 1;
  }
  .quote {
    display: block;
    margin-top: 6px;
    color: var(--tx3);
    font-size: 12px;
    white-space: pre-wrap;
  }
  .gone {
    text-decoration: line-through;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 6px;
  }
  .outdated {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: 8px;
    max-height: 40%;
    overflow: auto;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  .outdated .warning {
    margin: 0;
    font-size: 12px;
  }
  .empty {
    padding: 28px 18px;
    color: var(--tx2);
  }
  h3 {
    color: var(--tx);
    font-size: 14px;
    font-weight: 600;
    margin: 8px 0;
  }
  .empty p {
    font-size: 13px;
  }
  .foot {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 14px 16px;
    border-top: 1px solid var(--line);
  }
  .review {
    gap: 8px;
    padding-left: 0;
  }
  .box {
    width: 15px;
    height: 15px;
    display: grid;
    place-items: center;
    border: 1.5px solid var(--line3);
    border-radius: 4px;
    color: var(--on-primary);
  }
  .review[aria-pressed="true"] .box {
    border-color: var(--primary);
    background: var(--primary);
  }
</style>
