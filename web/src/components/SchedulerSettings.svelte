<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Scheduler } from "../lib/api.ts";
  import ScheduleList from "./ScheduleList.svelte";

  let view: Scheduler | undefined = $state();
  let busy = $state(false);
  let error: string | undefined = $state();
  async function load() {
    try {
      view = await api.scheduler();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  onMount(() => {
    void load();
  });
  async function toggle(enabled: boolean) {
    busy = true;
    error = undefined;
    try {
      view = await api.setScheduler(enabled);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<div class="setrow">
  <label for="scheduler">
    <div class="setl">Scheduled messages</div>
    <div class="setd">
      Lets chats send themselves messages at set times, with the chat's own model, approvals and grants. Off, nothing
      runs on a schedule; turning it back on skips what was due meanwhile.
    </div>
  </label>
  <input
    id="scheduler"
    class="swi"
    type="checkbox"
    role="switch"
    disabled={view === undefined || busy}
    checked={view?.enabled ?? false}
    onchange={(event) => toggle(event.currentTarget.checked)}
  />
</div>
{#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
{#if view !== undefined && view.schedules.length > 0}
  <ScheduleList schedules={view.schedules} onChanged={load} />
{/if}
