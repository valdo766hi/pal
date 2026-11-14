<script lang="ts">
  import { api } from "../../../web/src/lib/api.ts";

  type Connection = "typesafe" | "openrouter";
  type Status = {
    connection: Connection;
    threshold: number;
    sent: string;
    connections: { id: Connection; label: string; bills: string; model: string; keySet: boolean }[];
    recent: {
      at: number;
      connection: Connection;
      model: string;
      command: string;
      verdict?: "run" | "ask";
      confidence?: number;
      tokens?: number;
      costUsd?: number;
      latencyMs: number;
      error?: string;
    }[];
  };
  let status: Status | undefined = $state.raw();
  let failure: string | undefined = $state();
  let draft = $state("");
  let busy = $state(false);
  let notice: string | undefined = $state();
  const selected = $derived(status?.connections.find((item) => item.id === status?.connection));
  const last = $derived(status?.recent[0]);

  async function load() {
    try {
      status = await api.plugin<Status>("jev", "GET", "status");
      failure = undefined;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  void load();
  async function act(work: () => Promise<unknown>, done?: (result: unknown) => string) {
    busy = true;
    notice = undefined;
    try {
      const result = await work();
      if (done !== undefined) notice = done(result);
      await load();
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
  const percent = (value: number) => `${Math.round(value * 100)}%`;
</script>

<h2 class="h2">Jev</h2>
<p class="sub">
  In Auto command mode, Jev judges each agent shell command: clearly routine ones run without asking. Anything else is
  not run on its own: the agent goes on without it when it can and asks you in its reply, or waits on the normal
  approval card. Commands that change privileges, push, publish, delete outside the folder or touch credentials always
  need you, without a Jev request. A guard, not a sandbox.
</p>
{#if failure !== undefined}
  <div class="callout er" role="alert">
    Couldn't load Jev: {failure}<button class="b sm" onclick={load}>Retry</button>
  </div>
{:else if status === undefined}
  <p role="status">Loading…</p>
{:else}
  <section aria-labelledby="jev-connection">
    <h3 class="h3" id="jev-connection">Connection</h3>
    <div class="choices" role="radiogroup" aria-label="Jev connection">
      {#each status.connections as item (item.id)}
        <label class="choice" class:on={status.connection === item.id}>
          <input
            type="radio"
            name="jev-connection"
            value={item.id}
            checked={status.connection === item.id}
            disabled={busy}
            onchange={() => act(() => api.plugin("jev", "PUT", "connection", { connection: item.id }))}
          />
          <span class="name">{item.label}{item.id === "typesafe" ? " (default)" : ""}</span>
          <span class="note">Bills {item.bills} · <span class="mono">{item.model}</span></span>
          <span class="note">{item.keySet ? "Key saved" : "No key"}</span>
        </label>
      {/each}
    </div>
    <p class="setd">
      Each connection keeps its own key. Switching never moves or reuses a key, and Pal never tries the other one.
    </p>
  </section>

  {#if selected !== undefined}
    <section aria-labelledby="jev-key">
      <h3 class="h3" id="jev-key">{selected.label} API key</h3>
      <label class="fl key"
        >{selected.keySet ? "Replace the key" : "Key"}
        <input
          class="f mono"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder={selected.keySet ? "Saved key hidden" : "Paste your key"}
          bind:value={draft}
        /></label
      >
      <p class="setd">Stored sealed on this server and never shown again.</p>
      <div class="buttons">
        <button
          class="b"
          disabled={busy || draft.trim().length < 8}
          onclick={() =>
            act(async () => {
              await api.plugin("jev", "PUT", `keys/${selected.id}`, { key: draft });
              draft = "";
            })}>Save key</button
        >
        {#if selected.keySet}
          <button
            class="b q"
            disabled={busy}
            onclick={() =>
              act(
                () => api.plugin("jev", "POST", `keys/${selected.id}/check`),
                (result) => (result as { detail: string }).detail,
              )}>{selected.id === "typesafe" ? "Check key (one billed test)" : "Check key"}</button
          >
          <button
            class="b q d"
            disabled={busy}
            onclick={() => act(() => api.plugin("jev", "DELETE", `keys/${selected.id}`))}>Remove</button
          >
        {/if}
      </div>
      {#if notice !== undefined}<p class="callout" role="status">{notice}</p>{/if}
    </section>
  {/if}

  <section aria-labelledby="jev-threshold">
    <h3 class="h3" id="jev-threshold">Threshold</h3>
    <label class="fl key"
      >Run without asking only when Jev is at least this sure
      <span class="buttons"
        ><input
          type="range"
          min="0.5"
          max="0.99"
          step="0.01"
          value={status.threshold}
          disabled={busy}
          onchange={(event) =>
            act(() => api.plugin("jev", "PUT", "threshold", { threshold: Number(event.currentTarget.value) }))}
        /><span class="mono">{percent(status.threshold)}</span></span
      ></label
    >
  </section>

  <section aria-labelledby="jev-sent">
    <h3 class="h3" id="jev-sent">What is sent</h3>
    <p class="sub">{status.sent}</p>
    <p class="sub">
      Every command Auto checks is one request billed to {selected?.bills ?? "the selected account"}.
      {#if last !== undefined}
        Last decision: {last.tokens === undefined ? "tokens not reported" : `${last.tokens} tokens`}{last.costUsd ===
        undefined
          ? ""
          : ` · $${last.costUsd.toFixed(6)}`}.
      {/if}
    </p>
  </section>

  <section aria-labelledby="jev-recent">
    <h3 class="h3" id="jev-recent">Recent decisions</h3>
    {#if status.recent.length === 0}<p class="sub">None yet.</p>{/if}
    <ul class="recent">
      {#each status.recent as item, index (index)}
        <li>
          <code class="mono">{item.command}</code>
          <span class="note"
            >{item.error === undefined
              ? `${item.verdict === "run" ? "Run" : "Ask"} · ${percent(item.confidence ?? 0)} sure`
              : `No decision: ${item.error}`} · {item.connection === "typesafe" ? "TypeSafe" : "OpenRouter"} · {item.latencyMs}
            ms</span
          >
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 20px;
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
  }
  .choice {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    border: 1px solid var(--line2);
    border-radius: var(--radius-md);
    background: var(--bg1);
    cursor: pointer;
  }
  .choice input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }
  .choice.on {
    border-color: var(--acln);
    background: var(--acbg);
  }
  .choice:has(input:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .name {
    font-weight: 550;
  }
  .note {
    font-size: 12.5px;
    color: var(--tx3);
  }
  /* Shared fields grow in rows; in this column they keep their natural height. */
  .key {
    flex: 0 0 auto;
  }
  .buttons {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .recent {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .recent li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .recent code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
