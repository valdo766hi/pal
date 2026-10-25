import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { openPal } from "../src/core/app.ts";
import { baselineHarness, externalHarness, type Harness, palHarness } from "../src/evaluation/harnesses.ts";
import { markdown, summarize, wilson } from "../src/evaluation/report.ts";
import { evaluate } from "../src/evaluation/run.ts";
import { dependencyPlan, revisedDependencyPlan, TASKS } from "../src/evaluation/tasks.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fixtures = new URL("fixtures/evaluation/", import.meta.url);
const read = (path: string) => readFile(new URL(path, fixtures), "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ANSWER = JSON.stringify({ importers: ["src/api.mjs", "src/cli.mjs", "src/db.mjs"] });
const initialTasks = TASKS.filter((task) => task.id !== dependencyPlan.id && task.id !== revisedDependencyPlan.id);

/** Scripted model turns: these check the machinery and say nothing about any model's quality. */
async function solutions() {
  const prices = await read("fixed/src/prices.mjs"),
    receipt = await read("fixed/src/receipt.mjs");
  const buggyPrices = await read("buggy/src/prices.mjs"),
    buggyReceipt = await read("buggy/src/receipt.mjs"),
    continuedReceipt = await read("continued-fixed/src/receipt.mjs");
  const done = fauxAssistantMessage("done");
  const code = (body: string) =>
    fauxAssistantMessage(fauxToolCall("codemode", { code: body }), { stopReason: "toolUse" });
  const write = (files: Record<string, string>) =>
    fauxAssistantMessage(
      Object.entries(files).map(([path, content]) => fauxToolCall("write_file", { path, content })),
      { stopReason: "toolUse" },
    );
  const patch = code(
    `await tools.files_write({path:"src/prices.mjs",content:${JSON.stringify(prices)},expectedHash:${JSON.stringify(sha256(buggyPrices))}});` +
      `await tools.files_write({path:"src/receipt.mjs",content:${JSON.stringify(receipt)},expectedHash:${JSON.stringify(sha256(buggyReceipt))}});`,
  );
  const baselinePatch = write({ "src/prices.mjs": prices, "src/receipt.mjs": receipt });
  const checkoutTasks = new Set(["checkout-rounding", "checkout-owner-correction", "checkout-context-checkpoint"]);
  return {
    pal: (task: string): AssistantMessage[] =>
      task === "checkout-verifier-fallback"
        ? [
            code('return await tools.shell_run({command:"node verify.mjs", timeout:5});'),
            patch,
            code('return await tools.shell_run({command:"node test.mjs", timeout:5});'),
            done,
          ]
        : checkoutTasks.has(task)
          ? [
              patch,
              done,
              ...(task !== "checkout-rounding"
                ? [
                    code(
                      `await tools.files_write({path:"src/receipt.mjs",content:${JSON.stringify(continuedReceipt)},expectedHash:${JSON.stringify(sha256(receipt))}});`,
                    ),
                    done,
                  ]
                : []),
            ]
          : task === "module-inventory"
            ? [
                code('await tools.shell_run({command:"ls src", timeout: 5});'),
                code(
                  `await tools.files_write({path:"inventory.json",content:${JSON.stringify(ANSWER)},expectedHash:null});`,
                ),
                done,
              ]
            : [done],
    baseline: (task: string): AssistantMessage[] =>
      task === "checkout-verifier-fallback"
        ? [
            fauxAssistantMessage(fauxToolCall("run", { command: "node verify.mjs" }), { stopReason: "toolUse" }),
            baselinePatch,
            fauxAssistantMessage(fauxToolCall("run", { command: "node test.mjs" }), { stopReason: "toolUse" }),
            done,
          ]
        : checkoutTasks.has(task)
          ? [
              baselinePatch,
              done,
              ...(task === "checkout-context-checkpoint"
                ? [
                    fauxAssistantMessage(
                      "Retain unit rounding and the completed patch while awaiting the next request.",
                    ),
                  ]
                : []),
              ...(task !== "checkout-rounding" ? [write({ "src/receipt.mjs": continuedReceipt }), done] : []),
            ]
          : task === "module-inventory"
            ? [write({ "inventory.json": JSON.stringify({ importers: ["src/db.mjs"] }) }), done]
            : [done],
  };
}

async function dependencySolutions(kind: string, continued: boolean): Promise<AssistantMessage[]> {
  const graph = await read("dependency-plan-fixed/src/graph.mjs");
  const final = await read("dependency-plan-fixed/src/plan.mjs");
  const decision = "const found = ignored.has(root) ? undefined : closure(modules, root);";
  expect(final.split(decision)).toHaveLength(2);
  const base = final.replace(decision, "const found = closure(modules, root);");
  const transitive = final.replace(
    decision,
    "const found = closure(modules, root); " +
      "if (found && [...found].some(id => ignored.has(id))) { blocked.push(root); continue; }",
  );
  let previous = await read("dependency-plan/src/plan.mjs");
  const turns: AssistantMessage[] = [];
  for (const [index, plan] of (continued ? [base, transitive, final] : [base]).entries()) {
    if (index > 0 && kind === "baseline")
      turns.push(
        fauxAssistantMessage("Retain deterministic dependency-first ordering, validation and the latest owner policy."),
      );
    const changes: Record<string, { content: string; before: string }> = {
      ...(index === 0
        ? { "src/graph.mjs": { content: graph, before: await read("dependency-plan/src/graph.mjs") } }
        : {}),
      "src/plan.mjs": { content: plan, before: previous },
    };
    turns.push(
      kind === "pal"
        ? fauxAssistantMessage(
            fauxToolCall("codemode", {
              code:
                Object.entries(changes)
                  .map(
                    ([path, file]) =>
                      `await tools.files_write(${JSON.stringify({ path, content: file.content, expectedHash: sha256(file.before) })});`,
                  )
                  .join("\n") + '\nreturn await tools.shell_run({command:"node test.mjs",timeout:5});',
            }),
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage(
            [
              ...Object.entries(changes).map(([path, file]) =>
                fauxToolCall("write_file", { path, content: file.content }),
              ),
              fauxToolCall("run", { command: "node test.mjs" }),
            ],
            { stopReason: "toolUse" },
          ),
      fauxAssistantMessage(`Completed fixture stage ${index}.`),
    );
    previous = plan;
  }
  return turns;
}

describe("evaluation runner", () => {
  it.each([0, 2, 4])("grades all harnesses and repeats for task pair %i", async (offset) => {
    expect(initialTasks).toHaveLength(6);
    const tasks = initialTasks.slice(offset, offset + 2);
    expect(tasks).toHaveLength(2);
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-evaluation-test-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const options = { dataRoot: join(root, "data"), installRoot: join(root, "install") };
    let pal = await openPal(options, context);
    cleanups.push(() => pal.close());
    const faux = fauxProvider();
    const useFaux = () => (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    useFaux();
    const reopen = async () => {
      await pal.close();
      pal = await openPal(options, context);
      useFaux();
      return pal;
    };
    const model = faux.getModel();
    const choice = { provider: model.provider, modelId: model.id, effort: "off" } as const;
    const script = await solutions();
    // Each run gets its harness's turns for its task; the shared faux model is otherwise one queue.
    const scripted = (harness: Harness, turns: (task: string) => AssistantMessage[]): Harness => ({
      ...harness,
      run: (input) => {
        faux.setResponses(turns(TASKS.find((task) => input.runId.startsWith(`${task.id}-`))?.id ?? ""));
        return harness.run(input);
      },
    });
    // Only PAL_EVAL_PROMPT reaches the external command, so its answer is part of the command itself.
    const external = externalHarness(
      "external-cli",
      `if [ -f src/config.mjs ]; then printf %s '${ANSWER}' > inventory.json; elif [ -f verify.mjs ] || [ -f src/slug.mjs ]; then exit 69; else sleep 5; fi`,
    );
    const output = join(root, "report");
    const report = await evaluate({
      tasks,
      harnesses: [
        scripted(palHarness(pal, choice, "approve-all", reopen), script.pal),
        scripted(
          baselineHarness(() => pal.models, model, choice),
          script.baseline,
        ),
        { ...external, run: (input) => external.run({ ...input, budget: { ...input.budget, seconds: 2 } }) },
      ],
      model: choice,
      implementation: (await pal.extensions.view()).release,
      budget: { seconds: 60, turns: 10 },
      repeats: 2,
      output,
      modelKind: "fixture",
    });

    expect(report.notice).toContain("Not a model or harness quality result");
    expect(report.runs).toHaveLength(tasks.length * 3 * 2);
    const runs = (task: string, harness: string) =>
      report.runs.filter((run) => run.task.id === task && run.harness.id === harness);
    for (const task of tasks)
      for (const harness of ["pal", "baseline-loop", "external-cli"]) expect(runs(task.id, harness)).toHaveLength(2);
    if (tasks.some((task) => task.id === "checkout-rounding"))
      for (const harness of ["pal", "baseline-loop"])
        expect(runs("checkout-rounding", harness).map((run) => run.grade.passed)).toEqual([true, true]);
    for (const task of ["checkout-owner-correction", "checkout-context-checkpoint"])
      for (const harness of ["pal", "baseline-loop"])
        for (const run of runs(task, harness)) {
          expect(run.grade.passed).toBe(true);
          expect(run.outcome).toMatchObject({
            status: "completed",
            turns: task === "checkout-context-checkpoint" && harness === "baseline-loop" ? 5 : 4,
            interventions: 1,
          });
        }
    for (const harness of ["pal", "baseline-loop"])
      for (const run of runs("checkout-verifier-fallback", harness)) {
        expect(run.grade.passed).toBe(true);
        expect(run.outcome).toMatchObject({
          status: "completed",
          turns: 4,
          interventions: harness === "pal" ? 2 : 0,
        });
        if (harness === "baseline-loop") expect(run.outcome.failedToolCalls).toBe(1);
      }
    for (const task of ["checkout-verifier-fallback", "slug-test-repair"])
      for (const run of runs(task, "external-cli")) expect(run.outcome.status).toBe("harness_error");
    for (const run of runs("module-inventory", "pal")) {
      expect(run.grade.passed).toBe(true);
      // Pal asked to run a command; the runner's approval is an owner decision and is counted.
      expect(run.outcome.interventions).toBe(1);
    }
    for (const run of runs("module-inventory", "baseline-loop"))
      expect(run.grade).toMatchObject({ passed: false, failures: ["answer:incorrect_output"] });
    for (const run of runs("module-inventory", "external-cli")) expect(run.grade.passed).toBe(true);
    for (const run of runs("checkout-rounding", "external-cli"))
      expect(run.outcome).toMatchObject({ status: "budget_exceeded" });
    for (const run of runs("slug-test-repair", "pal")) {
      expect(run.task.split).toBe("held-out");
      expect(run.grade.passed).toBe(false);
      expect(run.grade.failures).toContain("public:incorrect_output");
    }

    // Every score links to its task, trace, frozen candidate and grader digests.
    for (const run of report.runs) {
      const trace = await readFile(join(output, run.trace.path), "utf8");
      expect(sha256(trace)).toBe(run.trace.sha256);
      expect(run.task.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(run.task.repository).toMatch(/^[a-f0-9]{64}$/);
      if ("candidate" in run.grade) expect(run.grade.grader).toMatch(/^[a-f0-9]{64}$/);
      if (run.task.id === "checkout-context-checkpoint") {
        expect(run.task.version).toBe(2);
        if (run.harness.id === "pal") {
          const journal = JSON.parse(trace) as { conversations: { entries: { kind: string; data: unknown }[] }[] };
          expect(
            journal.conversations.flatMap(({ entries }) =>
              entries.filter((entry) => entry.kind === "pal.evaluation-checkpoint").map((entry) => entry.data),
            ),
          ).toEqual([expect.objectContaining({ type: "restart", release: report.implementation, turns: 2 })]);
        } else if (run.harness.id === "baseline-loop") {
          const journal = JSON.parse(trace) as {
            messages: { role: string; content: unknown }[];
            checkpoints: unknown[];
          };
          const summary = journal.messages.findIndex(
            (message) =>
              message.role === "user" &&
              typeof message.content === "string" &&
              message.content.startsWith("Summarize this coding conversation"),
          );
          expect(summary).toBeGreaterThan(0);
          expect(journal.checkpoints).toEqual([
            { type: "context-checkpoint-reload", sha256: sha256(JSON.stringify(journal.messages.slice(0, summary))) },
          ]);
        }
      }
      if (run.task.id === "checkout-verifier-fallback" && run.harness.id === "pal") {
        const journal = JSON.parse(trace) as {
          conversations: {
            entries: { kind: string; data?: { shell?: { status: string; command: string; exitCode: number } } }[];
          }[];
        };
        const commands = journal.conversations.flatMap(({ entries }) =>
          entries.flatMap((entry) => {
            const shell = entry.kind === "pal.shell" ? entry.data?.shell : undefined;
            return shell?.status === "finished" ? [{ command: shell.command, exitCode: shell.exitCode }] : [];
          }),
        );
        expect(commands).toEqual([
          { command: "node verify.mjs", exitCode: 69 },
          { command: "node test.mjs", exitCode: 0 },
        ]);
      }
    }
    expect(report.evaluator).toMatch(/^[a-f0-9]{64}$/);
    expect(report.implementation).toBe((await pal.extensions.view()).release);
    const bothSplits = tasks.some((task) => task.split === "held-out");
    expect(report.summary.matched.map((row) => `${row.harness}/${row.split}`).sort()).toEqual(
      bothSplits
        ? ["baseline-loop/development", "baseline-loop/held-out", "pal/development", "pal/held-out"]
        : ["baseline-loop/development", "pal/development"],
    );
    expect(report.summary.unmatched.map((row) => row.harness)).toEqual(
      bothSplits ? ["external-cli", "external-cli"] : ["external-cli"],
    );
    expect(report.summary.unmatched[0]).toMatchObject({ interventions: null, toolCalls: null, toolFailureRate: null });
    const developmentRuns = tasks.filter((task) => task.split === "development").length * 2;
    const interventions: Record<string, number> = {
      "checkout-rounding": 0,
      "module-inventory": 2,
      "slug-test-repair": 0,
      "checkout-owner-correction": 2,
      "checkout-context-checkpoint": 2,
      "checkout-verifier-fallback": 4,
    };
    expect(report.summary.matched.find((row) => row.harness === "pal" && row.split === "development")).toMatchObject({
      runs: developmentRuns,
      passed: developmentRuns,
      interventions: tasks.reduce((sum, task) => sum + (interventions[task.id] ?? NaN), 0),
      interval95: wilson(developmentRuns, developmentRuns),
    });
    if (tasks.some((task) => task.id === "module-inventory")) {
      const correct = runs("module-inventory", "pal")[0];
      if (correct === undefined) throw new Error("missing control run");
      expect(correct.harness.configuration).toMatchObject({ model: choice, approvals: "approve-all" });
      const exceeded = { ...correct, outcome: { ...correct.outcome, status: "budget_exceeded" as const } };
      expect(summarize([exceeded]).matched[0]).toMatchObject({ passed: 0, unsuccessful: 1 });
    }
    expect(report.summary.bottlenecks[0]?.runs).toBeGreaterThan(0);
    expect(report.summary.nextMilestone).toContain("Investigate");
    const text = markdown(report);
    expect(text).toContain("## Model-matched harness comparison");
    expect(text).toContain("## Unmatched product comparison");
    expect(JSON.parse(await readFile(join(output, "report.json"), "utf8"))).toMatchObject({ kind: "pal-evaluation" });
  });

  it.each(["pal", "baseline"])(
    "%s grades dependency planning across two superseded-policy checkpoints",
    async (kind) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "pal-evaluation-dependencies-")));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const options = { dataRoot: join(root, "data"), installRoot: join(root, "install") };
      let pal = await openPal(options, context);
      cleanups.push(() => pal.close());
      const faux = fauxProvider();
      const useFaux = () => (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
      useFaux();
      const reopen = async () => {
        await pal.close();
        pal = await openPal(options, context);
        useFaux();
        return pal;
      };
      const model = faux.getModel();
      const choice = { provider: model.provider, modelId: model.id, effort: "off" } as const;
      const harness =
        kind === "pal" ? palHarness(pal, choice, "full", reopen) : baselineHarness(() => pal.models, model, choice);
      const output = join(root, "report");
      const report = await evaluate({
        tasks: [dependencyPlan, revisedDependencyPlan],
        harnesses: [
          {
            ...harness,
            run: async (input) => {
              faux.setResponses(await dependencySolutions(kind, input.runId.startsWith(revisedDependencyPlan.id)));
              return harness.run(input);
            },
          },
        ],
        model: choice,
        implementation: (await pal.extensions.view()).release,
        budget: { seconds: 15, turns: 10 },
        repeats: 1,
        output,
        modelKind: "fixture",
      });
      expect(report.notice).toContain("Not a model or harness quality result");
      expect(report.runs).toHaveLength(2);
      for (const run of report.runs) {
        const continued = run.task.id === revisedDependencyPlan.id;
        expect(run.task.version).toBe(1);
        expect(run.grade.passed).toBe(true);
        expect(run.grade.failures).toEqual([]);
        expect(run.outcome).toMatchObject({
          status: "completed",
          turns: continued ? (kind === "pal" ? 6 : 8) : 2,
          interventions: continued ? 2 : 0,
          failedToolCalls: 0,
        });
        const trace = await readFile(join(output, run.trace.path), "utf8");
        expect(sha256(trace)).toBe(run.trace.sha256);
        if (!continued) continue;
        expect(trace).toContain("Owner change: input may now include excluded");
        expect(trace).toContain("Owner correction supersedes my previous exclusion policy");
        const journal = JSON.parse(trace);
        if (kind === "pal")
          expect(
            journal.conversations.flatMap((scope: { entries: { kind: string }[] }) =>
              scope.entries.filter((entry) => entry.kind === "pal.evaluation-checkpoint"),
            ),
          ).toHaveLength(2);
        else expect(journal.checkpoints).toHaveLength(2);
      }
      expect(report.summary.matched[0]).toMatchObject({ runs: 2, passed: 2, interventions: 2 });
    },
  );

  it.each(["pal", "../escape", "outside/path"])(
    "rejects ambiguous or unsafe harness identity %s before creating artifacts",
    async (id) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "pal-evaluation-ids-")));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const idle: Harness = {
        id: "pal",
        version: 1,
        configuration: { fixture: true },
        matched: true,
        run: async () => {
          throw new Error("must not run");
        },
      };
      const output = join(root, "report");
      await expect(
        evaluate({
          tasks: TASKS,
          harnesses: [idle, { ...idle, id }],
          model: { provider: "fixture", modelId: "none", effort: "off" },
          implementation: "fixture",
          budget: { seconds: 1, turns: 1 },
          repeats: 1,
          output,
          modelKind: "fixture",
        }),
      ).rejects.toThrow(/harness/);
      await expect(readFile(join(output, "report.json"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("computes conservative intervals for small samples", () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    const one = wilson(1, 1);
    expect(one.high).toBe(1);
    expect(one.low).toBeGreaterThan(0.2);
    expect(one.low).toBeLessThan(0.3);
    const half = wilson(5, 10);
    expect(half.low).toBeLessThan(0.5);
    expect(half.high).toBeGreaterThan(0.5);
  });
});
