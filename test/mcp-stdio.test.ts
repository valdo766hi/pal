import { access, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { McpClient } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { checkStdioAuth, decodeStdio, StdioPrograms, stdioDigest, type StdioAuth } from "../src/pi/mcp-stdio.ts";
import { STDIO_FIXTURE } from "./fixtures/stdio-server.ts";
import { running } from "./fixtures/process.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(auth: StdioAuth = { kind: "none" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-stdio-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd"),
    data = join(root, "data");
  await mkdir(cwd);
  await mkdir(data);
  const programs = new StdioPrograms([data, "/nonexistent-install", "/nix/store"]);
  cleanups.push(() => programs.close());
  const program = await programs.prepare({ command: process.execPath, args: ["-e", STDIO_FIXTURE], cwd });
  const approve = () => {
    program.approval = stdioDigest(program, auth);
  };
  const connect = async (key?: string) => {
    const transport = await programs.transport(program, auth, key, AbortSignal.timeout(10_000));
    const client = new McpClient({ name: "pal-fixture", version: "1", requestTimeoutMs: 2000 });
    cleanups.push(() => client.close());
    await client.connect(transport);
    return client;
  };
  return { root, cwd, data, programs, program, auth, approve, connect };
}
async function inspect(client: McpClient, mode = "echo") {
  const result = await client.callTool("inspect", { mode });
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("fixture result missing");
  return JSON.parse(block.text) as {
    pid: number;
    child?: number;
    cwd: string;
    home: string;
    env: Record<string, string>;
  };
}
describe("approved local MCP programs", () => {
  it("requires the exact command/arguments/cwd/environment approval, with no anonymous key fallback", async () => {
    const fixture = await setup({ kind: "env", variable: "LOCAL_TOKEN" });
    await expect(fixture.connect("fixture-stdio-key")).rejects.toThrow(/approve this exact/);
    fixture.approve();
    await expect(fixture.connect()).rejects.toThrow(/configure.*API key/);
    const original = fixture.program.approval;
    fixture.program.args = [...fixture.program.args, "changed"];
    await expect(fixture.connect("fixture-stdio-key")).rejects.toThrow(/approve this exact/);
    fixture.program.args = fixture.program.args.slice(0, -1);
    expect(stdioDigest(fixture.program, fixture.auth)).toBe(original);
    await expect(
      fixture.programs.transport(
        fixture.program,
        { kind: "env", variable: "ANOTHER_TOKEN" },
        "fixture-stdio-key",
        AbortSignal.timeout(2000),
      ),
    ).rejects.toThrow(/approve this exact/);
  });

  it("uses the explicit cwd and a private temporary home with only the dedicated encrypted-key slot", async () => {
    const fixture = await setup({ kind: "env", variable: "LOCAL_TOKEN" });
    fixture.approve();
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fixture-ambient-must-not-leak";
    try {
      const client = await fixture.connect("fixture-stdio-key");
      const info = await inspect(client);
      expect(info.cwd).toBe(fixture.cwd);
      expect(info.env).toEqual({
        HOME: info.home,
        TMPDIR: info.home,
        PATH: dirname(fixture.program.command),
        LANG: "C.UTF-8",
        LOCAL_TOKEN: "fixture-stdio-key",
      });
      expect(info.home).not.toBe(fixture.cwd);
      await client.close();
      await expect.poll(() => running(info.pid)).toBe(false);
      await expect
        .poll(async () =>
          access(info.home).then(
            () => true,
            () => false,
          ),
        )
        .toBe(false);
    } finally {
      if (prior === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prior;
    }
  });

  it("refuses non-store commands, relative/private cwd, oversized/NUL arguments and startup environment names", async () => {
    const fixture = await setup();
    for (const command of ["node", "/usr/bin/node", join(fixture.cwd, "program")])
      await expect(fixture.programs.prepare({ command, args: [], cwd: fixture.cwd })).rejects.toThrow(/Nix store/);
    for (const cwd of [".", fixture.data, fixture.root, "/nix/store"])
      await expect(fixture.programs.prepare({ command: process.execPath, args: [], cwd })).rejects.toThrow();
    for (const args of [
      Array.from({ length: 33 }, () => "a"),
      ["\0"],
      Array.from({ length: 8 }, () => "x".repeat(4096)),
    ])
      await expect(fixture.programs.prepare({ command: process.execPath, args, cwd: fixture.cwd })).rejects.toThrow();
    for (const variable of ["PATH", "BASH_ENV", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PAL_DATA"])
      expect(() => checkStdioAuth({ kind: "env", variable })).toThrow(/dedicated/);
    expect(() => checkStdioAuth({ kind: "env", variable: "wrong-name" })).toThrow();
    expect(() => decodeStdio("broken JSON")).toThrow(/corrupt/);
  });

  it("accepts dedicated key slots, not interpreter startup, configuration or arbitrary environment variables", () => {
    for (const variable of ["KEY", "API_KEY", "SERVICE_API_KEY", "LOCAL_TOKEN", "SERVICE_SECRET", "SERVICE_PASSWORD"])
      expect(checkStdioAuth({ kind: "env", variable })).toEqual({ kind: "env", variable });
    for (const variable of [
      "PYTHONPATH",
      "RUBYOPT",
      "PERL5OPT",
      "JAVA_TOOL_OPTIONS",
      "GIT_CONFIG_SYSTEM",
      "NODE_EXTRA_CA_CERTS",
      "ARBITRARY",
      "PAL_API_KEY",
      "LD_TOKEN",
    ])
      expect(() => checkStdioAuth({ kind: "env", variable })).toThrow(/dedicated/);
  });

  it("refuses replaced cwd identities and never invents a substitute working folder", async () => {
    const fixture = await setup();
    fixture.approve();
    await rename(fixture.cwd, join(fixture.root, "old-cwd"));
    await mkdir(fixture.cwd);
    await expect(fixture.connect()).rejects.toThrow(/replaced/);
  });

  it("bounds reservations and closes never-started or aborted transports without leaks or recursive close", async () => {
    const fixture = await setup();
    fixture.approve();
    const transports = await Promise.all(
      Array.from({ length: 4 }, () =>
        fixture.programs.transport(fixture.program, fixture.auth, undefined, AbortSignal.timeout(2000)),
      ),
    );
    await expect(fixture.connect()).rejects.toThrow(/four/);
    await Promise.all(transports.flatMap((transport) => [transport.close(), transport.close()]));
    const controller = new AbortController();
    const aborted = await fixture.programs.transport(fixture.program, fixture.auth, undefined, controller.signal);
    controller.abort();
    await expect(aborted.start()).rejects.toThrow();
    await aborted.close();
    const client = await fixture.connect();
    expect((await inspect(client)).cwd).toBe(fixture.cwd);
  });

  it("kills ordinary background children even when the server exits first and they ignore SIGTERM", async () => {
    const fixture = await setup();
    fixture.approve();
    const client = await fixture.connect();
    const info = await inspect(client, "child");
    if (info.child === undefined) throw new Error("fixture child missing");
    expect(await running(info.child)).toBe(true);
    await client.close();
    await expect.poll(() => running(info.child as number), { timeout: 3000 }).toBe(false);
    expect(await running(info.pid)).toBe(false);
  });

  it.each(["flood", "stderr"])(
    "stops a %s flood and releases capacity instead of buffering indefinitely",
    async (mode) => {
      const fixture = await setup();
      fixture.approve();
      const client = await fixture.connect();
      await expect(inspect(client, mode)).rejects.toThrow();
      await client.close();
      const next = await fixture.connect();
      expect((await inspect(next)).cwd).toBe(fixture.cwd);
    },
  );
});
