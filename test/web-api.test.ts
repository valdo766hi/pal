import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../web/src/lib/api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("JSON API responses", () => {
  it("returns a complete successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ servers: [] }))));
    await expect(api.projectMcp("project")).resolves.toEqual({ servers: [] });
  });

  it("rejects truncated successful JSON instead of inventing empty settings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"servers":')));
    await expect(api.projectMcp("project")).rejects.toBeInstanceOf(SyntaxError);
  });

  it("preserves an aborted successful body as a failure", async () => {
    const failure = new DOMException("Response body interrupted", "AbortError");
    const response = new Response();
    vi.spyOn(response, "json").mockRejectedValue(failure);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(api.projectMcp("project")).rejects.toBe(failure);
  });

  it("keeps the HTTP status when an error response is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })));
    await expect(api.projectMcp("project")).rejects.toEqual(new ApiError(503, "error", "HTTP 503"));
  });
});
