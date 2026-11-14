<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api, type ChatSummary, type ContextUsageInfo } from "../../../web/src/lib/api.ts";
  import { nearSummarizing, percentUsed, tokens } from "../../../web/src/lib/context-usage.ts";
  import { viewport } from "../../../web/src/lib/state.svelte.ts";
  import ContextBreakdown from "./ContextBreakdown.svelte";
  import { ring } from "./choice.svelte.ts";

  let {
    chat,
    running,
    revision,
    onPanel,
  }: { chat: ChatSummary; running: boolean; revision: number; onPanel: (id: string) => void } = $props();
  const R = 6.5;
  const LENGTH = 2 * Math.PI * R;
  let usage: ContextUsageInfo | undefined = $state.raw();
  let shownFor: string | undefined;
  let open = $state(false);
  let opener: HTMLButtonElement | undefined = $state();
  let container: HTMLDivElement | undefined = $state();
  let sheet: HTMLDialogElement | undefined = $state();
  /** Where the popover sits: above the ring, kept inside the window whatever the ring's place in the row. */
  let place = $state({ left: 0, bottom: 0 });
  const phone = $derived(viewport() === "phone");
  // Read when the chat opens, a run starts or ends, or history commits; never while idle.
  const moment = $derived(`${chat.id}\n${running}\n${revision}`);
  $effect(() => {
    if (!ring.shown) return;
    const id = moment.split("\n", 1)[0] ?? "";
    let current = true;
    const first = untrack(() => shownFor !== id);
    if (first) {
      shownFor = id;
      usage = undefined;
    }
    const timer = setTimeout(
      () =>
        void api.contextUsage(id).then(
          (next) => {
            if (current) usage = next;
          },
          () => {},
        ),
      first ? 0 : 400,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  });

  const percent = $derived(usage === undefined ? undefined : percentUsed(usage));
  const near = $derived(usage !== undefined && nearSummarizing(usage));
  const fraction = $derived(
    usage?.usedTokens == null || usage.contextWindow === null ? 0 : Math.min(1, usage.usedTokens / usage.contextWindow),
  );
  const label = $derived.by(() => {
    if (usage?.usedTokens == null) return "Context: No context yet";
    if (usage.contextWindow === null) return `Context: ${tokens(usage.usedTokens)} tokens used`;
    return `Context: ${percent} used, ${tokens(usage.usedTokens)} of ${tokens(usage.contextWindow)} tokens${near ? ", near summarizing" : ""}`;
  });
  const text = $derived.by(() => {
    if (!ring.percent || usage?.usedTokens == null) return "";
    return usage.contextWindow === null ? tokens(usage.usedTokens) : (percent ?? "");
  });

  async function toggle() {
    open = !open;
    if (!open) return;
    void api.contextUsage(chat.id).then(
      (next) => {
        if (shownFor === chat.id) usage = next;
      },
      () => {},
    );
    if (!phone) locate();
    await tick();
    if (phone) sheet?.showModal();
    else container?.querySelector<HTMLElement>(".pop")?.focus();
  }
  function locate() {
    const box = opener?.getBoundingClientRect();
    if (box === undefined) return;
    const width = Math.min(380, innerWidth - 32);
    place = {
      left: Math.max(16, Math.min(box.right - width, innerWidth - width - 16)),
      bottom: innerHeight - box.top + 6,
    };
  }
  function close() {
    open = false;
    opener?.focus();
  }
  function inspect() {
    sheet?.close();
    open = false;
    onPanel("Context");
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (open && !phone && event.target instanceof Node && !container?.contains(event.target)) open = false;
  }}
  onkeydown={(event) => {
    if (open && !phone && event.key === "Escape") close();
  }}
  onresize={() => {
    if (open && !phone) locate();
  }}
/>

{#if ring.shown}
  <div class="gauge" bind:this={container}>
    <button
      class="b t"
      class:near
      bind:this={opener}
      aria-label={label}
      title={label.slice("Context: ".length)}
      aria-expanded={open}
      aria-haspopup="dialog"
      onclick={toggle}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle class="track" cx="8" cy="8" r={R} />
        {#if fraction > 0}<circle
            class="fill"
            cx="8"
            cy="8"
            r={R}
            stroke-dasharray={`${Math.max(0.6, fraction * LENGTH)} ${LENGTH}`}
          />{/if}
      </svg>
      {#if text !== ""}<span class="num">{text}</span>{/if}
    </button>
    {#if open && !phone}
      <div
        class="pop"
        role="dialog"
        aria-label="Context usage"
        tabindex="-1"
        style:left={`${place.left}px`}
        style:bottom={`${place.bottom}px`}
      >
        <ContextBreakdown {usage} onInspect={inspect} />
      </div>
    {/if}
  </div>
  {#if open && phone}
    <dialog class="sheet" aria-label="Context usage" bind:this={sheet} onclose={close}>
      <span class="grip" aria-hidden="true"></span>
      <ContextBreakdown {usage} onInspect={inspect} />
    </dialog>
  {/if}
{/if}

<style>
  .gauge {
    position: relative;
  }
  .b {
    gap: 5px;
  }
  .num {
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }
  svg {
    transform: rotate(-90deg);
  }
  circle {
    fill: none;
    stroke-width: 2;
  }
  .track {
    stroke: var(--line3);
  }
  .fill {
    stroke: currentColor;
    stroke-linecap: round;
  }
  .near {
    color: var(--wa);
  }
  .near:hover:not(:disabled) {
    color: var(--wa);
  }
  .pop {
    position: fixed;
    width: 380px;
    max-width: calc(100vw - 32px);
    max-height: min(520px, 70vh);
    padding: 12px 14px;
    --origin: bottom right;
  }
  .pop:focus {
    outline: none;
  }
  .sheet[open] {
    inset: auto 0 0;
    width: 100%;
    max-width: none;
    max-height: 85vh;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 10px 16px max(20px, env(safe-area-inset-bottom));
    border: 0;
    border-top: 1px solid var(--line2);
    border-radius: 24px 24px 0 0;
    overflow: auto;
    animation: rise var(--mid) var(--ease);
  }
  .grip {
    align-self: center;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--line3);
  }
</style>
