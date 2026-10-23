import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckedRelease, checkedReleases, verifyRelease } from "../src/core/release-check.ts";
import { privateReleaseDirectory, writeReleaseJson } from "../src/core/release-files.ts";
import { validate } from "../src/core/requests.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function receipt(count: number): CheckedRelease {
  return {
    format: 1,
    digest: (count === 6 ? "a" : "b").repeat(64),
    base: `/nix/store/${"0".repeat(32)}-pal`,
    package: `/nix/store/${"1".repeat(32)}-pal`,
    candidate: "/fixture-candidate",
    source: "c".repeat(64),
    compatibility: "d".repeat(64),
    snapshot: randomUUID(),
    checkedAt: 1,
    outputs: Array.from({ length: count }, (_, index) => `/nix/store/${String(index).repeat(32)}-check`),
    changes: ["web/src/app.css"],
  };
}

describe("mandatory release grading proof", () => {
  it("accepts the seven artifacts produced by the protected recipe", () => {
    const value = receipt(7);
    expect(validate(CheckedRelease, value)).toEqual(value);
  });

  it.each([5, 8])("rejects an unsupported %i-artifact receipt", (count) => {
    expect(() => validate(CheckedRelease, receipt(count))).toThrow();
  });

  it("keeps six-artifact legacy proofs inspectable without changing their bytes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-release-receipts-")));
    roots.push(root);
    const directory = join(root, "release-checks");
    await privateReleaseDirectory(directory);
    const legacy = receipt(6),
      current = receipt(7);
    const path = join(directory, `receipt-${legacy.digest}.json`);
    await writeReleaseJson(path, legacy);
    const original = await readFile(path);
    await writeReleaseJson(join(directory, `receipt-${current.digest}.json`), current);
    expect(await checkedReleases(root)).toEqual([legacy, current]);
    expect(await readFile(path)).toEqual(original);
  });

  it("rejects legacy proof before reading an installation or starting Nix", async () => {
    await expect(verifyRelease("/nonexistent-installation", "/nonexistent-data", receipt(6))).rejects.toThrow(
      /mandatory grading gate; check it again/,
    );
  });
});
