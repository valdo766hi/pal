import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { runGit } from "./git.ts";
import { validate } from "./requests.ts";
import { privateReleaseDirectory, readReleaseJson, releaseLock, writeReleaseJson } from "./release-files.ts";
import {
  candidateFiles,
  checkCandidate,
  hash,
  readSource,
  type ReleaseManifest,
  type SourceSnapshot,
} from "./release-policy.ts";

const exec = promisify(execFile);
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const StorePath = Type.String({ pattern: "^/nix/store/[a-z0-9]{32}-[^/\\s]+$" });
const FIXED_CHECK_COUNT = 7;
const Source = Type.Object(
  {
    files: Type.Array(
      Type.Object(
        {
          path: Type.String({ maxLength: 4096 }),
          hash: Digest,
          executable: Type.Boolean(),
          size: Type.Integer({ minimum: 0, maximum: 2 * 1024 * 1024 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 2000 },
    ),
    digest: Digest,
    compatibility: Digest,
  },
  { additionalProperties: false },
);
const Manifest = Type.Object(
  { format: Type.Literal(1), package: StorePath, nixpkgs: StorePath, schema: Type.Integer(), source: Source },
  { additionalProperties: false },
);
export const CheckedRelease = Type.Object(
  {
    format: Type.Literal(1),
    digest: Digest,
    base: StorePath,
    package: StorePath,
    candidate: Type.String({ maxLength: 4096 }),
    source: Digest,
    compatibility: Digest,
    snapshot: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
    checkedAt: Type.Number(),
    // Older proofs remain inspectable; verification requires the current complete gate set.
    outputs: Type.Array(StorePath, { minItems: 6, maxItems: FIXED_CHECK_COUNT }),
    changes: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 4 }),
  },
  { additionalProperties: false },
);
export type CheckedRelease = import("typebox").Static<typeof CheckedRelease>;
const NIX_OUTPUT = Type.Array(Type.Object({ outputs: Type.Object({ out: StorePath }) }), {
  minItems: FIXED_CHECK_COUNT,
  maxItems: FIXED_CHECK_COUNT,
});
const CHECK_EXPR =
  'import ((/. + builtins.getEnv "PAL_RELEASE_BASE") + "/nix/release.nix") { candidate = /. + builtins.getEnv "PAL_RELEASE_SOURCE"; nixpkgs = /. + builtins.getEnv "PAL_RELEASE_NIXPKGS"; }';

export async function releaseManifest(installRoot: string): Promise<ReleaseManifest> {
  const root = await realpath(installRoot);
  const value = validate(Manifest, await readReleaseJson(join(root, "release.json"), false));
  if (root !== `${value.package}/lib/pal`)
    throw new Error("controlled releases require the actual immutable Nix package");
  const source = await readSource(
    join(root, "release-source"),
    value.source.files.map((file) => file.path),
    false,
  );
  if (source.digest !== value.source.digest || source.compatibility !== value.source.compatibility)
    throw new Error("the trusted evaluator source does not match its manifest");
  return value;
}

async function worktree(candidate: string, base: ReleaseManifest, signal: AbortSignal): Promise<SourceSnapshot> {
  const root = await realpath(candidate);
  const git = async (...args: string[]) =>
    (await runGit(root, args, { signal, maxBytes: 512 * 1024 })).toString("utf8").trim();
  if ((await git("rev-parse", "--show-toplevel")) !== root) throw new Error("select the candidate worktree's root");
  const common = await realpath(resolve(root, await git("rev-parse", "--git-common-dir")));
  const own = await realpath(resolve(root, await git("rev-parse", "--git-dir")));
  if (common === own) throw new Error("use an isolated Git worktree, not the primary checkout");
  const listed = (await runGit(root, ["ls-files", "--stage", "-z"], { signal, maxBytes: 512 * 1024 })).toString("utf8");
  const actual = candidateFiles(
    listed,
    base.source.files.map((file) => file.path),
  );
  const snapshot = await readSource(root, actual);
  checkCandidate(base, snapshot);
  return snapshot;
}

export async function checkedReleases(dataRoot: string): Promise<CheckedRelease[]> {
  const root = join(dataRoot, "release-checks");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = entries.filter((name) => /^receipt-[a-f0-9]{64}\.json$/.test(name));
  if (names.length > 8) throw new Error("release receipts exceed their limit");
  return Promise.all(
    names.sort().map(async (name) => validate(CheckedRelease, await readReleaseJson(join(root, name)))),
  );
}

/** Always uses the running package's recipes and protected tests/evals, never the candidate's flake. */
async function fixedChecks(
  base: ReleaseManifest,
  snapshot: string,
  roots: string,
  log?: FileHandle,
  signal?: AbortSignal,
): Promise<string[]> {
  const nix = process.env.PAL_NIX ?? "/run/current-system/sw/bin/nix";
  const { stdout, stderr } = await exec(
    nix,
    [
      "build",
      "--extra-experimental-features",
      "nix-command",
      "--offline",
      "--impure",
      "--keep-going",
      "--max-jobs",
      "2",
      "--cores",
      "2",
      "--option",
      "sandbox",
      "true",
      "--json",
      "--out-link",
      roots,
      "--expr",
      CHECK_EXPR,
    ],
    {
      timeout: 15 * 60_000,
      killSignal: "SIGTERM",
      signal,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: `${dirname(nix)}:/run/current-system/sw/bin`,
        HOME: "/nonexistent",
        LC_ALL: "C",
        NIX_USER_CONF_FILES: "/dev/null",
        NIX_REMOTE: "daemon",
        PAL_RELEASE_BASE: await realpath(`${base.package}/lib/pal/release-source`),
        PAL_RELEASE_SOURCE: snapshot,
        PAL_RELEASE_NIXPKGS: base.nixpkgs,
      },
    },
  );
  if (log !== undefined) {
    await log.writeFile(stderr.slice(-1024 * 1024));
    await log.sync();
  }
  let output: unknown;
  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error("Nix returned invalid check results");
  }
  return validate(NIX_OUTPUT, output).map((result) => result.outputs.out);
}

