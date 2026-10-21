import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, constants, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const deadline = 5000;

export function distribution(values: readonly number[]) {
  assert(values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => {
    const value = sorted[Math.ceil(sorted.length * p) - 1];
    assert(value !== undefined);
    return value;
  };
  const min = sorted[0],
    max = sorted.at(-1);
  assert(min !== undefined && max !== undefined);
  return { min, p50: percentile(0.5), p95: percentile(0.95), max };
}

export function sampleCount(value = "7") {
  assert(/^(?:[3-9]|1\d|2[0-5])$/.test(value), "Use 3–25 startup samples.");
  return Number(value);
}

async function reportedRss(child: ChildProcess) {
  const report = Promise.withResolvers<number>(),
    id = randomUUID();
  const receive = (message: unknown) => {
    if (
      message === null ||
      typeof message !== "object" ||
      !("kind" in message) ||
      message.kind !== "pal-startup-rss" ||
      !("id" in message) ||
      message.id !== id
    )
      return;
    if (
      "pid" in message &&
      message.pid === child.pid &&
      "rssBytes" in message &&
      typeof message.rssBytes === "number" &&
      Number.isSafeInteger(message.rssBytes) &&
      message.rssBytes > 0
    )
      report.resolve(message.rssBytes);
    else report.reject(new Error("Package returned an invalid RSS report."));
  };
  child.on("message", receive);
  const timer = setTimeout(() => report.reject(new Error("Package did not report its RSS.")), 1000);
  try {
    child.send({ kind: "pal-startup-rss", id }, (error) => {
      if (error) report.reject(new Error("Could not request the package RSS."));
    });
    return await report.promise;
  } finally {
    clearTimeout(timer);
    child.off("message", receive);
  }
}

export async function sampleStartup(packagePath: string) {
  const root = await mkdtemp(join(tmpdir(), "pal-startup-"));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const started = performance.now();
  const child = spawn(
    join(packagePath, "bin/pal"),
    ["serve", "--host", "127.0.0.1", "--port", "0", "--data-dir", join(root, "data")],
    {
      cwd: root,
      env: {
        HOME: home,
        TMPDIR: root,
        PATH: process.env.PATH ?? "",
        NODE_OPTIONS: `--import=${pathToFileURL(join(import.meta.dirname, "benchmark-startup-observer.mjs")).href}`,
      },
      detached: true,
      stdio: ["ignore", "pipe", "ignore", "ipc"],
    },
  );
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const ready = Promise.withResolvers<string>();
  child.once("error", () => ready.reject(new Error("Package could not be started.")));
  child.once("exit", () => ready.reject(new Error("Package exited before readiness.")));
  let output = "",
    announced = false,
    measured = false;
  assert(child.stdout !== null);
  child.stdout.on("data", (bytes: Buffer) => {
    if (announced) return;
    output = (output + bytes.toString()).slice(-4096);
    const origin = /listening on (http:\/\/\S+)\s/.exec(output)?.[1];
    if (origin !== undefined) {
      announced = true;
      output = "";
      ready.resolve(origin);
    }
  });
  const timer = setTimeout(() => ready.reject(new Error("Package startup exceeded 5000 ms.")), deadline);
  try {
    const origin = new URL(await ready.promise);
    assert(
      origin.protocol === "http:" &&
        origin.hostname === "127.0.0.1" &&
        Number(origin.port) > 0 &&
        origin.username === "" &&
        origin.password === "" &&
        origin.pathname === "/" &&
        origin.search === "" &&
        origin.hash === "",
      "Package did not announce a loopback HTTP origin.",
    );
    const response = await fetch(new URL("/api/health", origin), {
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.floor(deadline - (performance.now() - started)))),
    });
    assert.equal(response.status, 200, "Package health did not become ready.");
    const health: unknown = await response.json();
    assert(
      health !== null &&
        typeof health === "object" &&
        "status" in health &&
        health.status === "ok" &&
        "name" in health &&
        health.name === "pal",
      "Package returned invalid health.",
    );
    const readyMs = performance.now() - started;
    assert(readyMs < deadline, "Package startup exceeded 5000 ms.");
    const rssBytes = await reportedRss(child);
    measured = true;
    return { readyMs, rssBytes };
  } finally {
    clearTimeout(timer);
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    kill("SIGTERM");
    const force = setTimeout(() => kill("SIGKILL"), deadline);
    try {
      const result = await closed;
      kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
      if (measured) assert(result.code === 0 && result.signal === null, "Package did not shut down cleanly.");
    } finally {
      clearTimeout(force);
    }
  }
}

async function main(args: readonly string[]) {
  assert(args.length >= 1 && args.length <= 2, "Usage: pal-benchmark-startup /nix/store/<package> [3–25 samples]");
  const [input, requestedCount] = args;
  assert(input !== undefined);
  const count = sampleCount(requestedCount);
  const packagePath = await realpath(input);
  assert(/^\/nix\/store\/[a-z0-9]{32}-[^/]+$/.test(packagePath), "Use an explicitly selected realized Nix package.");
  await access(join(packagePath, "bin/pal"), constants.X_OK);
  const manifest: unknown = JSON.parse(await readFile(join(packagePath, "lib/pal/release.json"), "utf8"));
  assert(
    manifest !== null && typeof manifest === "object" && "package" in manifest && manifest.package === packagePath,
    "Package release identity does not match.",
  );
  const { stdout } = await exec("nix", ["path-info", "--json", "--json-format", "1", "--closure-size", packagePath], {
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  const info: unknown = JSON.parse(stdout);
  assert(info !== null && typeof info === "object", "Nix did not report package information.");
  const sizes = (info as Record<string, unknown>)[packagePath];
  assert(
    sizes !== null &&
      typeof sizes === "object" &&
      "narSize" in sizes &&
      typeof sizes.narSize === "number" &&
      Number.isSafeInteger(sizes.narSize) &&
      sizes.narSize > 0 &&
      "closureSize" in sizes &&
      typeof sizes.closureSize === "number" &&
      Number.isSafeInteger(sizes.closureSize) &&
      sizes.closureSize >= sizes.narSize,
    "Nix did not report valid install sizes.",
  );
  const samples = [];
  for (let i = 0; i < count; i++) samples.push(await sampleStartup(packagePath));
  return {
    format: 2,
    scenario: "provider-unconfigured-http-startup",
    cache: "fresh process, home and store per sample; filesystem caches are not flushed",
    rss: "launched Node process after HTTP readiness, via IPC; not peak or aggregate worker memory",
    observer: "trusted Node preload included in both startup and RSS; not an untrusted-code evaluator",
    identity: { package: packagePath, release: createHash("sha256").update(packagePath).digest("hex") },
    host: {
      os: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
    },
    install: { narBytes: sizes.narSize, closureNarBytes: sizes.closureSize },
    samples,
    summary: {
      readyMs: distribution(samples.map((sample) => sample.readyMs)),
      rssBytes: distribution(samples.map((sample) => sample.rssBytes)),
    },
  };
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`pal-benchmark-startup: ${error instanceof Error ? error.message : "measurement failed"}\n`);
    process.exitCode = 1;
  }
}
