import { createHash } from "node:crypto";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { CommandMode } from "./approvals.ts";
import { type Admission, AdmissionStopped, ChatNotFound, ConfigurationRevision, type InputBody } from "./chats.ts";
import { HttpError } from "./http.ts";
import { InvalidRequest, normalize, RequestConflict, validate } from "./requests.ts";

/** Active and paused schedules; finished ones beyond this are pruned oldest first. */
export const MAX_SCHEDULES = 20;
/** A firing noticed this long after its time was missed: Pal was stopped, asleep or restarting. */
export const MISSED_AFTER_MS = 5 * 60_000;
const HISTORY = 20;
const WAKE_MS = 60_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const ENABLED = "scheduler:enabled";

const Clock = Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" });
const Rule = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("once"),
      date: Type.String({ pattern: "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$" }),
      time: Clock,
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("daily"), time: Clock }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal("weekly"),
      /** 0 is Sunday, as in `Date.getDay()`. */
      days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7, uniqueItems: true }),
      time: Clock,
    },
    { additionalProperties: false },
  ),
]);
/** The chat settings the owner saw when approving a schedule; a firing never runs under different ones. */
const Binding = Type.Object(
  { configuration: ConfigurationRevision, mode: Type.Enum(["ask", "full"]) },
  { additionalProperties: false },
);
export const ScheduleBody = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 4000 }),
    timezone: Type.String({ minLength: 1, maxLength: 64 }),
    rule: Rule,
    missed: Type.Enum(["skip", "run-once"]),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    ...Binding.properties,
    acknowledged: Type.Literal(true),
  },
  { additionalProperties: false },
);
export const ResumeBody = Type.Object(
  { ...Binding.properties, acknowledged: Type.Literal(true) },
  { additionalProperties: false },
);
const Event = Type.Object(
  {
    at: Type.Number(),
    kind: Type.Enum(["created", "admitted", "missed", "overlap", "blocked", "paused", "resumed", "cancelled", "done"]),
    due: Type.Optional(Type.Number()),
    count: Type.Optional(Type.Integer({ minimum: 1 })),
    request: Type.Optional(Type.String()),
    submission: Type.Optional(Type.Integer()),
    detail: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
const Stored = Type.Object(
  {
    id: Type.String({ pattern: "^[a-f0-9]{24}$" }),
    chatId: Type.String({ minLength: 1, maxLength: 64 }),
    digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    text: ScheduleBody.properties.text,
    timezone: ScheduleBody.properties.timezone,
    rule: Rule,
    missed: ScheduleBody.properties.missed,
    limit: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    binding: Binding,
    state: Type.Enum(["active", "paused", "cancelled", "done"]),
    reason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    createdAt: Type.Number(),
    next: Type.Union([Type.Number(), Type.Null()]),
    /** The next firing's number, part of its admission request ID. */
    sequence: Type.Integer({ minimum: 1 }),
    fired: Type.Integer({ minimum: 0 }),
    /** A firing claimed but not yet acknowledged by admission; reopening completes it under the same request ID. */
    pending: Type.Union([
      Type.Object(
        { sequence: Type.Integer({ minimum: 1 }), due: Type.Number(), request: Type.String() },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    /** The latest admitted firing's submission, to keep firings from overlapping. */
    last: Type.Union([Type.Integer(), Type.Null()]),
    history: Type.Array(Event, { maxItems: HISTORY }),
  },
  { additionalProperties: false },
);
export type ScheduleInput = Omit<Static<typeof ScheduleBody>, "acknowledged">;
/** What a scheduled run of a chat would cost and could do, shown before the owner approves a schedule. */
export type ScheduleNotice = {
  configuration: string;
  mode: CommandMode;
  model: { provider: string; providerName: string; modelId: string; effort: string } | null;
  cost: string;
  effects: string[];
};
type Schedule = Static<typeof Stored>;
type ScheduleEvent = Static<typeof Event>;
export type ScheduleView = Omit<Schedule, "digest" | "pending" | "last" | "sequence">;

export type ChatSettings = {
  readonly configuration: string;
  readonly mode: CommandMode;
  /** Why the chat's model can't be used now, such as a disabled provider. */
  readonly problem?: string;
};
export type ScheduleHost = {
  readonly database: SqliteDatabase;
  /** The chat's current settings, or undefined once it is deleted. */
  settings(chatId: string): Promise<ChatSettings | undefined>;
  /** Interactive admission: the same grants, model, approvals and request-ID deduplication as a typed message. */
  submit(chatId: string, requestId: string, body: InputBody): Promise<Admission>;
  /** Whether a submission is still queued or running. */
  running(submissionId: number): Promise<boolean>;
  readonly now?: () => number;
  /** Crash point between claiming a firing and admitting it, for recovery tests. */
  readonly barrier?: (point: "claimed") => void | Promise<void>;
};

/**
 * Opt-in scheduled messages. A firing is claimed in Pal's store under a deterministic request ID before it is
 * admitted to its chat, so a restart completes it rather than repeating it. Trigger times are computed here; what a
 * run may do is decided by the chat's own grants and approvals, exactly as for a typed message.
 */
export class Schedules {
  readonly #host: ScheduleHost;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #stopped = false;

  private constructor(host: ScheduleHost) {
    this.#host = host;
    this.#now = host.now ?? Date.now;
  }

  /** Complete firings claimed before a crash, then wake for the next due one if scheduling is on. */
  static async open(host: ScheduleHost): Promise<Schedules> {
    const schedules = new Schedules(host);
    await schedules.#exclusive(async () => {
      for (const schedule of await schedules.#all()) if (schedule.pending !== null) await schedules.#complete(schedule);
    });
    return schedules;
  }

  async enabled(db: SqliteExecutor = this.#host.database): Promise<boolean> {
    return (
      (await db.get("SELECT 1 AS enabled FROM pal_settings WHERE key = ? AND value = 'true'", ENABLED)) !== undefined
    );
  }

  /** Turning scheduling back on starts from now; firings due while it was off are not run. */
  setEnabled(enabled: boolean): Promise<void> {
    return this.#exclusive(async () => {
      const now = this.#now();
      await this.#host.database.transaction(async (tx) => {
        const was = await this.enabled(tx);
        await tx.run(
          "INSERT INTO pal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          ENABLED,
          String(enabled),
        );
        if (!enabled || was) return;
        for (const schedule of await this.#all(tx)) {
          if (schedule.state !== "active") continue;
          const next = nextDue(schedule, now);
          if (schedule.next !== null && schedule.next <= now)
            record(schedule, { at: now, kind: "missed", due: schedule.next, detail: "Scheduled messages were off." });
          if (next === undefined) finish(schedule, now, "Its time passed while scheduled messages were off.");
          else schedule.next = next;
          await save(tx, schedule);
        }
      });
    });
  }

  async list(chatId?: string): Promise<ScheduleView[]> {
    return (await this.#all())
      .filter((schedule) => chatId === undefined || schedule.chatId === chatId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(view);
  }

  async create(chatId: string, requestId: unknown, input: unknown): Promise<ScheduleView> {
    const { key, digest } = normalize(requestId, ScheduleBody, input, (body) => ({
      chatId,
      text: body.text,
      timezone: body.timezone,
      rule: ordered(body.rule),
      missed: body.missed,
      limit: body.limit ?? null,
      configuration: body.configuration,
      mode: body.mode,
    }));
    const body = input as Static<typeof ScheduleBody>;
    const id = createHash("sha256").update(`${chatId}\u0000${key}`).digest("hex").slice(0, 24);
    return this.#exclusive(async () => {
      const existing = await this.#get(id);
      if (existing !== undefined) {
        if (existing.digest !== digest) throw new RequestConflict(`request ${key} created a different schedule`);
        return view(existing);
      }
      if (!(await this.enabled()))
        throw new HttpError(409, "scheduler_disabled", "Turn on scheduled messages in Settings → General first.");
      await this.#current(chatId, body);
      const timezone = zone(body.timezone);
      const now = this.#now();
      const schedule: Schedule = {
        id,
        chatId,
        digest,
        text: body.text,
        timezone,
        rule: ordered(checkedDate(body.rule)),
        missed: body.missed,
        limit: body.rule.kind === "once" ? 1 : (body.limit ?? null),
        binding: { configuration: body.configuration, mode: body.mode },
        state: "active",
        reason: null,
        createdAt: now,
        next: null,
        sequence: 1,
        fired: 0,
        pending: null,
        last: null,
        history: [{ at: now, kind: "created" }],
      };
      const next = nextDue(schedule, now);
      if (next === undefined) throw new InvalidRequest("choose a time in the future");
      schedule.next = next;
      await this.#host.database.transaction(async (tx) => {
        const all = await this.#all(tx);
        if (all.filter((item) => item.state === "active" || item.state === "paused").length >= MAX_SCHEDULES)
          throw new HttpError(409, "schedule_limit", `Pal keeps at most ${MAX_SCHEDULES} schedules. Cancel one first.`);
        const finished = all
          .filter((item) => item.state === "cancelled" || item.state === "done")
          .sort((a, b) => b.createdAt - a.createdAt);
        for (const old of finished.slice(MAX_SCHEDULES))
          await tx.run("DELETE FROM pal_settings WHERE key = ?", `schedule:${old.id}`);
        await save(tx, schedule);
      });
      return view(schedule);
    });
  }

  pause(chatId: string, id: string): Promise<ScheduleView> {
    return this.#change(chatId, id, (schedule, now) => {
      if (schedule.state === "paused") return;
      if (schedule.state !== "active") throw finished(schedule);
      schedule.state = "paused";
      schedule.reason = null;
      schedule.next = null;
      record(schedule, { at: now, kind: "paused" });
    });
  }

  /** Rebinds the schedule to the chat settings the owner reviewed now; nothing missed while paused is run. */
  async resume(chatId: string, id: string, input: unknown): Promise<ScheduleView> {
    const body = validate(ResumeBody, input);
    return this.#change(chatId, id, async (schedule, now) => {
      if (schedule.state === "active") return;
      if (schedule.state !== "paused") throw finished(schedule);
      if (schedule.limit !== null && schedule.fired >= schedule.limit)
        throw new HttpError(409, "schedule_limit", "This schedule reached its run limit. Review and create a new one.");
      await this.#current(chatId, body);
      const next = nextDue(schedule, now);
      if (next === undefined)
        throw new HttpError(409, "schedule_passed", "This one-time message's time has passed. Schedule a new one.");
      schedule.binding = { configuration: body.configuration, mode: body.mode };
      schedule.state = "active";
      schedule.reason = null;
      schedule.next = next;
      record(schedule, { at: now, kind: "resumed" });
    });
  }

  cancel(chatId: string, id: string): Promise<ScheduleView> {
    return this.#change(chatId, id, (schedule, now) => {
      if (schedule.state === "cancelled" || schedule.state === "done") return;
      schedule.state = "cancelled";
      schedule.reason = null;
      schedule.next = null;
      record(schedule, { at: now, kind: "cancelled" });
    });
  }

  /** Admit every due firing once. The timer calls this; tests call it with their own clock. */
  tick(): Promise<void> {
    return this.#exclusive(async () => {
      if (!(await this.enabled())) return;
      const now = this.#now();
      for (const schedule of await this.#all())
        if (schedule.state === "active" && schedule.next !== null && schedule.next <= now)
          await this.#fire(schedule, now);
    });
  }

  /** Stop waking and wait for a firing in progress; its claim, if unfinished, completes on the next open. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    await this.#queue.catch(() => {});
  }

  async #fire(schedule: Schedule, now: number) {
    const { first, latest, count } = dueBy(schedule, now);
    const run = now - latest <= MISSED_AFTER_MS || schedule.missed === "run-once";
    const missed = run ? count - 1 : count;
    if (missed > 0) record(schedule, { at: now, kind: "missed", due: first, count: missed });
    const next = nextDue(schedule, now);
    schedule.next = next ?? null;
    if (!run) {
      if (next === undefined) finish(schedule, now, "Its time passed while Pal was not running.");
      return this.#save(schedule);
    }
    const settings = await this.#host.settings(schedule.chatId);
    if (settings === undefined) {
      schedule.state = "cancelled";
      schedule.reason = "Its chat was deleted.";
      schedule.next = null;
      record(schedule, { at: now, kind: "cancelled", due: latest, detail: schedule.reason });
      return this.#save(schedule);
    }
    const problem =
      settings.problem ??
      (settings.configuration !== schedule.binding.configuration || settings.mode !== schedule.binding.mode
        ? "This chat's model or command mode changed after the schedule was approved. Review and resume it."
        : undefined);
    if (problem !== undefined) return this.#block(schedule, now, latest, problem);
    if (schedule.last !== null && (await this.#host.running(schedule.last))) {
      record(schedule, { at: now, kind: "overlap", due: latest, detail: "The previous run was still working." });
      if (next === undefined) finish(schedule, now, "Its only run overlapped a run still working.");
      return this.#save(schedule);
    }
    schedule.pending = {
      sequence: schedule.sequence,
      due: latest,
      request: `schedule-${schedule.id}-${schedule.sequence}`,
    };
    schedule.sequence++;
    schedule.fired++;
    if (next === undefined || (schedule.limit !== null && schedule.fired >= schedule.limit)) {
      schedule.state = "done";
      schedule.next = null;
    }
    await this.#save(schedule);
    await this.#host.barrier?.("claimed");
    await this.#complete(schedule);
  }

  /** Admit a claimed firing; repeating its request ID after a crash returns the original admission. */
  async #complete(schedule: Schedule) {
    const pending = schedule.pending;
    if (pending === null) return;
    const now = this.#now();
    try {
      const admission = await this.#host.submit(schedule.chatId, pending.request, {
        text: schedule.text,
        configuration: schedule.binding.configuration,
      });
      schedule.last = admission.submissionId;
      record(schedule, {
        at: now,
        kind: "admitted",
        due: pending.due,
        request: pending.request,
        submission: admission.submissionId,
      });
      if (schedule.state === "done") record(schedule, { at: now, kind: "done" });
    } catch (error) {
      // Admission must restart and reconcile; the claim stays so reopening completes it.
      if (error instanceof AdmissionStopped) {
        this.#stopped = true;
        throw error;
      }
      schedule.pending = null;
      if (error instanceof ChatNotFound) {
        schedule.state = "cancelled";
        schedule.reason = "Its chat was deleted.";
        schedule.next = null;
        record(schedule, { at: now, kind: "cancelled", due: pending.due, detail: schedule.reason });
        return this.#save(schedule);
      }
      return this.#block(schedule, now, pending.due, error instanceof Error ? error.message : String(error));
    }
    schedule.pending = null;
    await this.#save(schedule);
  }

  #block(schedule: Schedule, now: number, due: number, detail: string) {
    record(schedule, { at: now, kind: "blocked", due, detail: detail.slice(0, 500) });
    if (schedule.state !== "done") {
      schedule.state = "paused";
      schedule.next = null;
    }
    schedule.reason = detail.slice(0, 500);
    return this.#save(schedule);
  }

  async #current(chatId: string, expected: Static<typeof Binding>) {
    const settings = await this.#host.settings(chatId);
    if (settings === undefined) throw new ChatNotFound("no such chat");
    if (settings.problem !== undefined) throw new HttpError(409, "model_unavailable", settings.problem);
    if (settings.configuration !== expected.configuration || settings.mode !== expected.mode)
      throw new HttpError(
        409,
        "schedule_stale",
        "This chat's model or command mode changed. Review the updated cost and effects before scheduling.",
      );
  }

  #change(chatId: string, id: string, apply: (schedule: Schedule, now: number) => void | Promise<void>) {
    return this.#exclusive(async () => {
      const schedule = await this.#get(id);
      if (schedule?.chatId !== chatId) throw new HttpError(404, "not_found", "no such schedule");
      await apply(schedule, this.#now());
      await this.#save(schedule);
      return view(schedule);
    });
  }

  async #save(schedule: Schedule) {
    await save(this.#host.database, schedule);
  }

  async #get(id: string): Promise<Schedule | undefined> {
    const row = await this.#host.database.get<{ value: string }>(
      "SELECT value FROM pal_settings WHERE key = ?",
      `schedule:${id}`,
    );
    return row === undefined ? undefined : parse(`schedule:${id}`, row.value);
  }

  async #all(db: SqliteExecutor = this.#host.database): Promise<Schedule[]> {
    const rows = await db.all<{ key: string; value: string }>(
      "SELECT key, value FROM pal_settings WHERE key GLOB 'schedule:*' ORDER BY key",
    );
    return rows.flatMap((row) => parse(row.key, row.value) ?? []);
  }

  /** One firing, change or reschedule at a time; each ends by arming the timer for the next due firing. */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const job = this.#queue
      .catch(() => {})
      .then(async () => {
        try {
          return await work();
        } finally {
          await this.#arm();
        }
      });
    this.#queue = job;
    return job;
  }

  async #arm() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#closed || this.#stopped || !(await this.enabled())) return;
    const due = (await this.#all()).flatMap((schedule) =>
      schedule.state === "active" && schedule.next !== null ? [schedule.next] : [],
    );
    if (due.length === 0) return;
    // Waking at least every minute keeps firings close to the wall clock across sleep and clock changes.
    this.#timer = setTimeout(
      () =>
        void this.tick().catch((error: unknown) => {
          this.#stopped = true;
          clearTimeout(this.#timer);
          console.error(
            "pal: scheduled messages stopped until restart:",
            error instanceof Error ? error.message : error,
          );
        }),
      Math.min(Math.max(Math.min(...due) - this.#now(), 0), WAKE_MS),
    );
    this.#timer.unref();
  }
}