export async function evaluateRelease(
  installRoot: string,
  dataRoot: string,
  candidatePath: string,
): Promise<CheckedRelease> {
  if (process.platform !== "linux") throw new Error("controlled release checks require Linux");
  const base = await releaseManifest(installRoot),
    candidate = await realpath(candidatePath);
  const root = join(dataRoot, "release-checks");
  const within = relative(root, candidate);
  if (within === "" || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within)))
    throw new Error("a release snapshot is not a candidate worktree");
  await privateReleaseDirectory(root);
  const lock = await releaseLock(join(root, "check.lock"));
  let snapshotDir: string | undefined;
  let log: FileHandle | undefined;
  try {
    const signal = AbortSignal.timeout(15 * 60_000);
    const source = await worktree(candidate, base, signal);
    if (source.digest === base.source.digest) throw new Error("candidate has no implementation changes");
    const existing = (await checkedReleases(dataRoot)).find(
      (item) =>
        item.outputs.length === FIXED_CHECK_COUNT &&
        item.base === base.package &&
        item.candidate === candidate &&
        item.source === source.digest,
    );
    if (existing !== undefined) {
      await verifyRelease(installRoot, dataRoot, existing, signal);
      return existing;
    }
    if ((await readdir(root)).filter((name) => /^attempt-[a-f0-9-]{36}\.log$/.test(name)).length >= 8)
      throw new Error("eight check attempts are retained; review retention before checking another");
    const snapshot = randomUUID();
    log = await open(join(root, `attempt-${snapshot}.log`), "wx", 0o600);
    const snapshots = join(root, "sources");
    await privateReleaseDirectory(snapshots);
    snapshotDir = join(snapshots, snapshot);
    await privateReleaseDirectory(snapshotDir);
    for (const file of source.files) {
      const path = join(snapshotDir, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, source.bytes.get(file.path) ?? Buffer.alloc(0), {
        flag: "wx",
        mode: file.executable ? 0o500 : 0o400,
      });
    }
    const roots = join(root, "roots");
    await privateReleaseDirectory(roots);
    const outputs = await fixedChecks(base, snapshotDir, join(roots, source.digest), log, signal);
    let tested: ReleaseManifest | undefined;
    for (const output of outputs) {
      try {
        tested = await releaseManifest(`${output}/lib/pal`);
        break;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    if (
      tested === undefined ||
      tested.source.digest !== source.digest ||
      tested.source.compatibility !== source.compatibility
    )
      throw new Error("the tested artifact does not match the frozen candidate");
    if ((await worktree(candidate, base, signal)).digest !== source.digest)
      throw new Error("candidate changed during testing; nothing was approved");
    const before = new Map(base.source.files.map((file) => [file.path, file.hash]));
    const changes = source.files.flatMap((file) => (before.get(file.path) === file.hash ? [] : [file.path]));
    const digest = hash(
      JSON.stringify([base.package, tested.package, candidate, source.digest, source.compatibility, outputs]),
    );
    const receipt: CheckedRelease = {
      format: 1,
      digest,
      base: base.package,
      package: tested.package,
      candidate,
      source: source.digest,
      compatibility: source.compatibility,
      snapshot,
      checkedAt: Date.now(),
      outputs,
      changes,
    };
    await writeReleaseJson(join(root, `receipt-${digest}.json`), receipt);
    snapshotDir = undefined;
    return receipt;
  } catch (error) {
    const detail = error as { stderr?: string };
    if (log !== undefined) {
      let diagnostic = "release check failed";
      if (typeof detail.stderr === "string") diagnostic = detail.stderr;
      else if (error instanceof Error) diagnostic = error.message;
      await log.writeFile(diagnostic.slice(-1024 * 1024));
      await log.sync();
      throw new Error(
        "protected checks/evals failed; no release was approved (diagnostic log retained in release-checks)",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (snapshotDir !== undefined) await rm(snapshotDir, { recursive: true, force: true });
    await log?.close();
    await lock.close();
  }
}

/** Recheck source and all fixed gates before approval/selection; a JSON receipt is not authority by itself. */
export async function verifyRelease(
  installRoot: string,
  dataRoot: string,
  receipt: CheckedRelease,
  signal = AbortSignal.timeout(15 * 60_000),
): Promise<void> {
  signal.throwIfAborted();
  if (receipt.outputs.length !== FIXED_CHECK_COUNT)
    throw new Error("release receipt predates the mandatory grading gate; check it again with this evaluator");
  const base = await releaseManifest(installRoot);
  if (receipt.base !== base.package || receipt.compatibility !== base.source.compatibility)
    throw new Error("candidate was checked under a different evaluator; check it again with this release");
  const source = await worktree(receipt.candidate, base, signal);
  if (source.digest !== receipt.source) throw new Error("candidate changed; its approval is invalid");
  const snapshot = join(dataRoot, "release-checks", "sources", receipt.snapshot);
  if (
    (
      await readSource(
        snapshot,
        base.source.files.map((file) => file.path),
      )
    ).digest !== receipt.source
  )
    throw new Error("the frozen candidate changed; its approval is invalid");
  const outputs = await fixedChecks(
    base,
    snapshot,
    join(dataRoot, "release-checks", "roots", receipt.source),
    undefined,
    signal,
  );
  if (JSON.stringify(outputs) !== JSON.stringify(receipt.outputs) || !outputs.includes(receipt.package))
    throw new Error("fixed check artifacts changed");
  const tested = await releaseManifest(`${receipt.package}/lib/pal`);
  if (
    tested.source.digest !== receipt.source ||
    tested.source.compatibility !== receipt.compatibility ||
    receipt.digest !==
      hash(
        JSON.stringify([
          base.package,
          tested.package,
          receipt.candidate,
          receipt.source,
          receipt.compatibility,
          outputs,
        ]),
      )
  )
    throw new Error("the tested digest changed; nothing was selected");
}
