import { describe, expect, it } from "vitest";
import { renderer } from "../web/src/lib/plugins.ts";

describe("plugin entries in a chat's history", () => {
  const pinned = [{ id: "memory", version: 1 }];
  it("shows a note when this build lacks the plugin version a chat pinned, after an upgrade as after removal", () => {
    expect(renderer("pal.memory", pinned, new Set(["memory@1"]))).toBeUndefined();
    expect(renderer("pal.memory", pinned, new Set(["memory@2"]))).toBe("missing");
    expect(renderer("pal.memory.lookup", pinned, new Set(["memory@2"]))).toBe("missing");
    expect(renderer("pal.memory", pinned, new Set())).toBe("missing");
    expect(renderer("pal.memory", pinned, undefined)).toBeUndefined();
    expect(renderer("pal.memorystore", pinned, new Set())).toBeUndefined();
  });
});
