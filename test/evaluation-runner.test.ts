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
import { TASKS } from "../src/evaluation/tasks.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fixtures = new URL("fixtures/evaluation/", import.meta.url);
const read = (path: string) => readFile(new URL(path, fixtures), "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ANSWER = JSON.stringify({ importers: ["src/api.mjs", "src/cli.mjs", "src/db.mjs"] });

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

describe("evaluation runner", () => {
  it("grades every run independently and reports matched, unmatched, failed and intervened runs", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-evaluation-test-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const pal = await openPal({ dataRoot: join(root, "data"), installRoot: join(root, "install") }, context);
    cleanups.push(() => pal.close());
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
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
      tasks: TASKS,
      harnesses: [
        scripted(palHarness(pal, choice, "approve-all"), script.pal),
        scripted(baselineHarness(pal.models, model, choice), script.baseline),
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
    expect(report.runs).toHaveLength(TASKS.length * 3 * 2);
    const runs = (task: string, harness: string) =>
      report.runs.filter((run) => run.task.id === task && run.harness.id === harness);
    expect(runs("checkout-rounding", "pal").map((run) => run.grade.passed)).toEqual([true, true]);
    expect(runs("checkout-rounding", "baseline-loop").map((run) => run.grade.passed)).toEqual([true, true]);
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
    expect(runs("module-inventory", "pal")[0]?.harness.configuration).toMatchObject({
      model: choice,
      approvals: "approve-all",
    });
    expect(report.summary.unmatched[0]).toMatchObject({ interventions: null, toolCalls: null, toolFailureRate: null });
    expect(report.summary.matched.map((row) => `${row.harness}/${row.split}`).sort()).toEqual([
      "baseline-loop/development",
      "baseline-loop/held-out",
      "pal/development",
      "pal/held-out",
    ]);
    expect(report.summary.unmatched.map((row) => row.harness)).toEqual(["external-cli", "external-cli"]);
    expect(report.summary.matched.find((row) => row.harness === "pal" && row.split === "development")).toMatchObject({
      runs: 10,
      passed: 10,
      interventions: 10,
      interval95: wilson(10, 10),
    });
    expect(report.summary.bottlenecks[0]?.runs).toBeGreaterThan(0);
    const correct = runs("module-inventory", "pal")[0];
    if (correct === undefined) throw new Error("missing control run");
    const exceeded = { ...correct, outcome: { ...correct.outcome, status: "budget_exceeded" as const } };
    expect(summarize([exceeded]).matched[0]).toMatchObject({ passed: 0, unsuccessful: 1 });
    expect(report.summary.nextMilestone).toContain("Investigate");
    const text = markdown(report);
    expect(text).toContain("## Model-matched harness comparison");
    expect(text).toContain("## Unmatched product comparison");
    expect(JSON.parse(await readFile(join(output, "report.json"), "utf8"))).toMatchObject({ kind: "pal-evaluation" });
  });

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
