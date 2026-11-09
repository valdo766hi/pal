<script lang="ts">
  import { api } from "../../../../../web/src/lib/api.ts";

  let prefix = $state("");
  let status = $state("");
  const loaded = api.plugin<{ prefix: string }>("example", "GET", "settings").then((saved) => (prefix = saved.prefix));

  async function save(event: SubmitEvent) {
    event.preventDefault();
    status = "";
    try {
      await api.plugin("example", "PUT", "settings", { prefix });
      status = "Saved.";
    } catch (failure) {
      status = failure instanceof Error ? failure.message : String(failure);
    }
  }
</script>

<h2 class="h2">Example echo</h2>
<p class="sub">A test plugin. Its prefix starts every echo in every chat that selected it.</p>
{#await loaded}
  <p role="status">Loading…</p>
{:then}
  <form onsubmit={save}>
    <label class="fl">Echo prefix<input class="f" bind:value={prefix} maxlength="32" autocomplete="off" /></label>
    <button class="b sm p" type="submit">Save prefix</button>
    {#if status}<p role="status">{status}</p>{/if}
  </form>
{:catch failure}
  <p role="alert">Couldn't load the example settings: {String(failure)}</p>
{/await}
