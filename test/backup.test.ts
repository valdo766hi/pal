import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { openPal } from "../src/core/app.ts";
import { backupDataRoot, inspectBackup, restoreBackup } from "../src/core/backup.ts";
import { MIGRATIONS } from "../src/storage/migrations.ts";
import { openStore } from "../src/storage/store.ts";
import { chatConfiguration } from "../src/core/chats.ts";

const exec = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PASSPHRASE = "correct horse battery";
const git = (cwd: string, ...args: string[]) =>
  exec(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
    },
  );

/** A stopped installation with an owner, a sealed provider key, managed files and Local/Worktree chats. */
async function installation() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-backup-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const installRoot = join(root, "install");
  const external = join(root, "external");
  await mkdir(installRoot);
  await mkdir(external);
  const pal = await openPal({ dataRoot, installRoot }, context);
  try {
    await pal.owner.setup(pal.owner.setupToken, PASSPHRASE);
    await pal.providers.setKey("openrouter", "sk-backup-fixture-key");
    const project = await pal.projects.create("backup-project", { name: "Backup" });
    await writeFile(join(project.root, "notes.md"), "managed bytes\n");
    await writeFile(join(project.root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await symlink("notes.md", join(project.root, "latest"));
    await git(project.root, "init", "-q");
    await git(project.root, "add", "notes.md");
    await git(project.root, "commit", "-qm", "base");
    await pal.projects.create("backup-external", { name: "External", folder: external });
    const local = await pal.chats.createChat("backup-local", { projectId: project.id, title: "Kept" }, context);
    const conversation = await pal.harness.conversation(local.conversationId, context);
    if (conversation === undefined) throw new Error("missing fixture conversation");
    await conversation.submit(
      { type: "write", entry: { kind: "pi.assistant", model: [fauxAssistantMessage("kept reply")] } },
      context,
    );
    const worktreeChat = await pal.chats.createChat(
      "backup-worktree",
      { projectId: project.id, workspace: "worktree" },
      context,
    );
    const worktree = await pal.workspaces.provision(worktreeChat.id);
    const workspace = await pal.workspaces.info(local.id);
    expect(worktree.state).toBe("ready");
    if (workspace?.state !== "ready") throw new Error("fixture workspace is not ready");
    return { root, dataRoot, installRoot, external, project, local, workspace, worktree };
  } finally {
    await pal.close();
  }
}

describe("stopped-state backup and restore", () => {
  it("restores an installation in place with owner, chats, managed files and credentials intact", async () => {
    const fixture = await installation();
    const backup = join(fixture.root, "backup");
    const made = await backupDataRoot({
      dataRoot: fixture.dataRoot,
      output: backup,
      version: "test",
      includeCredentialKey: true,
      includeBrowserProfiles: false,
    });
    expect(made).toMatchObject({
      dataRoot: fixture.dataRoot,
      schema: MIGRATIONS.at(-1)?.version,
      credentialKeyIncluded: true,
      browserProfiles: "absent",
      external: [{ kind: "project", root: fixture.external }],
      unfinished: { tasks: 0, submissions: 0, admissions: 0, approvals: 0, purges: 0 },
    });
    for (const [path, mode] of [
      [backup, 0o700],
      [join(backup, "manifest.json"), 0o600],
      [join(backup, "data", "pal.sqlite"), 0o600],
      [join(backup, "data", "credentials.key"), 0o600],
    ] as const)
      expect((await lstat(path)).mode & 0o777).toBe(mode);
    expect((await inspectBackup(backup)).report).toMatchObject({
      integrity: "ok",
      owners: 1,
      credentialKey: "included",
    });

    // Copying makes new folders; without remapping, Pal would correctly treat every workspace as replaced.
    await rename(fixture.dataRoot, join(fixture.root, "data-before"));
    const restored = await restoreBackup(backup, fixture.dataRoot);
    expect(restored.restored).toBe(fixture.dataRoot);
    expect(restored.remappedIdentities).toBeGreaterThanOrEqual(3);
    expect((await lstat(fixture.dataRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(fixture.dataRoot, "credentials.key"))).mode & 0o777).toBe(0o600);

    const pal = await openPal({ dataRoot: fixture.dataRoot, installRoot: fixture.installRoot }, context);
    cleanups.push(() => pal.close());
    await expect(pal.owner.signIn(PASSPHRASE)).resolves.toEqual(expect.any(String));
    expect((await pal.providers.list()).find((provider) => provider.id === "openrouter")?.hasKey).toBe(true);
    expect((await pal.chats.list(fixture.project.id)).map((chat) => chat.title)).toContain("Kept");
    const conversation = await pal.harness.conversation(fixture.local.conversationId, context);
    const history = await conversation?.context(context);
    expect(JSON.stringify(history?.messages)).toContain("kept reply");
    await expect(pal.workspaces.lease(fixture.project.id, fixture.workspace.id)).resolves.toMatchObject({
      root: fixture.project.root,
    });
    await expect(pal.workspaces.lease(fixture.project.id, fixture.worktree.id)).resolves.toMatchObject({
      root: fixture.worktree.root,
    });
    expect(await readFile(join(fixture.project.root, "notes.md"), "utf8")).toBe("managed bytes\n");
    expect(await readFile(join(fixture.worktree.root, "notes.md"), "utf8")).toBe("managed bytes\n");
    expect((await lstat(join(fixture.project.root, "run.sh"))).mode & 0o777).toBe(0o700);
    expect(await readlink(join(fixture.project.root, "latest"))).toBe("notes.md");
  });

  it("restores automatic messages paused and never retries a claimed firing", async () => {
    const fixture = await installation();
    const pal = await openPal({ dataRoot: fixture.dataRoot, installRoot: fixture.installRoot }, context);
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const model = faux.getModel();
    let id: string;
    let unclaimed: string;
    try {
      await pal.chats.configure(
        fixture.local.id,
        { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" },
        context,
      );
      const agent = await (await pal.harness.conversation(fixture.local.conversationId, context))?.agent(context);
      if (agent === undefined) throw new Error("missing fixture conversation");
      await pal.schedules.setEnabled(true);
      const input = {
        text: "Future check",
        timezone: "UTC",
        rule: { kind: "daily", time: "00:00" },
        missed: "run-once",
        configuration: chatConfiguration(agent),
        mode: "ask",
        acknowledged: true,
      };
      id = (await pal.schedules.create(fixture.local.id, "restore-schedule", input)).id;
      unclaimed = (await pal.schedules.create(fixture.local.id, "restore-unclaimed", input)).id;
    } finally {
      await pal.close();
    }
    const request = `schedule-${id}-1`;
    const store = await openStore(fixture.dataRoot);
    try {
      const row = await store.database.get<{ value: string }>(
        "SELECT value FROM pal_settings WHERE key = ?",
        `schedule:${id}`,
      );
      if (row === undefined) throw new Error("missing stored schedule");
      // A valid checkpoint immediately after the claim, before normal admission creates its own record.
      const schedule = JSON.parse(row.value);
      schedule.pending = { sequence: 1, due: Date.now() - 1000, request };
      schedule.fired = 1;
      schedule.sequence = 2;
      await store.database.run(
        "UPDATE pal_settings SET value = ? WHERE key = ?",
        JSON.stringify(schedule),
        `schedule:${id}`,
      );
    } finally {
      await store.close();
    }
    const backup = join(fixture.root, "scheduled-backup");
    const made = await backupDataRoot({
      dataRoot: fixture.dataRoot,
      output: backup,
      version: "test",
      includeCredentialKey: true,
      includeBrowserProfiles: false,
    });
    await rename(fixture.dataRoot, join(fixture.root, "data-before"));
    const report = await restoreBackup(backup, fixture.dataRoot);
    expect(report.schedulesPaused).toBe(2);
    const restored = await openPal({ dataRoot: fixture.dataRoot, installRoot: fixture.installRoot }, context);
    cleanups.push(() => restored.close());
    await restored.harness.waitForIdle(context);
    const admissions = await restored.store.database.get<{ n: number }>(
      "SELECT count(*) AS n FROM pal_admissions WHERE request_id = ?",
      request,
    );
    const schedules = await restored.schedules.list();
    const schedule = schedules.find((schedule) => schedule.id === id);
    expect(schedules.find((schedule) => schedule.id === unclaimed)).toMatchObject({ state: "paused", next: null });
    expect({
      claims: made.unfinished.schedules,
      enabled: await restored.schedules.enabled(),
      state: schedule?.state,
      admissions: admissions?.n,
    }).toEqual({ claims: 1, enabled: false, state: "paused", admissions: 0 });
    expect(schedule?.reason).toContain(request);
    expect(schedule?.history[0]).toMatchObject({ kind: "paused", request });
  });

  it("refuses a running store, an existing destination and a different destination", async () => {
    const fixture = await installation();
    const backup = join(fixture.root, "backup");
    const options = {
      dataRoot: fixture.dataRoot,
      output: backup,
      version: "test",
      includeCredentialKey: true,
      includeBrowserProfiles: false,
    };
    const pal = await openPal({ dataRoot: fixture.dataRoot, installRoot: fixture.installRoot }, context);
    await expect(backupDataRoot(options)).rejects.toThrow(/Pal is running/);
    await pal.close();
    await expect(backupDataRoot({ ...options, output: join(fixture.dataRoot, "inside") })).rejects.toThrow(/outside/);
    await backupDataRoot(options);
    await expect(backupDataRoot(options)).rejects.toThrow(/already exists/);

    const marker = join(fixture.dataRoot, "uploads-marker");
    await writeFile(marker, "live installation");
    await expect(restoreBackup(backup, fixture.dataRoot)).rejects.toThrow(/already exists/);
    expect(await readFile(marker, "utf8")).toBe("live installation");
    await expect(restoreBackup(backup, join(fixture.root, "elsewhere"))).rejects.toThrow(/original data directory/);
    await expect(lstat(join(fixture.root, "elsewhere"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects tampered, unlisted or newer backups before restoring anything", async () => {
    const fixture = await installation();
    const backup = join(fixture.root, "backup");
    await backupDataRoot({
      dataRoot: fixture.dataRoot,
      output: backup,
      version: "test",
      includeCredentialKey: true,
      includeBrowserProfiles: false,
    });
    const notes = join(backup, "data", "projects", fixture.project.id, "workspace", "notes.md");
    const original = await readFile(notes);
    await writeFile(notes, "tampered\n");
    await expect(inspectBackup(backup)).rejects.toThrow(/notes.md does not match its checksum/);
    await writeFile(notes, original);
    await writeFile(join(backup, "data", "planted.txt"), "extra");
    await expect(inspectBackup(backup)).rejects.toThrow(/unlisted path: planted.txt/);
    await rm(join(backup, "data", "planted.txt"));
    const manifest = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")) as { schema: number };
    await writeFile(join(backup, "manifest.json"), JSON.stringify({ ...manifest, schema: manifest.schema + 1 }));
    await expect(inspectBackup(backup)).rejects.toThrow(/this Pal supports up to/);
    await writeFile(join(backup, "manifest.json"), JSON.stringify(manifest));
    await expect(inspectBackup(backup)).resolves.toMatchObject({ report: { integrity: "ok" } });

    await rename(fixture.dataRoot, join(fixture.root, "data-before"));
    await writeFile(notes, "tampered\n");
    await expect(restoreBackup(backup, fixture.dataRoot)).rejects.toThrow(/checksum/);
    await expect(lstat(fixture.dataRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the credential key and browser logins out unless they are explicitly included", async () => {
    const fixture = await installation();
    const profile = join(fixture.dataRoot, "browser", fixture.project.id);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(join(profile, "Cookies"), "site login");
    const sealed = join(fixture.root, "sealed");
    const made = await backupDataRoot({
      dataRoot: fixture.dataRoot,
      output: sealed,
      version: "test",
      includeCredentialKey: false,
      includeBrowserProfiles: false,
    });
    expect(made).toMatchObject({ credentialKeyIncluded: false, browserProfiles: "excluded" });
    await expect(lstat(join(sealed, "data", "credentials.key"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(sealed, "data", "browser"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await inspectBackup(sealed)).report.credentialKey).toBe("missing");

    const withProfiles = join(fixture.root, "with-profiles");
    await backupDataRoot({
      dataRoot: fixture.dataRoot,
      output: withProfiles,
      version: "test",
      includeCredentialKey: false,
      includeBrowserProfiles: true,
    });
    expect(await readFile(join(withProfiles, "data", "browser", fixture.project.id, "Cookies"), "utf8")).toBe(
      "site login",
    );

    const key = join(fixture.root, "kept.key");
    await copyFile(join(fixture.dataRoot, "credentials.key"), key);
    await chmod(key, 0o600);
    const wrong = join(fixture.root, "wrong.key");
    await writeFile(wrong, Buffer.alloc(32, 7), { mode: 0o600 });
    await rename(fixture.dataRoot, join(fixture.root, "data-before"));
    await expect(restoreBackup(sealed, fixture.dataRoot)).rejects.toThrow(/pass --credential-key/);
    await expect(restoreBackup(sealed, fixture.dataRoot, wrong)).rejects.toThrow(/does not belong/);
    await chmod(key, 0o644);
    await expect(restoreBackup(sealed, fixture.dataRoot, key)).rejects.toThrow(/chmod 600/);
    await chmod(key, 0o600);
    await expect(restoreBackup(sealed, fixture.dataRoot, key)).resolves.toMatchObject({ credentialKey: "provided" });
    await expect(lstat(join(fixture.dataRoot, "browser"))).rejects.toMatchObject({ code: "ENOENT" });
    const pal = await openPal({ dataRoot: fixture.dataRoot, installRoot: fixture.installRoot }, context);
    cleanups.push(() => pal.close());
    expect((await pal.providers.list()).find((provider) => provider.id === "openrouter")?.hasKey).toBe(true);
  });
});
