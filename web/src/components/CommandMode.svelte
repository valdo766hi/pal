<script lang="ts">
  import { tick } from "svelte";
  import type { AutoStatus, CommandMode } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";

  let {
    mode,
    auto,
    onChoose,
    onOpen,
  }: {
    mode: CommandMode | undefined;
    auto: AutoStatus | undefined;
    onChoose: (mode: CommandMode) => Promise<void>;
    /** Asked when the menu opens, so Auto's availability is current. */
    onOpen?: () => void;
  } = $props();
  const options = $derived([
    {
      mode: "ask",
      icon: "lock",
      title: "Ask for approval",
      detail: "Each agent shell command waits until you approve it, with its folder and timeout shown.",
      disabled: false,
    },
    {
      mode: "auto",
      icon: "bolt",
      title: "Auto",
      detail:
        auto === undefined
          ? "Checking whether a decision model is ready…"
          : auto.ready
            ? auto.note
            : `Unavailable: ${auto.note}`,
      disabled: auto?.ready !== true,
    },
    {
      mode: "full",
      icon: "warn",
      title: "Full access (YOLO)",
      detail:
        "Agent shell commands run without asking, as the Pal host user. Not a sandbox; grants, protections and limits still apply.",
      disabled: false,
    },
  ] as const);
  // A chat left in Auto without a ready decision model asks like Ask; the button says so.
  const stalled = $derived(mode === "auto" && auto !== undefined && !auto.ready);
  const label = $derived(mode === "full" ? "Full access" : mode === "auto" ? "Auto" : "Ask first");
  let open = $state(false);
  let busy = $state(false);
  let container: HTMLDivElement | undefined;
  let opener: HTMLButtonElement | undefined;

  async function toggle() {
    open = !open;
    if (open) {
      onOpen?.();
      await tick();
      container?.querySelector<HTMLButtonElement>('.opt[aria-checked="true"], .opt:not(:disabled)')?.focus();
    }
  }
  async function choose(next: CommandMode) {
    if (busy) return;
    busy = true;
    try {
      if (next !== mode) await onChoose(next);
      open = false;
      opener?.focus();
    } finally {
      busy = false;
    }
  }
  function move(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = [...(container?.querySelectorAll<HTMLButtonElement>(".opt:not(:disabled)") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(at + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (!busy && event.target instanceof Node && !container?.contains(event.target)) open = false;
  }}
  onkeydown={(event) => {
    if (open && event.key === "Escape" && !busy) {
      open = false;
      opener?.focus();
    }
  }}
/>

<div class="command-mode" bind:this={container}>
  <button
    class="b t"
    class:warn={mode === "full" || stalled}
    bind:this={opener}
    aria-label={`Command approval: ${mode === "full" ? "Full access" : mode === "auto" ? (stalled ? "Auto, unavailable, asking instead" : "Auto") : "Ask for approval"}`}
    title={stalled ? `Auto is unavailable, so commands ask you: ${auto?.note}` : undefined}
    aria-expanded={open}
    disabled={mode === undefined || busy}
    onclick={toggle}
  >
    <Icon name={mode === "full" ? "warn" : mode === "auto" ? "bolt" : "shield"} size={14} />{label}
  </button>
  {#if open}
    <div class="pop" role="dialog" aria-label="Command approval">
      <div class="poph">How should Pal actions be approved?</div>
      <div role="radiogroup" aria-label="Command approval mode" tabindex="-1" onkeydown={move}>
        {#each options as option (option.mode)}
          <button
            class="opt"
            class:warn={option.mode === "full"}
            role="radio"
            aria-checked={mode === option.mode}
            disabled={busy || (option.disabled && mode !== option.mode)}
            onclick={() => choose(option.mode)}
          >
            <span class="row"
              ><Icon name={option.icon} /><span class="grow">{option.title}</span>{#if mode === option.mode}<Icon
                  name="check"
                />{/if}</span
            >
            <span class="optd">{option.detail}</span>
          </button>
        {/each}
      </div>
      {#if stalled}<p class="popn warn" role="status">
          Auto is unavailable, so this chat asks you for every command until a decision model is ready.
        </p>{/if}
      <p class="popn">
        Applies to this chat. Requests already waiting still need your answer. Browser actions always ask. Human
        Terminal is separate.
      </p>
    </div>
  {/if}
</div>

<style>
  .pop {
    bottom: calc(100% + 6px);
    left: 0;
    width: 360px;
    max-width: 100%;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .b.warn,
  .opt.warn,
  .popn.warn {
    color: var(--wa);
  }
  .opt.warn .optd {
    color: var(--wa);
    opacity: 0.85;
  }
</style>
