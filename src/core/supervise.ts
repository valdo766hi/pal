import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir, realpath, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Type } from "typebox";
import { MAX_RETAINED_RELEASES } from "../protocol/limits.ts";
import type { ServeConfig } from "./config.ts";
import { HttpError } from "./http.ts";
import { checkedReleases, releaseManifest, verifyRelease, type CheckedRelease } from "./release-check.ts";
import { privateReleaseDirectory, readReleaseJson, releaseLock, writeReleaseJson } from "./release-files.ts";
import { hash, readSource } from "./release-policy.ts";
import { ReleaseRpc, type ReleaseOperation } from "./release-rpc.ts";
import {
  compatibleRelease,
  initialSelection,
  recoveredSelection,
  ReleaseDigest,
  selection,
  stoppedReleaseIdle,
  type ReleaseArtifact,
  type ReleaseSelection,
} from "./release-state.ts";
import { validate } from "./requests.ts";

const exec = promisify(execFile);
const Empty = Type.Object({}, { additionalProperties: false });
const DigestBody = Type.Object({ digest: ReleaseDigest }, { additionalProperties: false });
const Approval = Type.Object(
  { digest: ReleaseDigest, acceptCodeTrust: Type.Literal(true) },
  { additionalProperties: false },
);
const Review = Type.Object(
  { digest: ReleaseDigest, path: Type.String({ maxLength: 4096 }) },
  { additionalProperties: false },
);
const Online = Type.Object(
  { port: Type.Integer({ minimum: 1, maximum: 65535 }), release: ReleaseDigest },
  { additionalProperties: false },
);
export type ReleaseView =
  | { available: false }
  | {
      available: true;
      evaluator: string;
      dataRoot: string;
      current: ReleaseArtifact;
      previous: ReleaseArtifact | null;
      busy: boolean;
      lastError: string | null;
      retained: number;
      candidates: (Pick<CheckedRelease, "digest" | "package" | "candidate" | "source" | "checkedAt" | "changes"> & {
        approved: boolean;
      })[];
    };
export type ReleaseReview = {
  path: string;
  before: { text: string; truncated: boolean };
  after: { text: string; truncated: boolean };
};
type Runtime = { process: ChildProcess; rpc: ReleaseRpc; exited: Promise<void>; expected: boolean; origin: string };
export type SupervisorHooks = {
  /** Deterministic host-fixture barriers; not exposed by CLI, environment or HTTP. */
  selected?: (state: ReleaseSelection) => Promise<void>;
  health?: (artifact: ReleaseArtifact) => Promise<void>;
  stopped?: () => Promise<void>;
};

export async function releaseHealth(origin: string, release: string, publicOrigin?: string): Promise<void> {
  const external = publicOrigin === undefined ? undefined : URL.parse(publicOrigin);
  if (external === null) throw new Error("invalid public origin");
  const response = await fetch(`${origin}/api/health`, {
    signal: AbortSignal.timeout(1500),
    redirect: "error",
    headers: external === undefined ? {} : { host: external.host },
  });
  const body = (await response.json()) as { status?: string; release?: string; admitting?: boolean };
  if (!response.ok || body.status !== "ok" || body.release !== release || body.admitting !== false)
    throw new Error("candidate health did not match its immutable artifact or admission barrier");
}

async function retain(root: string, artifact: ReleaseArtifact, signal: AbortSignal): Promise<void> {
  const nix = process.env.PAL_NIX ?? "/run/current-system/sw/bin/nix";
  await exec(
    nix,
    [
      "build",
      "--extra-experimental-features",
      "nix-command",
      "--offline",
      "--impure",
      "--out-link",
      join(root, artifact.digest),
      "--expr",
      'builtins.storePath (builtins.getEnv "PAL_RELEASE_RETAIN")',
    ],
    {
      timeout: 30_000,
      signal,
      maxBuffer: 64 * 1024,
      env: {
        PATH: `${dirname(nix)}:/run/current-system/sw/bin`,
        HOME: "/nonexistent",
        LC_ALL: "C",
        NIX_USER_CONF_FILES: "/dev/null",
        NIX_REMOTE: "daemon",
        PAL_RELEASE_RETAIN: artifact.package,
      },
    },
  );
}

