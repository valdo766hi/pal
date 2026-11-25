<script lang="ts">
  import { api, ApiError, type Session } from "../lib/api.ts";
  import PalMark from "../lib/PalMark.svelte";
  import { app } from "../lib/state.svelte.ts";

  let { session, onSignedIn }: { session: Session; onSignedIn: () => void } = $props();

  // The setup token arrives in the URL fragment, which the browser never sends to a server.
  const setupToken = $derived(new URLSearchParams(app.hash.replace(/^#/, "")).get("setup") ?? undefined);
  let passphrase = $state("");
  let confirm = $state("");
  let busy = $state(false);
  let error: string | undefined = $state();

  const messages: Record<string, string> = {
    invalid_setup: "This setup link is no longer valid. Use the newest link printed in Pal's terminal.",
    weak_passphrase: "Use at least 12 characters.",
    wrong_passphrase: "That passphrase is not correct.",
    throttled: "Too many attempts. Wait a few minutes, then try again.",
    exists: "This Pal already has an owner. Sign in instead.",
  };

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = undefined;
    if (!session.owner && passphrase !== confirm) {
      error = "The two passphrases differ.";
      return;
    }
    busy = true;
    try {
      if (session.owner) await api.signIn(passphrase);
      else await api.setup(setupToken ?? "", passphrase);
      history.replaceState(null, "", location.pathname);
      onSignedIn();
    } catch (failure) {
      error = failure instanceof ApiError ? (messages[failure.code] ?? failure.message) : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<div class="gate">
  {#if !session.owner && setupToken === undefined}
    <div class="head">
      <PalMark size={56} cutout="var(--bg1)" />
      <h1>Pal isn't set up yet</h1>
      <p>
        Open the setup link printed in the terminal where <code class="code">pal</code> is running. Only someone who can see
        that terminal can claim this Pal.
      </p>
    </div>
  {:else}
    <div class="head">
      <PalMark size={56} cutout="var(--bg1)" />
      <h1>{session.owner ? "Sign in to Pal" : "Set up Pal"}</h1>
      <p>
        {session.owner
          ? "Enter the owner's passphrase."
          : "Choose a passphrase for this Pal. You'll use it to sign in from any browser."}
      </p>
    </div>
    <form onsubmit={submit}>
      <label class="sr" for="passphrase">Passphrase</label>
      <input
        id="passphrase"
        class="f"
        type="password"
        placeholder="Passphrase"
        autocomplete={session.owner ? "current-password" : "new-password"}
        bind:value={passphrase}
        required
      />
      {#if !session.owner}
        <label class="sr" for="confirm">Confirm passphrase</label>
        <input
          id="confirm"
          class="f"
          type="password"
          placeholder="Confirm passphrase"
          autocomplete="new-password"
          bind:value={confirm}
          required
        />
      {/if}
      {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
      <button class="b p" type="submit" disabled={busy || passphrase === ""}>
        {session.owner ? "Sign in" : "Create owner"}
      </button>
    </form>
  {/if}
  <p class="foot">{location.host} · self-hosted · beta</p>
</div>

<style>
  .gate {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 28px;
    padding: 48px 16px;
    background: var(--bg1);
  }
  .head {
    max-width: 420px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
  }
  .head :global(.mark) {
    margin-bottom: 12px;
  }
  h1 {
    margin: 0;
    font-family: var(--display);
    font-size: 30px;
    font-weight: 650;
    letter-spacing: -0.025em;
  }
  .head p {
    margin: 0;
    color: var(--tx2);
  }
  form {
    width: 100%;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .f {
    height: 46px;
    padding: 0 14px;
    border-radius: var(--radius-md);
    background: var(--bg2);
    font-size: 15px;
  }
  .f[type="password"]:not(:placeholder-shown) {
    letter-spacing: 0.08em;
  }
  .b.p {
    height: 46px;
    border-radius: var(--radius-md);
    font-size: 15px;
  }
  .foot {
    margin: 0;
    font-size: 12.5px;
    color: var(--tx3);
  }
</style>
