import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, link, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { releaseLock } from "../src/core/release-files.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
async function fixture() {
  if (!process.env.PAL_RELEASE_LOCK) throw new Error("native lock tests require the Nix-packaged PAL_RELEASE_LOCK");
  // Prove the declared helper is used, never a PATH-dependent flock fallback.
  vi.stubEnv("PAL_FLOCK", "/nonexistent-pal-flock");
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-native-lock-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return join(root, "release.lock");
}

it("keeps an exclusive lock after its native helper exits, until the owning descriptor closes", async () => {
  const path = await fixture();
  const first = await releaseLock(path);
  try {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(releaseLock(path)).rejects.toThrow(/another release/);
  } finally {
    await first.close();
  }
  await (await releaseLock(path)).close();
});

it("fails closed for unavailable helpers and nonprivate or linked lock files", async () => {
  const path = await fixture();
  const helper = process.env.PAL_RELEASE_LOCK;
  vi.stubEnv("PAL_RELEASE_LOCK", "/nonexistent-pal-release-lock");
  await expect(releaseLock(path)).rejects.toThrow();
  vi.stubEnv("PAL_RELEASE_LOCK", helper);
  await writeFile(`${path}.public`, "", { mode: 0o644 });
  await chmod(`${path}.public`, 0o644);
  await expect(releaseLock(`${path}.public`)).rejects.toThrow(/private regular/);
  await symlink(path, `${path}.symlink`);
  await expect(releaseLock(`${path}.symlink`)).rejects.toThrow();
  await link(path, `${path}.hardlink`);
  await expect(releaseLock(`${path}.hardlink`)).rejects.toThrow(/private regular/);
});

it("retains the inherited lock after its original owner is killed and releases it after the last holder dies", async () => {
  const path = await fixture();
  const owner = spawn(process.execPath, [join(import.meta.dirname, "fixtures/release-lock-owner.ts"), "owner", path], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      PATH: process.env.PATH ?? "",
      PAL_RELEASE_LOCK: process.env.PAL_RELEASE_LOCK ?? "",
      PAL_FLOCK: process.env.PAL_FLOCK ?? "",
    },
  });
  let child: number | undefined;
  cleanups.push(async () => {
    if (child !== undefined) process.kill(child, "SIGKILL");
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await once(owner, "exit");
    }
  });
  const [ready] = (await Promise.race([
    once(owner, "message"),
    once(owner, "exit").then(() => {
      throw new Error("fixture lock owner exited before readiness");
    }),
  ])) as [{ ready: boolean; child: number }];
  expect(ready.ready).toBe(true);
  child = ready.child;
  expect(child).toBeGreaterThan(0);
  await expect(releaseLock(path)).rejects.toThrow(/another release/);
  const exited = once(owner, "exit");
  owner.kill("SIGKILL");
  await exited;
  await expect(releaseLock(path)).rejects.toThrow(/another release/);
  process.kill(child, "SIGKILL");
  child = undefined;
  await expect
    .poll(
      async () => {
        try {
          await (await releaseLock(path)).close();
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 3000 },
    )
    .toBe(true);
});
