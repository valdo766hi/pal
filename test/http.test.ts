import { describe, expect, it } from "vitest";
import { isOwnHost, isOwnOrigin } from "../src/core/http.ts";

function request(host: string | undefined, port = 7337): Parameters<typeof isOwnHost>[0] {
  return { headers: host === undefined ? {} : { host }, socket: { localPort: port } } as Parameters<
    typeof isOwnHost
  >[0];
}

const external = new URL("https://pal.example.com:8443");

describe("isOwnHost", () => {
  it("accepts every loopback authority at the arrival port", () => {
    for (const host of ["127.0.0.1:7337", "127.0.0.2:7337", "127.9.9.9:7337", "localhost:7337", "[::1]:7337"]) {
      expect(isOwnHost(request(host), undefined), host).toBe(true);
    }
  });

  it("accepts the exact configured public host", () => {
    expect(isOwnHost(request("pal.example.com:8443"), external)).toBe(true);
    expect(isOwnHost(request("pal.example.com:8443"), undefined)).toBe(false);
  });

  it("rejects wrong hosts, wrong ports and malformed loopback names", () => {
    for (const host of [
      "evil.example.com:7337",
      "127.0.0.2:9999",
      "127.0.0.1",
      "127.999.1.1:7337",
      "127.0.0.2.evil.com:7337",
      "[::2]:7337",
      undefined,
    ]) {
      expect(isOwnHost(request(host), external), String(host)).toBe(false);
    }
  });
});

describe("isOwnOrigin", () => {
  it("matches the origin of a loopback authority at the arrival port", () => {
    expect(isOwnOrigin({ headers: { host: "127.0.0.2:7337", origin: "http://127.0.0.2:7337" } } as never)).toBe(true);
  });

  it("rejects foreign origins", () => {
    expect(isOwnOrigin({ headers: { host: "127.0.0.2:7337", origin: "http://127.0.0.1:7337" } } as never)).toBe(false);
    expect(
      isOwnOrigin({ headers: { host: "pal.example.com:443", origin: "https://evil.example.com" } } as never, external),
    ).toBe(false);
  });
});
