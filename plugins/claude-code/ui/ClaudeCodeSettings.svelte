<script lang="ts">
  import { api } from "../../../web/src/lib/api.ts";
  import { navigate } from "../../../web/src/lib/state.svelte.ts";

  type Settings = { command: string; configDir: string | null; allowUsageCredits: boolean };
  type Status = {
    ready: boolean;
    detail: string;
    installed: boolean;
    loggedIn: boolean;
    version?: string;
    plan?: string;
    authMethod?: string;
  };
  let saved: Settings | undefined = $state.raw();
  let command = $state("");
  let configDir = $state("");
  let allowUsageCredits = $state(false);
  let status: Status | undefined = $state.raw();
  let busy = $state(false);
  let notice: string | undefined = $state();
  let failure: string | undefined = $state();

  function show(next: Settings) {
    saved = next;
    command = next.command;
    configDir = next.configDir ?? "";
    allowUsageCredits = next.allowUsageCredits;
  }
  void api.plugin<Settings>("claude-code", "GET", "settings").then(show, (error: unknown) => (failure = String(error)));
  async function act(work: () => Promise<void>) {
    busy = true;
    notice = undefined;
    try {
      await work();
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
  const save = () =>
    act(async () => {
      show(
        await api.plugin<Settings>("claude-code", "PUT", "settings", {
          command: command.trim(),
          configDir: configDir.trim() === "" ? null : configDir.trim(),
          allowUsageCredits,
        }),
      );
      notice = "Saved. New requests use these settings.";
    });
  const check = () =>
    act(async () => {
      status = await api.plugin<Status>("claude-code", "POST", "status");
    });
</script>

<h2 class="h2">Claude Code <span class="pill wa">Experimental</span></h2>
<p class="sub">
  Use your own Claude Pro or Max subscription for chats through the official Claude Code CLI on this server. Pal never
  offers a Claude login and never reads or stores Claude Code's credentials. Usage counts against your plan's limits; it
  is not separate or unlimited.
</p>
<div class="callout wa">
  Before enabling it, read Anthropic's <a
    href="https://code.claude.com/docs/en/legal-and-compliance"
    target="_blank"
    rel="noopener noreferrer">legal and compliance terms</a
  >: subscription logins are for ordinary use of Claude Code, and Anthropic may treat these requests as third-party use
  and charge them to usage credits.
</div>
{#if failure !== undefined}
  <p class="callout er" role="alert">Couldn't load the settings: {failure}</p>
{:else if saved === undefined}
  <p role="status">Loading…</p>
{:else}
  <section aria-labelledby="claude-status">
    <h3 class="h3" id="claude-status">Status</h3>
    <p class="setd">
      Checking runs <span class="mono">claude auth status</span> once. To sign in, open Terminal and run
      <span class="mono">claude auth login</span>; Pal never starts a login itself.
    </p>
    <div class="buttons">
      <button class="b" disabled={busy} onclick={check}>Check status</button>
      <button class="b q" onclick={() => navigate({ view: "settings", tab: "models" })}>Enable in Models</button>
    </div>
    {#if status !== undefined}
      <dl class="facts" role="status">
        <dt>Installed</dt>
        <dd>{status.installed ? `Yes${status.version === undefined ? "" : ` · ${status.version}`}` : "No"}</dd>
        <dt>Logged in</dt>
        <dd>{status.loggedIn ? "Yes" : "No"}</dd>
        {#if status.loggedIn}<dt>Login</dt>
          <dd>{status.plan === undefined ? (status.authMethod ?? "Unknown") : `Claude ${status.plan}`}</dd>{/if}
      </dl>
      <p class="callout" class:ac={status.ready} class:wa={!status.ready}>{status.detail}</p>
    {/if}
  </section>
  <section aria-labelledby="claude-command">
    <h3 class="h3" id="claude-command">Command</h3>
    <label class="fl key"
      >Claude Code command or absolute path<input
        class="f mono"
        autocomplete="off"
        spellcheck="false"
        bind:value={command}
      /></label
    >
    <label class="fl key"
      >Config directory (optional)<input
        class="f mono"
        autocomplete="off"
        spellcheck="false"
        placeholder="Claude Code's default"
        bind:value={configDir}
      /></label
    >
    <div class="setrow">
      <label for="claude-credits">
        <div class="setl">Allow usage credits</div>
        <div class="setd">Off: Pal stops a reply Anthropic would charge to usage credits instead of your plan.</div>
      </label>
      <input id="claude-credits" class="swi" type="checkbox" role="switch" bind:checked={allowUsageCredits} />
    </div>
    <div class="buttons"><button class="b" disabled={busy} onclick={save}>Save</button></div>
    {#if notice !== undefined}<p class="callout" role="status">{notice}</p>{/if}
  </section>
{/if}

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 20px;
  }
  .key {
    flex: 0 0 auto;
  }
  .buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    margin: 4px 0;
    font-size: 13px;
  }
  .facts dt {
    color: var(--tx3);
  }
  .facts dd {
    margin: 0;
  }
</style>
