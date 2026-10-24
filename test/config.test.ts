import { describe, expect, it } from "vitest";
import { type HostFacts, parseCommand, UsageError } from "../src/core/config.ts";

const linux: HostFacts = { env: {}, platform: "linux", home: "/home/owner", installRoot: "/opt/pal" };

function serve(argv: string[], host: HostFacts = linux) {
  const command = parseCommand(argv, host);
  if (command.kind !== "serve") throw new Error(`expected serve, got ${command.kind}`);
  return command.config;
}

describe("parseCommand", () => {
  it("defaults to serving on loopback with the XDG data directory", () => {
    expect(serve([])).toEqual({ host: "127.0.0.1", port: 7337, dataRoot: "/home/owner/.local/share/pal" });
    expect(serve([], { ...linux, env: { XDG_DATA_HOME: "/data/xdg" } }).dataRoot).toBe("/data/xdg/pal");
  });

  it("ignores a relative XDG_DATA_HOME as the XDG spec requires", () => {
    expect(serve([], { ...linux, env: { XDG_DATA_HOME: "rel" } }).dataRoot).toBe("/home/owner/.local/share/pal");
  });

  it("uses Application Support on macOS", () => {
    const darwin: HostFacts = { ...linux, platform: "darwin", home: "/Users/owner" };
    expect(serve([], darwin).dataRoot).toBe("/Users/owner/Library/Application Support/pal");
  });

  it("parses explicit options and commands", () => {
    expect(serve(["serve", "--host", "::1", "--port", "0", "--data-dir", "/srv/pal/"])).toEqual({
      host: "::1",
      port: 0,
      dataRoot: "/srv/pal",
    });
    expect(parseCommand(["--help"], linux)).toEqual({ kind: "help" });
    expect(parseCommand(["-v"], linux)).toEqual({ kind: "version" });
    expect(parseCommand(["probe"], linux)).toEqual({ kind: "probe" });
    expect(parseCommand(["doctor", "--json"], linux)).toEqual({
      kind: "doctor",
      dataRoot: "/home/owner/.local/share/pal",
      json: true,
    });
    expect(() => parseCommand(["doctor", "--port", "1"], linux)).toThrow(/does not accept --port/);
  });

  it.each([
    [["--host", "0.0.0.0"], /public-origin/],
    [["--host", "192.168.1.2"], /public-origin/],
    [["--host", "attacker.example", "--public-origin", "https://pal.example"], /address/],
    [["--port", "65536"], /--port/],
    [["--port", "80a"], /--port/],
    [["--data-dir", "relative/dir"], /absolute/],
    [["--data-dir", "/nix/store/abc-pal"], /nix\/store/],
    [["--data-dir", "/opt/pal/data"], /application directory/],
    [["--data-dir", "/opt"], /application directory/],
    [["--bogus"], /Unknown option/],
    [["deploy"], /unknown command/],
    [["serve", "extra"], /unexpected argument/],
    [["probe", "--port", "1"], /does not accept/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCommand(argv, linux)).toThrow(UsageError);
    expect(() => parseCommand(argv, linux)).toThrow(message);
  });

  it("checks only an explicit candidate worktree and never accepts activation flags", () => {
    expect(parseCommand(["check-release", "--candidate", "/tmp/candidate", "--data-dir", "/data/pal"], linux)).toEqual({
      kind: "check-release",
      candidate: "/tmp/candidate",
      dataRoot: "/data/pal",
    });
    for (const argv of [
      ["check-release"],
      ["check-release", "--candidate", "relative"],
      ["serve", "--candidate", "/tmp/candidate"],
      ["probe", "--candidate", "/tmp/candidate"],
      ["check-release", "--candidate", "/tmp/candidate", "--port", "7337"],
      ["check-release", "--candidate", "/tmp/candidate", "--approve"],
    ])
      expect(() => parseCommand(argv, linux)).toThrow(UsageError);
  });

  it("parses stopped-state backup and restore with explicit destinations and opt-in sensitive data", () => {
    expect(parseCommand(["backup", "--output", "/backups/pal-1/", "--data-dir", "/data/pal"], linux)).toEqual({
      kind: "backup",
      dataRoot: "/data/pal",
      output: "/backups/pal-1",
      includeCredentialKey: false,
      includeBrowserProfiles: false,
    });
    expect(
      parseCommand(["backup", "--output", "/b", "--include-credential-key", "--include-browser-profiles"], linux),
    ).toMatchObject({
      dataRoot: "/home/owner/.local/share/pal",
      includeCredentialKey: true,
      includeBrowserProfiles: true,
    });
    expect(parseCommand(["restore", "--from", "/b", "--check"], linux)).toEqual({
      kind: "restore",
      check: true,
      from: "/b",
    });
    expect(
      parseCommand(["restore", "--from", "/b", "--data-dir", "/data/pal", "--credential-key", "/keys/pal.key"], linux),
    ).toEqual({ kind: "restore", check: false, from: "/b", dataRoot: "/data/pal", credentialKey: "/keys/pal.key" });
    for (const [argv, message] of [
      [["backup"], /--output/],
      [["backup", "--output", "relative"], /--output/],
      [["backup", "--output", "/b", "--port", "1"], /does not accept --port/],
      [["restore", "--from", "/b"], /--check or an explicit --data-dir/],
      [["restore", "--from", "/b", "--check", "--data-dir", "/data/pal"], /does not accept --data-dir/],
      [["restore", "--from", "relative", "--check"], /--from/],
      [["restore", "--from", "/b", "--check", "--credential-key", "key"], /--credential-key/],
      [["restore", "--from", "/b", "--check", "--include-credential-key"], /does not accept/],
      [["serve", "--output", "/b"], /does not accept --output/],
      [["check-release", "--candidate", "/c", "--from", "/b"], /does not accept --from/],
    ] as const)
      expect(() => parseCommand([...argv], linux)).toThrow(message);
  });

  it("parses the Linux supervisor with the same binding rules, but no direct activation flags", () => {
    expect(parseCommand(["supervise", "--port", "0", "--data-dir", "/data/pal"], linux)).toEqual({
      kind: "supervise",
      config: { host: "127.0.0.1", port: 0, dataRoot: "/data/pal" },
    });
    expect(() => parseCommand(["supervise"], { ...linux, platform: "darwin" })).toThrow(/requires Linux/);
    expect(() => parseCommand(["supervise", "--host", "0.0.0.0"], linux)).toThrow(/public-origin/);
    expect(() => parseCommand(["supervise", "--candidate", "/tmp/candidate"], linux)).toThrow(/does not accept/);
    expect(() => parseCommand(["supervise", "--activate", "digest"], linux)).toThrow(UsageError);
  });

  it("requires explicit canonical public origins for remote binding", () => {
    expect(serve(["--host", "100.64.0.10", "--public-origin", "http://100.64.0.10:7337/"])).toMatchObject({
      host: "100.64.0.10",
      publicOrigin: "http://100.64.0.10:7337",
    });
    expect(serve(["--public-origin", "https://pal.example/"])).toMatchObject({
      host: "127.0.0.1",
      publicOrigin: "https://pal.example",
    });
    for (const origin of [
      "invalid",
      "ftp://pal.example",
      "https://user:pass@pal.example",
      "https://pal.example/path",
      "https://pal.example?key=x",
      "https://pal.example#x",
    ]) {
      expect(() => serve(["--public-origin", origin])).toThrow(UsageError);
    }
    expect(() => serve(["probe", "--public-origin", "https://pal.example"])).toThrow(/does not accept/);
  });

  it("requires an explicit data directory where no default exists", () => {
    expect(() => parseCommand([], { ...linux, platform: "win32" })).toThrow(/pass --data-dir/);
    expect(serve(["--data-dir", "/data/pal"], { ...linux, platform: "win32" }).dataRoot).toBe("/data/pal");
  });
});
