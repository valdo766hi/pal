import { access } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activationCapability, sampleActivation } from "../scripts/benchmark-activation.ts";
import { Projects } from "../src/core/projects.ts";
import { ProjectSearch } from "../src/core/search.ts";
import { Terminals } from "../src/core/terminals.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function projectRoots() {
  const roots: string[] = [];
  const create = Projects.prototype.create;
  vi.spyOn(Projects.prototype, "create").mockImplementation(async function (this: Projects, ...args) {
    const project = await create.apply(this, args);
    roots.push(project.root);
    return project;
  });
  return roots;
}

async function removedProject(roots: readonly string[]) {
  expect(roots).toHaveLength(1);
  for (const root of roots) await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("optional capability activation measurements", () => {
  it("requires one explicitly selected capability", () => {
    for (const value of ["search", "terminal", "browser"]) expect(activationCapability(value)).toBe(value);
    for (const value of [undefined, "", "all", "shell", "search; exit 0"])
      expect(() => activationCapability(value)).toThrow();
  });

  it.each(["search", "terminal"] as const)(
    "measures verified %s activation and removes its fixture",
    async (capability) => {
      const roots = projectRoots();
      const result = await sampleActivation(capability);
      expect(result.capability).toBe(capability);
      expect(result.ready).toBe(capability === "search" ? "matching-file" : "shell-prompt");
      expect(result.elapsedMs).toBeGreaterThan(0);
      expect(result.elapsedMs).toBeLessThan(20_000);
      expect(result.workload.files).toBe(500);
      expect(result.workload.bytes).toBeGreaterThan(0);
      for (const snapshot of [result.idle, result.active]) {
        expect(snapshot.rssBytes).toBeGreaterThan(0);
        for (const value of [snapshot.workerThreads, snapshot.directChildren, snapshot.nativeAddons]) {
          expect(Number.isSafeInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }
      await removedProject(roots);
    },
  );

  it("refuses an empty search result instead of reporting a fast successful sample", async () => {
    const roots = projectRoots();
    vi.spyOn(ProjectSearch.prototype, "search").mockResolvedValue({
      mode: "files",
      hits: [],
      truncated: false,
      indexing: false,
    });
    await expect(sampleActivation("search")).rejects.toThrow("Search did not return the fixture file.");
    await removedProject(roots);
  });

  it("refuses a terminal that cannot deliver its live controller and prompt", async () => {
    const roots = projectRoots();
    vi.spyOn(Terminals.prototype, "upgrade").mockImplementation(async (_request, socket) => {
      socket.destroy();
    });
    await expect(sampleActivation("terminal")).rejects.toThrow("Capability stream failed.");
    await removedProject(roots);
  });

  it("refuses unavailable browser protection rather than dropping the sandbox", async () => {
    vi.stubEnv("PAL_CHROMIUM", undefined);
    await expect(sampleActivation("browser")).rejects.toThrow("Protected browser runtime is unavailable.");
  });
});
