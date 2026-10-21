import { isIP } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7337;

export type ServeConfig = { host: string; port: number; dataRoot: string; publicOrigin?: string };

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "probe" }
  | { kind: "doctor"; dataRoot: string; json: boolean }
  | { kind: "serve" | "supervise"; config: ServeConfig }
  | { kind: "check-release"; dataRoot: string; candidate: string }
  | {
      kind: "backup";
      dataRoot: string;
      output: string;
      includeCredentialKey: boolean;
      includeBrowserProfiles: boolean;
    }
  | { kind: "restore"; from: string; check: true; credentialKey?: string }
  | { kind: "restore"; from: string; check: false; dataRoot: string; credentialKey?: string };

/** Process facts that decide defaults, passed in so tests do not depend on the machine. */
export type HostFacts = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  /** Directory the running application was loaded from; data must live elsewhere. */
  installRoot: string;
};

export class UsageError extends Error {}

export const USAGE = `Usage: pal [serve] [--host <address>] [--port <number>] [--data-dir <path>]
                 [--public-origin <url>]
       pal supervise [serve options]
       pal probe
       pal doctor [--data-dir <path>] [--json]
       pal check-release --candidate <worktree> [--data-dir <path>]
       pal backup --output <path> [--data-dir <path>] [--include-credential-key]
                  [--include-browser-profiles]
       pal restore --from <backup> (--check | --data-dir <path>) [--credential-key <file>]

Commands:
  serve              Run the Pal server (default)
  supervise          Run the owner-approved Nix release with guarded health/recovery (Linux)
  probe              Check SQLite FTS5, fff, Code Mode and PTY support on this host, then exit
  doctor             Report this build's identity, core health and unavailable optional capabilities
  check-release      Run protected offline candidate tests/evals; never approve or activate
  backup             Copy a stopped data directory to a new folder with a checksummed manifest
  restore            Verify a backup (--check), or restore it to its original, absent data directory

Options:
  --host <address>   Address to listen on (default ${DEFAULT_HOST})
                     Non-loopback binding requires --public-origin.
  --public-origin <url>  Exact browser origin; use HTTPS or a trusted private access layer
  --port <number>    TCP port (default ${DEFAULT_PORT}; 0 picks a free port)
  --data-dir <path>  Absolute path for Pal's writable data
                     (default: $XDG_DATA_HOME/pal or ~/.local/share/pal on Linux,
                     ~/Library/Application Support/pal on macOS)
  -h, --help         Show this help
  -v, --version      Show the version`;

