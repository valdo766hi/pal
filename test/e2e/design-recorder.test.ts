import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

const SHOOT = join(import.meta.dirname, "../../.agents/skills/oil-ui/scripts/shoot.mjs");
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("design skill recorder", () => {
  it("keeps frames folders it did not create and removes its own, on success, failure and repeat", async () => {
    const root = await mkdtemp(join(tmpdir(), "pal-recorder-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const out = join(root, "out");
    const kept = ["frames", "frames-open"];
    for (const dir of kept) {
      await mkdir(join(out, dir, "unrelated"), { recursive: true });
      await writeFile(join(out, dir, "unrelated", "keep.txt"), "owner file\n");
    }
    await writeFile(join(root, "page.html"), "<!doctype html><button>Open</button>");
    const record = async (steps: string) => {
      const child = spawn(
        process.execPath,
        [SHOOT, "page.html", "--size", "390x844", "--record", "--hold", "100", "--steps", steps, "--out", out],
        { cwd: root, env: { ...process.env, CHROME_PATH: chromium.executablePath() }, stdio: "ignore" },
      );
      await once(child, "exit");
    };
    // An unnamed and a named recording, again, and one whose step fails mid-recording.
    for (const steps of [
      "click button",
      "open: click button",
      "click button",
      "open: click button",
      "open: click #gone",
    ])
      await record(steps);
    expect(await readdir(out)).toEqual(expect.arrayContaining(["motion-start.jpg", "motion-open-start.jpg"]));
    for (const dir of kept)
      expect(await readFile(join(out, dir, "unrelated", "keep.txt"), "utf8")).toBe("owner file\n");
    expect((await readdir(out)).filter((name) => name.startsWith("frames")).sort()).toEqual(kept);
  }, 120_000);
});
