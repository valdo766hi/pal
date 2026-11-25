<script lang="ts">
  import { api, ApiError } from "../lib/api.ts";
  import { app, refreshChatGPT, savedDefault } from "../lib/state.svelte.ts";

  /** One provider's models for new chats; choosing one saves it as the default at once. */
  let { provider }: { provider: string } = $props();

  const SHOWN = 50;
  let query = $state("");
  let busy = $state(false);
  let error: string | undefined = $state();
  const chatgpt = $derived(provider === "openai");
  const name = $derived(
    chatgpt ? "ChatGPT" : (app.providers?.providers.find((entry) => entry.id === provider)?.name ?? provider),
  );
  const models = $derived(
    chatgpt
      ? (app.chatgpt?.models ?? []).map((model) => ({
          id: model.slug,
          name: model.displayName,
          supported: model.supported,
        }))
      : (app.providers?.providers.find((entry) => entry.id === provider)?.models ?? []).map((model) => ({
          id: model.id,
          name: model.name,
          supported: true,
        })),
  );
  const chosen = $derived(savedDefault()?.provider === provider ? savedDefault()?.modelId : undefined);
  const missing = $derived(
    chosen !== undefined && models.length > 0 && !models.some((model) => model.supported && model.id === chosen),
  );
  const matching = $derived.by(() => {
    const words = query.trim().toLowerCase();
    return words === "" ? models : models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(words));
  });

  async function choose(id: string) {
    busy = true;
    error = undefined;
    try {
      app.providers = await api.setDefault(provider, id);
      // Chats read the default from ChatGPT's state too.
      await refreshChatGPT();
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

{#if chatgpt && app.chatgpt?.modelsError}
  <div class="callout er" role="alert">Couldn't list your models: {app.chatgpt.modelsError}</div>
{:else if models.length === 0}
  <div class="callout wa" role="status">
    {name} offers no models Pal can use right now.{chatgpt ? "" : " Check its setup, then try again."}
  </div>
{/if}
{#if missing}
  <div class="callout wa" role="status">
    <span class="mono">{chosen}</span> isn't available from {name} anymore. Choose another model.
  </div>
{/if}
{#if models.length > 12}
  <input class="f" type="search" aria-label="Search models" placeholder="Search models" bind:value={query} />
{/if}
<div role="radiogroup" aria-label="Default model">
  {#each matching.slice(0, SHOWN) as model (model.id)}
    <label class="setrow model" class:off={!model.supported}>
      <span>
        <span class="setl">{model.name}</span>
        <span class="setd mono">
          {model.id}{model.supported ? "" : " · Pal doesn't know this model's capabilities yet"}
        </span>
      </span>
      <input
        type="radio"
        name={`default-model-${provider}`}
        checked={chosen === model.id}
        disabled={!model.supported || busy}
        onchange={() => choose(model.id)}
      />
    </label>
  {/each}
</div>
{#if matching.length > SHOWN}
  <p class="setd">Showing {SHOWN} of {matching.length} models. Search to find others.</p>
{:else if models.length > 0 && matching.length === 0}
  <p class="setd">No model matches “{query.trim()}”.</p>
{/if}
{#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}

<style>
  .model {
    cursor: pointer;
  }
  .model > span {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .model .mono {
    overflow-wrap: anywhere;
  }
  .off {
    cursor: default;
  }
  .off .setl {
    color: var(--tx2);
    font-weight: 500;
  }
</style>
