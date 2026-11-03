<script lang="ts">
  import { pet } from "./choice.svelte.ts";

  let { running, active, onSpace }: { running: boolean; active: boolean; onSpace: (pixels: number) => void } = $props();
  // Room above the transcript's end for the pet perched on the composer.
  $effect(() => onSpace(pet.enabled ? 54 : 0));
</script>

{#if pet.enabled}
  {#await import("./Companion.svelte") then { default: Companion }}
    <Companion id={pet.id} {running} {active} />
  {/await}
{/if}
