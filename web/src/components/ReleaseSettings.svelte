<script lang="ts">
  import { onMount } from "svelte";
  import { api, type ReleaseView, type ReleaseReview } from "../lib/api.ts";
  import ConfirmRemoval from "./ConfirmRemoval.svelte";
  import { MAX_CHECK_ATTEMPTS, MAX_RETAINED_RELEASES } from "../../../src/protocol/limits.ts";

  let view: ReleaseView | undefined = $state.raw();
  let selectedDigest: string | undefined = $state();
  const selected = $derived(
    view?.available ? view.candidates.find((item) => item.digest === selectedDigest) : undefined,
  );
  let reviews: ReleaseReview[] = $state.raw([]);
  let trust = $state(false),
    busy = $state(false),
    loading = $state(false),
    restarting = $state(false);
  let error: string | undefined = $state();
  let confirmation: { digest: string; rollback: boolean } | undefined = $state.raw();
  const locked = $derived(busy || loading || restarting || (view?.available && view.busy));
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

  async function load() {
    loading = true;
    error = undefined;
    try {
      view = await api.releases();
      if (view.available && !view.busy) restarting = false;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void load();
  });

  async function review(digest: string) {
    if (!view?.available || locked) return;
    const candidate = view.candidates.find((item) => item.digest === digest);
    if (candidate === undefined) return;
    selectedDigest = digest;
    reviews = [];
    trust = false;
    error = undefined;
    busy = true;
    try {
      reviews = await Promise.all(candidate.changes.map((path) => api.releaseReview(digest, path)));
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
  async function approve() {
    if (selected === undefined || !trust || locked || reviews.length !== selected.changes.length) return;
    busy = true;
    error = undefined;
    try {
      await api.approveRelease(selected.digest);
      trust = false;
      await load();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
  async function restart() {
    const action = confirmation;
    if (action === undefined) return;
    try {
      if (action.rollback) await api.rollbackRelease(action.digest);
      else await api.activateRelease(action.digest);
      confirmation = undefined;
      restarting = true;
    } catch (failure) {
      await load();
      throw failure;
    }
  }
</script>

<section aria-label="Controlled releases">
  <div class="heading">
    <h3 class="h3">Controlled releases</h3>
    <button class="b sm" disabled={loading || busy} onclick={load}
      >{loading ? "Refreshing…" : "Refresh releases"}</button
    >
  </div>
  <p class="sub">
    Review tested contributions, approve their exact digest, then ask the host to restart. No automatic self-deployment.
  </p>
  {#if error}<div class="callout er" role="alert">{error}</div>{/if}
  {#if restarting}<div class="callout ac" role="status">
      Pal is restarting. Use Refresh releases to reconnect. A failed health check returns to the retained compatible
      version.
    </div>{/if}
  {#if view?.available}
    <div class="fine hash">Selected digest: <span class="mono">{view.current.digest}</span></div>
    <div class="fine hash">Artifact: <span class="mono">{view.current.package}</span></div>
    {#if view.lastError}<div class="callout wa" role="status">{view.lastError}</div>{/if}
    <p class="fine">
      {view.retained}/{MAX_RETAINED_RELEASES} releases retained. Unfinished work blocks a change; old versions are never automatically
      deleted. Close all Terminal and Browser sessions first.
    </p>
    {#if view.previous}
      <button
        class="b sm"
        disabled={locked}
        onclick={() => {
          if (view?.available && view.previous) confirmation = { digest: view.previous.digest, rollback: true };
        }}>Roll back previous release…</button
      >
    {/if}
    <details>
      <summary>Check a candidate on the Pal host</summary>
      <p class="fine">
        Use an isolated Git worktree of this evaluator's public source. Checks run offline in Nix's build sandbox. Only
        the Files, Changes and Context panels and app.css may change; native code, permissions, tests, policy,
        dependencies and schemas are protected.
      </p>
      <pre
        class="command mono">{`${quote(view.evaluator + "/bin/pal")} check-release --candidate /absolute/worktree --data-dir ${quote(view.dataRoot)}`}</pre>
      <p class="fine">
        At most {MAX_CHECK_ATTEMPTS} attempts are retained. A different evaluator or a retention limit needs a reviewed host-side
        handoff, not an automatic policy upgrade.
      </p>
    </details>
    {#each view.candidates as candidate (candidate.digest)}
      <div class="candidate">
        <div class="hash"><strong class="mono">{candidate.digest}</strong></div>
        <div class="fine">
          Package, smoke, tests, browser, e2e and fixed policy evals checked. {new Date(
            candidate.checkedAt,
          ).toLocaleString()}
        </div>
        <div class="fine hash mono">{candidate.candidate}</div>
        <button class="b sm" disabled={locked} onclick={() => review(candidate.digest)}
          >Review candidate {candidate.digest.slice(0, 12)}</button
        >
      </div>
    {:else}<p class="sub">
        No checked candidates under this evaluator. Check a host worktree first, then refresh.
      </p>{/each}
    {#if selected}
      <section class="review" aria-label="Release source review">
        <h4 class="h3">Exact tested source</h4>
        <p class="fine hash mono">{selected.source}</p>
        <div class="callout wa">
          Approving trusts compiled application code, not a sandboxed plugin. Review every change. This launcher does
          not confine malicious code running as the same host user. Code rollback never undoes external effects.
        </div>
        {#each reviews as item (item.path)}
          <details>
            <summary class="mono hash">{item.path}</summary>
            <p class="fine">Before (fixed evaluator)</p>
            <pre class="source mono">{item.before.text}</pre>
            <p class="fine">Tested candidate</p>
            <pre class="source mono">{item.after.text}</pre>
            {#if item.before.truncated || item.after.truncated}<p class="fine warning">
                Preview is truncated at 32 KiB per side. Review the complete host worktree against the exact source
                digest before approving.
              </p>{/if}
          </details>
        {/each}
        {#if selected.approved}
          <p class="fine">Approval recorded for this digest; source and fixed gates are revalidated before restart.</p>
        {:else}
          <label class="consent"
            ><input
              type="checkbox"
              bind:checked={trust}
              disabled={locked || reviews.length !== selected.changes.length || reviews.length === 0}
            /> I reviewed all changes, including any truncated full source, and trust this exact digest as application code.</label
          >
          <button class="b" disabled={locked || !trust || reviews.length === 0} onclick={approve}
            >Approve exact digest</button
          >
        {/if}
        <button
          class="b p"
          disabled={locked || !selected.approved || selected.digest === view.current.digest}
          onclick={() => {
            if (selected) confirmation = { digest: selected.digest, rollback: false };
          }}>Activate approved release…</button
        >
      </section>
    {/if}
  {:else if view}<div class="callout">
      Controlled activation is unavailable with plain <span class="mono">pal serve</span>. The host owner must launch
      the tested Nix package with <span class="mono">pal supervise</span>.
    </div>
  {:else if !error}<p role="status">Loading release control…</p>{/if}
</section>

{#if confirmation}
  <ConfirmRemoval
    title={confirmation.rollback ? "Roll back to the retained release?" : "Activate this approved release?"}
    description="The host checks compatibility and idle work, then restarts Pal. Conversations, credentials and workspace files stay in place. Code rollback cannot undo external operations. This is not a database restore."
    detail={confirmation.digest}
    confirmLabel={confirmation.rollback ? "Roll back release" : "Activate release"}
    busyLabel="Checking and selecting…"
    onCancel={() => (confirmation = undefined)}
    onConfirm={restart}
  />
{/if}

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 24px;
    min-width: 0;
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  h3,
  h4,
  p {
    margin: 0;
  }
  .hash {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .candidate,
  .review {
    padding: 14px 0;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }
  .candidate {
    font-size: 12px;
  }
  summary {
    cursor: pointer;
    font-size: 12px;
    padding: 10px 0;
  }
  details {
    width: 100%;
    min-width: 0;
  }
  pre {
    max-width: 100%;
    overflow: auto;
    font-size: 11px;
    line-height: 1.6;
    padding: 12px;
    background: var(--bg0);
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .source {
    max-height: 260px;
  }
  .command {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .consent {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    color: var(--tx2);
    font-size: 12px;
    line-height: 1.6;
  }
  .warning {
    color: var(--wa);
  }
</style>
