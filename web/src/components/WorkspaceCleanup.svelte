<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type RemovedWorkspace } from "../lib/api.ts";
  import ConfirmRemoval from "./ConfirmRemoval.svelte";

  let workspaces: RemovedWorkspace[] = $state.raw([]);
  let truncated = $state(false);
  let loading = $state(false);
  let removing: RemovedWorkspace | undefined = $state.raw();
  let error: string | undefined = $state();
  let notice: string | undefined = $state();

  async function load() {
    loading = true;
    error = undefined;
    try {
      ({ workspaces, truncated } = await api.removedWorkspaces());
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      loading = false;
    }
  }
  onMount(() => void load());

  async function purge() {
    const item = removing;
    if (item?.identity == null) return;
    try {
      await api.purgeWorkspace(item.id, item.root, item.identity);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) await load();
      throw failure;
    }
    removing = undefined;
    notice = "Workspace deleted. Chat history and uploads were kept.";
    await load();
  }
</script>

{#if workspaces.length > 0 || error || notice}
  <section aria-label="Removed managed workspaces">
    <div class="heading">
      <h3 class="h3">Removed managed workspaces</h3>
      <button class="b sm" disabled={loading} onclick={load}>{loading ? "Refreshing…" : "Refresh workspaces"}</button>
    </div>
    <p class="sub">Project removal kept these files. Deleting a workspace is a separate, permanent action.</p>
    {#if error}<div class="callout er" role="alert">Couldn't load workspaces: {error}</div>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#each workspaces as workspace (workspace.id)}
      <div class="workspace">
        <div class="details">
          <strong>{workspace.name}</strong>
          <div class="mono path">{workspace.root}</div>
          {#if workspace.pending}<div class="setd">Interrupted deletion. Retry to inspect and finish it.</div>{/if}
          {#if workspace.problem}<p class="problem">{workspace.problem}</p>{/if}
        </div>
        <button
          class="b dz sm"
          aria-label={`${workspace.pending ? "Retry deleting" : "Delete workspace"} ${workspace.name}`}
          disabled={loading || workspace.identity === null}
          onclick={() => (removing = { ...workspace })}
        >
          {workspace.pending ? "Retry deletion…" : "Delete workspace…"}
        </button>
      </div>
    {/each}
    {#if truncated}<p class="sub">
        Showing the 100 most recently removed workspaces. Refresh after deleting to see more.
      </p>{/if}
  </section>
{/if}

{#if removing}
  <ConfirmRemoval
    title={`Delete workspace “${removing.name}”?`}
    description="Permanently deletes all files currently in this managed workspace, including changes made since this dialog opened. This cannot be undone. Chat history and uploads stay on the server. External folders are never deleted."
    detail={removing.root}
    confirmLabel="Delete workspace"
    busyLabel="Deleting…"
    onCancel={() => (removing = undefined)}
    onConfirm={purge}
  />
{/if}

<style>
  section {
    margin-top: 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  h3,
  p {
    margin: 0;
  }
  .workspace {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px 0;
    border-top: 1px solid var(--line);
  }
  .details {
    flex: 1 1 240px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .path,
  .problem {
    overflow-wrap: anywhere;
    font-size: 12px;
    color: var(--tx2);
  }
  .problem {
    color: var(--wa);
  }
</style>