const ARGUMENTS = {
  host: { type: "string" },
  port: { type: "string" },
  "data-dir": { type: "string" },
  "public-origin": { type: "string" },
  candidate: { type: "string" },
  output: { type: "string" },
  from: { type: "string" },
  "credential-key": { type: "string" },
  check: { type: "boolean" },
  "include-credential-key": { type: "boolean" },
  "include-browser-profiles": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const SERVE = ["host", "port", "data-dir", "public-origin"];
const OPTIONS: Partial<Record<string, readonly string[]>> = {
  serve: SERVE,
  supervise: SERVE,
  probe: [],
  doctor: ["data-dir", "json"],
  "check-release": ["candidate", "data-dir"],
  backup: ["data-dir", "output", "include-credential-key", "include-browser-profiles"],
  restore: ["from", "data-dir", "check", "credential-key"],
};

export function parseCommand(argv: readonly string[], host: HostFacts): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: ARGUMENTS,
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };

  const [name = "serve", extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument '${extra}'`);
  const accepted = OPTIONS[name];
  if (accepted === undefined) throw new UsageError(`unknown command '${name}'`);
  const given = Object.keys(values).find((option) => !accepted.includes(option));
  if (given !== undefined) throw new UsageError(`'${name}' does not accept --${given}`);
  if (name === "probe") return { kind: "probe" };
  if (name === "doctor")
    return { kind: "doctor", dataRoot: resolveDataRoot(values["data-dir"], host), json: values.json === true };
  if (name === "backup") return parseBackup(values, host);
  if (name === "restore") return parseRestore(values, host);
  if (name === "check-release") {
    if (values.candidate === undefined || !isAbsolute(values.candidate))
      throw new UsageError("--candidate must be an absolute worktree path");
    return {
      kind: "check-release",
      candidate: resolve(values.candidate),
      dataRoot: resolveDataRoot(values["data-dir"], host),
    };
  }
  if (name !== "serve" && name !== "supervise") throw new UsageError(`unknown command '${name}'`);
  if (name === "supervise" && host.platform !== "linux") throw new UsageError("supervise currently requires Linux");

  const publicOrigin = parsePublicOrigin(values["public-origin"]);
  return {
    kind: name,
    config: {
      host: parseHost(values.host ?? DEFAULT_HOST, publicOrigin),
      port: parsePort(values.port ?? String(DEFAULT_PORT)),
      dataRoot: resolveDataRoot(values["data-dir"], host),
      ...(publicOrigin === undefined ? {} : { publicOrigin }),
    },
  };
}

type Values = ReturnType<typeof parseArgs<{ options: typeof ARGUMENTS; allowPositionals: true }>>["values"];

function parseBackup(values: Values, host: HostFacts): Command {
  if (values.output === undefined || !isAbsolute(values.output))
    throw new UsageError("--output must be an absolute path for the new backup folder");
  return {
    kind: "backup",
    dataRoot: resolveDataRoot(values["data-dir"], host),
    output: resolve(values.output),
    includeCredentialKey: values["include-credential-key"] === true,
    includeBrowserProfiles: values["include-browser-profiles"] === true,
  };
}

function parseRestore(values: Values, host: HostFacts): Command {
  if (values.from === undefined || !isAbsolute(values.from)) throw new UsageError("--from must be an absolute path");
  const key = values["credential-key"];
  if (key !== undefined && !isAbsolute(key)) throw new UsageError("--credential-key must be an absolute path");
  const common = { from: resolve(values.from), ...(key === undefined ? {} : { credentialKey: resolve(key) }) };
  // A restore names its destination explicitly; only a check runs without one.
  if (values.check === true) {
    if (values["data-dir"] !== undefined) throw new UsageError("restore --check does not accept --data-dir");
    return { kind: "restore", check: true, ...common };
  }
  if (values["data-dir"] === undefined) throw new UsageError("restore needs --check or an explicit --data-dir");
  return { kind: "restore", check: false, dataRoot: resolveDataRoot(values["data-dir"], host), ...common };
}

function parseHost(value: string, publicOrigin: string | undefined): string {
  const loopback = value === "localhost" || value === "::1" || (isIP(value) === 4 && value.startsWith("127."));
  if (!loopback && isIP(value) === 0) throw new UsageError("--host must be an IP address or localhost");
  if (!loopback && publicOrigin === undefined) throw new UsageError("non-loopback --host requires --public-origin");
  return value;
}

function parsePublicOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = URL.parse(value);
  if (
    url === null ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new UsageError("--public-origin must be an HTTP(S) origin without credentials, path, query or fragment");
  }
  return url.origin;
}

function parsePort(value: string): number {
  const port = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  if (!(port >= 0 && port <= 65_535)) throw new UsageError(`--port must be an integer from 0 to 65535; got '${value}'`);
  return port;
}

function resolveDataRoot(explicit: string | undefined, host: HostFacts): string {
  const candidate = explicit ?? defaultDataRoot(host);
  if (!isAbsolute(candidate)) throw new UsageError(`--data-dir must be an absolute path; got '${candidate}'`);
  const dataRoot = resolve(candidate);
  if (isWithin(dataRoot, "/nix/store")) throw new UsageError("--data-dir must not be inside /nix/store");
  if (isWithin(dataRoot, host.installRoot) || isWithin(host.installRoot, dataRoot)) {
    throw new UsageError(`--data-dir must be outside the application directory ${host.installRoot}`);
  }
  return dataRoot;
}

function defaultDataRoot({ env, platform, home }: HostFacts): string {
  if (!isAbsolute(home)) throw new UsageError("cannot find the home directory; pass --data-dir");
  if (platform === "darwin") return join(home, "Library", "Application Support", "pal");
  if (platform === "linux") {
    // The XDG spec says relative values are invalid and must be ignored.
    const xdg = env.XDG_DATA_HOME;
    return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "pal");
  }
  throw new UsageError(`no default data directory on ${platform}; pass --data-dir`);
}

function isWithin(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
