import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSnapshot } from "./files.ts";
import { gnuCoreutil, gnuTimeout } from "./timeout.ts";

const GIT_FLAGS = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];
const RECEIPT_WAIT_MS = 7000;

export type GitOptions = {
  readonly signal: AbortSignal;
  readonly input?: Buffer;
  readonly acceptOne?: boolean;
  readonly maxBytes?: number;
};

/** No ambient credentials, hooks, fsmonitor or lazy fetch. Checkout/status can still run filters: use raw objects. */
export function runGit(cwd: string, args: readonly string[], options: GitOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // The independent deadline also bounds a Git child orphaned by a killed Pal process.
    const child = execFile(
      gnuTimeout(),
      ["--kill-after=1s", "5s", "git", ...GIT_FLAGS, ...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: options.maxBytes ?? 256 * 1024,
        timeout: 7000,
        signal: options.signal,
        env: gitEnvironment(cwd),
      },
      (error, stdout) => {
        if (error !== null && error.code === "ENOENT")
          reject(new Error("Git and GNU timeout from coreutils must be on PATH (gtimeout on macOS)"));
        else if (error !== null && !(options.acceptOne && error.code === 1))
          reject(new Error("Git unavailable or exceeds its limits; no hooks, filters or network were allowed"));
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", reject);
    child.stdin?.end(options.input);
  });
}

/** A started mutation without a completion receipt must be inspected, never dispatched again. */
export class GitEffectUnknown extends Error {}

// This fixed host worker retains the receipt even if Pal dies; no repository code or shell startup files are loaded.
const RECEIPT_WORKER = `set -euo pipefail
umask 077
set -C
receipt="$1"
timeout="$2"
sync="$3"
mv="$4"
shift 4
status=0
"$timeout" --kill-after=1s 5s git "$@" >/dev/null 2>&1 || status=$?
printf '%s\\n' "$status" > "$receipt.next"
"$sync" -f "$receipt.next"
"$mv" -T -- "$receipt.next" "$receipt"
"$sync" -f "$(dirname -- "$receipt")"
exit "$status"
`;

/** Caller supplies an app-private receipt path, recorded before dispatch, for one exact metadata mutation. */
export async function runGitEffect(
  cwd: string,
  args: readonly string[],
  receipt: string,
  signal: AbortSignal,
  mode: "start" | "reconcile" = "start",
): Promise<void> {
  const intent = `${createHash("sha256")
    .update(JSON.stringify(["git-effect-1", cwd, GIT_FLAGS, args]))
    .digest("hex")}\n`;
  let started = false;
  // Found before the intent is recorded, so a host without them refuses instead of leaving an unknown outcome.
  const sync = mode === "start" ? gnuCoreutil("sync") : undefined;
  const mv = mode === "start" ? gnuCoreutil("mv") : undefined;
  if (mode === "start" && (sync === undefined || mv === undefined))
    throw new Error("GNU sync and mv from coreutils must be on PATH (gsync and gmv on macOS)");
  if (mode === "start")
    try {
      const marker = await open(`${receipt}.started`, "wx", 0o600);
      try {
        await marker.writeFile(intent);
        await marker.sync();
      } finally {
        await marker.close();
      }
      const parent = await open(dirname(receipt), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      started = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  const marker = await readFileSnapshot(`${receipt}.started`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    throw new GitEffectUnknown("the Git intent receipt is missing; no mutation was retried");
  });
  if (marker.truncated || !marker.bytes.equals(Buffer.from(intent)))
    throw new GitEffectUnknown("the recorded Git intent does not match this release or workspace");
  if (started) {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.env.PAL_BASH ?? "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          RECEIPT_WORKER,
          "pal-git",
          receipt,
          gnuTimeout(),
          sync ?? "sync",
          mv ?? "mv",
          ...GIT_FLAGS,
          ...args,
        ],
        {
          cwd,
          timeout: 8000,
          maxBuffer: 4096,
          signal,
          env: gitEnvironment(cwd),
        },
        (error) => {
          if (error !== null && signal.aborted) reject(error);
          else resolve();
        },
      );
      child.stdin?.end();
    });
  }
  const deadline = Date.now() + RECEIPT_WAIT_MS;
  for (;;) {
    signal.throwIfAborted();
    const result = await readFileSnapshot(receipt).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (result !== undefined) {
      const text = result.bytes.toString("utf8");
      if (result.truncated || !/^(?:0|[1-9]\d{0,2})\n$/.test(text) || Number(text) > 255)
        throw new GitEffectUnknown("the Git completion receipt is invalid");
      if (Number(text) !== 0) throw new Error("Git workspace creation failed; retained files must be inspected");
      return;
    }
    if (Date.now() >= deadline) throw new GitEffectUnknown("Git outcome is unknown; no mutation was retried");
    await sleep(50, undefined, { signal });
  }
}

function gitEnvironment(cwd: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/run/current-system/sw/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CEILING_DIRECTORIES: dirname(cwd),
  };
}
