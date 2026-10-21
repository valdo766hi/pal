import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleTranscript } from "../../scripts/benchmark-transcript.ts";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
});
afterAll(async () => browser.close());

describe("transcript benchmark", () => {
  it("measures a rendered long transcript with exact live text", async () => {
    const sample = await sampleTranscript(browser, join(import.meta.dirname, "../../dist/public"), 40, 5);
    expect(Object.keys(sample).sort()).toEqual([
      "framesMs",
      "layoutMs",
      "scriptMs",
      "slowestFrameMs",
      "styleMs",
      "taskMs",
    ]);
    for (const value of Object.values(sample)) expect(value).toBeGreaterThanOrEqual(0);
    expect(sample.framesMs).toBeGreaterThan(0);
    expect(sample.taskMs).toBeGreaterThan(0);
  });

  it("does not report a measurement for a bundle that cannot render the chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "pal-transcript-web-"));
    try {
      await writeFile(join(root, "index.html"), "<!doctype html><title>Not Pal</title>");
      await expect(sampleTranscript(browser, root, 5, 1)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
