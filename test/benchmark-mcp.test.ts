import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { sampleMcp } from "../scripts/benchmark-mcp.ts";
import { McpManager } from "../src/pi/mcp.ts";

afterEach(() => vi.restoreAllMocks());
const scratch = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("pal-mcp-benchmark-")).sort();

it("measures real live/cache/bypass Code Mode paths without publishing source content or leaving stores", async () => {
  const before = await scratch();
  for (let repeat = 0; repeat < 2; repeat++) {
    const samples = await sampleMcp();
    expect(samples.map((sample) => sample.phase)).toEqual(["first-read", "cached-read", "forced-live"]);
    expect(samples.map((sample) => sample.toolCalls)).toEqual([1, 0, 1]);
    for (const sample of samples) {
      for (const value of [sample.roundTripMs, sample.rssBytes]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
      expect(Number.isFinite(sample.receiptMs)).toBe(true);
      expect(sample.receiptMs).toBeGreaterThanOrEqual(0);
      expect(sample.httpRequests).toBeGreaterThanOrEqual(sample.toolCalls + sample.catalogLists);
      expect(sample.catalogLists).toBe(1);
    }
    expect(JSON.stringify(samples)).not.toMatch(/Fixture durable source|fixture.invalid|127\.0\.0\.1/);
  }
  expect(await scratch()).toEqual(before);
});

it("fails rather than reporting a successful sample when fixture admission fails, and removes its scratch data", async () => {
  const before = await scratch();
  vi.spyOn(McpManager.prototype, "setEnabled").mockRejectedValue(new Error("fixture admission failed"));
  await expect(sampleMcp()).rejects.toThrow("fixture admission failed");
  expect(await scratch()).toEqual(before);
});
