<script lang="ts">
  import Icon from "../lib/Icon.svelte";
  import {
    app,
    chooseTheme,
    navigate,
    saveSetting,
    savedDefault,
    type SettingsTab,
    type Theme,
    viewport,
  } from "../lib/state.svelte.ts";
  import ChatGPTConnection from "./ChatGPTConnection.svelte";
  import DefaultModel from "./DefaultModel.svelte";
  import McpSettings from "./McpSettings.svelte";
  import ProviderSettings from "./ProviderSettings.svelte";
  import WorkspaceCleanup from "./WorkspaceCleanup.svelte";
  import ExtensionSettings from "./ExtensionSettings.svelte";
  import { api } from "../lib/api.ts";
  import { copyText } from "../lib/copy.ts";

  let { tab, onSignOut }: { tab: SettingsTab; onSignOut: () => void } = $props();

  const narrow = $derived(viewport() === "phone");
  const chosen = $derived(savedDefault());

  const themes: [Theme, string][] = [
    ["dark", "Dark"],
    ["light", "Light"],
    ["system", "System"],
  ];
  /** Radio-group keys: arrows move the choice, like a native radio set. */
  function themeKeys(event: KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const at = themes.findIndex(([id]) => id === app.theme);
    const next = themes[(at + step + themes.length) % themes.length];
    if (next === undefined) return;
    chooseTheme(next[0]);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-theme-option="${next[0]}"]`)?.focus();
  }

  let diagnostics: "idle" | "copying" | "copied" = $state("idle");
  let diagnosticsError: string | undefined = $state();
  async function copyDiagnostics() {
    diagnostics = "copying";
    diagnosticsError = undefined;
    try {
      if (!(await copyText(JSON.stringify(await api.diagnostics(), null, 2))))
        throw new Error("the browser refused to copy");
      diagnostics = "copied";
    } catch (failure) {
      diagnostics = "idle";
      diagnosticsError = failure instanceof Error ? failure.message : String(failure);
    }
  }

  const tabs = [
    { id: "general", label: "General", icon: "gear" },
    { id: "models", label: "Models", icon: "model" },
    { id: "mcp", label: "MCP servers", icon: "plug" },
    { id: "extensions", label: "Extensions", icon: "model" },
    { id: "pets", label: "Pets", icon: "paw" },
  ] as const;
</script>

<div class="settings" class:narrow>
  <nav aria-label="Settings sections">
    <div class="title">
      <button class="b i q tip start" aria-label="Back to chat" data-tip="Back to chat" onclick={() => history.back()}
        ><Icon name="chevL" /></button
      >
      <h1>Settings</h1>
    </div>
    {#each tabs as item (item.id)}
      <button class="row" aria-current={tab === item.id} onclick={() => navigate({ view: "settings", tab: item.id })}>
        <Icon name={item.icon} />{item.label}
      </button>
    {/each}
  </nav>
  <div class="content">
    <div class="column">
      {#if tab === "general"}
        <h2 class="h2">General</h2>
        <div>
          <div class="setrow">
            <label for="send-enter">
              <div class="setl">Send with Enter</div>
              <div class="setd">Shift+Enter adds a line. On phones, use the Send button.</div>
            </label>
            <input
              id="send-enter"
              class="swi"
              type="checkbox"
              role="switch"
              checked={app.sendWithEnter}
              onchange={(event) => {
                app.sendWithEnter = event.currentTarget.checked;
                saveSetting("pal.sendWithEnter", String(app.sendWithEnter));
              }}
            />
          </div>
          <div class="setrow">
            <div>
              <div class="setl" id="theme-label">Theme</div>
              <div class="setd">Saved in this browser. System follows this device's light or dark setting.</div>
            </div>
            <div class="seg" role="radiogroup" aria-labelledby="theme-label" tabindex="-1" onkeydown={themeKeys}>
              {#each themes as [id, label] (id)}
                <button
                  class="segb"
                  role="radio"
                  data-theme-option={id}
                  aria-checked={app.theme === id}
                  tabindex={app.theme === id ? 0 : -1}
                  onclick={() => chooseTheme(id)}>{label}</button
                >
              {/each}
            </div>
          </div>
          <div class="setrow">
            <div>
              <div class="setl">Owner session</div>
              <div class="setd">Signs this browser out of Pal. Model providers stay connected.</div>
            </div>
            <button class="b" onclick={onSignOut}>Sign out of Pal</button>
          </div>
          <div class="setrow">
            <div>
              <div class="setl">Diagnostics</div>
              <div class="setd">
                Copies Pal's version, states and counts for support. No keys, tokens, addresses, commands or chat
                contents.
              </div>
            </div>
            <button class="b" disabled={diagnostics === "copying"} onclick={copyDiagnostics}
              >{diagnostics === "copied" ? "Copied" : "Copy diagnostics"}</button
            >
          </div>
          {#if diagnosticsError !== undefined}
            <div class="callout er" role="alert">Couldn't copy diagnostics: {diagnosticsError}</div>
          {/if}
        </div>
        <WorkspaceCleanup />
      {:else if tab === "extensions"}
        <ExtensionSettings />
      {:else if tab === "pets"}
        {#await import("./PetSettings.svelte")}<p role="status">Loading pets…</p>
        {:then { default: PetSettings }}<PetSettings />
        {:catch failure}<p role="alert">Couldn't load pets: {String(failure)}</p>{/await}
      {:else if tab === "mcp"}
        <McpSettings />
      {:else}
        <h2 class="h2">Models</h2>
        <p class="sub">
          Connect the providers you want to use. Each is billed as shown, and Pal never falls back from one provider to
          another.
        </p>
        {#if chosen !== null}
          <p class="setd">
            New chats start with <span class="mono">{chosen.modelId}</span> on
            {chosen.provider === "openai"
              ? "ChatGPT"
              : (app.providers?.providers.find((entry) => entry.id === chosen.provider)?.name ?? chosen.provider)}.
            Change it with “Use for new chats” in a chat's model picker{app.chatgpt?.account
              ? ", or choose a ChatGPT model below"
              : ""}.
          </p>
        {/if}
        <h3 class="h3">Subscriptions</h3>
        <ChatGPTConnection />
        {#if app.chatgpt?.account}
          <h3 class="h3">ChatGPT model for new chats</h3>
          <DefaultModel provider="openai" />
        {/if}
        <ProviderSettings />
      {/if}
    </div>
  </div>
</div>

<style>
  .settings {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  nav {
    flex: 0 0 auto;
    width: 220px;
    border-right: 1px solid var(--line);
    padding: 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .narrow {
    flex-direction: column;
  }
  .narrow nav {
    width: auto;
    border-right: 0;
    border-bottom: 1px solid var(--line);
    flex-direction: row;
    overflow-x: auto;
    align-items: center;
  }
  .narrow nav .row {
    width: auto;
    flex: 0 0 auto;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 8px;
    flex: 0 0 auto;
  }
  .narrow .title {
    padding-bottom: 2px;
  }
  h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .content {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: 24px 20px 48px;
  }
  .narrow .content {
    padding: 24px 12px 48px;
  }
  .column {
    max-width: 760px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
</style>
