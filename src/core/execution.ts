import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { defineExtension, defineTool, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
import { gnuTimeout } from "./timeout.ts";
import type { WorkingChecks } from "./working-checks.ts";

const MAX_OUTPUT = 64 * 1024;
export const SHELL_NAMESPACE: CodemodeNamespace = {
  name: "shell",
  prefix: "shell_",
  description: "Trusted host commands, not sandboxed.",
  instructions:
    "Commands start in the project folder as the Pal user. Never access Pal data, credentials or unrelated private files. Print or return results. Interrupted commands have unknown effects: inspect before retrying.",
};

export class WorkspaceBusy extends Error {}

/** Serializes overlapping writable roots, not external editors or arbitrary host processes. */
export class WorkspaceLocks {
  readonly #active = new Set<string>();
  readonly #before: ((root: string) => Promise<void>) | undefined;
  constructor(before?: (root: string) => Promise<void>) {
    this.#before = before;
  }
  async run<T>(root: string, work: () => Promise<T>): Promise<T> {
    const inside = (a: string, b: string) => {
      const path = relative(a, b);
      return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    };
    if ([...this.#active].some((other) => inside(root, other) || inside(other, root)))
      throw new WorkspaceBusy("an overlapping workspace is busy; wait for its mutation to finish");
    this.#active.add(root);
    try {
      await this.#before?.(root);
      return await work();
    } finally {
      this.#active.delete(root);
    }
  }
}

export type ShellResult = { output: string; exitCode: number; truncated: boolean; timedOut: boolean };

export const COMPACT_EXTENSION = "pal.compact";
export const compactOutput = defineExtension({ name: COMPACT_EXTENSION });

function cleanEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/run/current-system/sw/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    LANG: "C",
    TERM: "dumb",
  };
}

/** Condensing piped or redirected data changes command semantics, not just presentation. */
export function outputReachesModel(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`" || (c === "$" && command[i + 1] === "(")) return false;
    if (quote === '"') {
      if (c === '"') quote = undefined;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "|" || c === ">" || c === "<" || c === "\n") return false;
    else if (c === "&") {
      if (command[i + 1] !== "&") return false;
      i++;
    }
  }
  return quote === undefined;
}

/** Explicit high-trust host execution. Cwd and a clean environment are not filesystem/network confinement. */
export class HostCommands {
  readonly #running = new Map<AbortController, Promise<ShellResult>>();
  readonly #rewrites = new Map<AbortController, Promise<string | undefined>>();
  readonly #rewriteMs: number;
  constructor(options: { rewriteMs?: number } = {}) {
    this.#rewriteMs = options.rewriteMs ?? 5_000;
  }

  /** Failed rewrites keep the original command; Stop and shutdown must terminate the helper. */
  async rewrite(cwd: string, command: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!outputReachesModel(command)) return undefined;
    const controller = new AbortController();
    const active = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const job = this.#rewrite(cwd, command, active);
    this.#rewrites.set(controller, job);
    try {
      return await job;
    } finally {
      this.#rewrites.delete(controller);
    }
  }
  async #rewrite(cwd: string, command: string, signal: AbortSignal): Promise<string | undefined> {
    const stopped = () => new Error("host command stopped before dispatch; nothing was run");
    if (signal.aborted) throw stopped();
    const home = await mkdtemp(join(tmpdir(), "pal-rtk-"));
    try {
      const result = await new Promise<{ code: number | null; stdout: string } | undefined>((resolve) => {
        const child = spawn(
          gnuTimeout(),
          ["--kill-after=1s", `${this.#rewriteMs / 1000}s`, "rtk", "rewrite", command],
          {
            cwd,
            detached: true,
            stdio: ["ignore", "pipe", "ignore"],
            env: cleanEnv(home),
          },
        );
        let stdout = "";
        const kill = () => {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already exited. */
            }
          }
        };
        const timer = setTimeout(kill, this.#rewriteMs);
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", kill);
          kill();
        };
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (stdout.length > 64 * 1024) kill();
        });
        child.once("error", () => {
          cleanup();
          resolve(undefined);
        });
        child.once("exit", kill);
        child.once("close", (code) => {
          cleanup();
          resolve({ code, stdout });
        });
        signal.addEventListener("abort", kill, { once: true });
        if (signal.aborted) kill();
      });
      if (signal.aborted) throw stopped();
      if (result === undefined || (result.code !== 0 && result.code !== 3)) return undefined;
      const rewritten = result.stdout.trim();
      const valid = rewritten !== "" && rewritten.length <= 16_384 && !rewritten.includes("\0");
      return valid && rewritten !== command ? rewritten : undefined;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  async run(
    cwd: string,
    command: string,
    timeout: number,
    signal?: AbortSignal,
    onOutput?: (text: string) => void,
  ): Promise<ShellResult> {
    if (this.#running.size >= 2) throw new Error("at most two host commands may run at once");
    if (!(timeout > 0 && timeout <= 120) || command.length > 16_384 || command.includes("\0"))
      throw new Error("invalid command or timeout (maximum 120 seconds)");
    const controller = new AbortController();
    const active = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const job = this.#execute(cwd, command, timeout, active, onOutput);
    this.#running.set(controller, job);
    try {
      return await job;
    } finally {
      this.#running.delete(controller);
    }
  }
  async close(): Promise<void> {
    for (const controller of [...this.#running.keys(), ...this.#rewrites.keys()]) controller.abort();
    await Promise.allSettled([...this.#running.values(), ...this.#rewrites.values()]);
  }
  async #execute(
    cwd: string,
    command: string,
    timeout: number,
    signal: AbortSignal,
    onOutput?: (text: string) => void,
  ): Promise<ShellResult> {
    signal.throwIfAborted();
    const home = await mkdtemp(join(tmpdir(), "pal-command-"));
    try {
      signal.throwIfAborted();
      return await new Promise<ShellResult>((resolve, reject) => {
        // GNU timeout retains an independent deadline even if Pal is killed before it can cancel the process group.
        const child = spawn(
          gnuTimeout(),
          ["--kill-after=1s", `${timeout}s`, process.env.PAL_BASH ?? "bash", "--noprofile", "--norc", "-c", command],
          {
            cwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: cleanEnv(home),
          },
        );
        let output = "";
        let truncated = false;
        let timedOut = false;
        const kill = () => {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already exited. */
            }
          }
        };
        const timer = setTimeout(
          () => {
            timedOut = true;
            kill();
          },
          timeout * 1000 + 1500,
        );
        const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")] as const;
        let callbackError: Error | undefined;
        const keep = (text: string) => {
          if (callbackError !== undefined) return;
          try {
            onOutput?.(text);
          } catch (error) {
            callbackError = error instanceof Error ? error : new Error(String(error));
            kill();
            return;
          }
          const bytes = Buffer.from(output + text);
          truncated ||= bytes.length > MAX_OUTPUT;
          const tail = bytes.subarray(-MAX_OUTPUT);
          let offset = 0;
          while (offset < tail.length && ((tail[offset] ?? 0) & 0xc0) === 0x80) offset++;
          output = tail.subarray(offset).toString("utf8");
        };
        child.stdout.on("data", (chunk: Buffer) => keep(decoders[0].write(chunk)));
        child.stderr.on("data", (chunk: Buffer) => keep(decoders[1].write(chunk)));
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", kill);
          kill();
        };
        child.once("error", (error: NodeJS.ErrnoException) => {
          cleanup();
          reject(
            error.code === "ENOENT"
              ? new Error("host commands need GNU timeout from coreutils on PATH (gtimeout on macOS); nothing was run")
              : error,
          );
        });
        child.once("exit", kill);
        child.once("close", (code) => {
          cleanup();
          for (const decoder of decoders) keep(decoder.end());
          if (callbackError !== undefined) reject(callbackError);
          else if (signal.aborted) reject(new Error("host command stopped; effects already performed are not undone"));
          else resolve({ output, exitCode: code ?? 137, truncated, timedOut: timedOut || code === 124 });
        });
        signal.addEventListener("abort", kill, { once: true });
        if (signal.aborted) kill();
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}

export function shellTools(options: {
  root: (id: ConversationId) => Promise<string | undefined>;
  commands: HostCommands;
  locks: WorkspaceLocks;
  /** Approved calls must stay exact, even if the chat later switches to Full access. */
  compact?: (id: ConversationId, task: TaskId, context: Context) => Promise<boolean>;
  verification?: Pick<WorkingChecks, "start" | "finish">;
}) {
  return defineExtension({
    name: "pal.shell",
    tools: [
      defineTool({
        name: "shell_run",
        description:
          "Run a trusted host command in the project folder. Not sandboxed; clean environment, bounded output, 120-second maximum. Never access Pal secrets. An interrupted command must not be blindly retried. When `executed` is present, the command ran as that rtk equivalent and its output is condensed; if the result is unusable, run `rtk bypass <command>` for the unfiltered output. Output sent to files or other programs is never condensed. Optional check binds this execution to an owner goalRevision and zero-based acceptance criterion; working_checks shows its host receipt and source freshness.",
        parameters: Type.Object({
          command: Type.String({ minLength: 1, maxLength: 16_384 }),
          timeout: Type.Optional(Type.Number({ minimum: 0.01, maximum: 120 })),
          check: Type.Optional(
            Type.Object(
              { goalRevision: Type.Integer({ minimum: 1 }), criterion: Type.Integer({ minimum: 0, maximum: 7 }) },
              { additionalProperties: false },
            ),
          ),
        }),
        callers: ["tools"],
        replay: "unsafe",
        outputLimits: { maxBytes: MAX_OUTPUT, maxLines: 2000 },
        structuredOutputSchema: Type.Object({
          output: Type.String(),
          exitCode: Type.Number(),
          truncated: Type.Boolean(),
          timedOut: Type.Boolean(),
          executed: Type.Optional(Type.String()),
        }),
        execute: async (args, api, context) => {
          const configured = await options.root(api.conversationId);
          if (configured === undefined) throw new Error("this conversation has no active project");
          const cwd = await realpath(configured);
          return options.locks.run(cwd, async () => {
            // Decided before the durable intent, so the receipt names exactly what was dispatched.
            const executed =
              (await options.compact?.(api.conversationId, api.taskId, context)) === true
                ? await options.commands.rewrite(cwd, args.command, context.abortSignal)
                : undefined;
            if (args.check !== undefined) {
              if (options.verification === undefined) throw new Error("working verification is unavailable");
              await options.verification.start(api, args.check, cwd, executed ?? args.command, context);
            }
            const shell = {
              callId: String(api.taskId),
              command: args.command,
              ...(executed === undefined ? {} : { executed }),
              cwd,
              status: "started",
            };
            await api.commit(
              (tx) => tx.appendEntry(api.conversationId, { kind: "pal.shell", data: { shell } }),
              context,
            );
            if ((await options.root(api.conversationId)) !== configured)
              throw new Error("the workspace was revoked before command dispatch");
            const ran = await options.commands.run(
              cwd,
              executed ?? args.command,
              args.timeout ?? 120,
              context.abortSignal,
              (text) => api.output(text),
            );
            const result = executed === undefined ? ran : { ...ran, executed };
            if (args.check !== undefined) await options.verification?.finish(api, result, context);
            await api.commit(
              (tx) =>
                tx.appendEntry(api.conversationId, {
                  kind: "pal.shell",
                  data: { shell: { ...shell, status: "finished", ...result } },
                }),
              context,
            );
            return { structuredOutput: result, isError: result.exitCode !== 0 || result.timedOut, details: result };
          });
        },
      }),
    ],
  });
}
