import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { grade } from "./grade.ts";
import {
  checkout,
  checkpointCheckout,
  continuedCheckout,
  dependencyPlan,
  inventory,
  revisedDependencyPlan,
  slug,
  verifierCheckout,
} from "./tasks.ts";

const output = process.argv[2];
const malformed = process.argv[3];
if (output === undefined || malformed === undefined) throw new Error("missing control output or malformed fixtures");
const fixtures = fileURLToPath(new URL("../../test/fixtures/evaluation/", import.meta.url));
await mkdir(output, { recursive: true });
let checks = 0;
for (const [name, status] of [
  ["buggy", 0],
  ["fixed", 0],
  ["dependency-plan", 1],
  ["dependency-plan-fixed", 0],
] as const) {
  const root = join(fixtures, name);
  const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${root}`, join(root, "test.mjs")], {
    env: { LANG: "C" },
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024,
  });
  assert.equal(result.status, status, `${name} public test: ${result.stderr}`);
  checks++;
}
const reference = await grade(join(fixtures, "fixed"));
assert.notEqual(reference.task.initial.digest, reference.candidate.digest);
for (const name of ["buggy", "fixed", "forged", "hang", "flood"]) {
  const result = name === "fixed" ? reference : await grade(join(fixtures, name));
  assert.equal(result.passed, name === "fixed", name);
  assert.equal(result.cases.length, checkout.cases.length);
  assert.equal(result.task.initial.digest, reference.task.initial.digest);
  assert.equal(result.grader.digest, reference.grader.digest);
  if (name === "buggy") assert.equal(result.candidate.digest, result.task.initial.digest);
  if (name === "forged")
    for (const test of result.cases)
      assert.deepEqual(test.output, {
        passed: true,
        denied: { readGrader: true, writeGrader: true, writeTask: true, spawn: true, worker: true },
      });
  if (name === "hang") assert(result.cases.every((test) => test.failure === "timeout"));
  if (name === "flood") assert(result.cases.every((test) => test.failure === "output_limit"));
  await writeFile(join(output, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  checks++;
}
// The other tasks: an untouched start fails, a reference solution passes, and answer tasks keep sources intact.
for (const [task, name, passed] of [
  [inventory, "inventory", false],
  [inventory, "inventory-solved", true],
  [slug, "slug", false],
  [slug, "slug-fixed", true],
  [continuedCheckout, "fixed", false],
  [continuedCheckout, "continued-fixed", true],
  [checkpointCheckout, "fixed", false],
  [checkpointCheckout, "continued-fixed", true],
  [verifierCheckout, "unavailable-verifier", false],
  [verifierCheckout, "verifier-fixed", true],
  [dependencyPlan, "dependency-plan", false],
  [dependencyPlan, "dependency-plan-fixed", true],
  [revisedDependencyPlan, "dependency-plan", false],
  [revisedDependencyPlan, "dependency-plan-fixed", true],
] as const) {
  const result = await grade(join(fixtures, name), task);
  assert.equal(result.passed, passed, name);
  if (name === "inventory") assert.deepEqual(result.cases.map((test) => test.failure)[0], "missing_answer");
  if (task === inventory)
    assert(
      result.cases.some((test) => test.id === "unchanged:src" && test.passed),
      name,
    );
  await writeFile(join(output, `${task.id}-${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  checks++;
}
const stalePolicy = await grade(join(malformed, "stale-policy"), revisedDependencyPlan);
assert.equal(stalePolicy.passed, false);
assert.deepEqual(
  stalePolicy.cases.filter((test) => !test.passed).map((test) => test.id),
  ["superseded-transitive-policy", "excluded-root-still-needed"],
);
await writeFile(join(output, "stale-policy.json"), `${JSON.stringify(stalePolicy, null, 2)}\n`);
checks++;
assert.equal(slug.split, "held-out");
for (const name of ["changed-test", "missing-test"]) {
  const result = await grade(join(malformed, name), slug);
  assert.equal(result.cases.length, slug.cases.length + 1);
  assert.equal(result.passed, false);
  assert(result.cases.every((test) => test.id === "unchanged:test.mjs" || test.passed));
  assert.deepEqual(
    result.cases.flatMap((test) => (test.passed ? [] : [test.id])),
    ["unchanged:test.mjs"],
  );
  await writeFile(join(output, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  checks++;
}
await assert.rejects(grade(output), /frozen Nix-store candidate|writable path/);
checks++;
for (const [name, pattern] of [
  ["symlink", /symlink/],
  ["bytes", /one MiB/],
  ["files", /128 regular files/],
  ["deep", /depth/],
  ["wide", /too many entries/],
  ["entries", /entry limit/],
] as const) {
  await assert.rejects(grade(join(malformed, name)), pattern);
  checks++;
}
await writeFile(
  join(output, "summary.json"),
  `${JSON.stringify(
    {
      kind: "grading-controls-not-model-evaluations",
      numTotalTests: checks,
      numPassedTests: checks,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`Independent grading controls: ${checks}/${checks}; no model evaluation performed.\n`);