function view(schedule: Schedule): ScheduleView {
  const { id, chatId, text, timezone, rule, missed, limit, binding, state, reason, createdAt, next, fired } = schedule;
  return {
    id,
    chatId,
    text,
    timezone,
    rule,
    missed,
    limit,
    binding,
    state,
    reason,
    createdAt,
    next,
    fired,
    history: schedule.history.toReversed(),
  };
}

function parse(key: string, value: string): Schedule | undefined {
  try {
    const schedule: unknown = JSON.parse(value);
    if (Value.Check(Stored, schedule)) return schedule;
  } catch {
    // Reported below.
  }
  console.error(`pal: ignoring an unreadable schedule ${key}`);
  return undefined;
}

function save(db: SqliteExecutor, schedule: Schedule) {
  return db.run(
    "INSERT INTO pal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    `schedule:${schedule.id}`,
    JSON.stringify(schedule),
  );
}

function record(schedule: Schedule, event: ScheduleEvent) {
  schedule.history = [...schedule.history, event].slice(-HISTORY);
}

function finish(schedule: Schedule, now: number, reason: string) {
  schedule.state = "done";
  schedule.reason = reason;
  schedule.next = null;
  record(schedule, { at: now, kind: "done", detail: reason });
}

/** Restore never retries automation; retain a claimed request as recovery evidence, not a fresh admission. */
export function pauseRestoredSchedule(value: string): string {
  let schedule: Schedule;
  try {
    schedule = validate(Stored, JSON.parse(value));
  } catch {
    throw new Error("cannot restore an unreadable schedule");
  }
  if (schedule.state !== "active" && schedule.pending === null) return value;
  const pending = schedule.pending;
  if (schedule.state !== "cancelled") schedule.state = "paused";
  schedule.next = null;
  schedule.pending = null;
  schedule.reason =
    "Restored backup: review chat outcomes before resuming automation." +
    (pending === null ? "" : ` Claimed request: ${pending.request}.`);
  record(schedule, {
    at: Date.now(),
    kind: schedule.state === "cancelled" ? "cancelled" : "paused",
    detail: schedule.reason,
    ...(pending === null ? {} : { request: pending.request, due: pending.due }),
  });
  return JSON.stringify(schedule);
}

