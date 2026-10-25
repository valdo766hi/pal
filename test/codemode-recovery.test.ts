import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const child = join(import.meta.dirname, "fixtures", "codemode-child.ts");
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The mutating service the script talks to. A write never answers, so the test can kill the child mid-effect. */
async function startService() {
  const requests: string[] = [];
  let inFlight: () => void = () => {};
  const writeInFlight = new Promise<void>((resolve) => {
    inFlight = resolve;
  });
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "POST") {
      inFlight();
      return;
    }
    response.end(`value of ${new URL(request.url ?? "/", "http://fixture.invalid").searchParams.get("key")}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, writeInFlight };
}

function runChild(args: string[]): {
  process: ChildProcess;
  checkpoint: Promise<unknown[]>;
  output: () => Promise<string>;
} {
  const proc = spawn(process.execPath, [child, ...args], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
  cleanups.push(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await once(proc, "exit");
    }
  });
  let output = "";
  proc.stdout?.on("data", (chunk) => (output += chunk));
  const exited = once(proc, "exit");
  return {
    process: proc,
    checkpoint: once(proc, "message"),
    output: async () => {
      const [code] = await exited;
      if (code !== 0) throw new Error(`child exited ${code}`);
      return output;
    },
  };
}

/** Kill a first process while its non-replay-safe write is in flight, then resume in a second one. */
async function crashDuringWrite(resumeArgs: string[] = [], scenario?: "budget" | "budget-journal") {
  const service = await startService();
  const dataRoot = await mkdtemp(join(tmpdir(), "pal-codemode-recovery-"));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));

  const mode = scenario === undefined ? [] : [scenario];
  const first = runChild(["start", dataRoot, service.url, ...mode]);
  await service.writeInFlight;
  if (scenario === "budget-journal") expect((await first.checkpoint)[0]).toBe("budget-journaled");
  first.process.kill("SIGKILL");
  await once(first.process, "exit");
  const beforeResume = [...service.requests];

  const resumed = runChild(["resume", dataRoot, service.url, ...mode, ...resumeArgs]);
  const results = JSON.parse((await resumed.output()).trim()) as {
    isError?: boolean;
    text?: string;
    answer?: string;
  }[];
  return { requests: service.requests, beforeResume, results };
}

describe("code mode recovery", () => {
  it("resumes without re-running finished calls and reports the interrupted write as unknown", async () => {
    const { requests, beforeResume, results } = await crashDuringWrite();
    expect(beforeResume).toEqual(["GET /read?key=a", "POST /write?key=b"]);
    // After the restart only the script's next call runs: the read is not repeated, the write is not replayed.
    expect(requests).toEqual(["GET /read?key=a", "POST /write?key=b", "GET /read?key=c"]);

    const script = results.find((result) => result.text !== undefined);
    expect(script?.isError).toBe(false);
    expect(script?.text).toContain('"a":"value of a"');
    expect(script?.text).toMatch(/"b":"unknown: [^"]*interrupted/i);
    expect(script?.text).toContain('"c":"value of c"');
    expect(results.at(-1)).toEqual({ answer: "Done." });
  });

  it("retains the evaluation turn allowance and deadline across SIGKILL without refilling or replaying effects", async () => {
    const service = await startService();
    const dataRoot = await mkdtemp(join(tmpdir(), "pal-evaluation-crash-budget-"));
    cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
    const args = [dataRoot, service.url, "evaluation", String(Date.now() + 60_000)];
    const first = runChild(["start", ...args]);
    await service.writeInFlight;
    first.process.kill("SIGKILL");
    await once(first.process, "exit");
    expect(service.requests).toEqual(["GET /read?key=a", "POST /write?key=b"]);
    const resumed = runChild(["resume", ...args]);
    const report = JSON.parse((await resumed.output()).trim()) as {
      results: { isError?: boolean; text?: string; answer?: string }[];
      turns: number;
      exceeded: boolean;
      modelCallsAfterRestart: number;
      budgetChangeRefused: boolean;
    };
    expect(report).toMatchObject({
      turns: 1,
      exceeded: true,
      modelCallsAfterRestart: 0,
      budgetChangeRefused: true,
    });
    expect(service.requests).toEqual(["GET /read?key=a", "POST /write?key=b", "GET /read?key=c"]);
    const script = report.results.find((result) => result.text !== undefined);
    expect(script?.isError).toBe(false);
    expect(script?.text).toMatch(/"b":"unknown: [^"]*interrupted/i);
    expect(script?.text).toContain('"c":"value of c"');
    expect(report.results.some((result) => result.answer === "Done.")).toBe(false);
  });

  it("keeps the shared discovery/tool budget across SIGKILL without charging replayed calls twice", async () => {
    const { requests, beforeResume, results } = await crashDuringWrite([], "budget");
    expect(beforeResume).toEqual(["GET /read?key=a", "POST /write?key=b"]);
    expect(requests).toEqual(beforeResume);
    const script = results.find((result) => result.text !== undefined);
    expect(script?.isError).toBe(false);
    expect(script?.text).toContain('"a":"value of a"');
    expect(script?.text).toMatch(/"b":"unknown: [^"]*interrupted/i);
    expect(script?.text).toMatch(/"discovery":"[^"]*script call limit of 3 reached/);
    expect(script?.text).toMatch(/"c":"[^"]*script call limit of 3 reached/);
    expect(results.at(-1)).toEqual({ answer: "Done." });
  });

  it("replays a journaled over-budget rejection while an earlier allowed call is interrupted", async () => {
    const { requests, beforeResume, results } = await crashDuringWrite([], "budget-journal");
    expect(beforeResume).toHaveLength(2);
    expect(beforeResume).toEqual(expect.arrayContaining(["GET /read?key=a", "POST /write?key=b"]));
    expect(requests).toEqual(beforeResume);
    const script = results.find((result) => result.text !== undefined);
    expect(script?.isError).toBe(false);
    expect(script?.text).toContain('"a":"value of a"');
    expect(script?.text).toMatch(/"b":"unknown: [^"]*interrupted/i);
    expect(script?.text).toMatch(/"discovery":"[^"]*script call limit of 3 reached/);
  });

  it("refuses to resume an unfinished script under a different call budget", async () => {
    const { requests, results } = await crashDuringWrite(["4"], "budget");
    expect(requests).toEqual(["GET /read?key=a", "POST /write?key=b"]);
    const script = results.find((result) => result.text !== undefined);
    expect(script?.isError).toBe(true);
    expect(script?.text).toMatch(/cannot resume: the sandbox changed/);
  });

  it("stops visibly instead of resuming on a changed sandbox", async () => {
    const { requests, results } = await crashDuringWrite([String(32 * 1024 * 1024)]);
    expect(requests).toEqual(["GET /read?key=a", "POST /write?key=b"]);
    const script = results.find((result) => result.text !== undefined);
    expect(script?.isError).toBe(true);
    expect(script?.text).toMatch(/cannot resume: the sandbox changed/);
  });
});
