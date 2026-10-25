<script lang="ts">
  import { api, ApiError, type ScheduleNotice, type ScheduleView } from "../lib/api.ts";
  import { describeEvent, describeRule, when } from "../lib/schedules.ts";

  let {
    schedules,
    notice,
    onChanged,
  }: {
    schedules: (ScheduleView & { chat?: string | null })[];
    /** The chat's current notice; resuming without it is offered from the chat instead. */
    notice?: ScheduleNotice | undefined;
    onChanged: () => Promise<void>;
  } = $props();
  let busy: string | undefined = $state();
  let error: string | undefined = $state();
  const states = { active: "ok", paused: "wa", cancelled: "", done: "" } as const;

  async function change(schedule: ScheduleView, action: "pause" | "resume" | "cancel") {
    busy = schedule.id;
    error = undefined;
    try {
      if (action === "resume" && notice !== undefined) await api.resumeSchedule(schedule.chatId, schedule.id, notice);
      else if (action !== "resume") await api.changeSchedule(schedule.chatId, schedule.id, action);
      await onChanged();
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy = undefined;
    }
  }
</script>

{#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
<ul class="list">
  {#each schedules as schedule (schedule.id)}
    <li class="item">
      <div class="head">
        <strong>{describeRule(schedule.rule, schedule.timezone)}</strong>
        <span class="pill {states[schedule.state]}">{schedule.state}</span>
      </div>
      {#if schedule.chat !== undefined}<div class="fine">In {schedule.chat ?? "an untitled chat"}</div>{/if}
      <p class="text">{schedule.text}</p>
      <div class="fine">
        {#if schedule.next !== null}Next: {when(schedule.next)} ·
        {/if}Attempted {schedule.fired}{schedule.limit === null ? "" : ` of ${schedule.limit}`} · Missed runs: {schedule.missed ===
        "skip"
          ? "skipped"
          : "run once when Pal is back"} · Commands: {schedule.binding.mode === "full" ? "Full access" : "Ask"}
      </div>
      {#if schedule.reason !== null}<div class="callout wa">{schedule.reason}</div>{/if}
      {#if schedule.state === "active" || schedule.state === "paused"}
        <div class="actions">
          {#if schedule.state === "active"}
            <button class="b sm" disabled={busy !== undefined} onclick={() => change(schedule, "pause")}>Pause</button>
          {:else if notice !== undefined}
            <button class="b sm" disabled={busy !== undefined} onclick={() => change(schedule, "resume")}
              >Resume with current settings</button
            >
          {:else}
            <span class="fine">Resume it from its chat's Add menu, after reviewing the current cost and effects.</span>
          {/if}
          <button class="b sm dz" disabled={busy !== undefined} onclick={() => change(schedule, "cancel")}
            >Cancel</button
          >
        </div>
      {/if}
      <details>
        <summary class="fine">History</summary>
        <ul class="history">
          {#each schedule.history as event, index (index)}
            <li class="fine">
              {when(event.at)} — {describeEvent(event)}{event.due !== undefined && event.due !== event.at
                ? ` (due ${when(event.due)})`
                : ""}
            </li>
          {/each}
        </ul>
      </details>
    </li>
  {/each}
</ul>

<style>
  .list,
  .history {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .history {
    gap: 2px;
    margin-top: 6px;
  }
  .item {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .head,
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .head strong {
    font-size: 13.5px;
  }
  .text {
    margin: 0;
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .fine {
    font-size: 12px;
    color: var(--tx3);
  }
</style>
