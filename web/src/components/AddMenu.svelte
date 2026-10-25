<script lang="ts">
  import { tick } from "svelte";
  import Icon from "../lib/Icon.svelte";

  let { onFiles, onSchedule }: { onFiles: (files: File[]) => void; onSchedule: () => void } = $props();
  let open = $state(false);
  let container: HTMLDivElement | undefined;
  let opener: HTMLButtonElement | undefined;
  let input: HTMLInputElement | undefined;

  async function show() {
    open = true;
    await tick();
    container?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }
  function close(refocus: boolean) {
    open = false;
    if (refocus) opener?.focus();
  }
  function pick() {
    close(true);
    // Still inside the click, so the browser treats the file chooser as user-initiated.
    input?.click();
  }
  function onOpenerKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      void show();
    }
  }
  function onMenuKey(event: KeyboardEvent) {
    if (event.key === "Tab") close(false);
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = [...(container?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        { ArrowDown: at + 1, ArrowUp: at - 1 + items.length, Home: 0, End: items.length - 1 }[event.key] ?? 0;
      items[next % items.length]?.focus();
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

<div class="add" bind:this={container}>
  <button
    class="b i q tip up start plus"
    bind:this={opener}
    aria-label="Add"
    data-tip="Add"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open ? close(false) : show())}
    onkeydown={onOpenerKey}><Icon name="plus" /></button
  >
  <input
    bind:this={input}
    class="sr"
    type="file"
    multiple
    tabindex="-1"
    aria-hidden="true"
    onchange={(event) => {
      const files = [...(event.currentTarget.files ?? [])];
      // Cleared, so choosing the same file again is still a change.
      event.currentTarget.value = "";
      onFiles(files);
    }}
  />
  {#if open}
    <div class="pop" role="menu" aria-label="Add" tabindex="-1" onkeydown={onMenuKey}>
      <button class="opt" role="menuitem" onclick={pick}>
        <span class="row"><Icon name="clip" />Add file from this device</span>
        <span class="optd">Uploads a copy for this chat. It doesn't give Pal access to your folders.</span>
      </button>
      <button
        class="opt"
        role="menuitem"
        onclick={() => {
          close(false);
          onSchedule();
        }}
      >
        <span class="row"><Icon name="clock" />Schedule a message</span>
        <span class="optd">Sends this chat a message at set times, with its current model and approvals.</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .add {
    position: relative;
  }
  .plus {
    width: 32px;
    height: 32px;
    margin-left: -6px;
  }
  .plus[aria-expanded="true"] :global(svg) {
    transform: rotate(45deg);
  }
  .plus :global(svg) {
    transition: transform var(--mid) var(--ease);
  }
  .pop {
    bottom: calc(100% + 8px);
    left: -4px;
    width: 300px;
    max-width: calc(100vw - 32px);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    font-weight: 550;
  }
  .optd {
    padding-left: 25px;
  }
</style>
