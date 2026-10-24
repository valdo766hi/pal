<script lang="ts">
  import { onMount, tick } from "svelte";
  import { api, ApiError } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import PalMark from "../lib/PalMark.svelte";
  import {
    app,
    defaultReady,
    providerReady,
    refreshChatGPT,
    refreshProviders,
    savedDefault,
  } from "../lib/state.svelte.ts";
  import ChatGPTConnection from "./ChatGPTConnection.svelte";
  import DefaultModel from "./DefaultModel.svelte";
  import McpSettings from "./McpSettings.svelte";
  import ProviderConnection from "./ProviderConnection.svelte";
  import WorkspaceCleanup from "./WorkspaceCleanup.svelte";

  let { onCreateProject }: { onCreateProject: () => void } = $props();
  type Step = "choose" | "connect" | "model" | "internet" | "project";
  /** Starts from what is saved, so a reload or restart resumes; undefined while loading. */
  let step: Step | undefined = $state();
  let reviewed: boolean | undefined = $state();
  let chosen: string | undefined = $state();
  let busy = $state(false);
  let error: string | undefined = $state();
  let failure: string | undefined = $state();
  let content: HTMLDivElement | undefined = $state();

  const STEPS = ["Provider", "Model", "Internet tools", "First project"];
  const at = $derived({ choose: 0, connect: 0, model: 1, internet: 2, project: 3 }[step ?? "choose"]);
  const options = $derived([
    {
      id: "openai",
      name: "ChatGPT",
      method: "Subscription sign-in",
      billing: "Counts against your ChatGPT plan's usage limits.",
      status: app.chatgpt?.account != null ? "Connected" : undefined,
    },
    ...(app.providers?.providers ?? []).map((provider) => ({
      id: provider.id,
      name: provider.id === "compatible" ? "OpenAI-compatible endpoint" : provider.name,
      method: provider.id === "compatible" ? "Custom endpoint" : "API key",
      billing: provider.billing,
      status: provider.enabled ? "Enabled" : providerReady(provider) ? "Ready · off" : undefined,
    })),
  ]);
  const option = $derived(options.find((entry) => entry.id === chosen));
  const view = $derived(app.providers?.providers.find((entry) => entry.id === chosen));
  const connected = $derived(
    chosen === "openai" ? app.chatgpt?.account != null : view !== undefined && providerReady(view),
  );
  const modelChosen = $derived(defaultReady() && savedDefault()?.provider === chosen);

  async function load() {
    error = undefined;
    try {
      const [mcp, setup] = await Promise.all([
        api.mcp(),
        api.modelSetup(),
        app.providers === undefined ? refreshProviders() : undefined,
        app.chatgpt === undefined ? refreshChatGPT() : undefined,
      ]);
      reviewed = !mcp.review;
      chosen = savedDefault()?.provider;
      step = !defaultReady() && !setup.deferred ? "choose" : reviewed ? "project" : "internet";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  onMount(() => void load());

  /** Moves to a step and puts keyboard focus on its heading. */
  async function go(next: Step) {
    failure = undefined;
    step = next;
    await tick();
    const heading = content?.querySelector("h2");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus();
  }

  async function defer(deferred: boolean) {
    busy = true;
    failure = undefined;
    try {
      await api.deferModelSetup(deferred);
      await go(deferred ? (reviewed ? "project" : "internet") : "choose");
    } catch (cause) {
      failure = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  /** Continuing with an API-key provider is the owner's choice to use it, so it is enabled here. */
  async function connect() {
    if (view !== undefined && !view.enabled) {
      busy = true;
      failure = undefined;
      try {
        app.providers = await api.providerEnabled(view.id, true);
      } catch (cause) {
        failure = cause instanceof ApiError ? cause.message : String(cause);
        return;
      } finally {
        busy = false;
      }
    }
    await go("model");
  }
</script>

<header class="brand">
  <PalMark size={22} cutout="var(--bg1)" /><span class="wordmark">pal</span>
</header>
<section aria-label="Set up Pal">
  <h1 class="sr">Welcome to Pal</h1>
  <ol aria-label="Setup steps">
    {#each STEPS as label, index (label)}
      <li aria-current={index === at ? "step" : undefined}>{label}</li>
    {/each}
  </ol>
  <div class="content" bind:this={content}>
    {#if error !== undefined}
      <div class="callout er" role="alert">Couldn't load setup: {error}</div>
      <div><button class="b" onclick={load}>Try again</button></div>
    {:else if step === undefined}
      <p role="status">Loading setup…</p>
    {:else if step === "choose"}
      <hgroup>
        <h2 class="h2">Connect a model provider</h2>
        <p class="sub">Choose the provider you want to use with Pal.</p>
      </hgroup>
      <div class="choices" role="radiogroup" aria-label="Model provider">
        {#each options as entry (entry.id)}
          <label class="choice">
            <input type="radio" name="provider" value={entry.id} bind:group={chosen} disabled={busy} />
            <span class="what">
              <span class="line">
                <strong>{entry.name}</strong><span class="method">{entry.method}</span>
                {#if entry.status !== undefined}<span class="status" class:ok={entry.status !== "Ready · off"}
                    >{entry.status}</span
                  >{/if}
              </span>
              <span class="billing">{entry.billing}</span>
            </span>
            <span class="dot" aria-hidden="true"></span>
          </label>
        {/each}
      </div>
      {#if failure !== undefined}<div class="callout er" role="alert">{failure}</div>{/if}
      <div class="nav">
        <span class="later">You can add more later in Settings.</span>
        <button class="b q" disabled={busy} onclick={() => defer(true)}>Set up later</button>
        <button class="b p" disabled={option === undefined || busy} onclick={() => go("connect")}>Continue</button>
      </div>
    {:else if step === "connect" && option !== undefined}
      <hgroup>
        <h2 class="h2">Connect {option.name}</h2>
        <p class="sub">
          {#if chosen === "openai"}
            Sign in with your ChatGPT account in your browser. Pal never sees your ChatGPT password.
          {:else if chosen === "compatible"}
            Describe a server that speaks OpenAI's chat completions API, such as a model server on your network.
          {:else}
            Paste an API key from {option.name}. Pal stores it encrypted on this server and never shows it again.
          {/if}
        </p>
      </hgroup>
      {#if chosen === "openai"}
        <ChatGPTConnection />
      {:else if view !== undefined}
        <ProviderConnection provider={view} switchable={false} />
        {#if !view.enabled}<p class="setd">Continue turns on {view.name} for chats.</p>{/if}
      {/if}
      {#if failure !== undefined}<div class="callout er" role="alert">{failure}</div>{/if}
      <div class="nav">
        <button class="b q" onclick={() => go("choose")}><Icon name="chevL" />Back</button>
        <button class="b p" disabled={!connected || busy} onclick={connect}>Continue</button>
      </div>
    {:else if step === "model" && option !== undefined && chosen !== undefined}
      <hgroup>
        <h2 class="h2">Choose a model</h2>
        <p class="sub">
          New chats start with the model you choose from {view?.name ?? option.name}. You can switch models in any chat.
        </p>
      </hgroup>
      <p class="setd">
        {option.billing} Sending a message shares it and the selected conversation history with
        {chosen === "compatible" ? view?.config?.baseUrl : option.name}. Chat history is not sent until you send a
        message.
      </p>
      <DefaultModel provider={chosen} />
      <div class="nav">
        <button class="b q" onclick={() => go("connect")}><Icon name="chevL" />Back</button>
        <button class="b p" disabled={!modelChosen} onclick={() => go(reviewed ? "project" : "internet")}
          >Continue</button
        >
      </div>
    {:else if step === "internet"}
      <McpSettings
        onReviewed={() => {
          reviewed = true;
          void go("project");
        }}
      />
    {:else if step === "project"}
      <hgroup>
        <h2 class="h2">Create your first project</h2>
        <p class="sub">Give Pal a managed workspace or choose an existing folder on this server.</p>
      </hgroup>
      {#if !defaultReady()}
        <div class="callout wa" role="status">
          Model setup is deferred. Send stays disabled until you connect a provider and explicitly choose a usable
          model. You can return here or open Settings → Models after creating a project.
        </div>
        {#if failure !== undefined}<div class="callout er" role="alert">{failure}</div>{/if}
        <div><button class="b q" disabled={busy} onclick={() => defer(false)}>Set up a model</button></div>
      {/if}
      <div>
        <button class="b p" disabled={busy} onclick={onCreateProject}><Icon name="folderPlus" />Create project</button>
      </div>
      <WorkspaceCleanup />
    {/if}
  </div>
</section>

<style>
  .brand {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 20px clamp(16px, 4vw, 32px);
  }
  .wordmark {
    font-family: var(--display);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.04em;
  }
  section {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    gap: 18px;
    overflow: auto;
    padding: 100px max(16px, calc((100% - 568px) / 2)) 48px;
    background: var(--bg1);
  }
  ol {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--tx3);
  }
  li::before {
    content: "";
    height: 3px;
    border-radius: 2px;
    background: var(--line2);
  }
  [aria-current="step"] {
    color: var(--tx);
  }
  [aria-current="step"]::before {
    background: var(--primary);
  }
  .content {
    display: flex;
    flex-direction: column;
    gap: 28px;
  }
  .content :global(h2:focus) {
    outline: none;
  }
  hgroup {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
  }
  hgroup :global(.h2) {
    font-family: var(--display);
    font-size: 30px;
    line-height: 1.1;
    font-weight: 650;
    letter-spacing: -0.025em;
  }
  hgroup :global(.sub) {
    font-size: 15px;
    color: var(--tx2);
  }
  .choices {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--side);
    overflow: hidden;
  }
  /* The native radio covers its row invisibly, so pointer, keyboard and assistive tech all reach it. */
  .choice {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    cursor: pointer;
    transition: background-color var(--fast) var(--ease);
  }
  .choice + .choice {
    border-top: 1px solid var(--line);
  }
  .choice input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .choice:hover {
    background: var(--bg2);
  }
  .choice:has(:checked) {
    background: color-mix(in srgb, var(--ac) 4%, var(--bg2));
  }
  .choice:has(:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  .what {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .line strong {
    font-size: 14.5px;
    font-weight: 550;
  }
  .method,
  .status {
    font-size: 12px;
    color: var(--tx3);
  }
  .status.ok {
    color: var(--ok);
  }
  .billing {
    font-size: 13px;
    color: var(--tx2);
  }
  .dot {
    width: 18px;
    height: 18px;
    flex: none;
    border: 1.5px solid var(--line3);
    border-radius: 50%;
  }
  .choice:has(:checked) .dot {
    border: 5px solid var(--primary);
    background: var(--tx);
  }
  .nav {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .later {
    flex: 1;
    font-size: 13.5px;
    color: var(--tx3);
  }
  .nav .b.p {
    height: 40px;
    padding: 0 20px;
    border-radius: 10px;
    font-size: 15px;
  }
</style>
