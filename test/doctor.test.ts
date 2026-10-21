import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { formatDoctor, runDoctor } from "../src/doctor.ts";
import { MIGRATIONS } from "../src/storage/migrations.ts";

const exec = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

async function store() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-doctor-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const pal = await openPal({ dataRoot, installRoot: join(root, "install") }, context);
  cleanups.push(() => pal.close());
  await pal.providers.setKey("openrouter", "sk-doctor-fixture-0123456789");
  return { root, dataRoot, pal };
}

const check = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  report.checks.find((item) => item.check === name);

describe("pal doctor", () => {
  it("does not misreport a corrupt stopped store as a running Pal", async () => {
    const { root, dataRoot, pal } = await store();
    await pal.close();
    await writeFile(join(dataRoot, "pal.sqlite"), "not a SQLite database");
    const report = await runDoctor({ installRoot: root, dataRoot, env: {} });
    expect(check(report, "data-directory")).toMatchObject({ ok: false });
    expect(report.core).toBe("broken");
  });

  it("checks a nested first-run data directory without creating it", async () => {
    const { root, pal } = await store();
    await pal.close();
    const dataRoot = join(root, "new", "nested", "pal");
    const report = await runDoctor({ installRoot: root, dataRoot, env: {} });
    expect(check(report, "data-directory")).toMatchObject({ ok: true });
    expect(report.core).toBe("ok");
    await expect(lstat(join(root, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([0, 1])("does not inherit ambient secrets or export arbitrary program output (exit %i)", async (code) => {
    const { root, dataRoot, pal } = await store();
    await pal.close();
    const secret = "opaque-doctor-test-value";
    vi.stubEnv("PAL_DOCTOR_TEST_SECRET", secret);
    const bash = join(root, "fake-bash");
    const observed = join(root, "observed-env");
    await writeFile(
      bash,
      `#!/bin/sh\nprintf '%s' "$PAL_DOCTOR_TEST_SECRET" > ${JSON.stringify(observed)}\nprintf 'GNU bash, version 5.3.9; ${secret}\\n'\nprintf '${secret}\\n' >&2\nexit ${code}\n`,
      { mode: 0o755 },
    );
    const report = await runDoctor({ installRoot: root, dataRoot, env: { PAL_BASH: bash } });
    expect(await readFile(observed, "utf8")).toBe("");
    expect(check(report, "bash")).toMatchObject({ kind: "core", ok: code === 0 });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(formatDoctor(report)).not.toContain(secret);
  });

  it("does not count nonexistent browser programs as configured prerequisites", async () => {
    const { root, dataRoot, pal } = await store();
    await pal.close();
    const report = await runDoctor({
      installRoot: root,
      dataRoot,
      env: {
        PAL_BASH: process.env.PAL_BASH ?? "bash",
        PAL_CHROMIUM: join(root, "missing-chromium"),
        PAL_BWRAP: join(root, "missing-bwrap"),
        PAL_SOCAT: join(root, "missing-socat"),
        PAL_COREUTILS: join(root, "missing-coreutils"),
      },
    });
    expect(check(report, "browser")).toMatchObject({ kind: "optional", ok: false });
    expect(report.core).toBe("ok");
  });

  it("fails an unverifiable installation without echoing malformed metadata", async () => {
    const { root, dataRoot, pal } = await store();
    await pal.close();
    const secret = "opaque-metadata-secret";
    await writeFile(join(root, "package.json"), `{"name":"pal","secret":"${secret}"`);
    const report = await runDoctor({ installRoot: root, dataRoot, env: {} });
    expect(report.core).toBe("broken");
    expect(check(report, "implementation")).toMatchObject({ kind: "core", ok: false });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("reports identity and separates a healthy core from unavailable optional capabilities", async () => {
    const { root, dataRoot, pal } = await store();
    const locked = () =>
      exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import assert from 'node:assert/strict';
           import {DatabaseSync} from 'node:sqlite';
           let db;
           try {db=new DatabaseSync(process.argv[1],{readOnly:true,timeout:0}); db.prepare('SELECT count(*) FROM pal_migrations').get(); throw new Error('owner lock lost');}
           catch(error) {assert.equal((error.errcode ?? 0) % 256,5);}
           finally {db?.close();}`,
          join(dataRoot, "pal.sqlite"),
        ],
        { timeout: 5000, env: {} },
      );
    await locked();
    const running = await runDoctor({ installRoot: root, dataRoot, env: {} });
    await locked();
    expect(check(running, "data-directory")).toMatchObject({
      kind: "core",
      ok: true,
      detail: expect.stringContaining("in use"),
    });
    await pal.close();
    const report = await runDoctor({ installRoot: root, dataRoot, env: {} });
    expect(report).toMatchObject({
      format: 1,
      core: "ok",
      identity: { supportedSchema: MIGRATIONS.at(-1)?.version, package: null, platform: process.platform },
    });
    expect(check(report, "data-directory")).toMatchObject({
      ok: true,
      detail: expect.stringContaining(`store schema ${MIGRATIONS.at(-1)?.version}`),
    });
    for (const name of ["sqlite", "codemode", "git", "timeout", "bash"])
      expect(check(report, name)).toMatchObject({ kind: "core", ok: true });
    // No configured browser programs: the capability is off, the install is not broken.
    expect(check(report, "browser")).toMatchObject({ kind: "optional", ok: false });
    expect(check(report, "release-supervisor")).toMatchObject({ kind: "optional", ok: false });
    expect(formatDoctor(report)).toContain("Core: ok");
    expect(JSON.stringify(report)).not.toContain("sk-doctor-fixture");
  });

  it("returns JSON and human CLI diagnostics with a failing exit code for a broken core", async () => {
    const { root, dataRoot, pal } = await store();
    await pal.close();
    const args = [fileURLToPath(new URL("../src/main.ts", import.meta.url)), "doctor", "--data-dir", dataRoot];
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: "C" };
    const { stdout } = await exec(process.execPath, [...args, "--json"], { env, timeout: 20_000 });
    expect(JSON.parse(stdout)).toMatchObject({ format: 1, core: "ok" });
    await chmod(dataRoot, 0o755);
    const failed = await exec(process.execPath, [...args, "--json"], { env, timeout: 20_000 }).catch(
      (error: { code: number; stdout: string }) => error,
    );
    expect(failed).toMatchObject({ code: 1 });
    expect(JSON.parse(failed.stdout)).toMatchObject({ format: 1, core: "broken" });
    await chmod(dataRoot, 0o700);
    expect((await exec(process.execPath, args, { env, timeout: 20_000 })).stdout).toContain("Core: ok");
  });

  it("fails the core for a shared data directory or a store from a newer schema", async () => {
    const { root, dataRoot, pal } = await store();
    await pal.close();
    await chmod(dataRoot, 0o755);
    const shared = await runDoctor({ installRoot: root, dataRoot, env: {} });
    expect(shared.core).toBe("broken");
    expect(check(shared, "data-directory")).toMatchObject({ ok: false, remedy: expect.stringContaining("chmod 700") });
    expect(formatDoctor(shared)).toContain("FAIL");
    await chmod(dataRoot, 0o700);
    const db = new DatabaseSync(join(dataRoot, "pal.sqlite"));
    db.prepare("INSERT INTO pal_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      9999,
      "future",
      Date.now(),
    );
    db.close();
    const newer = await runDoctor({ installRoot: root, dataRoot, env: {} });
    expect(newer.core).toBe("broken");
    expect(check(newer, "data-directory")).toMatchObject({ ok: false, detail: expect.stringContaining("schema 9999") });
  });
});
