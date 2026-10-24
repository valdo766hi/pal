// Target-host gate: real Nix candidates, packaged parents/children and deterministic crash/fault barriers.
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { checkedReleases, releaseManifest } from "../../src/core/release-check.ts";
import { readReleaseJson } from "../../src/core/release-files.ts";
import { selection } from "../../src/core/release-state.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { hash } from "../../src/core/release-policy.ts";
import type { ReleaseView } from "../../src/core/supervise.ts";
import { startProviderFixture } from "./provider-server.ts";

const exec = promisify(execFile);
const [packagePath, testRoot] = process.argv.slice(2);
if (!packagePath || !testRoot || process.platform !== "linux")
  throw new Error("pass a tested Nix package and isolated host test root");
const base = await releaseManifest(`${packagePath}/lib/pal`);
assert.equal(
  base.source.files.find((file) => file.path === "src/core/supervise.ts")?.hash,
  hash(await readFile(join(import.meta.dirname, "../../src/core/supervise.ts"))),
);
const checked = await exec(
  process.execPath,
  [join(import.meta.dirname, "release-check-host.ts"), packagePath, testRoot],
  {
    timeout: 40 * 60_000,
    maxBuffer: 2 * 1024 * 1024,
  },
);
const evidence = JSON.parse(checked.stdout) as {
  root: string;
  digest: string;
  candidatePackage: string;
  regressionRefused: boolean;
  changedCandidateRefused: boolean;
  fixedChecks: string[];
  legacyProofRefused: boolean;
  legacyRecheckPassed: boolean;
};
assert(
  evidence.regressionRefused &&
    evidence.changedCandidateRefused &&
    evidence.legacyProofRefused &&
    evidence.legacyRecheckPassed,
);
assert.deepEqual(evidence.fixedChecks, ["package", "smoke", "tests", "browser", "e2e", "grading", "evals"]);
const root = evidence.root,
  dataRoot = join(root, "data");
const receipt = (await checkedReleases(dataRoot)).find((item) => item.digest === evidence.digest);
if (receipt === undefined) throw new Error("missing real fixed-gate receipt");
const style = join(receipt.candidate, "web/src/app.css");
const testedStyle = await readFile(join(dataRoot, "release-checks/sources", receipt.snapshot, "web/src/app.css"));
await writeFile(style, testedStyle);

