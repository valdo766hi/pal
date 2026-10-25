import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function inspect(mode: "--running" | "--cwd", pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid fixture process ID");
  const probe = process.env.PAL_TEST_PROCESS;
  if (!probe) throw new Error("native process assertions require the Nix-packaged PAL_TEST_PROCESS");
  return (await exec(probe, [mode, String(pid)], { env: {}, timeout: 2000, maxBuffer: 8192 })).stdout;
}

export async function running(pid: number): Promise<boolean> {
  const state = await inspect("--running", pid);
  if (state !== "running" && state !== "stopped") throw new Error("invalid native process state");
  return state === "running";
}

export async function processCwd(pid: number): Promise<string | undefined> {
  const cwd = await inspect("--cwd", pid);
  return cwd === "" ? undefined : cwd;
}