/** The parent owns release selection only. Exactly one child owns Pi/SQLite, including during recovery. */
export async function supervise(
  installRoot: string,
  config: ServeConfig,
  hooks: SupervisorHooks = {},
): Promise<number> {
  if (process.platform !== "linux") throw new Error("pal supervise currently requires Linux and a tested Nix package");
  const base = await releaseManifest(installRoot);
  await mkdir(config.dataRoot, { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(config.dataRoot),
    root = join(dataRoot, "release-control");
  await privateReleaseDirectory(root);
  let lock: FileHandle | undefined;
  const lockDeadline = Date.now() + 15_000;
  // A child inherits this same flock description: a crashed parent's replacement cannot overlap its orphan.
  for (;;) {
    try {
      lock = await releaseLock(join(root, "supervisor.lock"));
      break;
    } catch (error) {
      if (Date.now() >= lockDeadline || !(error instanceof Error) || !error.message.startsWith("another release"))
        throw error;
      await sleep(100);
    }
  }
  const heldLock = lock;
  const statePath = join(root, "selection.json"),
    roots = join(root, "roots");
  const abort = new AbortController(),
    done = Promise.withResolvers<number>();
  let state: ReleaseSelection,
    running: Runtime | undefined,
    busy = false,
    switching = false,
    stopping = false;
  let transition: Promise<void> | undefined;
  let port = config.port;
  const crashes: number[] = [];
  const save = () => writeReleaseJson(statePath, state);
  const alive = (runtime: Runtime) =>
    runtime.process.pid !== undefined && runtime.process.exitCode === null && runtime.process.signalCode === null;
  const stopSignal = () => {
    stopping = true;
    abort.abort();
    done.resolve(0);
  };
  const stopChild = async (runtime: Runtime | undefined) => {
    if (runtime === undefined) return;
    runtime.expected = true;
    runtime.rpc.close();
    if (alive(runtime)) runtime.process.kill("SIGTERM");
    await Promise.race([runtime.exited, sleep(10_000, undefined, { ref: false })]);
    if (alive(runtime)) {
      runtime.process.kill("SIGKILL");
      await runtime.exited;
    }
    if (running === runtime) running = undefined;
  };
  const compatible = async (artifact: ReleaseArtifact) => {
    const candidate = await releaseManifest(`${artifact.package}/lib/pal`);
    compatibleRelease(base, candidate);
  };
  const find = async (digest: string) => {
    const receipt = (await checkedReleases(dataRoot)).find(
      (item) => item.digest === digest && item.base === base.package,
    );
    if (receipt === undefined)
      throw new HttpError(404, "release_missing", "No checked candidate with this digest under this evaluator.");
    return receipt;
  };
  const verify = async (receipt: CheckedRelease) => {
    try {
      await verifyRelease(installRoot, dataRoot, receipt, abort.signal);
      abort.signal.throwIfAborted();
    } catch (error) {
      if (!stopping) {
        state.approved = state.approved.filter((digest) => digest !== receipt.digest);
        await save();
      }
      throw error;
    }
  };
  const view = async (): Promise<ReleaseView> => ({
    available: true,
    evaluator: base.package,
    dataRoot,
    current: state.current,
    previous: state.previous ?? null,
    busy,
    lastError: state.lastError ?? null,
    retained: state.retained.length,
    candidates: (await checkedReleases(dataRoot)).flatMap((item) =>
      item.base !== base.package
        ? []
        : [
            {
              digest: item.digest,
              package: item.package,
              candidate: item.candidate,
              source: item.source,
              checkedAt: item.checkedAt,
              changes: item.changes,
              approved: state.approved.includes(item.digest),
            },
          ],
    ),
  });
  const review = async (args: unknown): Promise<ReleaseReview> => {
    const input = validate(Review, args),
      receipt = await find(input.digest);
    if (!receipt.changes.includes(input.path))
      throw new HttpError(404, "release_file", "No such changed contribution.");
    const snapshot = await readSource(
      join(dataRoot, "release-checks", "sources", receipt.snapshot),
      base.source.files.map((file) => file.path),
    );
    if (snapshot.digest !== receipt.source)
      throw new HttpError(409, "release_changed", "The tested source changed; check it again.");
    const before = await readSource(`${base.package}/lib/pal/release-source`, [input.path], false);
    const preview = (bytes: Buffer | undefined) => ({
      text: bytes?.subarray(0, 32 * 1024).toString("utf8") ?? "",
      truncated: (bytes?.length ?? 0) > 32 * 1024,
    });
    return {
      path: input.path,
      before: preview(before.bytes.get(input.path)),
      after: preview(snapshot.bytes.get(input.path)),
    };
  };

  const launch = async (artifact: ReleaseArtifact): Promise<Runtime> => {
    abort.signal.throwIfAborted();
    const args = [
      join(artifact.package, "lib/pal/dist/main.js"),
      "serve",
      "--host",
      config.host,
      "--port",
      String(port),
      "--data-dir",
      dataRoot,
    ];
    if (config.publicOrigin !== undefined) args.push("--public-origin", config.publicOrigin);
    const child = spawn(process.execPath, args, {
      env: { ...process.env, PAL_SUPERVISED: "1" },
      stdio: ["ignore", "inherit", "inherit", "ipc", heldLock.fd],
    });
    const ready = Promise.withResolvers<number>();
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const rpc = new ReleaseRpc(
      child,
      (message) => {
        if (!child.connected) throw new Error("child IPC disconnected");
        child.send(message, (error) => {
          if (error) rpc.close();
        });
      },
      async (op, args) => {
        if (running !== runtime || stopping)
          throw new HttpError(503, "release_disconnected", "This child no longer owns observation.");
        if (op === "online") {
          const online = validate(Online, args);
          if (online.release !== hash(artifact.package) || (port !== 0 && online.port !== port))
            throw new Error("child reported a different release or port");
          ready.resolve(online.port);
          return { received: true };
        }
        return manage(op, args);
      },
    );
    const runtime: Runtime = { process: child, expected: false, exited, origin: "", rpc };
    running = runtime;
    child.once("error", () => ready.reject(new Error("Pal child failed to start")));
    void exited
      .then(async () => {
        ready.reject(new Error("Pal child exited before readiness"));
        if (runtime.expected || switching || stopping) return;
        crashes.push(Date.now());
        while ((crashes[0] ?? Date.now()) < Date.now() - 60_000) crashes.shift();
        if (crashes.length > 3) {
          done.resolve(1);
          return;
        }
        switching = true;
        try {
          // Never roll back promoted work: resume its retained implementation, with Pi's own reconciliation.
          await bootCurrent();
        } catch {
          done.resolve(1);
        } finally {
          switching = false;
        }
      })
      .catch(() => done.resolve(1));
    const timeout = setTimeout(() => ready.reject(new Error("Pal child readiness timed out")), 15_000);
    try {
      port = await ready.promise;
      let host = config.host;
      if (host === "0.0.0.0") host = "127.0.0.1";
      else if (host === "::") host = "::1";
      runtime.origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
      const deadline = Date.now() + 15_000;
      for (;;) {
        abort.signal.throwIfAborted();
        try {
          await releaseHealth(runtime.origin, hash(artifact.package), config.publicOrigin);
          break;
        } catch (error) {
          if (!alive(runtime) || Date.now() >= deadline) throw error;
          await sleep(100, undefined, { signal: abort.signal });
        }
      }
      await hooks.health?.(artifact);
      return runtime;
    } finally {
      clearTimeout(timeout);
    }
  };
  const bootCurrent = async () => {
    const runtime = await launch(state.current);
    abort.signal.throwIfAborted();
    await runtime.rpc.call("promote", {}, 5000);
  };
  const perform = async (old: Runtime, next: ReleaseArtifact) => {
    try {
      await stopChild(old);
      abort.signal.throwIfAborted();
      await hooks.stopped?.();
      await stoppedReleaseIdle(dataRoot, base.schema);
      await compatible(next);
      const candidate = await launch(next);
      abort.signal.throwIfAborted();
      const previous = state.current;
      const promoted: ReleaseSelection = { ...state, current: next, previous, phase: "stable" };
      delete promoted.next;
      delete promoted.lastError;
      // Commit selection before opening admission; after this, only this implementation may resume unfinished work.
      await writeReleaseJson(statePath, promoted);
      state = promoted;
      await candidate.rpc.call("promote", {}, 5000);
    } catch (error) {
      await stopChild(running);
      if (!stopping) {
        const unpromoted = state.phase === "trying";
        state = recoveredSelection(state);
        state.lastError =
          `${unpromoted ? "Activation failed; recovered the stable release" : "Selected release interrupted; retained it for reconciliation"}. ${error instanceof Error ? error.message : "Health failed"}. Code rollback never undoes external effects.`.slice(
            0,
            1000,
          );
        await save();
        try {
          await bootCurrent();
        } catch {
          await stopChild(running);
          done.resolve(1);
        }
      }
    } finally {
      switching = false;
      busy = false;
      transition = undefined;
    }
  };
  const begin = async (next: ReleaseArtifact, receipt?: CheckedRelease) => {
    if (next.digest === state.current.digest)
      throw new HttpError(409, "release_current", "That artifact is already selected.");
    if (!state.retained.some((item) => item.digest === next.digest) && state.retained.length >= MAX_RETAINED_RELEASES)
      throw new HttpError(
        409,
        "release_retention",
        `${MAX_RETAINED_RELEASES} immutable releases are retained; review retention before adding another.`,
      );
    const old = running;
    if (old === undefined || !alive(old))
      throw new HttpError(503, "release_unavailable", "Pal is not ready for an activation.");
    await compatible(next);
    switching = true;
    try {
      await old.rpc.call("prepare", {}, 7000);
      if (receipt !== undefined) await verify(receipt);
      abort.signal.throwIfAborted();
      await retain(roots, next, abort.signal);
      const retained = state.retained.some((item) => item.digest === next.digest)
        ? state.retained
        : [...state.retained, next];
      state = { ...state, phase: "trying", next, retained };
      await save();
      await hooks.selected?.(state);
      const queued = Promise.withResolvers<undefined>();
      transition = queued.promise;
      setTimeout(() => {
        void perform(old, next).then(() => queued.resolve(undefined), queued.reject);
      }, 200);
      return { restarting: true };
    } catch (error) {
      switching = false;
      if (state.phase === "trying") {
        state = recoveredSelection(state);
        await save();
      }
      if (alive(old)) await old.rpc.call("resume", {}, 5000).catch(() => {});
      else if (!stopping) {
        try {
          await bootCurrent();
        } catch {
          done.resolve(1);
        }
      }
      throw error;
    }
  };
  const manage = async (op: ReleaseOperation, args: unknown): Promise<unknown> => {
    if (op === "view") {
      validate(Empty, args);
      return view();
    }
    if (op === "review") return review(args);
    if (busy) throw new HttpError(409, "release_busy", "Another release operation is in progress.");
    busy = true;
    try {
      if (op === "approve") {
        const input = validate(Approval, args),
          receipt = await find(input.digest);
        await verify(receipt);
        if (!state.approved.includes(receipt.digest)) {
          if (state.approved.length >= 8)
            throw new HttpError(
              409,
              "release_retention",
              "Eight approval records are retained; review retention first.",
            );
          state.approved.push(receipt.digest);
          await save();
        }
        return { approved: receipt.digest };
      }
      if (op === "activate") {
        const { digest } = validate(DigestBody, args),
          receipt = await find(digest);
        if (!state.approved.includes(digest))
          throw new HttpError(
            403,
            "release_unapproved",
            "Review and explicitly approve this exact tested digest first.",
          );
        await verify(receipt);
        return await begin({ digest, package: receipt.package }, receipt);
      }
      if (op === "rollback") {
        const { digest } = validate(DigestBody, args);
        if (state.previous?.digest !== digest)
          throw new HttpError(
            409,
            "release_stale",
            "The retained previous release changed; reload before rolling back.",
          );
        return await begin(state.previous);
      }
      throw new HttpError(400, "release_operation", "Unsupported supervisor operation.");
    } finally {
      if (!switching) busy = false;
    }
  };

  process.once("SIGINT", stopSignal);
  process.once("SIGTERM", stopSignal);
  try {
    await privateReleaseDirectory(roots);
    try {
      state = selection(await readReleaseJson(statePath), base);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = initialSelection(base);
    }
    for (const artifact of state.retained) {
      await compatible(artifact);
      await retain(roots, artifact, abort.signal);
    }
    if (state.phase === "trying") {
      await stoppedReleaseIdle(dataRoot, base.schema);
      state = recoveredSelection(state);
    }
    await save();
    switching = true;
    try {
      await bootCurrent();
    } finally {
      switching = false;
    }
    return await done.promise;
  } catch (error) {
    if (stopping) return 0;
    throw error;
  } finally {
    stopping = true;
    abort.abort();
    if (transition !== undefined) await transition;
    await stopChild(running);
    process.off("SIGINT", stopSignal);
    process.off("SIGTERM", stopSignal);
    await heldLock.close();
  }
}
