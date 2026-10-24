import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { checkPerformance, performanceMode } from "../scripts/check-performance.ts";

const exec = promisify(execFile);
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Synthetic reports exercise the validator; they are not host measurements.
function fixture(os = "linux") {
  const host = {
    os,
    arch: os === "darwin" ? "arm64" : "x64",
    release: "fixture",
    cpu: "fixture CPU",
    logicalCpus: 4,
    memoryBytes: 8 * GiB,
    node: "v24.21.0",
  };
  const source = `/nix/store/${"0".repeat(32)}-pal-ui-fixture-0.0.0`;
  const packagePath = (digit: string) => `/nix/store/${digit.repeat(32)}-pal-0.0.0`;
  const samples = <T>(sample: T) => Array.from({ length: 7 }, () => structuredClone(sample));
  const startup = (digit: string, readyMs: number) => ({
    format: 2,
    scenario: "provider-unconfigured-http-startup",
    host: structuredClone(host),
    identity: {
      package: packagePath(digit),
      release: createHash("sha256").update(packagePath(digit)).digest("hex"),
    },
    install: { narBytes: 110 * MiB, closureNarBytes: 1.5 * GiB },
    samples: samples({ readyMs, rssBytes: 125 * MiB }),
  });
  const activation = (capability: string) => ({
    format: 1,
    scenario: "optional-capability-activation",
    capability,
    host: structuredClone(host),
    identity: { source },
    samples: samples({
      capability,
      ready: capability === "search" ? "matching-file" : "shell-prompt",
      elapsedMs: capability === "search" ? 150 : 30,
      workload: { files: 500, bytes: 1_408_000 },
      idle: { rssBytes: 180 * MiB, workerThreads: 0, directChildren: 0, nativeAddons: 0 },
      active: { rssBytes: 190 * MiB, workerThreads: 0, directChildren: 1, nativeAddons: 1 },
    }),
  });
  const mcp = {
    format: 1,
    scenario: "loopback-mcp-code-mode-cache",
    host: structuredClone(host),
    identity: { source },
    samples: samples(
      ["first-read", "cached-read", "forced-live"].map((phase) => ({
        phase,
        roundTripMs: phase === "first-read" ? 200 : 100,
        rssBytes: 260 * MiB,
        toolCalls: phase === "cached-read" ? 0 : 1,
      })),
    ),
  };
  const transcript = (digit: string, taskMs: number, scriptMs: number) => ({
    format: 1,
    scenario: "long-transcript-live-text",
    host: structuredClone(host),
    workload: { entries: 500, updates: 60, viewport: "1440x900" },
    browser: "147.0.7727.15",
    identity: {
      webRoot: packagePath(digit) + "/lib/pal/dist/public",
      index: "a".repeat(64),
      entry: "b".repeat(64),
    },
    samples: samples({ taskMs, scriptMs, framesMs: 1000, slowestFrameMs: 25 }),
  });
  return {
    core: {
      "startup-baseline": startup("1", 400),
      "startup-candidate": startup("2", 420),
      "activation-search": activation("search"),
      "activation-terminal": activation("terminal"),
      "mcp-candidate": mcp,
    },
    transcript: {
      "transcript-baseline": transcript("1", 2800, 1900),
      "transcript-candidate": transcript("2", 450, 50),
    },
  };
}

