import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openPal } from "../src/core/app.ts";
import { BuiltinExtensions } from "../src/core/extensions.ts";
import { openDatabase } from "../src/storage/sqlite.ts";
import { MIGRATIONS } from "../src/storage/migrations.ts";
import { releaseLock } from "../src/core/release-files.ts";
import {
  compatibleRelease,
  initialSelection,
  recoveredSelection,
  selection,
  stoppedReleaseIdle,
  unfinishedWork,
} from "../src/core/release-state.ts";
import { hash, type ReleaseManifest } from "../src/core/release-policy.ts";

const base: ReleaseManifest = {
  format: 1,
  package: `/nix/store/${"0".repeat(32)}-pal`,
  nixpkgs: `/nix/store/${"1".repeat(32)}-source`,
  schema: MIGRATIONS.at(-1)?.version ?? 0,
  source: {
    files: [{ path: "web/src/app.css", hash: "a".repeat(64), size: 10, executable: false }],
    digest: "b".repeat(64),
    compatibility: "c".repeat(64),
  },
};
const candidate = { digest: "d".repeat(64), package: `/nix/store/${"2".repeat(32)}-pal` };

describe("host release selection", () => {
  it.each(["count", "stopped activation", "implementation change"])(
    "refuses %s with a claimed schedule before any chat admission",
    async (gate) => {
      const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-release-schedule-")));
      try {
        const child = spawn(
          process.execPath,
          [join(import.meta.dirname, "fixtures/schedules-child.ts"), "run", dataRoot, "claimed"],
          { stdio: ["ignore", "ignore", "inherit"] },
        );
        const [code, signal] = await once(child, "exit");
        expect(code).toBeNull();
        expect(signal).toBe("SIGKILL");
        const database = await openDatabase(join(dataRoot, "pal.sqlite"));
        try {
          expect(await database.get("SELECT count(*) AS n FROM pal_admissions")).toEqual({ n: 0 });
          expect(await database.get("SELECT count(*) AS n FROM pi_tasks WHERE status <> 'terminal'")).toEqual({ n: 0 });
          expect(
            await database.get("SELECT count(*) AS n FROM pi_submissions WHERE status IN ('queued', 'placed')"),
          ).toEqual({ n: 0 });
          const claim = await database.get<{ value: string }>(
            "SELECT value FROM pal_settings WHERE key GLOB 'schedule:*'",
          );
          expect(claim && JSON.parse(claim.value)).toMatchObject({ state: "done", pending: { sequence: 1 } });
          await database.run("UPDATE pal_settings SET value = 'false' WHERE key = 'scheduler:enabled'");
          if (gate === "count") expect(await unfinishedWork(database)).toBe(1);
          if (gate === "implementation change") {
            await expect(
              BuiltinExtensions.open(
                database,
                createRegistry(),
                () => {
                  throw new Error("must not open a harness");
                },
                "different-release",
              ),
            ).rejects.toThrow("unfinished work needs its retained Pal release");
            expect(
              await database.get("SELECT value FROM pal_settings WHERE key = 'extensions:release'"),
            ).toBeUndefined();
          }
        } finally {
          await database.close();
        }
        if (gate === "stopped activation")
          await expect(stoppedReleaseIdle(dataRoot, base.schema)).rejects.toThrow(/unfinished work/);
      } finally {
        await rm(dataRoot, { recursive: true, force: true });
      }
    },
  );

  it("fails closed on unreadable or missing schedule claims, but permits an explicit idle schedule", async () => {
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-release-schedule-json-")));
    const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
    try {
      await pal.store.database.run("INSERT INTO pal_settings (key, value) VALUES ('schedule:fixture', '{}')");
      for (const [value, count] of [
        ["not-json", 1],
        ["{}", 1],
        ['{"pending":{}}', 1],
        ['{"pending":0}', 1],
        ['{"pending":null}', 0],
      ] as const) {
        await pal.store.database.run("UPDATE pal_settings SET value = ? WHERE key = 'schedule:fixture'", value);
        expect(await unfinishedWork(pal.store.database)).toBe(count);
      }
      expect(await pal.store.database.get("SELECT value FROM pal_settings WHERE key = 'schedule:fixture'")).toEqual({
        value: '{"pending":null}',
      });
    } finally {
      await pal.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("probes only a stopped database, refuses busy/schema drift and preserves conversations, keys and external files", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-release-idle-")));
    const dataRoot = join(root, "data");
    const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
    try {
      const project = await pal.projects.create("release-idle-project", { name: "Release fixture" });
      const chat = await pal.chats.createChat("release-idle-chat", { projectId: project.id }, context);
      const key = hash(await readFile(join(dataRoot, "credentials.key")));
      const external = join(project.root, "keep.txt");
      await writeFile(external, "external effect stays");
      expect(await unfinishedWork(pal.store.database)).toBe(0);
      await pal.close();
      await stoppedReleaseIdle(dataRoot, base.schema);
      await expect(stoppedReleaseIdle(dataRoot, base.schema + 1)).rejects.toThrow(/schema/);
      const database = await openDatabase(join(dataRoot, "pal.sqlite"));
      try {
        expect(await database.get("SELECT id FROM pal_chats WHERE id = ?", chat.id)).toEqual({ id: chat.id });
        await database.run("UPDATE pal_projects SET state = 'provisioning' WHERE id = ?", project.id);
        expect(await unfinishedWork(database)).toBe(1);
      } finally {
        await database.close();
      }
      await expect(stoppedReleaseIdle(dataRoot, base.schema)).rejects.toThrow(/unfinished work/);
      expect(hash(await readFile(join(dataRoot, "credentials.key")))).toBe(key);
      expect(await readFile(external, "utf8")).toBe("external effect stays");
    } finally {
      await pal.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains the parent's lifetime lock only in its own child, never tool grandchildren", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-release-inherit-")));
    const path = join(root, "lock"),
      held = await releaseLock(path);
    const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/release-lock-child.ts")], {
      stdio: ["ignore", "pipe", "pipe", "ipc", held.fd],
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let diagnostic = "";
    child.stderr?.on("data", (bytes: Buffer) => {
      diagnostic = (diagnostic + bytes.toString()).slice(-16 * 1024);
    });
    try {
      await Promise.race([
        once(child, "message", { signal: AbortSignal.timeout(5000) }),
        exited.then(() => {
          throw new Error(`lock child exited early: ${diagnostic}`);
        }),
      ]);
      await held.close();
      await expect(releaseLock(path)).rejects.toThrow(/another release/);
      child.send("done");
      await exited;
      expect(child.exitCode, diagnostic).toBe(0);
      const next = await releaseLock(path);
      await next.close();
    } finally {
      await held.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("starts with only the explicitly launched artifact and retains exact identities", () => {
    const state = initialSelection(base);
    expect(selection(JSON.parse(JSON.stringify(state)), base)).toEqual(state);
    expect(state.current.package).toBe(base.package);
    expect(state.approved).toEqual([]);
    expect(state.retained).toEqual([state.current]);
  });

  it("recovers a persisted attempt to the old artifact, not the unpromoted candidate", () => {
    const stable = initialSelection(base);
    const trying = selection(
      {
        ...stable,
        phase: "trying",
        next: candidate,
        retained: [...stable.retained, candidate],
        approved: [candidate.digest],
      },
      base,
    );
    const recovered = recoveredSelection(trying);
    expect(recovered.current).toEqual(stable.current);
    expect(recovered.next).toBeUndefined();
    expect(recovered.phase).toBe("stable");
    expect(recovered.retained).toContainEqual(candidate);
    expect(recovered.lastError).toMatch(/No external effects were undone/);
    expect(trying.next).toEqual(candidate);
    expect(recoveredSelection(stable)).toBe(stable);
  });

  it("refuses inconsistent, unretained, oversized or foreign-evaluator selections", () => {
    const stable = initialSelection(base);
    for (const state of [
      { ...stable, evaluator: candidate.package },
      { ...stable, current: candidate },
      { ...stable, previous: candidate },
      { ...stable, phase: "trying" },
      { ...stable, next: candidate },
      { ...stable, phase: "trying", next: candidate },
      { ...stable, retained: [...stable.retained, ...stable.retained] },
      { ...stable, retained: Array.from({ length: 9 }, () => stable.current) },
      { ...stable, approved: ["invalid"] },
      { ...stable, automaticSchemaMigration: true },
    ])
      expect(() => selection(state, base)).toThrow();
  });

  it("requires identical schema, native/policy compatibility and file set even for rollback", () => {
    expect(() =>
      compatibleRelease(base, {
        ...base,
        package: candidate.package,
        source: { ...base.source, digest: candidate.digest },
      }),
    ).not.toThrow();
    for (const schema of [base.schema - 1, base.schema + 1])
      expect(() => compatibleRelease(base, { ...base, schema })).toThrow(/no automatic migration/);
    expect(() => compatibleRelease(base, { ...base, source: { ...base.source, compatibility: "different" } })).toThrow(
      /protected policy/,
    );
    expect(() => compatibleRelease(base, { ...base, source: { ...base.source, files: [] } })).toThrow(/unsupported/);
  });
});
