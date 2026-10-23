<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type WorkingStateInfo } from "../lib/api.ts";

  let { chatId }: { chatId: string } = $props();
  let info: WorkingStateInfo | undefined = $state.raw();
  let draft: { revision: number; text: string; constraints: string; acceptance: string } | undefined = $state();
  let allowanceDraft:
    { revision: number; goalRevision: number; steps: number | undefined; calls: number | undefined } | undefined =
    $state();
  let stale = $state(false);
  let error: string | undefined = $state();
  let loading = $state(false);
  let saving = $state(false);
  let generation = 0;
  const allowanceStale = $derived(
    allowanceDraft !== undefined &&
      info !== undefined &&
      (allowanceDraft.revision !== info.allowance?.revision || allowanceDraft.goalRevision !== info.goal.revision),
  );
  const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");
  const goal = $derived(
    draft === undefined
      ? undefined
      : {
          revision: draft.revision,
          text: draft.text,
          constraints: lines(draft.constraints),
          acceptance: lines(draft.acceptance),
        },
  );
  const bytes = $derived(
    goal === undefined
      ? 0
      : new TextEncoder().encode(
          JSON.stringify({
            text: goal.text,
            constraints: goal.constraints,
            acceptance: goal.acceptance,
          }),
        ).byteLength,
  );

  async function load(signal?: AbortSignal) {
    const current = ++generation,
      id = chatId;
    loading = true;
    error = undefined;
    try {
      const value = await api.workingState(id, signal);
      if (current === generation && id === chatId) {
        info = value;
        if (draft !== undefined && draft.revision !== value.goal.revision) stale = true;
      }
    } catch (failure) {
      if (current === generation && !signal?.aborted) error = String(failure);
    } finally {
      if (current === generation) loading = false;
    }
  }
  onMount(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      generation++;
      controller.abort();
    };
  });
  function edit() {
    if (info === undefined) return;
    draft = {
      ...info.goal,
      constraints: info.goal.constraints.join("\n"),
      acceptance: info.goal.acceptance.join("\n"),
    };
    stale = false;
    error = undefined;
  }
  function save(value: WorkingStateInfo["goal"]) {
    return change((id) => api.saveWorkingGoal(id, value), "goal");
  }
  function editAllowance() {
    if (info?.allowance === undefined) return;
    allowanceDraft = {
      revision: info.allowance.revision,
      goalRevision: info.goal.revision,
      steps: info.allowance.limits?.steps ?? 16,
      calls: info.allowance.limits?.calls ?? 128,
    };
    error = undefined;
  }
  function saveAllowance() {
    if (allowanceDraft === undefined || allowanceStale) return;
    const { revision, goalRevision, steps, calls } = allowanceDraft;
    if (steps === undefined || calls === undefined) return;
    return change(
      (id) => api.saveWorkingAllowance(id, { revision, goalRevision, limits: { steps, calls } }),
      "allowance",
    );
  }
  function disableAllowance() {
    const value = info;
    if (value?.allowance === undefined) return;
    return change((id) =>
      api.saveWorkingAllowance(id, {
        revision: value.allowance.revision,
        goalRevision: value.goal.revision,
        limits: null,
      }),
    );
  }
  async function change(
    send: (id: string) => Promise<WorkingStateInfo>,
    clearDraft: "goal" | "allowance" | false = false,
  ) {
    if (saving || loading || stale) return;
    const current = ++generation,
      id = chatId;
    saving = true;
    error = undefined;
    try {
      const saved = await send(id);
      if (current === generation && id === chatId) {
        info = saved;
        if (clearDraft === "goal") draft = undefined;
        if (clearDraft === "allowance") allowanceDraft = undefined;
      }
    } catch (failure) {
      if (current === generation && id === chatId) {
        error = String(failure);
        if (failure instanceof ApiError && failure.status === 409) {
          stale = draft !== undefined;
          try {
            const latest = await api.workingState(id);
            if (current === generation && id === chatId) info = latest;
          } catch (refreshFailure) {
            if (current === generation && id === chatId) error = String(refreshFailure);
          }
        }
      }
    } finally {
      if (current === generation && id === chatId) saving = false;
    }
  }
</script>

