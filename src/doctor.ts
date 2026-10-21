// Host and installation checks for `pal doctor`: what this build is, whether its core can run here, and which
// optional capabilities are unavailable and why. Reads no credentials and lists no folder contents.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { browserRuntime } from "./core/browser.ts";
import { releaseIdentity } from "./core/extensions.ts";
import { gnuTimeout } from "./core/timeout.ts";
import { runProbes } from "./probe.ts";
import { MIGRATIONS } from "./storage/migrations.ts";

const exec = promisify(execFile);

export type DoctorCheck = {
  readonly check: string;
  /** A broken core check means Pal cannot run here; an optional one only disables that capability. */
  readonly kind: "core" | "optional";
  readonly ok: boolean;
  readonly detail: string;
  readonly remedy?: string;
};

// Required to run chats and their tools; the other probes back optional capabilities.
const CORE_PROBES = new Set(["sqlite", "codemode"]);
const PROBE_REMEDY: Record<string, string> = {
  sqlite: "Use the Nix package or a Node.js 24 build whose SQLite includes FTS5.",
  codemode: "Reinstall dependencies with `pnpm install --frozen-lockfile`; Code Mode's WASM worker did not start.",
  fff: "Reinstall dependencies; file search needs the fff native module for this platform.",
  pty: "Reinstall dependencies; the terminal needs node-pty's native module and a working /bin/sh.",
  "terminal-screen": "Reinstall dependencies; the terminal screen modules are missing.",
};

const PROGRAMS = {
  git: { version: /^git version (\d+\.\d+(?:\.\d+)?)/, remedy: "Install Git; workspaces and reviews need it." },
  timeout: {
    version: /^\S+ \(GNU coreutils\) (\d+\.\d+(?:\.\d+)?)/,
    remedy: "Install GNU coreutils (`timeout`, or `gtimeout` on macOS); host commands need an independent deadline.",
  },
  bash: { version: /^GNU bash, version (\d+\.\d+(?:\.\d+)?)/, remedy: "Install Bash; host shells need it." },
};

