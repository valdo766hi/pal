<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type InstructionInfo, type InstructionSettings } from "../lib/api.ts";

  let { chatId }: { chatId: string } = $props();
  let info: InstructionInfo | undefined = $state.raw();
  let draft: InstructionSettings | undefined = $state();
  let globalFile = $state("");
  let error: string | undefined = $state();
  let saving = $state(false);
  let generation = 0;

  async function load(id: string, signal?: AbortSignal) {
    const current = ++generation;
    try {
      const value = await api.instructions(id, signal);
      if (current === generation && id === chatId) {
        info = value;
        error = undefined;
      }
    } catch (failure) {
      if (current === generation && !signal?.aborted) error = String(failure);
    }
  }
  onMount(() => {
    const controller = new AbortController();
    void load(chatId, controller.signal);
    return () => {
      generation++;
      controller.abort();
    };
  });
  function edit() {
    if (info === undefined) return;
    draft = { ...info.settings, disabled: [...info.settings.disabled] };
    globalFile = draft.globalFile ?? "";
  }
  async function save() {
    if (draft === undefined || saving) return;
    const id = chatId;
    const current = generation;
    const settings = { ...draft, disabled: [...draft.disabled], globalFile: globalFile.trim() || null };
    saving = true;
    error = undefined;
    try {
      const value = await api.configureInstructions(id, settings);
      if (id === chatId && current === generation) {
        info = value;
        draft = undefined;
      }
    } catch (failure) {
      if (id === chatId && current === generation) {
        error =
          failure instanceof ApiError && failure.status === 409
            ? "Your source settings draft is retained. Refresh sources, then explicitly reload the current settings before saving."
            : String(failure);
      }
    } finally {
      if (id === chatId && current === generation) saving = false;
    }
  }
  function disable(path: string, disabled: boolean) {
    if (draft === undefined) return;
    draft.disabled = disabled
      ? [...new Set([...draft.disabled, path])]
      : draft.disabled.filter((value) => value !== path);
  }
</script>

<section aria-label="Scoped instruction sources">
  <div class="row">
    <h3 class="h3 grow">Scoped instruction sources</h3>
    <button class="b sm q" onclick={() => load(chatId)} disabled={saving}>Refresh sources</button>
  </div>
  <p class="sub">
    Global means the account running Pal on the host, not this device. Root AGENTS.md guidance loads before each
    request; nested guidance applies only to its directory and descendants. Core policy, your current request and grants
    take precedence. These settings apply to this project. No scripts run when instructions load.
  </p>
  {#if error}<p class="callout er" role="alert">{error}</p>{/if}
  {#if info === undefined}<p class="sub" role="status">Loading instruction sources…</p>
  {:else}
    <p class="sub">
      Current files, not a reconstruction of an earlier request. Inspect the prepared prompt below for retained request
      bytes. Limits: {info.limits.fileBytes.toLocaleString()} bytes per file, {info.limits.contextBytes.toLocaleString()}
      bytes of source context,
      {info.limits.scopes} nested scopes and {info.limits.sources} sources.
    </p>
    {#each info.current.diagnostics as diagnostic (diagnostic)}<p class="callout wa">{diagnostic}</p>{/each}
    {#each info.current.sources as source (source.path)}
      <details>
        <summary>{source.scope} · {source.directory} · {source.state}</summary>
        <p class="mono sub">{source.path}</p>
        {#if source.sha256}<p class="mono sub">sha256: {source.sha256}</p>{/if}
        {#if source.diagnostic}<p class="callout wa">{source.diagnostic}</p>{/if}
        {#if source.text !== null}<pre class="mono">{source.text}</pre>{/if}
      </details>
    {:else}<p class="sub">No enabled instruction sources.</p>{/each}
    {#if draft === undefined}
      <button class="b sm q" onclick={edit}>Configure instruction sources</button>
    {:else}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={saving}>
          <label class="fl"
            >Global instructions file on the host
            <input class="f mono" maxlength="4096" bind:value={globalFile} />
          </label>
          <p class="sub">
            Leave empty to disable global instructions for this project. ~/.agents/AGENTS.md is the default; ~/AGENTS.md
            is used only when explicitly configured. There is no fallback to a different file.
          </p>
          <label class="sub"
            ><input type="checkbox" bind:checked={draft.project} /> Load project and nested AGENTS.md files</label
          >
          {#each info.current.sources as source (source.path)}
            <label class="sub"
              ><input
                type="checkbox"
                checked={draft.disabled.includes(source.path)}
                onchange={(event) => disable(source.path, event.currentTarget.checked)}
              />
              Disable {source.path}</label
            >
          {/each}
          {#if draft.disabled.some((path) => !info?.current.sources.some((source) => source.path === path))}
            <label class="fl"
              >Disabled source paths (one absolute path per line)
              <textarea
                class="f mono"
                rows="3"
                value={draft.disabled.join("\n")}
                onchange={(event) => {
                  if (draft) draft.disabled = event.currentTarget.value.split("\n").filter(Boolean);
                }}></textarea>
            </label>
          {/if}
          <div class="row end">
            <button
              class="b sm q"
              type="button"
              onclick={() => {
                draft = undefined;
              }}>Cancel source edit</button
            >
            <button class="b sm q" type="button" onclick={edit}>Reload current source settings</button>
            <button class="b sm p" type="submit">Save instruction sources</button>
          </div>
        </fieldset>
      </form>
    {/if}
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
  details {
    overflow-wrap: anywhere;
  }
  summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--tx2);
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 220px;
    overflow: auto;
    font-size: 12px;
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
