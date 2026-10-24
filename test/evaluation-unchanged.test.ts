import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Harness } from "../src/evaluation/harnesses.ts";
import { evaluate } from "../src/evaluation/run.ts";
import { inventory, slug } from "../src/evaluation/tasks.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

for (const task of [slug, inventory]) {
  it.each(["preserve", "change", "remove"])(`${task.id} enforces unchanged paths (%s)`, async (operation) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-evaluation-unchanged-")));
    roots.push(root);
    const path = task.kind === "program" ? "test.mjs" : "src/db.mjs";
    const check = task.kind === "program" ? "test.mjs" : "src";
    const harness: Harness = {
      id: "fixture-repair",
      version: 1,
      configuration: { fixture: true },
      matched: true,
      async run({ workspace }) {
        if (task.kind === "program") {
          const fixed = await readFile(new URL("fixtures/evaluation/slug-fixed/src/slug.mjs", import.meta.url), "utf8");
          await writeFile(join(workspace, "src/slug.mjs"), fixed);
        } else await writeFile(join(workspace, task.answer.file), JSON.stringify(task.answer.expected));
        if (operation === "change") await writeFile(join(workspace, path), "process.exit(0);\n");
        if (operation === "remove") await unlink(join(workspace, path));
        return {
          status: "completed",
          error: null,
          turns: 0,
          toolCalls: 0,
          failedToolCalls: 0,
          interventions: 0,
          usage: null,
          trace: [],
        };
      },
    };
    const report = await evaluate({
      tasks: [task],
      harnesses: [harness],
      model: { provider: "fixture", modelId: "none", effort: "off" },
      implementation: "fixture",
      budget: { seconds: 5, turns: 1 },
      repeats: 1,
      output: join(root, "report"),
      modelKind: "fixture",
    });
    expect(report.runs[0]?.outcome.status).toBe("completed");
    expect(report.runs[0]?.grade).toMatchObject({
      passed: operation === "preserve",
      failures: operation === "preserve" ? [] : [`unchanged:${check}:changed`],
    });
  });
}
