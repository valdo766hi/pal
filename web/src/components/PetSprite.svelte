<script lang="ts">
  import { type Pet, type Pose, pixels } from "../lib/pets.ts";

  let { pet, pose, scale = 3 }: { pet: Pet; pose: Pose; scale?: number } = $props();
  const shown = $derived(pet.poses[pose]);
</script>

<svg
  viewBox={`0 0 ${pet.size.width} ${pet.size.height}`}
  width={pet.size.width * scale}
  height={pet.size.height * scale}
  shape-rendering="crispEdges"
  style:--beat={`${shown.beat ?? 1}s`}
  aria-hidden="true"
>
  {#each shown.parts as [layer, motion], index (index)}
    <g class={motion}>
      {#each pixels(layer) as run (`${run.x},${run.y}`)}
        <rect x={run.x} y={run.y} width={run.width} height="1" fill={pet.colors[run.ink]} />
      {/each}
    </g>
  {/each}
</svg>

<style>
  svg {
    display: block;
  }
  /* Still frames show `open` and `a`; reduced motion stops every animation on them. */
  .shut,
  .b {
    opacity: 0;
  }
  .open {
    animation: blink 7s steps(1, end) infinite;
  }
  .shut {
    animation: blink-shut 7s steps(1, end) infinite;
  }
  .a {
    animation: flick var(--beat) steps(1, end) infinite;
  }
  .b {
    animation: flick-other var(--beat) steps(1, end) infinite;
  }
  @keyframes blink {
    0%,
    96% {
      opacity: 1;
    }
    97%,
    100% {
      opacity: 0;
    }
  }
  @keyframes flick {
    0%,
    49% {
      opacity: 1;
    }
    50%,
    100% {
      opacity: 0;
    }
  }
  @keyframes flick-other {
    0%,
    49% {
      opacity: 0;
    }
    50%,
    100% {
      opacity: 1;
    }
  }
  @keyframes blink-shut {
    0%,
    96% {
      opacity: 0;
    }
    97%,
    100% {
      opacity: 1;
    }
  }
</style>
