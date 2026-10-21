// Owner-run evaluation: runs the task suite against Pal and the model-matched baseline (plus optional external
// commands) on a real provider configured in a separate evaluation data directory. It spends provider credit.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openPal } from "../src/core/app.ts";
import {
  baselineHarness,
  externalHarness,
  type Harness,
  type ModelChoice,
  palHarness,
} from "../src/evaluation/harnesses.ts";
import { markdown } from "../src/evaluation/report.ts";
import { evaluate } from "../src/evaluation/run.ts";
import { TASKS } from "../src/evaluation/tasks.ts";

const USAGE = `Usage: pal-evaluate --data-dir <evaluation data dir> --provider <id> --model <id> --output <new dir>
                    [--effort off|minimal|low|medium|high|xhigh] [--repeats 3] [--split development|held-out|all]
                    [--harness pal,baseline] [--external name=command ...] [--seconds 600] [--turns 40]
                    [--approvals full|approve-all]`;

async function main(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      "data-dir": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      output: { type: "string" },
      effort: { type: "string", default: "off" },
      repeats: { type: "string", default: "3" },
      split: { type: "string", default: "development" },
      harness: { type: "string", default: "pal,baseline" },
      external: { type: "string", multiple: true, default: [] },
      seconds: { type: "string", default: "600" },
      turns: { type: "string", default: "40" },
      approvals: { type: "string", default: "full" },
    },
  });
  const dataRoot = values["data-dir"],
    output = values.output;
  assert(dataRoot !== undefined && isAbsolute(dataRoot) && output !== undefined && isAbsolute(output), USAGE);
  assert(values.provider !== undefined && values.model !== undefined, USAGE);
  assert(["off", "minimal", "low", "medium", "high", "xhigh"].includes(values.effort), "unknown --effort");
  assert(["development", "held-out", "all"].includes(values.split), "unknown --split");
  assert(["full", "approve-all"].includes(values.approvals), "unknown --approvals");
  const seconds = Number(values.seconds),
    turns = Number(values.turns);
  assert(Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 3600, "use 1–3600 --seconds");
  assert(Number.isSafeInteger(turns) && turns > 0 && turns <= 200, "use 1–200 --turns");
  const choice = { provider: values.provider, modelId: values.model, effort: values.effort } as ModelChoice;
  // The evaluation data directory owns its own store: a running Pal (such as the live one) refuses this open.
  const pal = await openPal({ dataRoot: resolve(dataRoot), installRoot: join(import.meta.dirname, "..") }, context);
  try {
    const model = pal.models.getModel(choice.provider, choice.modelId);
    assert(model !== undefined, `${choice.provider}/${choice.modelId} is not available in this data directory`);
    const harnesses: Harness[] = [];
    for (const name of values.harness.split(",")) {
      if (name === "pal") harnesses.push(palHarness(pal, choice, values.approvals as "full" | "approve-all"));
      else if (name === "baseline") harnesses.push(baselineHarness(pal.models, model, choice));
      else throw new Error(`unknown harness ${name}`);
    }
    for (const entry of values.external) {
      const at = entry.indexOf("=");
      assert(at > 0, "use --external name=command");
      harnesses.push(externalHarness(entry.slice(0, at), entry.slice(at + 1)));
    }
    const report = await evaluate({
      tasks: TASKS.filter((task) => values.split === "all" || task.split === values.split),
      harnesses,
      model: choice,
      implementation: (await pal.extensions.view()).release,
      budget: { seconds, turns },
      repeats: Number(values.repeats),
      output: resolve(output),
      modelKind: "provider",
    });
    await writeFile(join(output, "report.md"), markdown(report), { mode: 0o600 });
    return report;
  } finally {
    await pal.close();
  }
}

if (import.meta.main) {
  try {
    const report = await main(process.argv.slice(2));
    process.stdout.write(`${markdown(report)}\n`);
  } catch (error) {
    process.stderr.write(`pal-evaluate: ${error instanceof Error ? error.message : "evaluation failed"}\n`);
    process.exitCode = 1;
  }
}
