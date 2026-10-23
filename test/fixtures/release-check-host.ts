// Real Nix evaluation is a host gate, not a recursive build inside the unit-test sandbox. Uses isolated public source.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { checkedReleases, releaseManifest, verifyRelease } from "../../src/core/release-check.ts";
import { writeReleaseJson } from "../../src/core/release-files.ts";
import { hash } from "../../src/core/release-policy.ts";

const exec = promisify(execFile);
const [packagePath, testRoot] = process.argv.slice(2);
if (!packagePath || !testRoot || process.platform !== "linux")
  throw new Error("pass a tested Nix package and isolated host test root");
const installRoot = `${await realpath(packagePath)}/lib/pal`;
const base = await releaseManifest(installRoot);
const root = await realpath(await mkdtemp(join(testRoot, "release-check-run-")));
const repo = join(root, "repo"),
  candidate = join(root, "candidate"),
  data = join(root, "data");
await mkdir(data, { mode: 0o700 });
await cp(`${installRoot}/release-source`, repo, { recursive: true, dereference: true });
// The immutable source is copied, not modified in place. Git/edits need writable fixture files.
await exec("chmod", ["-R", "u+w", repo]);
const git = async (...args: string[]) =>
  exec("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    env: {
      PATH: process.env.PATH ?? "/run/current-system/sw/bin",
      HOME: "/nonexistent",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LC_ALL: "C",
    },
    maxBuffer: 1024 * 1024,
  });
await git("init", "-q");
await mkdir(join(repo, ".claude/skills"), { recursive: true, mode: 0o700 });
await symlink("missing-outside-build-source", join(repo, ".claude/skills/fixture"));
await git("--literal-pathspecs", "add", "--", ...base.source.files.map((file) => file.path), ".claude/skills/fixture");
await git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-qm",
  "test: seed verified public release source",
);
await git("worktree", "add", "--detach", candidate, "HEAD");
const cli = async () =>
  exec(`${base.package}/bin/pal`, ["check-release", "--candidate", candidate, "--data-dir", data], {
    timeout: 20 * 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
const refused = async (pattern: RegExp) => {
  try {
    await cli();
    throw new Error("candidate unexpectedly passed");
  } catch (error) {
    const result = error as { code?: number; stderr?: string };
    assert.equal(result.code, 1);
    assert.match(result.stderr ?? "", pattern);
    assert.equal((await checkedReleases(data)).length, 0);
  }
};
for (const path of ["src/core/owner.ts", "test/codemode-policy.test.ts", "src/storage/migrations.ts"]) {
  const original = await readFile(join(candidate, path), "utf8");
  await writeFile(join(candidate, path), `${original}\n// protected fixture change\n`);
  await refused(/protected code|protected.*schema/);
  await writeFile(join(candidate, path), original);
}
const panelPath = join(candidate, "web/src/components/ContextPanel.svelte");
const panel = await readFile(panelPath, "utf8");
assert(panel.includes("Recent native request pins"));
await writeFile(panelPath, panel.replace("Recent native request pins", "Broken release fixture"));
await refused(/protected checks\/evals failed/);
const logs = await readdir(join(data, "release-checks"));
const diagnostics = await Promise.all(
  logs
    .filter((name) => name.startsWith("attempt-"))
    .map((name) => readFile(join(data, "release-checks", name), "utf8")),
);
const failedBuild = diagnostics.join("\n").match(/Cannot build '(\/nix\/store\/[a-z0-9]{32}-pal-e2e-[^/'\s]+\.drv)'/);
assert(failedBuild?.[1], "the fixed UI regression build must fail");
// Nix's last 25 lines can omit the first failure when later UI tests also fail.
const { stdout: buildLog } = await exec(
  process.env.PAL_NIX ?? "/run/current-system/sw/bin/nix",
  ["--extra-experimental-features", "nix-command", "log", failedBuild[1]],
  {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      PATH: "/run/current-system/sw/bin",
      HOME: "/nonexistent",
      NIX_USER_CONF_FILES: "/dev/null",
      NIX_REMOTE: "daemon",
      LC_ALL: "C",
    },
  },
);
const regression = stripVTControlCharacters(buildLog);
assert(
  /FAIL\s+test\/e2e\/app\.test\.ts/.test(regression) && regression.includes("Recent native request pins"),
  "the fixed UI regression gate must run and fail",
);
await writeFile(panelPath, panel);
const stylePath = join(candidate, "web/src/app.css");
const css = await readFile(stylePath, "utf8");
await writeFile(stylePath, `${css}\n/* isolated release-check fixture */\n`);
const { stdout } = await cli();
const result = JSON.parse(stdout) as { digest: string; package: string };
const receipts = await checkedReleases(data);
assert.equal(receipts.length, 1);
const receipt = receipts[0];
if (receipt === undefined) throw new Error("missing tested receipt");
assert.equal(result.digest, receipt.digest);
assert.equal(result.package, receipt.package);
assert.deepEqual(receipt.changes, ["web/src/app.css"]);
assert.equal(receipt.outputs.length, 7);
await verifyRelease(installRoot, data, receipt);
// Rechecking an obsolete cached proof must create a complete proof, not keep selecting the old cache entry.
const legacyOutputs = receipt.outputs.filter((output) => !output.endsWith("-pal-evaluation-controls"));
assert.equal(legacyOutputs.length, 6);
const legacy = {
  ...receipt,
  outputs: legacyOutputs,
  digest: hash(
    JSON.stringify([base.package, receipt.package, candidate, receipt.source, receipt.compatibility, legacyOutputs]),
  ),
};
await rename(
  join(data, "release-checks", `receipt-${receipt.digest}.json`),
  join(data, "release-checks", "receipt-with-grading.kept"),
);
const legacyPath = join(data, "release-checks", `receipt-${legacy.digest}.json`);
await writeReleaseJson(legacyPath, legacy);
const legacyBytes = await readFile(legacyPath);
await assert.rejects(verifyRelease(installRoot, data, legacy), /mandatory grading gate; check it again/);
const rechecked = JSON.parse((await cli()).stdout) as { digest: string; package: string };
assert.equal(rechecked.digest, receipt.digest);
assert.equal(rechecked.package, receipt.package);
assert.equal((await checkedReleases(data)).find((item) => item.digest === rechecked.digest)?.outputs.length, 7);
assert.deepEqual(await readFile(legacyPath), legacyBytes);
await writeFile(stylePath, `${css}\n/* a different candidate after testing */\n`);
await assert.rejects(verifyRelease(installRoot, data, receipt), /candidate changed; its approval is invalid/);
process.stdout.write(
  JSON.stringify({
    root,
    package: base.package,
    candidatePackage: receipt.package,
    digest: receipt.digest,
    protectedEditsRefused: 3,
    regressionRefused: true,
    fixedChecks: ["package", "smoke", "tests", "browser", "e2e", "grading", "evals"],
    legacyProofRefused: true,
    legacyRecheckPassed: true,
    changedCandidateRefused: true,
  }) + "\n",
);
