import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openPal } from "../src/core/app.ts";
import { fakeRtk } from "./fixtures/fake-rtk.ts";
import { startOpenAIFixture } from "./fixtures/openai-server.ts";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostCommands, WorkspaceLocks, outputReachesModel, shellTools } from "../src/core/execution.ts";
import type { ConversationId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-command-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const commands = new HostCommands();
  cleanups.push(() => commands.close());
  return { root, commands };
}
async function running(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") return !/^\d+ \(.*\) [ZX]/.test(await readFile(`/proc/${pid}/stat`, "utf8"));
    return true;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

describe("trusted host commands", () => {
  it("rechecks workspace authority after the durable intent and before dispatch", async () => {
    const { root, commands } = await setup();
    let authorized: string | undefined = root;
    const tools = shellTools({ root: async () => authorized, commands, locks: new WorkspaceLocks() });
    const tool = tools.tools?.find((tool) => tool.name === "shell_run") as ToolRegistration;
    const api = {
      conversationId: 1 as ConversationId,
      commit: async () => {
        authorized = undefined;
      },
    } as unknown as ToolExecutionApi;
    await expect(
      tool.execute({ command: "printf dispatched > marker", timeout: 1 } as never, api, context),
    ).rejects.toThrow(/revoked before command dispatch/);
    await expect(readFile(join(root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts in the project and does not inherit secrets or shell startup configuration", async () => {
    const { root, commands } = await setup();
    const old = { key: process.env.OPENAI_API_KEY, startup: process.env.BASH_ENV };
    await writeFile(join(root, "startup"), "echo startup-leaked\n");
    process.env.OPENAI_API_KEY = "fixture-secret-must-not-leak";
    process.env.BASH_ENV = join(root, "startup");
    try {
      const result = await commands.run(
        root,
        'pwd; printf "%s" "${OPENAI_API_KEY-missing}:${BASH_ENV-missing}"; printf error >&2; exit 7',
        2,
      );
      expect(result).toMatchObject({ exitCode: 7, timedOut: false, truncated: false });
      expect(result.output).toContain(root);
      expect(result.output).toContain("missing:missing");
      expect(result.output).toContain("error");
      expect(result.output).not.toMatch(/fixture-secret|startup-leaked/);
    } finally {
      if (old.key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old.key;
      if (old.startup === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = old.startup;
    }
  });
  it("bounds Unicode flood output and has a real deadline", async () => {
    const { root, commands } = await setup();
    const flood = await commands.run(root, `${process.execPath} -e 'process.stdout.write("é".repeat(200000))'`, 3);
    expect(flood.truncated).toBe(true);
    expect(Buffer.byteLength(flood.output)).toBeLessThanOrEqual(64 * 1024);
    expect(flood.output).not.toContain("�");
    expect(await commands.run(root, "sleep 30", 0.1)).toMatchObject({ timedOut: true, exitCode: 124 });
  });
  it("kills the process group on Stop and does not leave ordinary background children", async () => {
    const { root, commands } = await setup();
    const controller = new AbortController();
    const stopped = commands
      .run(root, "sleep 30 & echo $! > child.pid; wait", 10, controller.signal)
      .catch((error: unknown) => error);
    await expect.poll(() => readFile(join(root, "child.pid"), "utf8")).toMatch(/^\d+/);
    const pid = Number((await readFile(join(root, "child.pid"), "utf8")).trim());
    controller.abort();
    expect(await stopped).toBeInstanceOf(Error);
    await expect.poll(() => running(pid)).toBe(false);
    await commands.run(root, "sleep 30 >/dev/null 2>&1 & echo $! > background.pid", 2);
    const background = Number((await readFile(join(root, "background.pid"), "utf8")).trim());
    await expect.poll(() => running(background)).toBe(false);
  });
  it("caps active commands, closes them, and contains an output callback failure", async () => {
    const { root, commands } = await setup();
    const first = commands.run(root, "sleep 30", 10).catch((error: unknown) => error);
    const second = commands.run(root, "sleep 30", 10).catch((error: unknown) => error);
    await expect(commands.run(root, "true", 1)).rejects.toThrow(/two host commands/);
    await commands.close();
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    await expect(
      commands.run(root, "printf test", 1, undefined, () => {
        throw new Error("consumer closed");
      }),
    ).rejects.toThrow("consumer closed");
    await expect(commands.run(root, "true", 999)).rejects.toThrow(/120/);
  });
  it("does not replay an unknown host effect after SIGKILL and bounds the orphan command", async () => {
    const { root } = await setup();
    const fixture = await startOpenAIFixture();
    cleanups.push(fixture.close);
    fixture.behavior.responses = "script";
    fixture.behavior.script =
      'return await tools.shell_run({ command: "printf run >> marker; echo $PPID > command.pid; sleep 30", timeout: 1 });';
    const dataRoot = join(root, "data");
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        join(import.meta.dirname, "fixtures/execution-child.ts"),
        dataRoot,
        JSON.stringify(fixture.endpoints),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    const lines = createInterface({ input: child.stdout });
    const [line] = await Promise.race([
      once(lines, "line"),
      once(child, "exit").then(() => {
        throw new Error("fixture exited before ready");
      }),
    ]);
    const ready = JSON.parse(String(line)) as { root: string; chatId: string };
    await expect.poll(() => readFile(join(ready.root, "command.pid"), "utf8"), { timeout: 5000 }).toMatch(/^\d+/);
    const commandPid = Number((await readFile(join(ready.root, "command.pid"), "utf8")).trim());
    child.kill("SIGKILL");
    await once(child, "exit");
    const reopened = await openPal(
      { dataRoot, installRoot: "/nonexistent-install", endpoints: fixture.endpoints },
      context,
    );
    cleanups.push(() => reopened.close());
    await reopened.harness.waitForIdle(context);
    await expect.poll(() => running(commandPid), { timeout: 4000 }).toBe(false);
    expect(await readFile(join(ready.root, "marker"), "utf8")).toBe("run");
    const chat = await reopened.chats.get(ready.chatId);
    if (chat === undefined) throw new Error("missing recovered chat");
    const history = await (await reopened.harness.conversation(chat.conversationId, context))?.context(context);
    const intents = history?.entries.filter((entry) => entry.kind === "pal.shell");
    expect(intents).toHaveLength(1);
    expect(intents?.[0]?.data).toMatchObject({ shell: { status: "started" } });
  });

  it("locks overlapping roots and releases them even when work fails", async () => {
    const locks = new WorkspaceLocks();
    const done = Promise.withResolvers<undefined>();
    const held = locks.run("/workspace", () => done.promise);
    await expect(locks.run("/workspace/nested", async () => true)).rejects.toThrow(/busy/);
    await expect(locks.run("/workspace/..nested", async () => true)).rejects.toThrow(/busy/);
    await expect(locks.run("/", async () => true)).rejects.toThrow(/busy/);
    expect(await locks.run("/other", async () => true)).toBe(true);
    done.resolve(undefined);
    await held;
    await expect(
      locks.run("/workspace", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(await locks.run("/workspace", async () => true)).toBe(true);
  });
});

describe("compact command output", () => {
  async function shell(compact: boolean) {
    const { root, commands } = await setup();
    const rtk = await fakeRtk();
    cleanups.push(rtk.cleanup);
    const entries: { data: { shell: Record<string, unknown> } }[] = [];
    const tools = shellTools({
      root: async () => root,
      commands,
      locks: new WorkspaceLocks(),
      compact: async () => compact,
    });
    const tool = tools.tools?.find((tool) => tool.name === "shell_run") as ToolRegistration;
    const api = {
      conversationId: 1 as ConversationId,
      taskId: 7,
      output: () => undefined,
      commit: async (work: (tx: unknown) => Promise<unknown>) =>
        work({ appendEntry: async (_conversation: unknown, entry: (typeof entries)[number]) => entries.push(entry) }),
    } as unknown as ToolExecutionApi;
    const call = async (command: string) =>
      (await tool.execute({ command, timeout: 5 } as never, api, context)) as {
        structuredOutput: Record<string, unknown>;
        isError: boolean;
      };
    return { root, commands, rtk, entries, call };
  }

  it("runs the rtk equivalent, keeps its exit code, and names it from intent to receipt", async () => {
    const { rtk, entries, call } = await shell(true);
    const result = await call("report hello 5");
    expect(result.isError).toBe(true);
    expect(result.structuredOutput).toMatchObject({
      output: "compact:hello\n",
      exitCode: 5,
      executed: "rtk report hello 5",
    });
    expect(entries.map((entry) => entry.data.shell)).toEqual([
      expect.objectContaining({ status: "started", command: "report hello 5", executed: "rtk report hello 5" }),
      expect.objectContaining({ status: "finished", command: "report hello 5", executed: "rtk report hello 5" }),
    ]);
    expect((await call("allowed again 0")).structuredOutput).toMatchObject({
      output: "compact:again\n",
      exitCode: 0,
      executed: "rtk report again 0",
    });
    // The owner's rtk and agent configuration never apply: every call gets a throwaway home.
    for (const { home } of await rtk.calls()) expect(home).not.toBe(homedir());
  });

  it("runs commands unchanged without an equivalent, on a denial, when output is redirected, or without rtk", async () => {
    const { root, commands, rtk, entries, call } = await shell(true);
    const plain = await call("printf plain");
    expect(plain.structuredOutput).toMatchObject({ output: "plain", exitCode: 0 });
    expect(plain.structuredOutput).not.toHaveProperty("executed");
    const denied = await call("denied thing");
    expect(denied.structuredOutput).toMatchObject({ exitCode: 127 });
    expect(denied.structuredOutput).not.toHaveProperty("executed");
    // Output that feeds a file or another program must stay exact, so rtk is never asked.
    const consulted = (await rtk.calls()).length;
    for (const command of [
      "report hi 0 > out",
      "report hi 0 | cat",
      "report hi 0 2>&1",
      'x="$(report hi 0)"; echo "$x"',
    ])
      expect((await call(command)).structuredOutput).not.toHaveProperty("executed");
    expect(await rtk.calls()).toHaveLength(consulted);
    expect(await readFile(join(root, "out"), "utf8")).toBe("");
    for (const entry of entries) expect(entry.data.shell).not.toHaveProperty("executed");
    const path = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      expect(await commands.rewrite(root, "report hello 0")).toBeUndefined();
    } finally {
      process.env.PATH = path;
    }
  });

  it("never consults rtk for chats without compact output", async () => {
    const { rtk, call } = await shell(false);
    const result = await call("report hello 0");
    expect(result.structuredOutput).toMatchObject({ exitCode: 127 });
    expect(result.structuredOutput).not.toHaveProperty("executed");
    expect(await rtk.calls()).toEqual([]);
  });

  it("rewrites only commands whose whole output reaches the model", () => {
    for (const command of [
      "git status",
      "git status && git log -2",
      "git status; ls",
      "git log --format='%h|%s' -2",
      'git log --format="%h > %s"',
      "grep -n a\\|b file",
    ])
      expect(outputReachesModel(command), command).toBe(true);
    for (const command of [
      "git diff > patch",
      "git diff >> patch",
      "git diff | wc -l",
      "git status || true",
      "git diff 2>&1",
      "git diff < input",
      "cat <<EOF\nx\nEOF",
      "git diff | tee out",
      "x=$(git status)",
      'echo "$(git status)"',
      "echo `git status`",
      "git status &",
      "git status\ngit diff > patch",
      "git log --format='unterminated",
    ])
      expect(outputReachesModel(command), command).toBe(false);
  });

  it("bounds a rewrite that ignores termination, and stops one in flight on Stop or close", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-command-test-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const rtk = await fakeRtk();
    cleanups.push(rtk.cleanup);
    const bounded = new HostCommands({ rewriteMs: 500 });
    cleanups.push(() => bounded.close());
    // The first exec of a new script can be slower than the deadline on macOS, which would hide the hang.
    expect(await bounded.rewrite(root, "printf warm", AbortSignal.timeout(30_000))).toBeUndefined();
    const started = Date.now();
    expect(await bounded.rewrite(root, "slow deadline")).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
    const late = await rtk.slowPids();
    if (late === undefined) throw new Error("rewrite never started");
    for (const pid of late) await expect.poll(() => running(pid)).toBe(false);

    const commands = new HostCommands({ rewriteMs: 60_000 });
    cleanups.push(() => commands.close());
    const pids = async (previous: readonly [number, number]) => {
      await expect
        .poll(async () => {
          const current = await rtk.slowPids();
          return current !== undefined && current.every((pid, i) => pid !== previous[i]);
        })
        .toBe(true);
      const current = await rtk.slowPids();
      if (current === undefined) throw new Error("rewrite never started");
      return current;
    };
    const controller = new AbortController();
    const stopped = commands.rewrite(root, "slow stop", controller.signal);
    const first = await pids(late);
    controller.abort();
    await expect(stopped).rejects.toThrow(/stopped before dispatch/);
    for (const pid of first) await expect.poll(() => running(pid)).toBe(false);

    const closing = expect(commands.rewrite(root, "slow close")).rejects.toThrow(/stopped before dispatch/);
    const second = await pids(first);
    await commands.close();
    await closing;
    for (const pid of second) await expect.poll(() => running(pid)).toBe(false);
  });

  it.each([undefined, 2_000])(
    "bounds orphaned rewrites and descendants after parent SIGKILL (override: %s)",
    async (rewriteMs) => {
      const { root, commands } = await setup();
      const rtk = await fakeRtk();
      cleanups.push(rtk.cleanup);
      expect(await commands.rewrite(root, "printf warm")).toBeUndefined();
      const child = spawn(
        process.execPath,
        [
          join(import.meta.dirname, "fixtures/rtk-rewrite-child.ts"),
          root,
          ...(rewriteMs === undefined ? [] : [String(rewriteMs)]),
        ],
        { stdio: "ignore" },
      );
      const exited = once(child, "exit");
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        for (const pid of (await rtk.slowPids()) ?? []) {
          if (!(await running(pid))) continue;
          for (const target of [-pid, pid]) {
            try {
              process.kill(target, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
        }
      });
      await expect.poll(() => rtk.slowPids(), { timeout: 5000 }).toBeDefined();
      const pids = await rtk.slowPids();
      if (pids === undefined) throw new Error("rewrite never started");
      for (const pid of pids) expect(await running(pid)).toBe(true);
      child.kill("SIGKILL");
      expect((await exited)[1]).toBe("SIGKILL");
      await expect
        .poll(() => Promise.all(pids.map(running)), { timeout: (rewriteMs ?? 5_000) + 2_500 })
        .toEqual([false, false]);
    },
  );
});