function finished(schedule: Schedule) {
  return new HttpError(
    409,
    "schedule_finished",
    `This schedule is ${schedule.state === "done" ? "finished" : "cancelled"}.`,
  );
}

function zone(name: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    throw new InvalidRequest(`unknown time zone ${name}`);
  }
}

function checkedDate(rule: Static<typeof Rule>): Static<typeof Rule> {
  if (rule.kind !== "once") return rule;
  const [year = 0, month = 0, day = 0] = rule.date.split("-").map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) throw new InvalidRequest("no such date");
  return rule;
}

/** Fixed key order and sorted days, so equal requests digest equally. */
function ordered(rule: Static<typeof Rule>): Static<typeof Rule> {
  if (rule.kind === "once") return { kind: rule.kind, date: rule.date, time: rule.time };
  if (rule.kind === "daily") return { kind: rule.kind, time: rule.time };
  return { kind: rule.kind, days: [...rule.days].sort((a, b) => a - b), time: rule.time };
}

const formats = new Map<string, Intl.DateTimeFormat>();
/** The zone's wall clock at an instant, written as if it were UTC. */
function wall(timezone: string, instant: number): number {
  let format = formats.get(timezone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(timezone, format);
  }
  const part = Object.fromEntries(format.formatToParts(instant).map((item) => [item.type, Number(item.value)]));
  return Date.UTC(
    part.year ?? 0,
    (part.month ?? 1) - 1,
    part.day ?? 1,
    part.hour ?? 0,
    part.minute ?? 0,
    part.second ?? 0,
  );
}

