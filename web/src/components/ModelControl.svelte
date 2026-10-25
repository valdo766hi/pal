<script lang="ts" module>
  import type { Effort } from "../lib/api.ts";

  export type Choice = { provider: string; id: string; name: string; efforts: readonly Effort[] };
  export type Group = { provider: string; name: string; billing: string; choices: Choice[] };
  /** Pi's thinking levels in order; a model's steps are the ones it supports. */
  const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  export const LABELS: Record<Effort, string> = {
    off: "Off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  };
</script>

<script lang="ts">
  import { tick } from "svelte";
  import Icon from "../lib/Icon.svelte";

  let {
    groups,
    effective,
    current,
    effort,
    busy,
    disabled,
    connected,
    isDefault,
    usable,
    onModel,
    onEffort,
    onDefault,
  }: {
    groups: Group[];
    effective: { provider: string; modelId: string } | null;
    current: Choice | undefined;
    effort: Effort;
    busy: boolean;
    disabled: boolean;
    connected: boolean;
    isDefault: boolean;
    usable: boolean;
    onModel: (choice: Choice) => Promise<void>;
    onEffort: (level: Effort) => Promise<void>;
    onDefault: () => Promise<void>;
  } = $props();

  const SHOWN_PER_PROVIDER = 50;
  let open = $state(false);
  let view: "effort" | "models" = $state("effort");
  let query = $state("");
  let saving = $state(false);
  /** The step being dragged or keyed to, before the server confirms it. */
  let preview: number | undefined = $state();
  let wanted: Effort | undefined;
  let container: HTMLDivElement | undefined;
  let opener: HTMLButtonElement | undefined;
  let range: HTMLInputElement | undefined = $state();

  const steps = $derived(LEVELS.filter((level) => current?.efforts.includes(level)));
  const index = $derived(Math.max(0, steps.indexOf(effort as (typeof LEVELS)[number])));
  const step = $derived(preview ?? index);
  const shown = $derived(steps[step] ?? effort);
  const adjustable = $derived(current !== undefined && steps.length > 1);
  /** "Off" beside a model name reads as if the model were off. */
  const levelName = (level: Effort) => (level === "off" ? "Reasoning off" : LABELS[level]);
  const modelName = $derived(current?.name ?? effective?.modelId ?? "Choose model");
  const providerName = $derived(groups.find((group) => group.provider === effective?.provider)?.name);
  const searchable = $derived(groups.reduce((total, group) => total + group.choices.length, 0) > 12);
  const matching = $derived.by(() => {
    const words = query.trim().toLowerCase();
    if (words === "") return groups;
    return groups.map((group) => ({
      ...group,
      choices: group.choices.filter((choice) => `${choice.name} ${choice.id}`.toLowerCase().includes(words)),
    }));
  });

  async function show(next: "effort" | "models") {
    open = true;
    view = next;
    await tick();
    const target =
      next === "models"
        ? container?.querySelector<HTMLElement>(
            'input[type="search"], [role="radio"][aria-checked="true"], [role="radio"]',
          )
        : adjustable
          ? range
          : container?.querySelector<HTMLElement>(".head");
    target?.focus();
  }
  function close(refocus: boolean) {
    open = false;
    query = "";
    if (refocus) opener?.focus();
  }
  async function choose(choice: Choice) {
    close(true);
    await onModel(choice);
  }
  /** Keyboard and drag changes arrive faster than the server answers; send only the latest, one at a time. */
  async function commit(level: Effort) {
    wanted = level;
    if (saving) return;
    saving = true;
    try {
      while (wanted !== undefined && wanted !== effort) {
        const next = wanted;
        wanted = undefined;
        await onEffort(next);
      }
    } finally {
      wanted = undefined;
      saving = false;
      preview = undefined;
      // A refused change snaps back to the chat's actual effort.
      if (range !== undefined) range.value = String(index);
    }
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (open && event.target instanceof Node && !container?.contains(event.target)) close(false);
  }}
  onkeydown={(event) => {
    if (open && event.key === "Escape") close(true);
  }}
/>