const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = (reservation.address() as AddressInfo).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`,
  baseline = hash(base.package);
const provider = await startProviderFixture();
provider.behavior.reply = "Conversation retained across compatible releases";
let cookie = "";
type Parent = {
  process: ChildProcess;
  exited: Promise<number | null>;
  events: EventEmitter;
  output: () => string;
  diagnostic: () => string;
};
let parent: Parent | undefined;
async function until<T>(read: () => Promise<T> | T, good: (value: T) => boolean, milliseconds = 30_000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const value = await read();
    if (good(value)) return value;
    if (Date.now() >= deadline) throw new Error(`fixture condition timed out: ${parent?.diagnostic() ?? "no parent"}`);
    await sleep(50);
  }
}
function start(faults = false): Parent {
  let output = "",
    diagnostic = "";
  const child = faults
    ? spawn(
        process.execPath,
        [join(import.meta.dirname, "supervisor-child.ts"), base.package, dataRoot, String(port)],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      )
    : spawn(`${base.package}/bin/pal`, ["supervise", "--port", String(port), "--data-dir", dataRoot], {
        stdio: ["ignore", "pipe", "pipe"],
      });
  const events = new EventEmitter();
  child.stdout?.on("data", (bytes: Buffer) => {
    output = (output + bytes.toString()).slice(-64 * 1024);
  });
  child.stderr?.on("data", (bytes: Buffer) => {
    diagnostic = (diagnostic + bytes.toString()).slice(-64 * 1024);
  });
  child.on("message", (message: { armed?: string; barrier?: string }) => {
    if (message.armed) events.emit(`armed:${message.armed}`);
    if (message.barrier) events.emit(`barrier:${message.barrier}`);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", (error) => {
      diagnostic = error.message;
      resolve(null);
    });
  });
  return { process: child, exited, events, output: () => output, diagnostic: () => diagnostic };
}
async function stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  const current = parent;
  if (current === undefined) return;
  if (current.process.pid !== undefined && current.process.exitCode === null && current.process.signalCode === null)
    current.process.kill(signal);
  const timer = setTimeout(() => current.process.kill("SIGKILL"), 20_000);
  const code = await current.exited;
  clearTimeout(timer);
  if (signal === "SIGTERM") assert.equal(code, 0, current.diagnostic());
  parent = undefined;
}
async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  ownOrigin = origin,
  session = cookie,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}/api/${path}`, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      origin: ownOrigin,
      cookie: session,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie !== null) cookie = setCookie.split(";")[0] ?? "";
  return { status: response.status, body: (await response.json()) as T };
}
async function ok<T = Record<string, unknown>>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const response = await api<T>(method, path, body);
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
}
async function ready(expected: string = baseline) {
  await until(async () => {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      const body = (await response.json()) as { release?: string; admitting?: boolean };
      return response.ok && body.release === expected && body.admitting === true;
    } catch {
      return false;
    }
  }, Boolean);
}
async function view() {
  const value = await ok<ReleaseView>("GET", "releases");
  if (!value.available) throw new Error("packaged supervisor did not expose owner release control");
  return value;
}
async function arm(mode: string, project?: string) {
  const current = parent;
  if (current === undefined || !current.process.connected) throw new Error("fault fixture is not connected");
  const armed = once(current.events, `armed:${mode}`, { signal: AbortSignal.timeout(5000) });
  current.process.send({ arm: mode, project });
  await armed;
}
const releasePath = `releases/${receipt.digest}`;
try {
  parent = start();
  await ready();
  assert.equal((await api("GET", "releases")).status, 401);
  await until(
    () => parent?.output().match(/#setup=([A-Za-z0-9_-]+)/)?.[1],
    (value) => value !== undefined,
  );
  const setup = parent.output().match(/#setup=([A-Za-z0-9_-]+)/)?.[1];
  assert(setup);
  await ok("POST", "setup", { token: setup, passphrase: "correct horse battery" });
  assert.equal((await view()).current.package, base.package);
  assert.equal(
    (await api("POST", `${releasePath}/approve`, { acceptCodeTrust: true }, "https://attacker.example")).status,
    403,
  );
  assert.equal(
    (await api("POST", `${releasePath}/approve`, { acceptCodeTrust: true }, origin, "pal_session=forged")).status,
    401,
  );
  assert.equal((await api("POST", `${releasePath}/approve`, { acceptCodeTrust: false })).status, 400);
  assert.equal((await api("POST", `${releasePath}/activate`, {})).status, 403);
  assert.equal((await api("GET", `${releasePath}/review?path=..%2Fcredentials.key`)).status, 404);
  assert.equal((await api("POST", `releases/${"0".repeat(64)}/approve`, { acceptCodeTrust: true })).status, 404);
  const review = await ok<{ after: { text: string } }>("GET", `${releasePath}/review?path=web%2Fsrc%2Fapp.css`);
  assert(review.after.text.length > 0);
  await ok("PUT", "providers/compatible/config", {
    name: "Release fixture",
    baseUrl: `${provider.origin}/compat/v1`,
    models: ["fixture"],
    contextWindow: 128000,
    maxTokens: 8192,
    images: false,
    keyless: true,
  });
  await ok("PUT", "providers/compatible/enabled", { enabled: true });
  await ok("PUT", "default-model", { provider: "compatible", model: "fixture" });
  const { project } = await ok<{ project: { id: string; root: string } }>("POST", "projects", {
    requestId: "release-host-project",
    name: "Release recovery",
  });
  const { chat } = await ok<{ chat: { id: string } }>("POST", "chats", {
    requestId: "release-host-chat",
    projectId: project.id,
  });
  const external = join(project.root, "keep.txt");
  await writeFile(external, "external workspace effect stays");
  const key = hash(await readFile(join(dataRoot, "credentials.key")));
  await ok("POST", `chats/${chat.id}/inputs`, {
    requestId: "release-host-message",
    text: "Retain this conversation through releases",
    whenBusy: "followUp",
  });
  const prompt = async () => {
    const value = await api("GET", `chats/${chat.id}/context/prompt`);
    return value.status === 200 ? JSON.stringify(value.body) : "";
  };
  await until(prompt, (text) => text.includes("Retain this conversation through releases"));
  await until(
    () => provider.requests.length,
    (count) => count > 0,
  );
  await ok("POST", `${releasePath}/approve`, { acceptCodeTrust: true });
  await writeFile(style, Buffer.concat([testedStyle, Buffer.from("\n/* changed after approval */\n")]));
  const changed = await api<{ message: string }>("POST", `${releasePath}/activate`, {});
  assert.equal(changed.status, 409);
  assert.match(changed.body.message, /candidate changed/);
  assert.equal((await view()).candidates.find((item) => item.digest === receipt.digest)?.approved, false);
  await writeFile(style, testedStyle);
  await ok("POST", `${releasePath}/approve`, { acceptCodeTrust: true });
  provider.behavior.hold = true;
  await ok("POST", `chats/${chat.id}/inputs`, {
    requestId: "release-host-busy",
    text: "Hold this fake request",
    whenBusy: "followUp",
  });
  await until(
    () => provider.holding,
    (count) => count > 0,
  );
  assert.equal((await api("POST", `${releasePath}/activate`, {})).status, 409);
  await ok("POST", `chats/${chat.id}/stop`, {});
  provider.behavior.hold = false;
  await until(
    () => provider.holding,
    (count) => count === 0,
  );
  await until(prompt, (text) => text.includes(provider.behavior.reply));
  const { terminal } = await ok<{ terminal: { id: string } }>("POST", `projects/${project.id}/terminals`, {
    cols: 80,
    rows: 24,
    trust: true,
  });
  assert.equal((await api("POST", `${releasePath}/activate`, {})).status, 409);
  await ok("DELETE", `projects/${project.id}/terminals/${terminal.id}`);
  await stop();

  parent = start(true);
  await ready();
  await arm("health");
  await ok("POST", `${releasePath}/activate`, {}, 202);
  await until(async () => {
    try {
      const state = await view();
      return (
        !state.busy &&
        state.lastError?.includes("fixture rejected candidate health") === true &&
        state.current.package === base.package
      );
    } catch {
      return false;
    }
  }, Boolean);
  await ready();
  assert((await prompt()).includes(provider.behavior.reply));
  await arm("busy", project.id);
  await ok("POST", `${releasePath}/activate`, {}, 202);
  await until(async () => {
    try {
      const state = await view();
      return (
        !state.busy && state.lastError?.includes("unfinished work") === true && state.current.package === base.package
      );
    } catch {
      return false;
    }
  }, Boolean);
  await ready();
  await arm("selected");
  const selected = once(parent.events, "barrier:selected", { signal: AbortSignal.timeout(60_000) });
  const interrupted = api("POST", `${releasePath}/activate`, {}).then(
    (value) => value.status,
    () => 0,
  );
  await selected;
  const selectedState = (await readReleaseJson(join(dataRoot, "release-control/selection.json"))) as {
    phase: string;
    next: { digest: string };
    current: { package: string };
  };
  assert.equal(selectedState.phase, "trying");
  assert.equal(selectedState.next.digest, receipt.digest);
  assert.equal(selectedState.current.package, base.package);
  await stop("SIGKILL");
  assert.notEqual(await interrupted, 202);
  parent = start();
  await ready();
  assert.match((await view()).lastError ?? "", /Interrupted activation/);
  assert.equal((await view()).current.package, base.package);
  await ok("POST", `${releasePath}/activate`, {}, 202);
  await ready(hash(receipt.package));
  await until(async () => {
    try {
      return !(await view()).busy;
    } catch {
      return false;
    }
  }, Boolean);
  assert.equal((await view()).current.digest, receipt.digest);
  assert.equal((await view()).previous?.digest, baseline);
  assert((await prompt()).includes(provider.behavior.reply));
  await stop();
  parent = start();
  await ready(hash(receipt.package));
  assert.equal((await view()).current.digest, receipt.digest);
  assert.equal((await api("POST", `releases/${"0".repeat(64)}/rollback`, {})).status, 409);
  await ok("POST", `releases/${baseline}/rollback`, {}, 202);
  await ready();
  await until(async () => {
    try {
      return !(await view()).busy;
    } catch {
      return false;
    }
  }, Boolean);
  assert.equal((await view()).current.package, base.package);
  assert.equal((await view()).previous?.digest, receipt.digest);
  assert((await prompt()).includes(provider.behavior.reply));
  assert.equal((await ok<{ chat: { id: string } }>("GET", `chats/${chat.id}`)).chat.id, chat.id);
  assert.equal(hash(await readFile(join(dataRoot, "credentials.key"))), key);
  assert.equal(await readFile(external, "utf8"), "external workspace effect stays");
  for (const file of [
    join(dataRoot, "release-control/selection.json"),
    join(dataRoot, "release-control/supervisor.lock"),
  ])
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await view()).retained, 2);
  await stop();

  parent = start(true);
  await ready();
  await ok("POST", `${releasePath}/activate`, {}, 202);
  await ready(hash(receipt.package));
  await until(async () => !(await view()).busy, Boolean);
  const requests = provider.requests.length;
  await arm("schema");
  await ok("POST", `releases/${baseline}/rollback`, {}, 202);
  const incompatible = parent;
  await until(
    () => incompatible.process.exitCode,
    (code) => code !== null,
  );
  assert.equal(await incompatible.exited, 1, incompatible.diagnostic());
  parent = undefined;
  await assert.rejects(fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }));
  const held = selection(await readReleaseJson(join(dataRoot, "release-control/selection.json")), base);
  assert.equal(held.phase, "stable");
  assert.equal(held.current.package, receipt.package);
  assert.equal(held.previous?.package, base.package);
  assert.equal(held.next, undefined);
  assert.equal(held.retained.length, 2);
  assert.match(held.lastError ?? "", /schema/);
  const database = await openDatabase(join(dataRoot, "pal.sqlite"));
  try {
    assert.deepEqual(
      { ...(await database.get("SELECT version, name FROM pal_migrations ORDER BY version DESC LIMIT 1")) },
      { version: base.schema + 1, name: "fixture-future" },
    );
    assert.deepEqual({ ...(await database.get("SELECT id FROM pal_chats WHERE id = ?", chat.id)) }, { id: chat.id });
  } finally {
    await database.close();
  }
  assert.equal(hash(await readFile(join(dataRoot, "credentials.key"))), key);
  assert.equal(await readFile(external, "utf8"), "external workspace effect stays");
  assert.equal(provider.requests.length, requests);
  process.stdout.write(
    JSON.stringify({
      root,
      package: base.package,
      candidatePackage: receipt.package,
      digest: receipt.digest,
      fixedChecks: 7,
      legacyProofRefused: evidence.legacyProofRefused,
      legacyRecheckPassed: evidence.legacyRecheckPassed,
      ownerOrigin: true,
      changedApprovalRefused: true,
      busyNativeAndTerminalRefused: true,
      failedHealthRecovered: true,
      stoppedRaceRefused: true,
      selectionBeforeRestartSIGKILLRecovered: true,
      promotedSelectionRetainedAfterRestart: true,
      compatibleRollbackPreservedConversationKeysAndExternalFiles: true,
      incompatibleRollbackHeldWithoutDataRestore: true,
    }) + "\n",
  );
} finally {
  await stop();
  await provider.close();
}
