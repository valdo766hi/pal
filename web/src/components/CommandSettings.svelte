<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api.ts";

  const presets = [120, 300, 600, 900, 1800];
  let seconds: number | undefined = $state();
  let busy = $state(false);
  let error: string | undefined = $state();
  // A limit saved through the API that is not a preset still shows as chosen.
  const choices = $derived(
    seconds === undefined || presets.includes(seconds) ? presets : [...presets, seconds].sort((a, b) => a - b),
  );
  onMount(() => {
    api.commandTimeout().then(
      (view) => (seconds = view.seconds),
      (failure: unknown) => (error = failure instanceof Error ? failure.message : String(failure)),
    );
  });
  async function choose(value: number) {
    busy = true;
    error = undefined;
    try {
      seconds = (await api.setCommandTimeout(value)).seconds;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<div class="setrow">
  <label for="command-timeout">
    <div class="setl">Longest agent command</div>
    <div class="setd">
      The longest one agent command may run. Commands inside its scripts stay within 2 minutes. Stop ends a command
      early; one cut off by a restart is reported as interrupted and never rerun.
    </div>
  </label>
  <select
    id="command-timeout"
    class="f"
    disabled={seconds === undefined || busy}
    value={seconds}
    onchange={(event) => choose(Number(event.currentTarget.value))}
  >
    {#each choices as choice (choice)}<option value={choice}>{choice / 60} minutes</option>{/each}
  </select>
</div>
{#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}

<style>
  select {
    width: auto;
  }
</style>
