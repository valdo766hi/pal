// Runs each task × harness × repeat in a fresh copy of the task's starting repository, then grades a read-only copy
// of the result with the independent grader. Every run is reported, including failures and interventions.
import { createHash } from "node:crypto";
import type { JsonObject } from "@earendil-works/pi-durable";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { authority, grade, initialSnapshot, repositoryDigest } from "./grade.ts";
import type { Budget, Harness, ModelChoice, RunOutcome } from "./harnesses.ts";
import { summarize } from "./report.ts";
import type { Task } from "./tasks.ts";

export type EvaluationOptions = {
  readonly tasks: readonly Task[];
  readonly harnesses: readonly Harness[];
  readonly model: ModelChoice;
  /** Exact immutable package or mutable runtime digest, shared by Pal and the packaged baseline. */
  readonly implementation: string;
  readonly budget: Budget;
  readonly repeats: number;
  /** A new directory for traces, frozen candidates and the report. */
  readonly output: string;
  /** Recorded so a fixture-driven run can never be mistaken for a model result. */
  readonly modelKind: "provider" | "fixture";
};

export type RunRecord = {
  readonly task: {
    id: string;
    version: number;
    split: string;
    categories: readonly string[];
    /** The task definition and its starting repository. */
    digest: string;
    repository: string;
  };
  readonly harness: { id: string; version: number; matched: boolean; configuration: Readonly<JsonObject> };
  readonly repeat: number;
  readonly elapsedMs: number;
  readonly outcome: Omit<RunOutcome, "trace">;
  readonly trace: { path: string; sha256: string };
  readonly grade:
    | { passed: boolean; failures: string[]; candidate: string; grader: string; path: string }
    | { passed: false; failures: string[]; error: string };
};

/** Copy of a finished workspace with every entry read-only, so grading sees exactly what the run left. */
async function freeze(workspace: string, target: string) {
  await cp(workspace, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
  async function seal(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) for (const name of await readdir(path)) await seal(join(path, name));
    await chmod(path, info.isDirectory() ? 0o555 : 0o444);
  }
  await seal(target);
}

async function unseal(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || info.isSymbolicLink()) return;
  await chmod(path, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const name of await readdir(path)) await unseal(join(path, name));
}

/** One task, harness and repeat: a fresh workspace, the harness run, then independent grading of a frozen copy. */
async function runOnce(
  options: EvaluationOptions,
  task: Task,
  harness: Harness,
  repeat: number,
  scratch: string,
  evaluator: string,
): Promise<RunRecord> {
  const runId = `${task.id}-v${task.version}-${harness.id}-${repeat}`;
  const workspace = join(scratch, runId);
  const repository = await repositoryDigest(task);
  await cp(await initialSnapshot(task), workspace, { recursive: true, errorOnExist: true });
  const started = performance.now();
  let outcome: RunOutcome;
  try {
    outcome = await harness.run({
      workspace,
      prompt: task.prompt,
      continuations: task.continuations ?? [],
      runId,
      budget: options.budget,
    });
  } catch (failure) {
    outcome = {
      status: "harness_error",
      error: failure instanceof Error ? failure.message : String(failure),
      turns: null,
      toolCalls: null,
      failedToolCalls: null,
      interventions: null,
      usage: null,
      trace: null,
    };
  }
  const elapsedMs = Math.round(performance.now() - started);
  const directory = join(options.output, "runs", runId);
  await mkdir(directory, { recursive: true });
  const trace = `${JSON.stringify(outcome.trace)}\n`;
  await writeFile(join(directory, "trace.json"), trace, { mode: 0o600 });
  const summary = {
    status: outcome.status,
    error: outcome.error,
    turns: outcome.turns,
    toolCalls: outcome.toolCalls,
    failedToolCalls: outcome.failedToolCalls,
    interventions: outcome.interventions,
    usage: outcome.usage,
  };
  const candidate = join(directory, "candidate");
  let graded: RunRecord["grade"];
  // A run that could change the grader, tasks or starting snapshots invalidates itself.
  if ((await authority()) !== evaluator) {
    graded = { passed: false, failures: ["evaluator_changed"], error: "the evaluator changed during the run" };
  } else {
    try {
      await freeze(workspace, candidate);
      const result = await grade(candidate, task);
      // Its digest now pins what was graded; the owner can inspect or delete the copy normally.
      await unseal(candidate);
      graded = {
        passed: result.passed,
        failures: result.cases.flatMap((test) => (test.failure === null ? [] : [`${test.id}:${test.failure}`])),
        candidate: result.candidate.digest,
        grader: result.grader.digest,
        path: join("runs", runId, "candidate"),
      };
    } catch (failure) {
      const error = failure instanceof Error ? failure.message : String(failure);
      graded = { passed: false, failures: ["invalid_candidate"], error };
    }
  }
  return {
    task: {
      id: task.id,
      version: task.version,
      split: task.split,
      categories: task.categories,
      digest: createHash("sha256").update(JSON.stringify(task)).digest("hex"),
      repository,
    },
    harness: {
      id: harness.id,
      version: harness.version,
      matched: harness.matched,
      configuration: harness.configuration,
    },
    repeat,
    elapsedMs,
    outcome: summary,
    trace: {
      path: join("runs", runId, "trace.json"),
      sha256: createHash("sha256").update(trace).digest("hex"),
    },
    grade: graded,
  };
}

export async function evaluate(options: EvaluationOptions) {
  if (!Number.isSafeInteger(options.repeats) || options.repeats < 1 || options.repeats > 20)
    throw new Error("use 1–20 repeats");
  if (
    !Number.isSafeInteger(options.budget.seconds) ||
    options.budget.seconds < 1 ||
    options.budget.seconds > 3600 ||
    !Number.isSafeInteger(options.budget.turns) ||
    options.budget.turns < 1 ||
    options.budget.turns > 200
  )
    throw new Error("use a budget of 1–3600 seconds and 1–200 turns");
  for (const [kind, entries] of [
    ["task", options.tasks],
    ["harness", options.harnesses],
  ] as const) {
    const ids = new Set<string>();
    if (entries.length === 0) throw new Error(`select at least one ${kind}`);
    for (const entry of entries) {
      if (
        entry.id.length > 80 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) ||
        ids.has(entry.id) ||
        !Number.isSafeInteger(entry.version) ||
        entry.version < 1
      )
        throw new Error(`invalid or duplicate ${kind} identity: ${entry.id}`);
      ids.add(entry.id);
    }
  }
  await mkdir(options.output, { mode: 0o700 });
  const evaluator = await authority();
  const scratch = await mkdtemp(join(tmpdir(), "pal-evaluation-"));
  const runs: RunRecord[] = [];
  try {
    for (const task of options.tasks)
      for (const harness of options.harnesses)
        for (let repeat = 1; repeat <= options.repeats; repeat++)
          runs.push(await runOnce(options, task, harness, repeat, scratch, evaluator));
  } finally {
    await unseal(scratch);
    await rm(scratch, { recursive: true, force: true });
  }
  const report = {
    format: 1,
    kind: "pal-evaluation",
    notice:
      options.modelKind === "fixture"
        ? "Scripted fixture model: checks the evaluation machinery only. Not a model or harness quality result."
        : "Owner-run provider evaluation. Compare only rows with the same model, settings and budget.",
    generatedAt: new Date().toISOString(),
    evaluator,
    implementation: options.implementation,
    model: { ...options.model, kind: options.modelKind },
    budget: options.budget,
    repeats: options.repeats,
    environment: { platform: platform(), release: release(), arch: arch(), node: process.version },
    runs,
    summary: summarize(runs),
  };
  await writeFile(join(options.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}
