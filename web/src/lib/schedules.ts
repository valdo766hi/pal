import type { ScheduleInput, ScheduleView } from "./api.ts";

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function describeRule(rule: ScheduleInput["rule"], timezone: string): string {
  const at = `at ${rule.time} (${timezone})`;
  if (rule.kind === "once") return `Once on ${rule.date} ${at}`;
  if (rule.kind === "daily") return `Every day ${at}`;
  return `Every ${rule.days.map((day) => WEEKDAYS[day]).join(", ")} ${at}`;
}

const runs = (count: number) => `${count} ${count === 1 ? "run" : "runs"}`;

/** How often it can run, for the cost notice. */
export function frequency(rule: ScheduleInput["rule"], limit: number | undefined): string {
  if (rule.kind === "once") return "One run";
  const most = limit === undefined ? "" : `, at most ${runs(limit)} in total`;
  return `Up to ${runs(rule.kind === "daily" ? 7 : rule.days.length)} a week${most}`;
}

export function describeEvent(event: ScheduleView["history"][number]): string {
  switch (event.kind) {
    case "created":
      return "Scheduled";
    case "admitted":
      return "Sent to the chat";
    case "missed":
      return `Missed ${runs(event.count ?? 1)}${event.detail === undefined ? " while Pal wasn't running" : `: ${event.detail}`}`;
    case "overlap":
      return "Skipped: the previous run was still working";
    case "blocked":
      return `Not sent: ${event.detail ?? "blocked"}`;
    default:
      return { paused: "Paused", resumed: "Resumed", cancelled: "Cancelled", done: "Finished" }[event.kind];
  }
}

export const when = (at: number): string =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
