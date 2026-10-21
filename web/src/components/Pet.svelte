<script lang="ts">
  import { PETS, type PetId, type Pose } from "../lib/pets.ts";
  import PetSprite from "./PetSprite.svelte";

  let { id, running, active }: { id: string; running: boolean; active: boolean } = $props();
  /** A pet saved by another version of Pal falls back to the first bundled one. */
  const shown: PetId = $derived(Object.hasOwn(PETS, id) ? (id as PetId) : "abuy");
  /** Takes a break after ten seconds with no run and no composer use and naps after thirty; either wakes it. */
  let idle: "awake" | "rest" | "nap" = $state("awake");
  $effect(() => {
    if (running || active) {
      idle = "awake";
      return;
    }
    const timers = [setTimeout(() => (idle = "rest"), 10_000), setTimeout(() => (idle = "nap"), 30_000)];
    return () => timers.forEach(clearTimeout);
  });
  const pose: Pose = $derived(running ? "work" : idle === "awake" ? "sit" : idle);
</script>

<!-- Decorative only: invisible to assistive technology and to the pointer, so it never takes input. -->
<div class="pet" class:running data-pet={shown} data-pose={pose} aria-hidden="true">
  {#key pose}<div class="pose"><PetSprite pet={PETS[shown]} {pose} /></div>{/key}
</div>

<style>
  /* Perched on the top edge of the composer dock; during a run it steps aside so Stop stays clear. */
  .pet {
    position: absolute;
    right: 22px;
    bottom: calc(100% - 1px);
    z-index: 1;
    pointer-events: none;
    line-height: 0;
    animation: fade var(--mid) var(--ease);
    transition: right 0.5s steps(5, end);
  }
  .pet.running {
    right: 112px;
  }
  .pose {
    animation: fade 0.6s var(--ease);
  }
  .running .pose {
    animation: hop 0.36s steps(3, end) 1;
  }
  @keyframes hop {
    50% {
      transform: translateY(-6px);
    }
  }
</style>
