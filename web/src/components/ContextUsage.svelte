<script lang="ts">
  import type { ContextUsageInfo } from "../lib/api.ts";
  import { percentUsed, share, tokens } from "../lib/context-usage.ts";

  let { usage }: { usage: ContextUsageInfo } = $props();
  // Existing Quiet tokens, desaturated like code, so the bar never competes with the conversation.
  const INKS = ["--ac", "--syn-t", "--syn-s", "--syn-n", "--syn-p", "--syn-m", "--syn-f", "--syn-k", "--tx3"];
  const limit = $derived(usage.contextWindow);
  const used = $derived(usage.usedTokens ?? 0);
  const free = $derived(limit === null ? 0 : Math.max(0, limit - used - usage.reserveTokens));
  const parts = $derived(
    usage.categories.map((category, index) => ({ ...category, ink: `var(${INKS[index % INKS.length]})` })),
  );
  const amount = (count: number) => (limit === null ? "" : share(count, limit));
</script>

<div class="usage">
  <div class="head">
    <strong>Context</strong>
    {#if percentUsed(usage) !== undefined}<span>{percentUsed(usage)} used</span>{/if}
    <span class="dim">{tokens(used)}{limit === null ? " tokens" : ` / ${tokens(limit)}`}</span>
  </div>
  {#if limit !== null}
    <div class="bar" aria-hidden="true">
      {#each parts as part (part.id)}{#if part.tokens > 0}<span
            style:width={`${(part.tokens / limit) * 100}%`}
            style:background={part.ink}
          ></span>{/if}{/each}<span class="reserve" style:width={`${(usage.reserveTokens / limit) * 100}%`}></span>
    </div>
  {/if}
  <ul class="rows" aria-label="Where the context goes">
    {#each parts as part (part.id)}
      <li>
        {#if part.items !== undefined}
          <details>
            <summary class="row"
              ><span class="key" style:background={part.ink}></span><span class="name">{part.label}</span><span
                class="num">{tokens(part.tokens)}</span
              ><span class="num pct">{amount(part.tokens)}</span></summary
            >
            <ul class="items">
              {#each part.items as item (item.label)}<li class="row">
                  <span class="name mono">{item.label}</span><span class="num">{tokens(item.tokens)}</span><span
                    class="num pct">{amount(item.tokens)}</span
                  >
                </li>{/each}
              {#if part.more}<li class="row dim">and {part.more} more</li>{/if}
            </ul>
          </details>
        {:else}
          <div class="row">
            <span class="key" style:background={part.ink}></span><span class="name">{part.label}</span><span class="num"
              >{part.tokens > 0 && part.id === "reported" ? "+" : ""}{tokens(part.tokens)}</span
            ><span class="num pct">{amount(part.tokens)}</span>
          </div>
        {/if}
      </li>
    {/each}
    {#if limit !== null}
      <li class="row">
        <span class="key hollow reserve"></span><span class="name">Reserved for summarizing</span><span class="num"
          >{tokens(usage.reserveTokens)}</span
        ><span class="num pct">{amount(usage.reserveTokens)}</span>
      </li>
      <li class="row">
        <span class="key hollow"></span><span class="name">Free space</span><span class="num">{tokens(free)}</span><span
          class="num pct">{amount(free)}</span
        >
      </li>
    {/if}
    {#each usage.unloaded as group (group.id)}
      <li>
        <details>
          <summary class="row"
            ><span class="key none"></span><span class="name">{group.label} tools not in the request</span><span
              class="num">{group.count}</span
            ><span class="num pct" title="Reachable through discovery; not counted">—</span></summary
          >
          <ul class="items">
            {#each group.items as name (name)}<li class="row"><span class="name mono">{name}</span></li>{/each}
            {#if group.count > group.items.length}<li class="row dim">
                and {group.count - group.items.length} more
              </li>{/if}
          </ul>
        </details>
      </li>
    {/each}
  </ul>
</div>

<style>
  .usage {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .head strong {
    flex: 1;
    font-weight: 600;
  }
  .dim {
    color: var(--tx3);
  }
  .bar {
    display: flex;
    height: 6px;
    border-radius: 3px;
    background: var(--bg3);
    overflow: hidden;
  }
  .bar span {
    flex: none;
    min-width: 1px;
  }
  .bar .reserve {
    margin-left: auto;
    background: repeating-linear-gradient(135deg, var(--line3) 0 2px, transparent 2px 4px);
  }
  .rows,
  .items {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .items {
    margin: 2px 0 4px 18px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    color: var(--tx2);
  }
  summary.row {
    cursor: pointer;
    list-style: none;
  }
  summary.row::-webkit-details-marker {
    display: none;
  }
  summary.row:hover {
    color: var(--tx);
  }
  details[open] > summary .name {
    color: var(--tx);
  }
  .key {
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 2px;
  }
  .key.hollow {
    border: 1px solid var(--line3);
  }
  .key.reserve {
    background: repeating-linear-gradient(135deg, var(--line3) 0 2px, transparent 2px 4px);
  }
  .key.none {
    background: transparent;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .items .name {
    font-size: 12px;
  }
  .num {
    flex: none;
    font-variant-numeric: tabular-nums;
    text-align: right;
    min-width: 44px;
  }
  .pct {
    min-width: 48px;
    color: var(--tx3);
  }
</style>
