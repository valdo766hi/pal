import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { distribution } from "./benchmark-startup.ts";

type ObjectValue = Record<string, unknown>;
type Mode = "core" | "transcript";
type Check = { metric: string; observed: number; maximum: number; passed: boolean; baseline?: number };
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const STORE = /^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._-]+$/;

export function performanceMode(value: string | undefined): Mode {
  assert(value === "core" || value === "transcript", "Select core or transcript.");
  return value;
}

function object(value: unknown): ObjectValue {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Missing or invalid benchmark object.");
  return value as ObjectValue;
}
function text(value: unknown): string {
  assert(typeof value === "string" && value.length > 0 && value.length <= 200, "Invalid benchmark identity.");
  return value;
}
function positive(value: unknown): number {
  assert(typeof value === "number" && Number.isFinite(value) && value > 0, "Invalid benchmark observation.");
  return value;
}
function samples(value: unknown): unknown[] {
  assert(Array.isArray(value) && value.length >= 7 && value.length <= 25, "Budget checks require 7–25 raw samples.");
  return value;
}
function rows(report: ObjectValue) {
  return samples(report.samples).map(object);
}
function stats(values: ObjectValue[], field: string) {
  const observed = values.map((value) => positive(value[field]));
  if (field === "rssBytes") assert(observed.every(Number.isSafeInteger), "Invalid RSS byte count.");
  return distribution(observed);
}
/** A startup report's separately measured first launch, validated like a sample. */
function firstLaunchMs(report: ObjectValue) {
  const launch = object(report.firstLaunch);
  stats([launch], "rssBytes");
  return stats([launch], "readyMs").p50;
}
function host(report: ObjectValue) {
  const value = object(report.host);
  const result = {
    os: text(value.os),
    arch: text(value.arch),
    release: text(value.release),
    cpu: text(value.cpu),
    node: text(value.node),
    logicalCpus: positive(value.logicalCpus),
    memoryBytes: positive(value.memoryBytes),
  };
  assert(Number.isSafeInteger(result.logicalCpus) && Number.isSafeInteger(result.memoryBytes));
  assert(
    (result.os === "linux" && result.arch === "x64") || (result.os === "darwin" && result.arch === "arm64"),
    "No measured budget profile for this host.",
  );
  return result;
}
function identity(report: ObjectValue) {
  const value = object(report.identity);
  if (report.scenario === "provider-unconfigured-http-startup") {
    const path = text(value.package);
    assert(STORE.test(path), "Invalid package identity.");
    assert.equal(
      value.release,
      createHash("sha256").update(path).digest("hex"),
      "Mismatched package release identity.",
    );
    return { package: path, release: value.release };
  }
  if (report.scenario === "long-transcript-live-text") {
    const path = text(value.webRoot);
    assert(path.endsWith("/lib/pal/dist/public") && STORE.test(path.slice(0, -20)), "Invalid web-bundle identity.");
    const index = text(value.index),
      entry = text(value.entry);
    assert(/^[a-f0-9]{64}$/.test(index) && /^[a-f0-9]{64}$/.test(entry), "Missing web-bundle digests.");
    return { webRoot: path, index, entry };
  }
  const source = text(value.source);
  assert(STORE.test(source), "Invalid runner source identity.");
  return { source };
}