/**
 * The instant a zone's clock shows a wall time. A time repeated when clocks go back is its first occurrence; a time
 * skipped when they go forward runs that much later (02:30 becomes 03:30), as the pre-transition offset gives.
 */
export function instantAt(timezone: string, local: number): number {
  const before = wall(timezone, local - DAY) - (local - DAY);
  const after = wall(timezone, local + DAY) - (local + DAY);
  const exact = [local - before, local - after].filter((instant) => wall(timezone, instant) === local);
  return exact.length > 0 ? Math.min(...exact) : local - before;
}

/** The firing times due by `now`, from the schedule's next one: the first, the latest and how many (at most 1000). */
function dueBy(schedule: Schedule, now: number) {
  const first = schedule.next ?? now;
  let latest = first,
    count = 1;
  for (
    let due = nextDue(schedule, first);
    due !== undefined && due <= now && count < 1000;
    due = nextDue(schedule, due)
  ) {
    latest = due;
    count++;
  }
  return { first, latest, count };
}

/** The first firing time strictly after `after`, or undefined when a one-time schedule has none left. */
export function nextDue(schedule: Pick<Schedule, "rule" | "timezone">, after: number): number | undefined {
  const { rule, timezone } = schedule;
  const [hour = 0, minute = 0] = rule.time.split(":").map(Number);
  if (rule.kind === "once") {
    const [year = 0, month = 0, day = 0] = rule.date.split("-").map(Number);
    const at = instantAt(timezone, Date.UTC(year, month - 1, day, hour, minute));
    return at > after ? at : undefined;
  }
  const today = Math.floor(wall(timezone, after) / DAY) * DAY;
  for (let offset = 0; offset <= 8; offset++) {
    const day = today + offset * DAY;
    if (rule.kind === "weekly" && !rule.days.includes(new Date(day).getUTCDay())) continue;
    const at = instantAt(timezone, day + (hour * 60 + minute) * MINUTE);
    if (at > after) return at;
  }
  return undefined;
}