describe("performance regression budgets", () => {
  it.each(["linux", "darwin"])("checks core and transcript reports under the measured %s profile", (os) => {
    const data = fixture(os);
    for (const [mode, reports] of Object.entries(data)) {
      const result = checkPerformance(performanceMode(mode), reports);
      expect(result.passed).toBe(true);
      expect(result.checks.length).toBeGreaterThan(0);
      expect(result.checks.every((check) => check.passed)).toBe(true);
      if (mode === "core") expect(result.unexecuted).toContain("protected-browser-activation");
    }
  });

  it("requires an explicit supported report mode", () => {
    expect(performanceMode("core")).toBe("core");
    expect(performanceMode("transcript")).toBe("transcript");
    for (const mode of [undefined, "", "all", "skip"]) expect(() => performanceMode(mode)).toThrow();
  });

  it("recomputes raw percentiles instead of trusting a forged summary", () => {
    const data = fixture().core;
    for (const sample of data["startup-candidate"].samples) sample.readyMs = 5000;
    Object.assign(data["startup-candidate"], { summary: { readyMs: { p50: 1, p95: 1 } } });
    const result = checkPerformance("core", data);
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ metric: "startup.readyMs.p95", passed: false }));
  });

  it("rejects missing reports and fewer than seven samples", () => {
    const data: Record<string, unknown> = fixture().core;
    delete data["activation-search"];
    expect(() => checkPerformance("core", data)).toThrow();
    const short = fixture().core;
    short["startup-candidate"].samples.length = 6;
    expect(() => checkPerformance("core", short)).toThrow(/7–25/);
  });

  it("rejects nonfinite observations and unsupported instrumentation", () => {
    const data = fixture().core;
    for (const sample of data["startup-candidate"].samples) sample.rssBytes = NaN;
    expect(() => checkPerformance("core", data)).toThrow();
    const old = fixture().core;
    old["startup-baseline"].format = 1;
    expect(() => checkPerformance("core", old)).toThrow();
  });

  it("rejects unsupported profiles and fractional byte counts", () => {
    expect(() => checkPerformance("core", fixture("freebsd").core)).toThrow(/budget profile/);
    const data = fixture().core;
    data["startup-candidate"].install.narBytes += 0.5;
    expect(() => checkPerformance("core", data)).toThrow();
  });

  it("rejects mismatched hosts and package identity", () => {
    const data = structuredClone(fixture().core);
    data["activation-terminal"].host.cpu = "different host";
    expect(() => checkPerformance("core", data)).toThrow(/same host/);
    const identity = fixture().core;
    identity["startup-candidate"].identity.release = "0".repeat(64);
    expect(() => checkPerformance("core", identity)).toThrow();
  });

  it("requires the measured activation workload, readiness and idle-worker controls", () => {
    for (const change of ["workload", "readiness", "idle"]) {
      const data = fixture().core;
      for (const sample of data["activation-search"].samples) {
        if (change === "workload") sample.workload.files = 499;
        if (change === "readiness") sample.ready = "created";
        if (change === "idle") sample.idle.directChildren = 1;
      }
      expect(() => checkPerformance("core", data)).toThrow();
    }
  });

  it("checks protected browser observations only from the same immutable runner", () => {
    const data = fixture().core;
    const browser = structuredClone(data["activation-terminal"]);
    browser.capability = "browser";
    for (const sample of browser.samples) {
      sample.capability = "browser";
      sample.ready = "browser-frame";
      sample.elapsedMs = 600;
    }
    const reports = { ...data, "activation-browser": browser };
    const result = checkPerformance("core", reports);
    expect(result.passed).toBe(true);
    expect(result.unexecuted).toEqual([]);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ metric: "activation.browser.elapsedMs.p95", observed: 600, maximum: 2500 }),
    );
    browser.identity.source = `/nix/store/${"3".repeat(32)}-different-fixture`;
    expect(() => checkPerformance("core", reports)).toThrow(/runner source/);
  });

  it("rejects a failed MCP cache control rather than grading its latency", () => {
    const data = fixture().core;
    for (const sample of data["mcp-candidate"].samples)
      for (const phase of sample) if (phase.phase === "cached-read") phase.toolCalls = 1;
    expect(() => checkPerformance("core", data)).toThrow();
  });

  it("rejects mismatched transcript workloads and browser versions", () => {
    const data = fixture().transcript;
    data["transcript-candidate"].workload.entries = 499;
    expect(() => checkPerformance("transcript", data)).toThrow();
    const browser = fixture().transcript;
    browser["transcript-candidate"].browser = "different browser";
    expect(() => checkPerformance("transcript", browser)).toThrow();
  });

  it("retains evidence of transcript regressions", () => {
    const data = fixture().transcript;
    for (const sample of data["transcript-candidate"].samples) sample.scriptMs = 1800;
    const result = checkPerformance("transcript", data);
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ metric: "transcript.scriptMs.p50", passed: false }));
  });

  it("does not echo malformed input contents into CLI diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "pal-budget-test-"));
    roots.push(root);
    await writeFile(join(root, "startup-baseline.json"), '{"token":"private-canary",');
    await expect(
      exec(
        process.execPath,
        [fileURLToPath(new URL("../scripts/check-performance.ts", import.meta.url)), "core", root],
        {
          env: { PATH: process.env.PATH ?? "" },
          timeout: 5000,
        },
      ),
    ).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.not.stringContaining("private-canary") });
  });

  it("prints the failed report and exits nonzero for a regression", async () => {
    const root = await mkdtemp(join(tmpdir(), "pal-budget-test-"));
    roots.push(root);
    const data = fixture().core;
    for (const sample of data["startup-candidate"].samples) sample.readyMs = 5000;
    for (const [name, report] of Object.entries(data))
      await writeFile(join(root, name + ".json"), JSON.stringify(report));
    await expect(
      exec(
        process.execPath,
        [fileURLToPath(new URL("../scripts/check-performance.ts", import.meta.url)), "core", root],
        {
          env: { PATH: process.env.PATH ?? "" },
          timeout: 5000,
        },
      ),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"passed": false') });
  });
});