/** Checks trusted benchmark output, not the authenticity of measurements from untrusted code. */
export function checkPerformance(mode: Mode, input: Record<string, unknown>) {
  const checks: Check[] = [];
  const evidence: { report: string; identity: ReturnType<typeof identity>; samples: number }[] = [];
  let measuredHost: ReturnType<typeof host> | undefined;
  const use = (name: string, scenario: string, format: number) => {
    const report = object(input[name]);
    assert(report.scenario === scenario && report.format === format, `Unsupported instrumentation for ${name}.`);
    const current = host(report);
    if (measuredHost === undefined) measuredHost = current;
    else assert.deepEqual(current, measuredHost, "Benchmark reports must use the same host.");
    evidence.push({ report: name, identity: identity(report), samples: samples(report.samples).length });
    return report;
  };
  const add = (metric: string, observed: number, maximum: number, baseline?: number) => {
    checks.push({
      metric,
      observed,
      maximum,
      passed: observed <= maximum,
      ...(baseline === undefined ? {} : { baseline }),
    });
  };
  const unexecuted: string[] = [];
  if (mode === "core") {
    const baseline = use("startup-baseline", "provider-unconfigured-http-startup", 3);
    const candidate = use("startup-candidate", "provider-unconfigured-http-startup", 3);
    const before = rows(baseline),
      after = rows(candidate);
    // The one-time first launch is held to the runner's own startup deadline, never folded into the samples.
    firstLaunchMs(baseline);
    add("startup.firstLaunch.readyMs", firstLaunchMs(candidate), 5000);
    add(
      "startup.readyMs.p50",
      stats(after, "readyMs").p50,
      stats(before, "readyMs").p50 * 1.35 + 50,
      stats(before, "readyMs").p50,
    );
    add("startup.readyMs.p95", stats(after, "readyMs").p95, 1500);
    add(
      "startup.rssBytes.p50",
      stats(after, "rssBytes").p50,
      stats(before, "rssBytes").p50 * 1.15 + 8 * MiB,
      stats(before, "rssBytes").p50,
    );
    add("startup.rssBytes.p95", stats(after, "rssBytes").p95, 192 * MiB);
    const oldInstall = object(baseline.install),
      install = object(candidate.install);
    const nar = positive(install.narBytes),
      closure = positive(install.closureNarBytes),
      oldNar = positive(oldInstall.narBytes),
      oldClosure = positive(oldInstall.closureNarBytes);
    assert([nar, closure, oldNar, oldClosure].every(Number.isSafeInteger) && closure >= nar && oldClosure >= oldNar);
    add("install.narBytes", nar, Math.min(160 * MiB, oldNar * 1.1), oldNar);
    add(
      "install.closureNarBytes",
      closure,
      Math.min(host(candidate).os === "linux" ? 2 * GiB : 3 * GiB, oldClosure * 1.05),
      oldClosure,
    );

    const mcp = use("mcp-candidate", "loopback-mcp-code-mode-cache", 1);
    const groups = samples(mcp.samples).map((sample) => {
      assert(Array.isArray(sample) && sample.length === 3, "Missing MCP phase controls.");
      return sample.map(object);
    });
    for (const [index, phase] of ["first-read", "cached-read", "forced-live"].entries()) {
      const observations = groups.map((group) => {
        const sample = group[index];
        assert(
          sample !== undefined && sample.phase === phase && sample.toolCalls === (phase === "cached-read" ? 0 : 1),
          "Failed MCP cache control.",
        );
        return sample;
      });
      add(`mcp.${phase}.roundTripMs.p95`, stats(observations, "roundTripMs").p95, phase === "first-read" ? 1500 : 750);
      add(`mcp.${phase}.rssBytes.p95`, stats(observations, "rssBytes").p95, 512 * MiB);
    }
    const capabilities = ["search", "terminal"];
    if (input["activation-browser"] !== undefined) capabilities.push("browser");
    else unexecuted.push("protected-browser-activation");
    for (const capability of capabilities) {
      const report = use(`activation-${capability}`, "optional-capability-activation", 1);
      assert.equal(report.capability, capability, "Mismatched activation capability.");
      assert.equal(object(report.identity).source, object(mcp.identity).source, "Mismatched runner source.");
      const observations = rows(report);
      for (const sample of observations) {
        assert.equal(sample.capability, capability);
        assert.equal(
          sample.ready,
          capability === "search" ? "matching-file" : capability === "terminal" ? "shell-prompt" : "browser-frame",
          "Missing activation readiness.",
        );
        assert.deepEqual(sample.workload, { files: 500, bytes: 1_408_000 }, "Changed activation workload.");
        const idle = object(sample.idle);
        assert(idle.workerThreads === 0 && idle.directChildren === 0, "Disabled capabilities started workers.");
        positive(idle.rssBytes);
      }
      add(
        `activation.${capability}.elapsedMs.p95`,
        stats(observations, "elapsedMs").p95,
        capability === "search" ? 1500 : capability === "terminal" ? 750 : 2500,
      );
      add(
        `activation.${capability}.rssBytes.p95`,
        stats(
          observations.map((sample) => object(sample.active)),
          "rssBytes",
        ).p95,
        512 * MiB,
      );
    }
  } else {
    const baseline = use("transcript-baseline", "long-transcript-live-text", 1);
    const candidate = use("transcript-candidate", "long-transcript-live-text", 1);
    for (const report of [baseline, candidate])
      assert.deepEqual(
        report.workload,
        { entries: 500, updates: 60, viewport: "1440x900" },
        "Changed transcript workload.",
      );
    assert.equal(text(candidate.browser), text(baseline.browser), "Mismatched browser versions.");
    const before = rows(baseline),
      after = rows(candidate);
    add(
      "transcript.taskMs.p50",
      stats(after, "taskMs").p50,
      stats(before, "taskMs").p50 * 0.5,
      stats(before, "taskMs").p50,
    );
    add(
      "transcript.scriptMs.p50",
      stats(after, "scriptMs").p50,
      stats(before, "scriptMs").p50 * 0.25,
      stats(before, "scriptMs").p50,
    );
    add("transcript.taskMs.p95", stats(after, "taskMs").p95, 2000);
    add("transcript.scriptMs.p95", stats(after, "scriptMs").p95, 250);
    add("transcript.framesMs.p95", stats(after, "framesMs").p95, 2000);
    add("transcript.slowestFrameMs.p95", stats(after, "slowestFrameMs").p95, 100);
  }
  assert(measuredHost !== undefined);
  return {
    format: 1,
    kind: "performance-budgets-not-model-quality",
    mode,
    host: measuredHost,
    passed: checks.every((check) => check.passed),
    checks,
    evidence,
    unexecuted,
    limits:
      "Initial measured-host guardrails, not universal service SLOs. Trusted raw samples; reported summaries are ignored. NAR bytes are not compressed downloads. Warm-cache/main-RSS/fixture limits remain those of each runner; no full browser/security/release parity or provider-quality claim.",
  };
}

async function main(args: readonly string[]) {
  assert(
    args.length === 2 && args[1] !== undefined,
    "Usage: pal-check-performance <core|transcript> <reports-directory>",
  );
  const mode = performanceMode(args[0]);
  const names =
    mode === "core"
      ? [
          "startup-baseline",
          "startup-candidate",
          "mcp-candidate",
          "activation-search",
          "activation-terminal",
          "activation-browser",
        ]
      : ["transcript-baseline", "transcript-candidate"];
  const input: Record<string, unknown> = {};
  for (const name of names) {
    const path = join(args[1], name + ".json");
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (name === "activation-browser" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Missing benchmark report ${name}.`, { cause: error });
    }
    assert(info.isFile() && info.size <= 1024 * 1024, `Invalid benchmark file ${name}.`);
    const bytes = await readFile(path);
    assert(bytes.length <= 1024 * 1024, `Oversize benchmark report ${name}.`);
    try {
      input[name] = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Invalid benchmark JSON ${name}.`, { cause: error });
    }
  }
  return checkPerformance(mode, input);
}

if (import.meta.main) {
  try {
    const report = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : "invalid benchmark data";
    process.stderr.write(`pal-check-performance: ${message}\n`);
    process.exitCode = 1;
  }
}
