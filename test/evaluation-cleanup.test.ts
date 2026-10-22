import { chmod, lstat, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Harness } from "../src/evaluation/harnesses.ts";
import { evaluate } from "../src/evaluation/run.ts";
import { checkout } from "../src/evaluation/tasks.ts";

it("unseals a rejected candidate without following its symlinks", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-evaluation-cleanup-")));
  const output = join(root, "report");
  const candidate = join(output, "runs", `${checkout.id}-v${checkout.version}-symlink-1`, "candidate");
  const target = join(root, "protected.mjs");
  const harness: Harness = {
    id: "symlink",
    version: 1,
    configuration: { fixture: true },
    matched: true,
    async run({ workspace }) {
      await symlink(target, join(workspace, "src/link.mjs"));
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
  try {
    await writeFile(target, "export default 1;\n", { mode: 0o444 });
    const report = await evaluate({
      tasks: [checkout],
      harnesses: [harness],
      model: { provider: "fixture", modelId: "none", effort: "off" },
      implementation: "fixture",
      budget: { seconds: 5, turns: 1 },
      repeats: 1,
      output,
      modelKind: "fixture",
    });
    expect(report.runs[0]?.grade).toMatchObject({
      passed: false,
      failures: ["invalid_candidate"],
      error: "candidate contains a symlink or writable path",
    });
    expect((await lstat(candidate)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(candidate, "src"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(candidate, "src/prices.mjs"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(candidate, "src/link.mjs"))).isSymbolicLink()).toBe(true);
    expect((await lstat(target)).mode & 0o777).toBe(0o444);
  } finally {
    // The red control leaves these two known fixture directories sealed.
    for (const path of [candidate, join(candidate, "src")]) await chmod(path, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
