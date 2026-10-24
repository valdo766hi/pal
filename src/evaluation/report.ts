// Aggregates evaluation runs without hiding failures: success counts with Wilson intervals per harness and split,
// model-matched comparisons separate from unmatched ones, and failure classes ranked as bottlenecks.
import type { RunRecord } from "./run.ts";

/** 95% Wilson score interval for k successes in n runs. */
export function wilson(successes: number, runs: number): { low: number; high: number } {
  if (runs === 0) return { low: 0, high: 1 };
  const z = 1.96,
    p = successes / runs;
  const centre = p + (z * z) / (2 * runs);
  const spread = z * Math.sqrt((p * (1 - p)) / runs + (z * z) / (4 * runs * runs));
  const scale = 1 + (z * z) / runs;
  return { low: Math.max(0, (centre - spread) / scale), high: Math.min(1, (centre + spread) / scale) };
}

function groups(runs: readonly RunRecord[]) {
  const rows = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const key = `${run.harness.id}\u0000${run.task.split}`;
    rows.set(key, [...(rows.get(key) ?? []), run]);
  }
  return [...rows.values()].map((group) => {
    const first = group[0];
    if (first === undefined) throw new Error("empty group");
    const passed = group.filter((run) => run.grade.passed && run.outcome.status === "completed").length;
    const interventions = group.map((run) => run.outcome.interventions);
    const calls = group.map((run) => run.outcome.toolCalls);
    const failedCalls = group.map((run) => run.outcome.failedToolCalls);
    const toolCalls = calls.every((count) => count !== null) ? calls.reduce((sum, count) => sum + count, 0) : null;
    const failedToolCalls = failedCalls.every((count) => count !== null)
      ? failedCalls.reduce((sum, count) => sum + count, 0)
      : null;
    const usage = group.flatMap((run) => (run.outcome.usage === null ? [] : [run.outcome.usage]));
    return {
      harness: first.harness.id,
      matched: first.harness.matched,
      split: first.task.split,
      runs: group.length,
      passed,
      successRate: passed / group.length,
      interval95: wilson(passed, group.length),
      unsuccessful: group.length - passed,
      interventions: interventions.every((count) => count !== null)
        ? interventions.reduce((sum, count) => sum + count, 0)
        : null,
      toolCalls,
      failedToolCalls,
      toolFailureRate:
        toolCalls === null || failedToolCalls === null || toolCalls === 0 ? null : failedToolCalls / toolCalls,
      medianSeconds: median(group.map((run) => run.elapsedMs / 1000)),
      tokens: usage.length === group.length ? usage.reduce((sum, item) => sum + item.totalTokens, 0) : null,
      cost:
        usage.length === group.length && usage.every((item) => item.cost !== null)
          ? usage.reduce((sum, item) => sum + (item.cost ?? 0), 0)
          : null,
    };
  });
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function summarize(runs: readonly RunRecord[]) {
  const failures = new Map<string, { count: number; runs: string[] }>();
  for (const run of runs) {
    const classes = run.grade.failures.map((failure) => `grade:${failure.split(":").at(-1)}`);
    if (run.outcome.status !== "completed") classes.push(`harness:${run.outcome.status}`);
    if ((run.outcome.failedToolCalls ?? 0) > 0)
      classes.push(run.grade.passed ? "tool:recovered_failure" : "tool:failed");
    if ((run.outcome.interventions ?? 0) > 0) classes.push("owner:intervention");
    for (const failure of new Set(classes)) {
      const entry = failures.get(failure) ?? { count: 0, runs: [] };
      entry.count++;
      entry.runs.push(run.trace.path);
      failures.set(failure, entry);
    }
  }
  const all = groups(runs);
  const bottlenecks = [...failures.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([failure, entry]) => ({ failure, runs: entry.count, traces: entry.runs.slice(0, 5) }));
  return {
    matched: all.filter((group) => group.matched),
    unmatched: all.filter((group) => !group.matched),
    bottlenecks,
    // The next milestone follows the most common observed failure; with none observed, broaden the task set.
    nextMilestone:
      bottlenecks[0] === undefined
        ? "No failures observed: add tasks or repeats before drawing conclusions."
        : `Investigate ${bottlenecks[0].failure} (${bottlenecks[0].runs} of ${runs.length} runs) using the linked traces.`,
  };
}

export function markdown(report: {
  notice: string;
  model: { provider: string; modelId: string; effort: string; kind: string };
  summary: ReturnType<typeof summarize>;
  runs: readonly RunRecord[];
}): string {
  const table = (rows: ReturnType<typeof summarize>["matched"]) =>
    rows.length === 0
      ? "None run.\n"
      : [
          "| Harness | Split | Success | 95% interval | Interventions | Failed tools | Median s | Tokens | Cost estimate |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
          ...rows.map(
            (row) =>
              `| ${row.harness} | ${row.split} | ${row.passed}/${row.runs} | ${(row.interval95.low * 100).toFixed(0)}–${(row.interval95.high * 100).toFixed(0)}% | ${row.interventions ?? "unknown"} | ${row.failedToolCalls ?? "unknown"}/${row.toolCalls ?? "unknown"} | ${row.medianSeconds.toFixed(1)} | ${row.tokens ?? "unknown"} | ${row.cost ?? "unknown"} |`,
          ),
        ].join("\n") + "\n";
  return [
    "# Pal evaluation",
    "",
    `> ${report.notice}`,
    "",
    `Model: ${report.model.provider}/${report.model.modelId}, reasoning ${report.model.effort} (${report.model.kind}).`,
    "",
    "Success requires independent grading and completion within budget. A correct but timed-out patch is not a successful run.",
    "Model-matched controls model/reasoning, not identical prompts, tool interfaces or product-native policy. External metrics not reported are unknown.",
    "",
    "## Model-matched harness comparison",
    "",
    table(report.summary.matched),
    "## Unmatched product comparison",
    "",
    table(report.summary.unmatched),
    "## Bottlenecks",
    "",
    ...(report.summary.bottlenecks.length === 0
      ? ["None observed."]
      : report.summary.bottlenecks.map((item) => `- ${item.failure}: ${item.runs} runs (e.g. ${item.traces[0]})`)),
    "",
    `Next milestone: ${report.summary.nextMilestone}`,
    "",
    "## Runs",
    "",
    "| Task | Harness | Repeat | Status | Passed | Failures | Trace |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.runs.map(
      (run) =>
        `| ${run.task.id} v${run.task.version} (${run.task.split}) | ${run.harness.id} | ${run.repeat} | ${run.outcome.status} | ${run.grade.passed ? "yes" : "no"} | ${run.grade.failures.join(", ") || "none"} | ${run.trace.path} |`,
    ),
    "",
  ].join("\n");
}
