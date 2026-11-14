<script lang="ts">
  import { api, ApiError, type KeyCheck, type ProvidersState, type ProviderView } from "../lib/api.ts";
  import { app, providerReady } from "../lib/state.svelte.ts";
  import CompatibleEndpoint from "./CompatibleEndpoint.svelte";

  /** One API-key provider or endpoint. Without `switchable`, the caller decides when to enable it. */
  let { provider, switchable = true }: { provider: ProviderView; switchable?: boolean } = $props();

  let draft = $state("");
  let check: KeyCheck | undefined = $state();
  let busy = $state(false);
  let error: string | undefined = $state();
  const custom = $derived(provider.id === "compatible");
  const plugin = $derived(provider.plugin !== undefined);
  const keyless = $derived(provider.config?.keyless === true || plugin);
  const checkLabel = $derived(plugin ? "Check status" : keyless ? "Check endpoint" : "Check key");
  const ready = $derived(providerReady(provider));

  async function act(work: () => Promise<ProvidersState>): Promise<boolean> {
    busy = true;
    error = undefined;
    check = undefined;
    try {
      app.providers = await work();
      return true;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
      return false;
    } finally {
      busy = false;
    }
  }
  async function save() {
    if (await act(() => api.providerKey(provider.id, draft.trim()))) draft = "";
  }
  async function verify() {
    busy = true;
    error = undefined;
    try {
      check = (await api.providerCheck(provider.id)).check;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<div class="fold" role="group" aria-label={custom ? "OpenAI-compatible endpoint" : provider.name}>
  <div class="line">
    <strong>{provider.name}</strong><span class="pill"
      >{custom ? "Custom endpoint" : plugin ? "Plugin" : "API key"}</span
    >
    {#if provider.enabled}<span class="pill ok">Enabled</span>
    {:else if ready}<span class="pill">Ready · off</span>
    {:else}<span class="pill wa">Not set up</span>{/if}
  </div>
  <div class="setd">{provider.billing}</div>
  {#if custom}
    <CompatibleEndpoint
      config={provider.config ?? null}
      {busy}
      onSave={async (config) => {
        await act(() => api.providerCompatible(config));
      }}
    />
  {/if}
  {#if !keyless}<label class="fl key">
      {provider.hasKey ? "Replace API key" : "API key"}
      <input
        class="f mono"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder={provider.hasKey ? "Saved key hidden" : "Paste your key"}
        bind:value={draft}
      />
    </label>{/if}
  <div class="buttons">
    {#if !keyless}<button class="b" disabled={busy || draft.trim() === ""} onclick={save}>Save key</button>{/if}
    {#if provider.hasKey}
      <button class="b q" disabled={busy} onclick={() => act(() => api.providerKey(provider.id, null))}
        >Remove key</button
      >
    {/if}
    {#if provider.checkable && ready}
      <button class="b q" disabled={busy} onclick={verify}>{checkLabel}</button>
    {/if}
    {#if provider.keys !== null}<a class="b q" href={provider.keys} target="_blank" rel="noopener noreferrer"
        >Get a key</a
      >{/if}
  </div>
  {#if ready && check === undefined && !plugin}
    <div class="setd">
      {keyless ? "Endpoint saved, not checked." : "Key saved, not checked."}
      {provider.checkable
        ? `${keyless ? "Check endpoint" : "Check key"} asks ${provider.name} without a model request.`
        : `${provider.name} has no free key check, so your first message tests it.`}
    </div>
  {/if}
  {#if switchable}
    <div class="setrow">
      <label for={`provider-${provider.id}`}>
        <div class="setl">Use {provider.name} in chats</div>
        <div class="setd">
          {provider.enabled
            ? `${provider.models.length} models in the chat model picker.`
            : ready
              ? "Off. Chats can't send to it."
              : custom
                ? "Describe the endpoint, and save a key unless it needs none."
                : "Save a key first."}
        </div>
      </label>
      <input
        id={`provider-${provider.id}`}
        class="swi"
        type="checkbox"
        role="switch"
        checked={provider.enabled}
        disabled={!ready || busy}
        onchange={(event) => act(() => api.providerEnabled(provider.id, event.currentTarget.checked))}
      />
    </div>
  {/if}
  {#if check !== undefined}
    <div class="callout" class:ac={check.ok} class:wa={!check.ok} role="status">{check.detail}</div>
  {/if}
  {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
</div>

<style>
  /* Shared fields grow in rows; in this column card they keep their natural height. */
  .key {
    flex: 0 0 auto;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .buttons {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  a.b {
    text-decoration: none;
  }
</style>
