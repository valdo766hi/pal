import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Admission, InputBody } from "../src/core/chats.ts";
import { ChatNotFound } from "../src/core/chats.ts";
import { HttpError } from "../src/core/http.ts";
import { InvalidRequest, RequestConflict } from "../src/core/requests.ts";
import {
  type ChatSettings,
  instantAt,
  MISSED_AFTER_MS,
  nextDue,
  pauseRestoredSchedule,
  Schedules,
} from "../src/core/schedules.ts";
import { openStore } from "../src/storage/store.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const utc = (text: string) => Date.parse(text);
const local = (year: number, month: number, day: number, hour: number, minute: number) =>
  Date.UTC(year, month - 1, day, hour, minute);

describe("schedule times", () => {
  it("runs a time skipped by a forward clock change that much later, once", () => {
    // New York jumps from 02:00 EST to 03:00 EDT on 2026-03-08; Berlin from 02:00 CET to 03:00 CEST on 2026-03-29.
    expect(instantAt("America/New_York", local(2026, 3, 8, 2, 30))).toBe(utc("2026-03-08T07:30:00Z"));
    expect(instantAt("Europe/Berlin", local(2026, 3, 29, 2, 30))).toBe(utc("2026-03-29T01:30:00Z"));
    const daily = { timezone: "America/New_York", rule: { kind: "daily", time: "02:30" } as const };
    const skipped = nextDue(daily, utc("2026-03-07T12:00:00Z"));
    expect(skipped).toBe(utc("2026-03-08T07:30:00Z"));
    expect(nextDue(daily, skipped ?? 0)).toBe(utc("2026-03-09T06:30:00Z"));
  });

  it("runs a time repeated by a backward clock change at its first occurrence only", () => {
    // New York repeats 01:00–02:00 on 2026-11-01; Berlin repeats 02:00–03:00 on 2026-10-25.
    expect(instantAt("America/New_York", local(2026, 11, 1, 1, 30))).toBe(utc("2026-11-01T05:30:00Z"));
    expect(instantAt("Europe/Berlin", local(2026, 10, 25, 2, 30))).toBe(utc("2026-10-25T00:30:00Z"));
    const daily = { timezone: "America/New_York", rule: { kind: "daily", time: "01:30" } as const };
    const first = nextDue(daily, utc("2026-10-31T12:00:00Z"));
    expect(first).toBe(utc("2026-11-01T05:30:00Z"));
    // The repeated 01:30 EST an hour later is not a second firing.
    expect(nextDue(daily, first ?? 0)).toBe(utc("2026-11-02T06:30:00Z"));
    const sunday = { timezone: "Europe/Berlin", rule: { kind: "weekly" as const, days: [0], time: "02:30" } };
    const fallBack = nextDue(sunday, utc("2026-10-20T00:00:00Z"));
    expect(fallBack).toBe(utc("2026-10-25T00:30:00Z"));
    expect(nextDue(sunday, fallBack ?? 0)).toBe(utc("2026-11-01T01:30:00Z"));
  });

  it("keeps the local wall time across offset changes and honours weekdays and one-time dates", () => {
    const morning = { timezone: "America/New_York", rule: { kind: "daily", time: "09:00" } as const };
    expect(nextDue(morning, utc("2026-03-07T00:00:00Z"))).toBe(utc("2026-03-07T14:00:00Z"));
    expect(nextDue(morning, utc("2026-03-08T00:00:00Z"))).toBe(utc("2026-03-08T13:00:00Z"));
    // Monday and Friday, from a Saturday.
    const weekly = { timezone: "Asia/Tokyo", rule: { kind: "weekly" as const, days: [1, 5], time: "08:15" } };
    expect(nextDue(weekly, utc("2026-10-24T00:00:00Z"))).toBe(utc("2026-10-25T23:15:00Z"));
    expect(nextDue(weekly, utc("2026-10-25T23:15:00Z"))).toBe(utc("2026-10-29T23:15:00Z"));
    const single = { timezone: "UTC", rule: { kind: "once", date: "2026-12-01", time: "10:00" } as const };
    expect(nextDue(single, utc("2026-11-30T00:00:00Z"))).toBe(utc("2026-12-01T10:00:00Z"));
    expect(nextDue(single, utc("2026-12-01T10:00:00Z"))).toBeUndefined();
  });
});

