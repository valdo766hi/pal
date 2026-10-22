<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type WorkingStateInfo } from "../lib/api.ts";

  let { chatId }: { chatId: string } = $props();
  let info: WorkingStateInfo | undefined = $state.raw();
  let draft: { revision: number; text: string; constraints: string; acceptance: string } | undefined = $state();
  let stale = $state(false);
  let error: string | undefined = $state();
  let loading = $state(false);
  let saving = $state(false);
  let generation = 0;
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
  async function save(value: WorkingStateInfo["goal"]) {
    if (saving || loading || stale) return;
    const current = ++generation,
      id = chatId;
    saving = true;
    error = undefined;
    try {
      const saved = await api.saveWorkingGoal(id, value);
      if (current === generation && id === chatId) {
        info = saved;
        draft = undefined;
      }
    } catch (failure) {
      if (current === generation && id === chatId) {
        error = String(failure);
        if (failure instanceof ApiError && failure.status === 409) {
          stale = true;
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
        <button class="b sm q" onclick={edit} disabled={loading || saving}>Edit working goal</button>
        {#if info.goal.text !== ""}<button
            class="b sm q"
            disabled={loading || saving || stale}
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
      Correction or clearing invalidates the current agent checkpoint, not old transcript entries or backups. It does
      not cancel running work.
    </p>
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