export async function runDoctor(options: { installRoot: string; dataRoot: string; env?: NodeJS.ProcessEnv }) {
  const env = options.env ?? process.env;
  const linux = platform() === "linux";
  const supportedSchema = MIGRATIONS.at(-1)?.version ?? 0;
  const installRoot = await realpath(options.installRoot).catch(() => options.installRoot);
  const nixPackage = /^\/nix\/store\/[a-z0-9]{32}-[^/]+/.exec(installRoot)?.[0];
  const checks: DoctorCheck[] = [];

  for (const result of await runProbes())
    checks.push({
      check: result.check,
      kind: CORE_PROBES.has(result.check) ? "core" : "optional",
      ok: result.ok,
      detail: result.ok ? result.detail : "Native capability probe failed.",
      ...(result.ok ? {} : { remedy: PROBE_REMEDY[result.check] }),
    });
  checks.push(await dataDirectory(options.dataRoot, supportedSchema));
  checks.push(
    await program("git", "git", env),
    await program("timeout", gnuTimeout(), env),
    await program("bash", env.PAL_BASH ?? "bash", env),
    await browserCheck(env),
  );
  let supervisor = optional(
    "release-supervisor",
    false,
    "Controlled releases need the Nix package's pinned Nix and flock.",
    "Use the Nix package to run `pal supervise`.",
  );
  if (!linux)
    supervisor = optional("release-supervisor", false, `Controlled releases are not available on ${platform()} yet.`);
  else if (
    nixPackage !== undefined &&
    env.PAL_NIX !== undefined &&
    env.PAL_FLOCK !== undefined &&
    (await executable(env.PAL_NIX, env)) &&
    (await executable(env.PAL_FLOCK, env))
  )
    supervisor = optional("release-supervisor", true, "Pinned Nix and flock are executable; doctor activates nothing.");
  checks.push(supervisor);

  let release: string;
  try {
    const privateRoot = await realpath(options.dataRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    release = await releaseIdentity(installRoot, privateRoot);
    checks.push({ check: "implementation", kind: "core", ok: true, detail: "Content identity verified." });
  } catch {
    release = "unavailable";
    checks.push({
      check: "implementation",
      kind: "core",
      ok: false,
      detail: "Implementation identity could not be verified.",
      remedy: "Use an intact retained build and frozen dependencies before resuming work.",
    });
  }
  return {
    format: 1,
    identity: {
      version: pkg.version,
      release,
      package: nixPackage ?? null,
      supportedSchema,
      node: process.version,
      platform: platform(),
      arch: arch(),
    },
    core: checks.every((check) => check.kind !== "core" || check.ok) ? "ok" : "broken",
    checks,
  };
}

function optional(check: string, ok: boolean, detail: string, remedy?: string): DoctorCheck {
  return { check, kind: "optional", ok, detail, ...(remedy === undefined ? {} : { remedy }) };
}

async function program(check: keyof typeof PROGRAMS, command: string, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const home = await mkdtemp(join(tmpdir(), "pal-doctor-"));
  const { version, remedy } = PROGRAMS[check];
  try {
    const { stdout } = await exec(command, ["--version"], {
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      cwd: home,
      env: { PATH: env.PATH ?? process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, LANG: "C", LC_ALL: "C" },
    });
    const matched = version.exec(stdout)?.[1];
    if (matched === undefined) throw new Error("unrecognized version");
    return { check, kind: "core", ok: true, detail: `${check} ${matched}` };
  } catch {
    // Neither successful output nor subprocess exceptions are safe to copy verbatim.
    return { check, kind: "core", ok: false, detail: "No recognized version returned within 5 seconds.", remedy };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function executable(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  let paths: string[];
  if (isAbsolute(command)) paths = [command];
  else
    paths = (env.PATH ?? process.env.PATH ?? "/usr/bin:/bin")
      .split(delimiter)
      .flatMap((directory) => (isAbsolute(directory) ? [join(directory, command)] : []));
  for (const path of paths)
    try {
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry without exposing filesystem errors.
    }
  return false;
}

async function browserCheck(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  if (platform() !== "linux")
    return optional("browser", false, `The sandboxed project browser is not available on ${platform()} yet.`);
  const browser = browserRuntime(env);
  const remedy = "Use the Nix package's Chromium, bubblewrap, socat, Bash, coreutils and systemd-run.";
  if (browser === undefined) return optional("browser", false, "Browser programs are not configured.", remedy);
  const missing: string[] = [];
  for (const [name, command] of [
    ["Chromium", browser.chromium],
    ["bubblewrap", browser.bwrap],
    ["socat", browser.socat],
    ["Bash", browser.bash],
    ["coreutils", join(browser.coreutils, "sleep")],
    ["systemd-run", browser.scope ?? ""],
  ] as const)
    if (!(await executable(command, env))) missing.push(name);
  if (missing.length > 0)
    return optional("browser", false, `Missing browser prerequisites: ${missing.join(", ")}.`, remedy);
  return optional(
    "browser",
    true,
    "Programs found; namespace, egress and user-scope protections are checked at browser start, not by doctor.",
  );
}

async function writableParent(path: string): Promise<boolean> {
  let parent = dirname(path);
  for (;;) {
    try {
      if (!(await stat(parent)).isDirectory()) return false;
      await access(parent, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(parent) === parent) return false;
      parent = dirname(parent);
    }
  }
}

/** The data directory must be private and writable; an existing store must be one this build can open. */
async function dataDirectory(dataRoot: string, supportedSchema: number): Promise<DoctorCheck> {
  const check = "data-directory";
  const broken = (detail: string, remedy: string): DoctorCheck => ({ check, kind: "core", ok: false, detail, remedy });
  const info = await lstat(dataRoot).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : null,
  );
  if (info === null) return broken("Cannot inspect the data directory.", "Check the chosen --data-dir permissions.");
  if (info === undefined) {
    if (!(await writableParent(dataRoot)))
      return broken("The data directory cannot be created here.", "Pass a writable --data-dir.");
    return {
      check,
      kind: "core",
      ok: true,
      detail: "The data directory will be created with mode 0700 on first start.",
    };
  }
  if (!info.isDirectory()) return broken(`${dataRoot} is not a directory`, "Pass a directory to --data-dir.");
  if (info.uid !== process.getuid?.()) return broken(`${dataRoot} belongs to another user`, "Run Pal as its owner.");
  if ((info.mode & 0o077) !== 0)
    return broken(`${dataRoot} is readable by other users`, `Run \`chmod 700 ${dataRoot}\`; it holds credentials.`);
  try {
    await access(dataRoot, constants.W_OK);
  } catch {
    return broken(`${dataRoot} is not writable`, "Make the data directory writable by Pal's user.");
  }
  const file = await lstat(join(dataRoot, "pal.sqlite")).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : null,
  );
  if (file === undefined)
    return { check, kind: "core", ok: true, detail: "Private writable data directory; no store yet." };
  if (file === null || !file.isFile() || file.uid !== process.getuid?.() || file.nlink !== 1)
    return broken(
      "The store is not a private regular file owned by Pal's user.",
      "Inspect the stopped data directory; do not replace its files blindly.",
    );
  let schema: number | null | undefined;
  try {
    const db = new DatabaseSync(join(dataRoot, "pal.sqlite"), { readOnly: true, timeout: 0 });
    try {
      schema = (db.prepare("SELECT max(version) AS n FROM pal_migrations").get() as { n: number | null } | undefined)
        ?.n;
    } finally {
      db.close();
    }
  } catch (error) {
    if (((error as { errcode?: number }).errcode ?? 0) % 256 === 5)
      return { check, kind: "core", ok: true, detail: "The store is in use; its schema was not inspected." };
    return broken(
      "The stopped store could not be read as a Pal database.",
      "Preserve it and inspect a backup before attempting recovery.",
    );
  }
  if (schema === null || schema === undefined || !Number.isSafeInteger(schema) || schema < 1)
    return broken("The store has no valid Pal schema.", "Inspect the stopped store or choose a new --data-dir.");
  if (schema > supportedSchema)
    return broken(
      `the store has schema ${schema}; this build supports up to ${supportedSchema}`,
      "Run the Pal release that created this data, or restore a backup made for this build.",
    );
  return { check, kind: "core", ok: true, detail: `${dataRoot} is private; store schema ${schema ?? "unknown"}` };
}

export function formatDoctor(report: Awaited<ReturnType<typeof runDoctor>>): string {
  const { identity } = report;
  const lines = [
    `Pal ${identity.version} on ${identity.platform}/${identity.arch}, Node ${identity.node}`,
    `Release ${identity.release}${identity.package === null ? "" : ` (${identity.package})`}; data schema up to ${identity.supportedSchema}`,
    ...report.checks.map((check) => {
      const failed = check.kind === "core" ? "FAIL" : "off ";
      const mark = check.ok ? "ok  " : failed;
      return `${mark} ${check.kind.padEnd(8)} ${check.check}: ${check.detail}${check.remedy === undefined ? "" : `\n      ${check.remedy}`}`;
    }),
    report.core === "ok" ? "Core: ok" : "Core: broken; Pal cannot run reliably here until the FAIL items are fixed.",
  ];
  return `${lines.join("\n")}\n`;
}