async function setup() {
  const dataRoot = await mkdtemp(join(tmpdir(), "pal-schedules-"));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  cleanups.push(() => store.close());
  const clock = { now: utc("2030-01-14T08:00:00Z") };
  const chats = new Map<string, ChatSettings>([["chat-1", { configuration: "a".repeat(64), mode: "ask" }]]);
  const submitted: { chatId: string; requestId: string; body: InputBody }[] = [];
  const admissions = new Map<string, Admission>();
  const running = new Set<number>();
  const host = {
    database: store.database,
    now: () => clock.now,
    settings: async (chatId: string) => chats.get(chatId),
    // Request-ID deduplication, as chat admission does.
    submit: async (chatId: string, requestId: string, body: InputBody) => {
      if (!chats.has(chatId)) throw new ChatNotFound("no such chat");
      const previous = admissions.get(requestId);
      if (previous !== undefined) return previous;
      submitted.push({ chatId, requestId, body });
      const admission = { chatId, requestId, submissionId: submitted.length } as unknown as Admission;
      admissions.set(requestId, admission);
      running.add(submitted.length);
      return admission;
    },
    running: async (id: number) => running.has(id),
  };
  const schedules = await Schedules.open(host);
  cleanups.push(() => schedules.close());
  await schedules.setEnabled(true);
  let requests = 0;
  const create = (overrides: Record<string, unknown> = {}, requestId = `schedule-request-${++requests}`) =>
    schedules.create("chat-1", requestId, {
      text: "Check the build",
      timezone: "UTC",
      rule: { kind: "daily", time: "09:00" },
      missed: "skip",
      configuration: "a".repeat(64),
      mode: "ask",
      acknowledged: true,
      ...overrides,
    });
  const at = async (iso: string) => {
    clock.now = utc(iso);
    await schedules.tick();
  };
  return { store, host, schedules, clock, chats, submitted, running, create, at };
}

