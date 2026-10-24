import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { WebSocket } from "ws";
import { createApi } from "../src/core/api.ts";
import { openPal } from "../src/core/app.ts";
import { browserRuntime } from "../src/core/browser.ts";
import { startServer } from "../src/core/server.ts";
import { distribution, sampleCount } from "./benchmark-startup.ts";

const FILES = 500;
const CONTENT = "export const fixture = 'activation needle';\n".repeat(64);
const NEEDLE = "activation-needle-資料.txt";
type Capability = "search" | "terminal" | "browser";

export function activationCapability(value: string | undefined): Capability {
  assert(value === "search" || value === "terminal" || value === "browser", "Select search, terminal or browser.");
  return value;
}

function resources() {
  const report = process.report.getReport() as {
    workers: unknown[];
    libuv: { type: string }[];
    sharedObjects: string[];
  };
  return {
    rssBytes: process.memoryUsage.rss(),
    workerThreads: report.workers.length,
    directChildren: report.libuv.filter((handle) => handle.type === "process").length,
    nativeAddons: report.sharedObjects.filter((path) => path.endsWith(".node")).length,
  };
}

async function streamReady(base: string, path: string, token: string, capability: "terminal" | "browser") {
  const ready = Promise.withResolvers<undefined>();
  const ws = new WebSocket(`${base.replace("http:", "ws:")}${path}`, {
    headers: { origin: base, cookie: `pal_session=${token}` },
  });
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  const fail = () => ready.reject(new Error("Capability stream failed."));
  let controlled = false,
    blank = false,
    framed = false,
    output = "";
  ws.on("error", fail);
  ws.once("close", fail);
  ws.on("message", (bytes, binary) => {
    if (binary) framed = true;
    else {
      try {
        const message = JSON.parse(String(bytes)) as {
          type: string;
          control?: unknown;
          epoch?: unknown;
          data?: unknown;
          tabs?: unknown;
        };
        if (message.type === "error") fail();
        if (message.type === "state") {
          controlled = message.control === true && Number.isSafeInteger(message.epoch);
          if (Array.isArray(message.tabs))
            blank = message.tabs.some(
              (tab: unknown) => tab !== null && typeof tab === "object" && "url" in tab && tab.url === "about:blank",
            );
        }
        if ((message.type === "snapshot" || message.type === "output") && typeof message.data === "string")
          output = (output + message.data).slice(-8192);
      } catch {
        fail();
      }
    }
    if (controlled && (capability === "terminal" ? output.includes("$") : blank && framed)) ready.resolve(undefined);
  });
  const timer = setTimeout(() => ready.reject(new Error("Capability readiness exceeded 20000 ms.")), 20_000);
  try {
    await ready.promise;
    return performance.now();
  } finally {
    clearTimeout(timer);
    ws.terminate();
    await closed;
  }
}

/** Fresh fixture data per sample; only real successful capability work is timed. No model or internet request. */
export async function sampleActivation(capability: Capability) {
  const runtime = browserRuntime();
  if (capability === "browser")
    assert(runtime !== undefined && runtime.scope !== null, "Protected browser runtime is unavailable.");
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-act-")));
  const cleanups: (() => Promise<unknown>)[] = [() => rm(root, { recursive: true, force: true })];
  try {
    const pal = await openPal(
      {
        dataRoot: join(root, "data"),
        guidanceHome: join(root, "home"),
        installRoot: join(root, "install"),
        browser: { runtime },
      },
      context,
    );
    cleanups.push(() => pal.close());
    const token = await pal.owner.setup(pal.owner.setupToken, "activation fixture password");
    const project = await pal.projects.create("activation-project", { name: "Activation" });
    for (let index = 0; index < FILES; index++)
      await writeFile(join(project.root, index === FILES - 1 ? NEEDLE : `file-${index}.ts`), CONTENT);
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      version: "benchmark",
      api: createApi(pal),
      upgrade: (request, socket, head) => pal.upgrade(request, socket, head),
    });
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const idle = resources();
    const started = performance.now();
    let completed: number;
    let ready: "matching-file" | "shell-prompt" | "browser-frame";
    if (capability === "search") {
      const result = await pal.search.search(project.root, "activation-needle", "files");
      assert(
        result.hits.some((hit) => hit.path === NEEDLE),
        "Search did not return the fixture file.",
      );
      completed = performance.now();
      ready = "matching-file";
    } else if (capability === "terminal") {
      const terminal = await pal.terminals.create(project.id, { cols: 80, rows: 24 });
      assert.equal(terminal.ended, false);
      completed = await streamReady(base, `/api/terminals/${terminal.id}/socket`, token, capability);
      ready = "shell-prompt";
    } else {
      completed = await streamReady(base, `/api/projects/${project.id}/browser/socket`, token, capability);
      ready = "browser-frame";
    }
    return {
      capability,
      ready,
      elapsedMs: completed - started,
      idle,
      active: resources(),
      workload: { files: FILES, bytes: Buffer.byteLength(CONTENT) * FILES },
    };
  } finally {
    for (const cleanup of cleanups.toReversed()) await cleanup();
  }
}

async function main(args: readonly string[]) {
  assert(
    args.length >= 1 && args.length <= 2,
    "Usage: pal-benchmark-activation <search|terminal|browser> [3–25 samples]",
  );
  const capability = activationCapability(args[0]);
  const count = sampleCount(args[1]);
  const samples = [];
  for (let index = 0; index < count; index++) samples.push(await sampleActivation(capability));
  return {
    format: 1,
    scenario: "optional-capability-activation",
    capability,
    identity: { source: await realpath(join(import.meta.dirname, "..")) },
    limits:
      "This immutable runner's in-process Pal; owner setup and 500-file project seeding are excluded. " +
      "Search ends at the first verified matching file, terminal at its live controller/prompt, browser at a controlled blank-page frame. " +
      "RSS is the main process, not peak or aggregate child memory; child counts are its direct libuv process handles. " +
      "Samples share a process, loaded addons and filesystem caches, but have fresh stores/projects/guidance roots. " +
      "Unavailable protection or failed work fails the measurement; no sandbox fallback or provider call.",
    host: {
      os: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
    },
    samples,
    summary: {
      elapsedMs: distribution(samples.map((sample) => sample.elapsedMs)),
      idleRssBytes: distribution(samples.map((sample) => sample.idle.rssBytes)),
      activeRssBytes: distribution(samples.map((sample) => sample.active.rssBytes)),
      workerThreads: distribution(samples.map((sample) => sample.active.workerThreads)),
      directChildren: distribution(samples.map((sample) => sample.active.directChildren)),
      nativeAddons: distribution(samples.map((sample) => sample.active.nativeAddons)),
    },
  };
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `pal-benchmark-activation: ${error instanceof Error ? error.message : "measurement failed"}\n`,
    );
    process.exitCode = 1;
  }
}
