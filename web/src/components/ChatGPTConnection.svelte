<script lang="ts">
  import { api, ApiError, type ChatGPTState } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import { app, refreshChatGPT } from "../lib/state.svelte.ts";

  let paste = $state("");
  let busy = $state(false);
  let error: string | undefined = $state();
  const chatgpt = $derived(app.chatgpt);
  const attempt = $derived(chatgpt?.attempt);
  const waiting = $derived(attempt?.state === "waiting" || attempt?.state === "verifying");

  const failures: Record<string, string> = {
    denied: "Sign-in was declined in ChatGPT.",
    plan_not_enabled:
      "ChatGPT plan use wasn't granted to Pal, so it can't send messages with your subscription. Sign in again and allow plan use.",
    account_changed:
      "ChatGPT signed in a different account than this connection's. Sign in with the same account, or forget this connection first.",
    reauthorize: "That sign-in can't be used anymore. Start again.",
    invalid_response: "ChatGPT's answer couldn't be verified, so nothing was saved.",
    port_in_use: "Port 1455 on the server is in use, probably by another sign-in. Finish or cancel it, then try again.",
  };

  $effect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refreshChatGPT(), 1000);
    return () => clearInterval(timer);
  });

  async function act(work: () => Promise<ChatGPTState>) {
    busy = true;
    error = undefined;
    try {
      app.chatgpt = await work();
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<div class="fold" role="group" aria-label="ChatGPT">
  <div class="line">
    <strong>ChatGPT</strong><span class="pill">Subscription sign-in</span>
    {#if chatgpt?.account}<span class="pill ok">Connected</span>
    {:else if waiting}<span class="pill ac">Signing in</span>
    {:else}<span class="pill wa">Not signed in</span>{/if}
  </div>
  {#if chatgpt?.account}
    <div class="setd">
      Signed in as <span class="mono">{chatgpt.account.email ?? chatgpt.account.accountId}</span>. Usage counts against
      that account's ChatGPT limits.
    </div>
    <div>
      <button class="b sm" onclick={() => act(api.chatgptSignOut)} disabled={busy}>Sign out of ChatGPT</button>
    </div>
  {:else if attempt?.state === "waiting"}
    <div class="callout ac">
      <strong>Continue in your browser.</strong> Sign in to ChatGPT and allow Pal to use your plan.
    </div>
    {#if attempt.authUrl}
      <div>
        <a class="b p" href={attempt.authUrl} target="_blank" rel="noopener noreferrer">
          <Icon name="globe" />Open ChatGPT sign-in
        </a>
      </div>
    {/if}
    <label class="fl paste">
      If the browser ends on a page that won't load (for example on a phone), paste its address here:
      <input
        class="f mono"
        bind:value={paste}
        placeholder="http://127.0.0.1:1455/auth/callback?…"
        autocomplete="off"
        spellcheck="false"
      />
    </label>
    <div class="buttons">
      <button
        class="b"
        onclick={() => act(() => api.chatgptPaste(paste.trim()))}
        disabled={busy || paste.trim() === ""}
      >
        Submit address
      </button>
      <button class="b q" onclick={() => act(api.chatgptCancel)} disabled={busy}>Cancel</button>
    </div>
  {:else if attempt?.state === "verifying"}
    <div class="status"><span class="ring spin" aria-hidden="true"></span>Verifying your ChatGPT account…</div>
  {:else}
    {#if attempt?.state === "failed" && attempt.error}
      <div class="callout er" role="alert">{failures[attempt.error.code] ?? attempt.error.message}</div>
    {/if}
    <div class="setd">
      Sign-in opens ChatGPT in your browser. Pal stores the tokens encrypted on this server; they never reach this page.
    </div>
    <div>
      <button class="b p" onclick={() => act(api.chatgptSignIn)} disabled={busy}>Sign in with ChatGPT</button>
    </div>
  {/if}
  {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
</div>

<style>
  /* Shared fields grow in rows; in this column card they keep their natural height. */
  .paste {
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
  .status {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    color: var(--tx2);
  }
  a.b {
    text-decoration: none;
  }
</style>
