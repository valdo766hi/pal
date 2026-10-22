<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { api, ApiError, requestId, type ScheduleInput, type ScheduleNotice, type ScheduleView } from "../lib/api.ts";
  import { frequency, WEEKDAYS } from "../lib/schedules.ts";
  import { navigate } from "../lib/state.svelte.ts";
  import ScheduleList from "./ScheduleList.svelte";

  let { chatId, draft, onClose }: { chatId: string; draft: string; onClose: () => void } = $props();
  let dialog: HTMLDialogElement;
  let loaded: { enabled: boolean; notice: ScheduleNotice; schedules: ScheduleView[] } | undefined = $state();
  let error: string | undefined = $state();
  let busy = $state(false);
  // One key per approval: retrying after a lost response creates one schedule.
  let key = requestId();
  const pad = (value: number) => String(value).padStart(2, "0");
  const today = new Date();
  let text = $state(untrack(() => draft));
  let kind = $state<ScheduleInput["rule"]["kind"]>("daily");
  let date = $state(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`);
  let time = $state("09:00");
  let days: number[] = $state([1, 2, 3, 4, 5]);
  let timezone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone);
  let missed = $state<ScheduleInput["missed"]>("skip");
  let limit: number | null | undefined = $state();
  const zones = Intl.supportedValuesOf("timeZone");
  const kinds = [
    ["once", "Once"],
    ["daily", "Daily"],
    ["weekly", "Weekly"],
  ] as const;
  const rule = $derived.by((): ScheduleInput["rule"] => {
    if (kind === "once") return { kind, date, time };
    if (kind === "weekly") return { kind, days: [...days].sort((a, b) => a - b), time };
    return { kind, time };
  });
  const capped = $derived(kind !== "once" && typeof limit === "number" && limit >= 1 ? limit : undefined);

  async function load() {
    try {
      loaded = await api.schedules(chatId);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  onMount(() => {
    dialog.showModal();
    void load();
  });

  async function schedule(event: SubmitEvent) {
    event.preventDefault();
    if (busy || loaded === undefined) return;
    busy = true;
    error = undefined;
    try {
      await api.createSchedule(chatId, key, {
        text: text.trim(),
        timezone,
        rule,
        missed,
        ...(capped === undefined ? {} : { limit: capped }),
        configuration: loaded.notice.configuration,
        mode: loaded.notice.mode,
      });
      key = requestId();
      await load();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      // Changed chat settings mean a changed notice: show it before the owner tries again.
      if (failure instanceof ApiError && failure.code === "schedule_stale") await load();
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="schedule-title"
  onclose={onClose}
  oncancel={(event) => {
    if (busy) event.preventDefault();
  }}
>
  <form onsubmit={schedule}>
    <h2 id="schedule-title">Schedule a message</h2>
    {#if loaded === undefined}
      {#if error === undefined}<p class="fine" role="status">Loading…</p>{/if}
    {:else if !loaded.enabled}
      <div class="callout ac">
        Scheduled messages are off. Turn them on in Settings → General to send this chat messages at set times.
      </div>
    {:else}
      <label class="fl"
        >Message<textarea class="f" rows="3" maxlength="4000" required disabled={busy} bind:value={text}
        ></textarea></label
      >
      <div class="seg" role="radiogroup" aria-label="Repeat">
        {#each kinds as [id, label] (id)}
          <button type="button" class="segb" role="radio" aria-checked={kind === id} onclick={() => (kind = id)}
            >{label}</button
          >
        {/each}
      </div>
      {#if kind === "weekly"}
        <fieldset class="days">
          <legend class="fine">Days</legend>
          {#each WEEKDAYS as label, day (label)}
            <label class="flr"
              ><input
                type="checkbox"
                checked={days.includes(day)}
                onchange={(event) =>
                  (days = event.currentTarget.checked ? [...days, day] : days.filter((item) => item !== day))}
              />{label}</label
            >
          {/each}
        </fieldset>
      {/if}
      <div class="when">
        {#if kind === "once"}<label class="fl">Date<input class="f" type="date" required bind:value={date} /></label
          >{/if}
        <label class="fl">Time<input class="f" type="time" required bind:value={time} /></label>
        <label class="fl">Time zone<input class="f" list="schedule-zones" required bind:value={timezone} /></label>
        <datalist id="schedule-zones">
          {#each zones as zone (zone)}<option value={zone}></option>{/each}
        </datalist>
      </div>
      <fieldset>
        <legend class="fine">If Pal isn't running at that time</legend>
        <label class="flr"><input type="radio" name="missed" value="skip" bind:group={missed} />Skip it</label>
        <label class="flr"
          ><input type="radio" name="missed" value="run-once" bind:group={missed} />Send it once when Pal is back</label
        >
      </fieldset>
      {#if kind !== "once"}
        <label class="fl"
          >Stop after this many runs (optional)<input
            class="f"
            type="number"
            min="1"
            max="1000"
            bind:value={limit}
          /></label
        >
      {/if}
      <div class="callout wa notice" role="note">
        <strong>Before you schedule</strong>
        <p>
          Runs use {loaded.notice.model === null
            ? "no model yet"
            : `${loaded.notice.model.modelId} on ${loaded.notice.model.providerName}, reasoning ${loaded.notice.model.effort}`}.
          {frequency(rule, capped)}.
        </p>
        <p>{loaded.notice.cost}</p>
        <ul>
          {#each loaded.notice.effects as effect (effect)}<li>{effect}</li>{/each}
        </ul>
        <p>Scheduling approves this cost and these effects for every run.</p>
      </div>
    {/if}
    {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
    <div class="buttons">
      {#if loaded !== undefined && !loaded.enabled}
        <button
          class="b"
          type="button"
          onclick={() => {
            dialog.close();
            navigate({ view: "settings", tab: "general" });
          }}>Open Settings</button
        >
      {/if}
      <button class="b" type="button" disabled={busy} onclick={() => dialog.close()}>Close</button>
      {#if loaded?.enabled}
        <button
          class="b p"
          type="submit"
          disabled={busy ||
            text.trim() === "" ||
            loaded.notice.model === null ||
            (kind === "weekly" && days.length === 0)}>{busy ? "Scheduling…" : "Schedule"}</button
        >
      {/if}
    </div>
  </form>
  {#if loaded !== undefined && loaded.schedules.length > 0}
    <section aria-labelledby="chat-schedules">
      <h3 class="h3" id="chat-schedules">This chat's schedules</h3>
      <ScheduleList schedules={loaded.schedules} notice={loaded.notice} onChanged={load} />
    </section>
  {/if}
</dialog>

<style>
  dialog {
    width: 560px;
    max-width: calc(100% - 32px);
    max-height: calc(100dvh - 32px);
    overflow: auto;
  }
  form,
  section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  section {
    margin-top: 18px;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 14px;
  }
  legend {
    padding: 0;
    margin-bottom: 2px;
    width: 100%;
  }
  .when {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  form > .fl {
    flex: none;
  }
  .seg {
    align-self: flex-start;
  }
  .notice p,
  .notice ul {
    margin: 4px 0 0;
  }
  .notice ul {
    padding-left: 18px;
  }
  .fine {
    font-size: 12px;
    color: var(--tx3);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
