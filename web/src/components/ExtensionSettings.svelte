<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type ExtensionScope } from "../lib/api.ts";
  import { app, refreshExtensions } from "../lib/state.svelte.ts";
  import ReleaseSettings from "./ReleaseSettings.svelte";

  let busy = $state(false);
  let error: string | undefined = $state();
  async function load() {
    error = undefined;
    try {
      await refreshExtensions();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  onMount(() => {
    void load();
  });
  async function toggle(id: ExtensionScope["selected"][number]["id"], enabled: boolean) {
    const view = app.extensions;
    if (view === undefined || busy) return;
    busy = true;
    error = undefined;
    const selected = view.catalog
      .filter((item) => (item.id === id ? enabled : view.selected.some((choice) => choice.id === item.id)))
      .map(({ id, version }) => ({ id, version }));
    try {
      app.extensions = await api.selectExtensions(selected, view.digest);
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<h2 class="h2">Extensions</h2>
<p class="sub">
  Compiled built-ins only, with explicit version pins. No marketplace, downloaded code or arbitrary page JavaScript.
</p>
<div class="callout ac">
  Defaults for new chats. Existing chats and active runs keep their selected versions, tools and panels. Start a new
  chat to use changed defaults. This never grants folders, internet tools, commands or browser control.
</div>
{#if error !== undefined}
  <div class="callout er" role="alert">{error}<button class="b sm" onclick={load}>Reload</button></div>
{/if}
{#if app.extensions}
  {#each app.extensions.catalog as item (item.id)}
    <div class="extension">
      <div class="details">
        <div class="heading">
          <strong>{item.name}</strong><span class="mono dim">v{item.version}</span><span class="pill"
            >Built-in · trusted code</span
          >
        </div>
        <p>{item.description}</p>
        <div class="fine">
          {#if item.panels.length > 0}Contributes: {item.panels.join(", ")} ·
          {/if}<span class="mono">{item.native}</span>
        </div>
      </div>
      <label class="choice">
        <span>New chats</span>
        <input
          class="swi"
          type="checkbox"
          role="switch"
          aria-label={`Enable ${item.name} for new chats`}
          checked={app.extensions.selected.some((choice) => choice.id === item.id)}
          disabled={busy}
          onchange={(event) => toggle(item.id, event.currentTarget.checked)}
        />
      </label>
    </div>
  {/each}
  <div class="callout">
    Owner authorization, storage, Code Mode policy, approval and instruction/preparation hooks cannot be disabled here.
    Native Pi records request pins; unfinished work requires its retained immutable release.
  </div>
  <p class="fine hash">Running implementation: <span class="mono">{app.extensions.release}</span></p>
{:else if error === undefined}<p role="status">Loading extensions…</p>{/if}
<ReleaseSettings />

<style>
  .extension {
    display: flex;
    gap: 16px;
    padding: 14px 0;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .details {
    flex: 1 1 300px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .heading {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  p {
    margin: 0;
    font-size: 13px;
    color: var(--tx2);
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--tx2);
  }
  .hash {
    overflow-wrap: anywhere;
  }
</style>
