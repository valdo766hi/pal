import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { gnuTimeout } from "../src/core/timeout.ts";
import { processCwd, running } from "./fixtures/process.ts";

afterEach(() => vi.unstubAllEnvs());

it("positively identifies a live process, its exact cwd and a reaped child on the native platform", async () => {
  expect(await running(process.pid)).toBe(true);
  expect(await processCwd(process.pid)).toBe(await realpath(process.cwd()));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pal-process-漢 space-")));
  const child = spawn(process.execPath, ["-e", 'process.send("ready"); setInterval(()=>{},1000)'], {
    cwd,
    env: {},
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("fixture exited before readiness");
      }),
    ]);
    if (child.pid === undefined) throw new Error("fixture PID missing");
    expect(await running(child.pid)).toBe(true);
    expect(await processCwd(child.pid)).toBe(cwd);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect(await running(child.pid)).toBe(false);
    expect(await processCwd(child.pid)).toBeUndefined();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

it.each(["idle", "blocked"])("reaps the %s native finder after its controller is killed", async (mode) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-finder-controller-death-")));
  await writeFile(join(root, "seed.txt"), "public needle fixture");
  const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/finder-child.ts"), root], {
    cwd: root,
    env: { PAL_TIMEOUT: gnuTimeout() },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let group: number | undefined;
  let worker: number | undefined;
  const failures: unknown[] = [];
  try {
    const [message] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("finder fixture exited before readiness");
      }),
    ]);
    const pids = message as { group: number; worker: number };
    expect(Number.isSafeInteger(pids.group) && pids.group > 0).toBe(true);
    expect(Number.isSafeInteger(pids.worker) && pids.worker > 0).toBe(true);
    group = pids.group;
    worker = pids.worker;
    expect(await running(group)).toBe(true);
    expect(await running(worker)).toBe(true);
    if (mode === "blocked") process.kill(worker, "SIGSTOP");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    await expect
      .poll(async () => (await running(pids.group)) || (await running(pids.worker)), { timeout: 12_000 })
      .toBe(false);
  } catch (error) {
    failures.push(error);
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    if (group !== undefined) {
      try {
        process.kill(-group, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(error);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
  if (failures.length > 0) throw new AggregateError(failures, "native finder ownership or cleanup failed");
});

it("fails rather than reporting death when its native probe is unavailable or input is invalid", async () => {
  await expect(running(0)).rejects.toThrow(/process ID/);
  await expect(running(Number.NaN)).rejects.toThrow(/process ID/);
  vi.stubEnv("PAL_TEST_PROCESS", "/nonexistent-pal-process-probe");
  await expect(running(process.pid)).rejects.toThrow();
  vi.stubEnv("PAL_TEST_PROCESS", "");
  await expect(running(process.pid)).rejects.toThrow(/PAL_TEST_PROCESS/);
});