<div class="model" bind:this={container}>
  <button
    class="b t trigger"
    bind:this={opener}
    aria-label={`Model and reasoning: ${modelName}, reasoning ${LABELS[effort].toLowerCase()}`}
    title={providerName === undefined ? modelName : `${modelName} · ${providerName}`}
    aria-expanded={open}
    {disabled}
    onclick={() => (open ? close(false) : show("effort"))}
  >
    <span class="name">{modelName}</span>{#if current !== undefined && steps.length > 1}<span class="level"
        >{levelName(effort)}</span
      >{/if}<Icon name="chevD" size={12} />
  </button>
  {#if open}
    <div
      class="pop"
      class:wide={view === "models"}
      role="dialog"
      aria-label={view === "models" ? "Choose model" : "Model and reasoning"}
    >
      {#if view === "effort"}
        <button class="head" aria-label={`Choose model (${modelName})`} {disabled} onclick={() => show("models")}>
          <Icon name="bolt" />
          <span class="title">
            <span class="hname">{modelName}</span>{#if adjustable}<span class="hlevel">{levelName(shown)}</span>{/if}
          </span>
          <Icon name="chevR" />
        </button>
        {#if providerName !== undefined && effective?.provider !== "openai"}<p class="hprov">{providerName}</p>{/if}
        <!-- Drawn track, fill, dots and knob; the transparent native range on top supplies dragging, keys and the
             slider role. The knob is taller than the track and the fill ends at its center, so no fill edge shows. -->
        <div class="track" class:off={!adjustable} style:--ratio={adjustable ? step / (steps.length - 1) : 0}>
          <span class="fill"></span>
          {#if adjustable}
            {#each steps as level, at (level)}<span
                class="dot"
                class:lit={at < step}
                style:--at={at / (steps.length - 1)}
              ></span>{/each}
          {/if}
          <span class="knob"></span>
          <input
            bind:this={range}
            type="range"
            min="0"
            max={Math.max(0, steps.length - 1)}
            step="1"
            value={index}
            disabled={disabled || !adjustable}
            aria-label="Reasoning effort"
            aria-valuetext={LABELS[shown]}
            oninput={(event) => (preview = Number(event.currentTarget.value))}
            onchange={(event) => {
              const level = steps[Number(event.currentTarget.value)];
              if (level !== undefined) void commit(level);
            }}
          />
        </div>
        <p class="note" role="status">
          {#if current === undefined}
            {connected || effective?.provider !== "openai"
              ? "Choose a model to set its reasoning."
              : "Sign in with ChatGPT to choose a model."}
          {:else if steps.length <= 1}
            This model has no adjustable reasoning.
          {:else if saving}
            Saving…
          {:else}
            Higher reasoning takes longer and uses more of your plan or credits.
          {/if}
        </p>
        <div class="defaults">
          {#if isDefault}<span class="optd">New chats start with this model.</span>
          {:else}<button class="b sm" disabled={disabled || effective === null || !usable} onclick={onDefault}
              >Use for new chats</button
            >{/if}
        </div>
      {:else}
        <div class="listhead">
          <button
            class="b i q sm tip start"
            aria-label="Back to reasoning"
            data-tip="Back"
            onclick={() => show("effort")}><Icon name="chevL" /></button
          >
          <span>Choose model</span>
        </div>
        {#if searchable}
          <input
            class="f search"
            type="search"
            placeholder="Search models"
            aria-label="Search models"
            bind:value={query}
          />
        {/if}
        <div class="models">
          {#each matching as group (group.provider)}
            <div class="grouph"><span>{group.name}</span><span class="optd">{group.billing}</span></div>
            {#if group.provider === "openai" && !connected}
              <p class="popn">Sign in with ChatGPT to list your models.</p>
            {:else if effective !== null && group.provider !== effective.provider}
              <p class="popn">Choosing one sends this chat's history to {group.name} with your next message.</p>
            {/if}
            <div role="radiogroup" aria-label={`${group.name} models`}>
              {#each group.choices.slice(0, SHOWN_PER_PROVIDER) as choice (choice.id)}
                {@const chosen = choice.provider === effective?.provider && choice.id === effective.modelId}
                <button
                  class="opt"
                  role="radio"
                  aria-checked={chosen}
                  disabled={busy || disabled}
                  onclick={() => choose(choice)}
                >
                  <span>{choice.name}</span>
                  <span class="mono optd">{choice.id}</span>
                  {#if chosen}<Icon name="check" />{/if}
                </button>
              {/each}
            </div>
            {#if group.choices.length > SHOWN_PER_PROVIDER}
              <p class="popn">Showing {SHOWN_PER_PROVIDER} of {group.choices.length}. Search to find others.</p>
            {:else if group.choices.length === 0 && query.trim() !== ""}
              <p class="popn">No {group.name} model matches.</p>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .model {
    position: relative;
    min-width: 0;
  }
  .trigger {
    max-width: 100%;
    gap: 5px;
    color: color-mix(in srgb, var(--tx) 85%, transparent);
  }
  .trigger :global(svg) {
    color: var(--tx3);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .level {
    color: var(--tx3);
  }
  .pop {
    bottom: calc(100% + 8px);
    right: -4px;
    width: 320px;
    max-width: calc(100vw - 32px);
    padding: 8px;
    --origin: bottom right;
    max-height: min(520px, 70dvh);
  }
  .pop.wide {
    width: 420px;
  }
  .head {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    width: 100%;
    min-height: 40px;
    padding: 6px 34px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--tx);
    transition: background-color var(--fast) var(--ease);
  }
  .head:hover {
    background: var(--bg3);
  }
  .head :global(svg) {
    flex: 0 0 auto;
    color: var(--tx3);
  }
  .head > :global(svg:first-child) {
    position: absolute;
    left: 10px;
  }
  .title {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    white-space: nowrap;
  }
  .hname {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 15px;
    font-weight: 650;
  }
  .hlevel {
    color: var(--tx3);
    font-size: 15px;
  }
  .hprov {
    margin: 0;
    text-align: center;
    font-size: 12px;
    color: var(--tx3);
  }
  .track {
    --knob: 32px;
    position: relative;
    height: 28px;
    margin: 12px 8px 6px;
    border-radius: 14px;
    background: var(--bg4);
  }
  .track.off {
    opacity: 0.5;
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: calc(var(--knob) / 2 + (100% - var(--knob)) * var(--ratio));
    border-radius: 14px 0 0 14px;
    background: var(--primary);
    transition: width var(--fast) var(--ease);
  }
  .dot {
    position: absolute;
    top: 50%;
    left: calc(var(--knob) / 2 + (100% - var(--knob)) * var(--at));
    width: 5px;
    height: 5px;
    margin: -2.5px 0 0 -2.5px;
    border-radius: 50%;
    background: var(--tx3);
    opacity: 0.7;
  }
  .dot.lit {
    background: #fff;
    opacity: 0.55;
  }
  .knob {
    position: absolute;
    top: 50%;
    left: calc((100% - var(--knob)) * var(--ratio));
    width: var(--knob);
    height: var(--knob);
    margin-top: calc(var(--knob) / -2);
    border-radius: 50%;
    background: #fff;
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.35),
      0 3px 10px rgba(0, 0, 0, 0.25);
    transition:
      left var(--fast) var(--ease),
      transform var(--fast) var(--ease);
  }
  .track:has(input:active) .knob {
    transform: scale(0.94);
  }
  .track:has(input:focus-visible) .knob {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  /* Invisible but real: its thumb is the knob's size, so a press lands on the step drawn under the pointer. */
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    position: absolute;
    inset: -4px 0;
    width: 100%;
    height: calc(100% + 8px);
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  input[type="range"]:disabled {
    cursor: not-allowed;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: var(--knob);
    height: var(--knob);
  }
  input[type="range"]::-moz-range-thumb {
    width: var(--knob);
    height: var(--knob);
    border: 0;
  }
  .note {
    margin: 8px 10px 2px;
    font-size: 12.5px;
    color: var(--tx3);
  }
  .defaults {
    margin-top: 8px;
    padding: 8px 10px 2px;
    border-top: 1px solid var(--line);
  }
  .listhead {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px 6px;
    font-weight: 650;
  }
  .search {
    margin: 0 4px 6px;
    width: calc(100% - 8px);
  }
  .models {
    max-height: min(320px, 45dvh);
    overflow-y: auto;
  }
  .grouph {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 10px 2px;
    font-size: 12.5px;
    font-weight: 650;
    color: var(--tx2);
  }
  .grouph .optd {
    font-weight: 400;
  }
  .opt {
    flex-direction: row;
    align-items: baseline;
    gap: 8px;
  }
  .opt .mono {
    margin-left: auto;
  }
  .opt :global(svg) {
    align-self: center;
    color: var(--tx);
  }
</style>
