import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { type EventEmitter, once } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileTools } from "../src/core/files.ts";
import { PrivateFiles } from "../src/core/file-policy.ts";
import { gnuTimeout } from "../src/core/timeout.ts";

let barrier: ((phase: string) => Promise<void>) | undefined;
let workerPrefix: string | undefined;
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (workerPrefix !== undefined) {
        const argv = args[1];
        if (argv?.at(-2) !== "--eval") throw new Error("missing fixed writer program");
        args[1] = [...argv.slice(0, -1), `${workerPrefix}\n${argv.at(-1)}`];
      }
      const child = actual.spawn(...args);
      const events: EventEmitter = child;
      const on = events.on.bind(events);
      vi.spyOn(events, "on").mockImplementation((event, listener) => {
        if (event !== "message") return on(event, listener);
        return on(event, (message: { ready?: boolean; prepared?: boolean }) => {
          const phase = message.ready ? "before-prepare" : message.prepared ? "after-prepare" : "other";
          void Promise.resolve(barrier?.(phase))
            .then(() => listener(message))
            .catch((error: unknown) => child.emit("error", error));
        });
      });
      const send = child.send.bind(child);
      vi.spyOn(child, "send").mockImplementation((...args: Parameters<typeof child.send>) => {
        if (typeof args[0] === "object" && args[0] !== null && "commit" in args[0]) {
          void Promise.resolve(barrier?.("before-publish"))
            .then(() => send(...args))
            .catch((error: unknown) => child.emit("error", error));
          return true;
        }
        return send(...args);
      });
      return child;
    },
  };
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  barrier = undefined;
  workerPrefix = undefined;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const original = "original\n";
const digest = createHash("sha256").update(original).digest("hex");

async function setup() {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pal-file-parent-race-")));
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  const root = join(home, "project"),
    parent = join(root, "src"),
    outside = join(home, "outside"),
    moved = join(root, "original-src");
  await fs.mkdir(parent, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(join(parent, "main.txt"), original);
  await fs.writeFile(join(outside, "main.txt"), original);
  const tool = fileTools({ root: async () => root, deny: [], privateFiles: await PrivateFiles.open([]) }).tools?.find(
    (tool) => tool.name === "files_write",
  );
  if (tool === undefined) throw new Error("missing write tool");
  const api = { conversationId: 1 as ConversationId } as ToolExecutionApi;
  const write = (signal?: AbortSignal) =>
    tool.execute(
      { path: "src/main.txt", expectedHash: digest, content: "replacement\n" } as never,
      api,
      signal === undefined ? context : withAbortSignal(signal, context),
    );
  return { home, parent, outside, moved, write };
}

describe("file mutation parent replacement", () => {
  it.each(["before-prepare", "after-prepare", "before-publish"])(
    "refuses a parent swapped for an outside symlink at %s",
    async (stage) => {
      const { parent, outside, moved, write } = await setup();
      let swapped = false;
      barrier = async (phase) => {
        if (swapped || phase !== stage) return;
        swapped = true;
        await fs.rename(parent, moved);
        await fs.symlink(outside, parent, "dir");
      };
      const failed = await write().then(
        () => false,
        () => true,
      );
      expect({
        swapped,
        failed,
        outside: await fs.readFile(join(outside, "main.txt"), "utf8"),
        original: await fs.readFile(join(moved, "main.txt"), "utf8"),
        temporaryFiles: (await fs.readdir(moved)).filter((name) => name.startsWith(".pal-")),
      }).toEqual({ swapped: true, failed: true, outside: original, original, temporaryFiles: [] });
    },
  );

  it("keeps publication on the original inode when its parent moves after the final check", async () => {
    const { home, parent, outside, write } = await setup();
    const moved = join(home, "late-moved-outside-project");
    workerPrefix = `
      const probe = process.getBuiltinModule("node:fs").promises;
      const rename = probe.rename;
      probe.rename = async (...args) => {
        probe.rename = rename;
        await rename(${JSON.stringify(parent)}, ${JSON.stringify(moved)});
        await probe.symlink(${JSON.stringify(outside)}, ${JSON.stringify(parent)}, "dir");
        return rename(...args);
      };
    `;
    await write();
    expect(await fs.readFile(join(outside, "main.txt"), "utf8")).toBe(original);
    expect(await fs.readFile(join(moved, "main.txt"), "utf8")).toBe("replacement\n");
    expect((await fs.readdir(moved)).filter((name) => name.startsWith(".pal-"))).toEqual([]);
  });

  it("cleans the prepared temporary on cancellation without publishing it", async () => {
    const { parent, write } = await setup();
    const controller = new AbortController();
    let prepared = false;
    barrier = async (phase) => {
      if (phase === "after-prepare") {
        prepared = true;
        controller.abort();
      }
    };
    await expect(write(controller.signal)).rejects.toThrow();
    expect(prepared).toBe(true);
    expect(await fs.readFile(join(parent, "main.txt"), "utf8")).toBe(original);
    expect((await fs.readdir(parent)).filter((name) => name.startsWith(".pal-"))).toEqual([]);
  });

  it("cleans an unpublished write after its controller is killed", async () => {
    const { parent } = await setup();
    const controller = spawn(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/file-write-parent.ts", import.meta.url)), parent],
      {
        env: { PATH: process.env.PATH ?? "", PAL_TIMEOUT: gnuTimeout() },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const exited = once(controller, "exit");
    cleanups.push(async () => {
      if (controller.exitCode === null && controller.signalCode === null) controller.kill("SIGKILL");
      await exited;
    });
    const [message] = await once(controller, "message", { signal: AbortSignal.timeout(5000) });
    expect(message).toMatchObject({ prepared: true });
    if (typeof message.worker !== "number" || !Number.isSafeInteger(message.worker) || message.worker < 1)
      throw new Error("the fixture did not identify its worker");
    const pid: number = message.worker;
    expect((await fs.readdir(parent)).filter((name) => name.startsWith(".pal-"))).toHaveLength(1);
    controller.kill("SIGKILL");
    await exited;
    await expect
      .poll(async () => (await fs.readdir(parent)).filter((name) => name.startsWith(".pal-")), { timeout: 2000 })
      .toEqual([]);
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
            throw error;
          }
        },
        { timeout: 2000 },
      )
      .toBe(false);
    expect(await fs.readFile(join(parent, "main.txt"), "utf8")).toBe(original);
  });

  it("preserves the original file's permissions independently of umask", async () => {
    const { parent, write } = await setup();
    await fs.chmod(join(parent, "main.txt"), 0o666);
    await write();
    expect((await fs.stat(join(parent, "main.txt"))).mode & 0o777).toBe(0o666);
    expect(await fs.readFile(join(parent, "main.txt"), "utf8")).toBe("replacement\n");
    expect((await fs.readdir(parent)).filter((name) => name.startsWith(".pal-"))).toEqual([]);
  });
});
