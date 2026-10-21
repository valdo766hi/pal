import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "../src/evaluation/harnesses.ts";
import { evaluate } from "../src/evaluation/run.ts";
import { checkout } from "../src/evaluation/tasks.ts";

// Stands in for a run that rewrote the grader, a task or a starting snapshot.
let digests = 0;
vi.mock("../src/evaluation/grade.ts", async (original) => ({
  ...(await original<typeof import("../src/evaluation/grade.ts")>()),
  authority: async () => (digests++ === 0 ? "a".repeat(64) : "b".repeat(64)),
}));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("evaluator authority", () => {
  it("reports a run that changed the evaluator as invalid instead of grading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pal-evaluation-authority-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const idle: Harness = {
      id: "idle",
      version: 1,
      configuration: { fixture: true },
      matched: true,
      run: async () => ({
        status: "completed",
        error: null,
        turns: 0,
        toolCalls: 0,
        failedToolCalls: 0,
        interventions: 0,
        usage: null,
        trace: [],
      }),
    };
    const report = await evaluate({
      tasks: [checkout],
      harnesses: [idle],
      model: { provider: "fixture", modelId: "none", effort: "off" },
      implementation: "fixture",
      budget: { seconds: 5, turns: 1 },
      repeats: 1,
      output: join(root, "report"),
      modelKind: "fixture",
    });
    expect(report.evaluator).toBe("a".repeat(64));
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]?.grade).toEqual({
      passed: false,
      failures: ["evaluator_changed"],
      error: "the evaluator changed during the run",
    });
  });
});
