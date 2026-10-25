<script lang="ts">
  import { onMount } from "svelte";
  import OwnerGate from "./components/OwnerGate.svelte";
  import Workspace from "./components/Workspace.svelte";
  import { api, type Session, signedOut } from "./lib/api.ts";
  import { shownTheme } from "./lib/state.svelte.ts";
  import { drafts } from "./lib/drafts.svelte.ts";

  let session: Session | undefined = $state();
  let failure: string | undefined = $state();

  async function load() {
    try {
      session = await api.session();
      failure = undefined;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  onMount(() => {
    void load();
    const ended = () => {
      drafts.clear();
      if (session !== undefined) session = { ...session, signedIn: false };
    };
    signedOut.addEventListener("signed-out", ended);
    return () => signedOut.removeEventListener("signed-out", ended);
  });

  $effect(() => {
    const theme = shownTheme();
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "light" ? "#f4f4f5" : "#141517");
  });

  async function signOut() {
    drafts.clear();
    await api.signOut().catch(() => {});
    await load();
  }
</script>

{#if session === undefined}
  <div class="loading">
    {#if failure === undefined}
      <span class="ring spin" aria-hidden="true"></span><span>Connecting to Pal…</span>
    {:else}
      <div class="callout er" role="alert">Pal's server isn't reachable: {failure}</div>
      <button class="b" onclick={load}>Try again</button>
    {/if}
  </div>
{:else if !session.signedIn}
  <OwnerGate {session} onSignedIn={load} />
{:else}
  <Workspace onSignOut={signOut} />
{/if}

<style>
  .loading {
    height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 16px;
    color: var(--tx2);
    background: var(--bg1);
  }
</style>
