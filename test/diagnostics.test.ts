import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ReportInfo } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openPal } from "../src/core/app.ts";
import { Reports } from "../src/core/diagnostics.ts";

describe("Pi report diagnostics", () => {
  it("keeps bounded categories and never the reported error", () => {
    const reports = new Reports();
    const task = { id: 7, kind: "memory_search", conversationId: "c" } as unknown as Extract<
      ReportInfo,
      { type: "task_error" }
    >["task"];
    reports.record({ type: "task_faulted", task, extension: "pal.memory", reason: "threw" }, 0);
    reports.record({ type: "host_error", callback: "models" }, 1);
    for (let i = 0; i < 25; i++) reports.record({ type: "listener_error" }, 2);
    const view = reports.view();
    expect(view.counts).toEqual({ task_faulted: 1, host_error: 1, listener_error: 25 });
    expect(view.recent).toHaveLength(20);
    expect(view.recent.every((report) => report.type === "listener_error")).toBe(true);
    const early = new Reports();
    early.record({ type: "task_faulted", task, extension: "pal.memory", reason: "threw" }, 0);
    early.record({ type: "host_error", callback: "models" }, 1);
    expect(early.view().recent).toEqual([
      {
        at: "1970-01-01T00:00:00.000Z",
        type: "task_faulted",
        extension: "pal.memory",
        task: "memory_search",
        reason: "threw",
      },
      { at: "1970-01-01T00:00:00.001Z", type: "host_error", callback: "models" },
    ]);
  });

  it("records the reports Pi sends while Pal runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pal-reports-"));
    try {
      const pal = await openPal(
        { dataRoot: join(root, "data"), installRoot: "/nonexistent-install", guidanceHome: join(root, "home") },
        context,
      );
      pal.harness.subscribeClose(() => {
        throw new Error("listener secret sk-test-123");
      });
      await pal.close();
      expect(pal.reports.view().counts).toEqual({ listener_error: 1 });
      expect(JSON.stringify(pal.reports.view())).not.toContain("sk-test-123");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