<section aria-label="Working goal">
  <div class="row">
    <h3 class="h3 grow">Working goal</h3>
    <button class="b sm q" onclick={() => load()} disabled={loading || saving}>Refresh working state</button>
  </div>
  <p class="sub">
    Saved for this chat across compaction and restart. Saving does not send a message, run work or grant permissions.
  </p>
  {#if error}<p class="callout er" role="alert">{error}</p>{/if}
  {#if loading}<p class="sub" role="status">Loading working state…</p>{/if}
  {#if info !== undefined}
    <p class="sub">Owner goal · revision {info.goal.revision}. Changes apply at the next request preparation.</p>
    {#if info.goal.text === ""}<p class="sub">No saved working goal.</p>
    {:else}
      <pre aria-label="Saved working goal">{info.goal.text}</pre>
      {#if info.goal.constraints.length > 0}<strong class="sub">Constraints</strong>
        <pre>{info.goal.constraints.join("\n")}</pre>{/if}
      {#if info.goal.acceptance.length > 0}<strong class="sub">Acceptance checks (not verified results)</strong>
        <pre>{info.goal.acceptance.join("\n")}</pre>{/if}
    {/if}
    {#if draft === undefined}
      <div class="row">
        <button class="b sm q" onclick={edit} disabled={loading || saving || allowanceDraft !== undefined}
          >Edit working goal</button
        >
        {#if info.goal.text !== ""}<button
            class="b sm q"
            disabled={loading || saving || stale || allowanceDraft !== undefined}
            onclick={() => {
              if (info) void save({ revision: info.goal.revision, text: "", constraints: [], acceptance: [] });
            }}>Clear current goal</button
          >{/if}
      </div>
    {:else}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          if (goal) void save(goal);
        }}
      >
        <fieldset disabled={saving || loading}>
          <label class="fl">Goal<textarea class="f" rows="3" maxlength="2000" bind:value={draft.text}></textarea></label
          >
          <label class="fl"
            >Constraints (one per line)<textarea class="f" rows="3" maxlength="1607" bind:value={draft.constraints}
            ></textarea></label
          >
          <label class="fl"
            >Acceptance checks (one per line)<textarea class="f" rows="3" maxlength="1607" bind:value={draft.acceptance}
            ></textarea></label
          >
          <p class="sub">
            Up to eight entries per list, 200 characters each. {bytes.toLocaleString()} / {info.limits.goalBytes.toLocaleString()}
            UTF-8 bytes; {info.limits.goalTokens.toLocaleString()} estimated-token limit. Clear all fields to remove the goal.
          </p>
          {#if stale}
            <p class="callout wa">Your draft is retained. Review the current saved goal above before replacing it.</p>
            <button
              class="b sm"
              type="button"
              disabled={draft.revision === info.goal.revision}
              onclick={() => {
                if (draft && info) {
                  draft.revision = info.goal.revision;
                  stale = false;
                  error = undefined;
                }
              }}>Use current goal revision for my draft</button
            >
          {/if}
          <div class="row end">
            <button
              class="b sm q"
              type="button"
              onclick={() => {
                draft = undefined;
                stale = false;
                error = undefined;
              }}>Cancel goal edit</button
            >
            <button class="b sm p" type="submit" disabled={stale || bytes > info.limits.goalBytes}
              >Save working goal</button
            >
          </div>
        </fieldset>
      </form>
    {/if}
    <p class="sub">
      Correction or clearing invalidates the current checkpoint and check receipts, not old transcript entries or
      backups. It does not cancel running work.
    </p>
    {#if info.allowance}
      <div class="fl" role="region" aria-label="Execution allowance">
        <h4 class="h3">Execution allowance</h4>
        <p class="sub" role="status">
          {info.allowance.state.replaceAll("-", " ")} · revision {info.allowance.revision}
        </p>
        {#if info.allowance.limits}
          <p class="sub">
            Goal {info.allowance.goalRevision} · model steps {info.allowance.used.steps} / {info.allowance.limits.steps} ·
            tool attempts {info.allowance.used.calls} / {info.allowance.limits.calls}
          </p>
        {/if}
        {#if info.allowance.blocked}
          <p class="callout wa">
            Stopped before native task {info.allowance.blocked.task}: {info.allowance.blocked.reason.replaceAll(
              "-",
              " ",
            )}. Inspect earlier effects before continuing.
          </p>
        {/if}
        {#if info.allowance.state === "goal-changed"}
          <p class="callout wa">
            The goal changed. The existing allowance was not silently removed; review the new goal, then explicitly
            renew or disable it.
          </p>
        {/if}
        {#if allowanceDraft === undefined}
          <div class="row">
            <button
              class="b sm q"
              disabled={loading || saving || draft !== undefined || info.goal.text === ""}
              onclick={editAllowance}>Set execution allowance</button
            >
            {#if info.allowance.limits}
              <button class="b sm q" disabled={loading || saving || draft !== undefined} onclick={disableAllowance}
                >Disable execution allowance</button
              >
            {/if}
          </div>
        {:else}
          <form
            onsubmit={(event) => {
              event.preventDefault();
              void saveAllowance();
            }}
          >
            <fieldset disabled={saving || loading}>
              <label class="fl"
                >Model steps<input
                  class="f"
                  type="number"
                  min="1"
                  max={info.allowance.max.steps}
                  step="1"
                  required
                  bind:value={allowanceDraft.steps}
                /></label
              >
              <label class="fl"
                >Tool attempts<input
                  class="f"
                  type="number"
                  min="1"
                  max={info.allowance.max.calls}
                  step="1"
                  required
                  bind:value={allowanceDraft.calls}
                /></label
              >
              <p class="sub">
                Starting or renewing resets these counters. It does not send a message, resume stopped work or change
                tool grants. These are not spending, token or time caps.
              </p>
              {#if allowanceStale}
                <p class="callout wa">
                  Your allowance draft is retained. Review the current saved goal and limits before resetting.
                </p>
                <button
                  class="b sm"
                  type="button"
                  onclick={() => {
                    if (info && allowanceDraft) {
                      allowanceDraft.revision = info.allowance.revision;
                      allowanceDraft.goalRevision = info.goal.revision;
                      error = undefined;
                    }
                  }}>Use current allowance revision for my draft</button
                >
              {/if}
              <div class="row end">
                <button
                  class="b sm q"
                  type="button"
                  onclick={() => {
                    allowanceDraft = undefined;
                    error = undefined;
                  }}>Cancel allowance edit</button
                >
                <button
                  class="b sm p"
                  type="submit"
                  disabled={allowanceStale ||
                    allowanceDraft.steps === undefined ||
                    allowanceDraft.calls === undefined ||
                    info.goal.text === ""}>Start or renew execution allowance</button
                >
              </div>
            </fieldset>
          </form>
        {/if}
        <details>
          <summary>Allowance scope and limits</summary>
          <p class="sub">{info.allowance.notice}</p>
        </details>
      </div>
    {/if}
    {#if info.checkpoint !== null}
      <h4 class="h3">Unverified agent checkpoint</h4>
      <p class="sub">
        Checkpoint {info.checkpoint.revision} · goal {info.checkpoint.goalRevision} · {new Date(
          info.checkpoint.at,
        ).toLocaleString()}. Refresh to read newer notes.
      </p>
      <pre>{info.checkpoint.summary}</pre>
      <details>
        <summary>Plan and open questions</summary>
        <strong class="sub">Plan</strong>
        <pre>{info.checkpoint.plan.join("\n") || "No plan recorded."}</pre>
        <strong class="sub">Next action</strong>
        <pre>{info.checkpoint.next || "Not recorded."}</pre>
        <strong class="sub">Open questions</strong>
        <pre>{info.checkpoint.questions.join("\n") || "None recorded."}</pre>
      </details>
    {:else}<p class="sub">No agent checkpoint.</p>{/if}
    {#if info.verification}
      <div class="fl" role="region" aria-label="Recorded acceptance checks">
        <h4 class="h3">Recorded acceptance checks</h4>
        <p class="sub">
          {info.verification.state.replaceAll("-", " ")} · {info.verification.attempts} / {info.verification.limit} verification
          attempts
        </p>
        {#if info.verification.goalRevision !== info.goal.revision}
          <p class="callout wa">Goal changed during inspection. Refresh before reviewing these receipts.</p>
        {:else}
          {#each info.verification.checks as check (check.task)}
            <details>
              <summary>Check {check.criterion + 1} · {check.outcome}{check.stale ? " · stale source" : ""}</summary>
              <p class="sub">
                {info.goal.acceptance[check.criterion]} · goal {check.goalRevision} · shell task {check.task}
              </p>
              <pre>{check.command}{check.commandTruncated
                  ? "\n[Preview truncated; full command is in the shell task.]"
                  : ""}</pre>
              <p class="sub">
                Exit {check.exitCode ?? "not recorded"}{check.timedOut
                  ? " · command timed out"
                  : ""}{check.outputTruncated ? " · output truncated" : ""}. {check.stale
                  ? "Recheck the changed or unavailable source."
                  : "Refresh to recheck source freshness."}
              </p>
              <pre aria-label="Tested source revision">{check.after ?? "No completed source observation."}</pre>
            </details>
          {:else}<p class="sub">No host-run acceptance checks recorded.</p>{/each}
          {#if info.verification.remaining.length > 0}<p class="sub">
              Checks still needed: {info.verification.remaining.map((index) => index + 1).join(", ")}
            </p>{/if}
        {/if}
        {#if info.verification.review}
          <p class:wa={info.verification.review.stale} class="sub">
            Owner accepted {new Date(info.verification.review.at).toLocaleString()}{info.verification.review.stale
              ? " · stale: source, goal or check evidence changed. This goal is no longer complete."
              : " · current checked revision complete."}
          </p>
        {/if}
        {#if info.verification.state === "ready-for-review" && info.verification.goalRevision === info.goal.revision && info.verification.reviewDigest}
          <p class="sub">
            Review the Changes diff and whether these commands adequately test every criterion before accepting. This
            does not commit, deploy or stop running work. Later changes invalidate completion.
          </p>
          <button
            class="b sm q"
            disabled={loading || saving || draft !== undefined}
            onclick={() => {
              const digest = info?.verification.reviewDigest;
              if (digest) void change((id) => api.acceptWorkingChecks(id, digest));
            }}>Accept checks and complete goal</button
          >
        {/if}
        <details>
          <summary>Verification scope and limits</summary>
          <p class="sub">{info.verification.scope}</p>
          <p class="sub">{info.verification.notice}</p>
        </details>
      </div>
    {/if}
    <p class="sub">{info.notice}</p>
  {/if}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px 0;
    border-top: 1px solid var(--line);
  }
  pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 220px;
    overflow: auto;
    font-size: 12px;
  }
  details {
    overflow-wrap: anywhere;
  }
  summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--tx2);
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .fl {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--tx2);
  }
  .f {
    width: 100%;
    min-width: 0;
  }
  @media (max-width: 699px) {
    summary {
      min-height: 44px;
    }
  }
</style>