describe("scheduled messages", () => {
  it("admits each due firing once under a deterministic request ID", async () => {
    const { schedules, create, at, submitted, running } = await setup();
    const schedule = await create();
    expect(schedule.next).toBe(utc("2030-01-14T09:00:00Z"));
    await at("2030-01-14T08:59:59Z");
    expect(submitted).toEqual([]);
    await at("2030-01-14T09:00:20Z");
    await at("2030-01-14T09:01:00Z");
    expect(submitted).toEqual([
      {
        chatId: "chat-1",
        requestId: `schedule-${schedule.id}-1`,
        body: { text: "Check the build", configuration: "a".repeat(64) },
      },
    ]);
    running.clear();
    await at("2030-01-15T09:00:05Z");
    expect(submitted.map((item) => item.requestId)).toEqual([`schedule-${schedule.id}-1`, `schedule-${schedule.id}-2`]);
    const [saved] = await schedules.list("chat-1");
    expect(saved).toMatchObject({ state: "active", fired: 2, next: utc("2030-01-16T09:00:00Z") });
    expect(saved?.history[0]).toMatchObject({ kind: "admitted", due: utc("2030-01-15T09:00:00Z"), submission: 2 });
  });

  it("skips firings missed while Pal was down, or runs only the latest one when asked", async () => {
    const { create, at, submitted, schedules, running } = await setup();
    const skip = await create({ missed: "skip" });
    const catchUp = await create({ missed: "run-once", text: "Catch up" });
    // Three daily firings passed while stopped; Pal starts two hours after the latest.
    await at("2030-01-16T11:00:00Z");
    expect(submitted.map((item) => item.requestId)).toEqual([`schedule-${catchUp.id}-1`]);
    const views = new Map((await schedules.list()).map((item) => [item.id, item]));
    expect(views.get(skip.id)?.history[0]).toMatchObject({
      kind: "missed",
      count: 3,
      due: utc("2030-01-14T09:00:00Z"),
    });
    expect(views.get(catchUp.id)?.history.slice(0, 2)).toMatchObject([
      { kind: "admitted", due: utc("2030-01-16T09:00:00Z") },
      { kind: "missed", count: 2 },
    ]);
    for (const view of views.values()) expect(view.next).toBe(utc("2030-01-17T09:00:00Z"));
    running.clear();
    // Slightly late, within the grace period, is not missed.
    await at(new Date(utc("2030-01-17T09:00:00Z") + MISSED_AFTER_MS - 1000).toISOString());
    expect(submitted).toHaveLength(3);
  });

  it("finishes a one-time message missed by more than the grace period without running it", async () => {
    const { create, at, submitted, schedules } = await setup();
    await create({ rule: { kind: "once", date: "2030-01-14", time: "09:00" } });
    await at("2030-01-14T09:30:00Z");
    expect(submitted).toEqual([]);
    expect((await schedules.list())[0]).toMatchObject({ state: "done", next: null });
  });

  it("skips a firing while the previous run is still working", async () => {
    const { create, at, submitted, running, schedules } = await setup();
    await create();
    await at("2030-01-14T09:00:00Z");
    await at("2030-01-15T09:00:00Z");
    expect(submitted).toHaveLength(1);
    expect((await schedules.list())[0]?.history[0]).toMatchObject({
      kind: "overlap",
      due: utc("2030-01-15T09:00:00Z"),
    });
    running.clear();
    await at("2030-01-16T09:00:00Z");
    expect(submitted).toHaveLength(2);
  });

  it("admits nothing while paused, cancelled or turned off, and never catches up afterwards", async () => {
    const { create, at, submitted, schedules } = await setup();
    const schedule = await create({ missed: "run-once" });
    await schedules.pause("chat-1", schedule.id);
    await at("2030-01-14T09:00:30Z");
    expect(submitted).toEqual([]);
    const resumed = await schedules.resume("chat-1", schedule.id, {
      configuration: "a".repeat(64),
      mode: "ask",
      acknowledged: true,
    });
    expect(resumed).toMatchObject({ state: "active", next: utc("2030-01-15T09:00:00Z") });

    await schedules.setEnabled(false);
    await at("2030-01-15T09:00:00Z");
    expect(submitted).toEqual([]);
    await schedules.setEnabled(true);
    expect((await schedules.list())[0]).toMatchObject({ state: "active", next: utc("2030-01-16T09:00:00Z") });
    await at("2030-01-15T09:01:00Z");
    expect(submitted).toEqual([]);

    await schedules.cancel("chat-1", schedule.id);
    await at("2030-01-16T09:00:00Z");
    expect(submitted).toEqual([]);
    await expect(
      schedules.resume("chat-1", schedule.id, { configuration: "a".repeat(64), mode: "ask", acknowledged: true }),
    ).rejects.toMatchObject({ code: "schedule_finished" });
    await expect(schedules.pause("chat-2", schedule.id)).rejects.toMatchObject({ status: 404 });
  });

  it("pauses instead of running under a different model, command mode or unavailable provider", async () => {
    const { create, at, submitted, schedules, chats } = await setup();
    const schedule = await create();
    chats.set("chat-1", { configuration: "a".repeat(64), mode: "full" });
    await at("2030-01-14T09:00:00Z");
    expect(submitted).toEqual([]);
    const [paused] = await schedules.list();
    expect(paused).toMatchObject({ state: "paused", next: null });
    expect(paused?.history[0]).toMatchObject({ kind: "blocked", due: utc("2030-01-14T09:00:00Z") });
    // Resuming needs the settings the owner now sees.
    const stale = { configuration: "a".repeat(64), mode: "ask", acknowledged: true };
    await expect(schedules.resume("chat-1", schedule.id, stale)).rejects.toMatchObject({ code: "schedule_stale" });
    await schedules.resume("chat-1", schedule.id, { ...stale, mode: "full" });

    chats.set("chat-1", { configuration: "a".repeat(64), mode: "full", problem: "OpenAI API isn't enabled." });
    await at("2030-01-15T09:00:00Z");
    expect(submitted).toEqual([]);
    expect((await schedules.list())[0]).toMatchObject({ state: "paused", reason: "OpenAI API isn't enabled." });
  });

  it("stops after its limit and cancels itself once its chat is deleted", async () => {
    const { create, at, submitted, schedules, chats, running } = await setup();
    const limited = await create({ limit: 2 });
    for (const day of ["14", "15", "16"]) {
      await at(`2030-01-${day}T09:00:00Z`);
      running.clear();
    }
    expect(submitted).toHaveLength(2);
    expect((await schedules.list()).find((item) => item.id === limited.id)).toMatchObject({ state: "done", fired: 2 });

    const orphan = await create();
    chats.delete("chat-1");
    await at("2030-01-17T09:00:00Z");
    expect(submitted).toHaveLength(2);
    expect((await schedules.list()).find((item) => item.id === orphan.id)).toMatchObject({
      state: "cancelled",
      reason: "Its chat was deleted.",
    });
  });

  it("does not bypass the run limit when an interrupted schedule is paused", async () => {
    const { create, schedules, store, at, submitted } = await setup();
    const schedule = await create({ limit: 1 });
    const key = `schedule:${schedule.id}`;
    const row = await store.database.get<{ value: string }>("SELECT value FROM pal_settings WHERE key = ?", key);
    if (row === undefined) throw new Error("missing stored schedule");
    const paused = { ...JSON.parse(row.value), state: "paused", fired: 1, next: null };
    await store.database.run("UPDATE pal_settings SET value = ? WHERE key = ?", JSON.stringify(paused), key);
    await expect(
      schedules.resume("chat-1", schedule.id, { configuration: "a".repeat(64), mode: "ask", acknowledged: true }),
    ).rejects.toMatchObject({ code: "schedule_limit" });
    await at("2030-01-15T09:00:00Z");
    expect(submitted).toEqual([]);
  });

  it("keeps restored completed/cancelled schedules closed and rejects unreadable automation", async () => {
    const { create, store } = await setup();
    const schedule = await create();
    const row = await store.database.get<{ value: string }>(
      "SELECT value FROM pal_settings WHERE key = ?",
      `schedule:${schedule.id}`,
    );
    if (row === undefined) throw new Error("missing stored schedule");
    for (const state of ["done", "cancelled", "paused"]) {
      const stored = JSON.stringify({ ...JSON.parse(row.value), state, next: null });
      expect(pauseRestoredSchedule(stored)).toBe(stored);
    }
    for (const value of [
      "private malformed content",
      "{}",
      JSON.stringify({ ...JSON.parse(row.value), state: "unknown" }),
    ])
      expect(() => pauseRestoredSchedule(value)).toThrow("cannot restore an unreadable schedule");
  });

  it("creates only acknowledged, current, future and bounded schedules, once per request", async () => {
    const { create, schedules } = await setup();
    const first = await create({}, "schedule-create-1");
    expect(await create({}, "schedule-create-1")).toEqual(first);
    await expect(create({ text: "Other" }, "schedule-create-1")).rejects.toBeInstanceOf(RequestConflict);
    await expect(create({ acknowledged: false })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(create({ mode: "full" })).rejects.toMatchObject({ code: "schedule_stale" });
    await expect(create({ timezone: "Mars/Olympus" })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(create({ rule: { kind: "once", date: "2030-02-30", time: "09:00" } })).rejects.toBeInstanceOf(
      InvalidRequest,
    );
    await expect(create({ rule: { kind: "once", date: "2030-01-14", time: "07:00" } })).rejects.toBeInstanceOf(
      InvalidRequest,
    );
    for (let index = 1; index < 20; index++) await create();
    await expect(create()).rejects.toMatchObject({ code: "schedule_limit" });
    await schedules.setEnabled(false);
    await schedules.cancel("chat-1", first.id);
    await expect(create()).rejects.toBeInstanceOf(HttpError);
  });
});

const child = join(import.meta.dirname, "fixtures", "schedules-child.ts");
async function runChild(args: string[]) {
  const proc = spawn(process.execPath, [child, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  proc.stdout.on("data", (chunk) => (output += chunk));
  const [code, signal] = (await once(proc, "exit")) as [number | null, string | null];
  return { code, signal, output };
}

describe("scheduled message recovery", () => {
  it.each(["claimed", "input-recorded", "input-submitted", "input-admitted"])(
    "admits one firing exactly once after SIGKILL at %s",
    async (barrier) => {
      const dataRoot = await mkdtemp(join(tmpdir(), "pal-schedules-recovery-"));
      cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
      const crashed = await runChild(["run", dataRoot, barrier]);
      expect(crashed.signal).toBe("SIGKILL");
      const inspected = await runChild(["inspect", dataRoot]);
      expect(inspected.code).toBe(0);
      const state = JSON.parse(inspected.output);
      expect(state.userMessages).toBe(1);
      expect(state.admissions).toEqual([
        {
          request_id: `schedule-${state.schedule.id}-1`,
          state: "admitted",
          submission_id: state.schedule.history.find((event: { kind: string }) => event.kind === "admitted")
            ?.submission,
        },
      ]);
      expect(state.schedule).toMatchObject({ state: "done", fired: 1 });
      expect(state.schedule.history.filter((event: { kind: string }) => event.kind === "admitted")).toHaveLength(1);
    },
  );
});
