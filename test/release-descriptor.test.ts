import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { descriptorPath } from "../src/core/release-files.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function helper(args: string[], fd?: number) {
  const native = process.env.PAL_RELEASE_LOCK;
  if (!native) throw new Error("descriptor tests require the Nix-packaged PAL_RELEASE_LOCK");
  return spawnSync(native, args, {
    stdio: ["ignore", "pipe", "pipe", fd ?? "ignore"],
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4096,
    env: { LC_ALL: "C" },
  });
}

it("resolves the held descriptor's actual path after an ancestor moves, without trimming valid filename bytes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-release-descriptor-")));
  roots.push(root);
  const original = join(root, "source"),
    moved = join(root, "renamed"),
    name = "space λ\n.css";
  await mkdir(original, { mode: 0o700 });
  await writeFile(join(original, name), "original");
  const file = await open(join(original, name), "r");
  try {
    expect(helper(["--path"], file.fd)).toMatchObject({ status: 0, stdout: join(original, name) });
    expect(await descriptorPath(file)).toBe(join(original, name));
    expect(helper(["--unknown"], file.fd).status).toBe(1);
    expect(helper(["--path", "extra"], file.fd).status).toBe(1);
    await rename(original, moved);
    expect(helper(["--path"], file.fd)).toMatchObject({ status: 0, stdout: join(moved, name) });
    expect(await descriptorPath(file)).toBe(join(moved, name));
    if (process.platform === "darwin") {
      vi.stubEnv("PAL_RELEASE_LOCK", "/nonexistent-pal-descriptor-helper");
      await expect(descriptorPath(file)).rejects.toThrow(/confined file descriptor/);
    }
  } finally {
    await file.close();
  }
});

it("rejects a missing descriptor and unknown native helper operations", () => {
  expect(helper(["--path"]).status).toBe(1);
  expect(helper(["--unknown"]).status).toBe(1);
  expect(helper(["--path", "extra"]).status).toBe(1);
});
