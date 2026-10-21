<script lang="ts">
  import type { CompatibleConfig } from "../lib/api.ts";

  let {
    config,
    busy,
    onSave,
  }: { config: CompatibleConfig | null; busy: boolean; onSave: (config: CompatibleConfig) => Promise<void> } = $props();
  /** The saved description as an editable copy; editing never changes the endpoint until Save. */
  function fromSaved() {
    return {
      name: config?.name ?? "",
      baseUrl: config?.baseUrl ?? "",
      models: config?.models.join("\n") ?? "",
      contextWindow: config?.contextWindow ?? 32_768,
      maxTokens: config?.maxTokens ?? 4096,
      images: config?.images ?? false,
      keyless: config?.keyless ?? false,
    };
  }
  let draft = $state(fromSaved());
  const models = $derived(
    draft.models
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
</script>

<p class="setd">
  Pal's server sends the chats that use this endpoint to the address below, which may be on your private network.
  Context window and output limits are what you enter here; Pal can't verify them.
</p>
<div class="grid">
  <label class="fl">Name<input class="f" bind:value={draft.name} maxlength="60" /></label>
  <label class="fl"
    >Base URL<input
      class="f mono"
      bind:value={draft.baseUrl}
      placeholder="http://127.0.0.1:11434/v1"
      autocomplete="off"
      spellcheck="false"
    /></label
  >
  <label class="fl wide"
    >Model IDs, one per line<textarea class="f mono" rows="3" bind:value={draft.models} spellcheck="false"
    ></textarea></label
  >
  <label class="fl"
    >Context window (tokens)<input class="f" type="number" min="1024" bind:value={draft.contextWindow} /></label
  >
  <label class="fl">Max output tokens<input class="f" type="number" min="1" bind:value={draft.maxTokens} /></label>
  <label class="flr"><input type="checkbox" bind:checked={draft.images} />Models accept images</label>
  <label class="flr"><input type="checkbox" bind:checked={draft.keyless} />This endpoint needs no key</label>
</div>
{#if config !== null && draft.baseUrl.trim().replace(/\/+$/, "") !== config.baseUrl}
  <p class="setd">Saving a new address turns this endpoint off and removes its saved key; enable it again to use it.</p>
{/if}
<div>
  <button
    class="b"
    disabled={busy || draft.name.trim() === "" || draft.baseUrl.trim() === "" || models.length === 0}
    onclick={() => onSave({ ...draft, models })}>Save endpoint</button
  >
</div>

<style>
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .wide {
    flex-basis: 100%;
  }
</style>
