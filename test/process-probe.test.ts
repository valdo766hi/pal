import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

it("fails rather than reporting death when its native probe is unavailable or input is invalid", async () => {
  await expect(running(0)).rejects.toThrow(/process ID/);
  await expect(running(Number.NaN)).rejects.toThrow(/process ID/);
  vi.stubEnv("PAL_TEST_PROCESS", "/nonexistent-pal-process-probe");
  await expect(running(process.pid)).rejects.toThrow();
  vi.stubEnv("PAL_TEST_PROCESS", "");
  await expect(running(process.pid)).rejects.toThrow(/PAL_TEST_PROCESS/);
});
