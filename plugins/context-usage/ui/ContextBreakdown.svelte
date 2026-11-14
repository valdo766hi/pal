<script lang="ts">
  import type { ContextUsageInfo } from "../../../web/src/lib/api.ts";
  import ContextUsage from "../../../web/src/components/ContextUsage.svelte";

  let { usage, onInspect }: { usage: ContextUsageInfo | undefined; onInspect: () => void } = $props();
</script>

{#if usage === undefined}
  <p class="note" role="status">Loading context…</p>
{:else if usage.usedTokens === null}
  <p class="note">No context yet. The ring fills once Pal prepares this chat's first model request.</p>
{:else}
  <ContextUsage {usage} />
  <p class="note">
    Estimated from the last prepared request{usage.reported === undefined
      ? ""
      : `; ${usage.reported.tokens.toLocaleString()} tokens reported by ${usage.reported.provider} after the last reply`}.
  </p>
{/if}
<button class="b sm q" onclick={onInspect}>Inspect prompt in Context</button>

<style>
  .note {
    margin: 8px 0 4px;
    font-size: 12.5px;
    color: var(--tx3);
  }
  .b {
    align-self: flex-end;
    margin-left: auto;
    display: flex;
  }
</style>
