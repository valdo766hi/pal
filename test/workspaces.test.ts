import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { fileTools, searchFolder } from "../src/core/files.ts";
import { PrivateFiles } from "../src/core/file-policy.ts";
import { WorktreeFiles } from "../src/core/worktree-files.ts";
import type { WorkspaceMode } from "../src/core/workspaces.ts";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  exec(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
    { cwd },
  );
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-workspaces-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const source = join(root, "source");
  await mkdir(source);
  await git(source, "init", "-q");
  await writeFile(join(source, "file.txt"), "committed needle\n");
  await git(source, "add", "file.txt");
  await git(source, "commit", "-qm", "base");
  let pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("fixture-project", { name: "Repo", folder: source });
  const chat = async (mode: WorkspaceMode, key = `chat-${mode}`, provision = true) => {
    const chat = await pal.chats.createChat(key, { projectId: project.id, workspace: mode }, context);
    const workspace = provision ? await pal.workspaces.provision(chat.id) : await pal.workspaces.info(chat.id);
    if (workspace === undefined) throw new Error("fixture workspace missing");
    return { chat, workspace };
  };
  return {
    root,
    dataRoot,
    source,
    project,
    chat,
    get pal() {
      return pal;
    },
    reopen: async () => {
      await pal.close();
      pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
      return pal;
    },
  };
}
async function aliasedPal() {
  const fixture = await setup();
  await fixture.pal.close();
  const alias = join(fixture.root, "alias");
  await symlink(fixture.root, alias);
  const pal = await openPal({ dataRoot: join(alias, "data"), installRoot: "/nonexistent-install" }, context);
  cleanups.push(() => pal.close());
  return { pal, alias, root: fixture.root, dataRoot: fixture.dataRoot, project: fixture.project };
}

const script = (code: string) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });

async function run(
  pal: Awaited<ReturnType<typeof openPal>>,
  chat: { id: string; conversationId: Parameters<typeof pal.harness.conversation>[0] },
  codes: string[],
) {
  const faux = fauxProvider();
  (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  const conversation = await pal.harness.conversation(chat.conversationId, context);
  if (conversation === undefined) throw new Error("fixture conversation missing");
  const model = faux.getModel();
  await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
  faux.setResponses([...codes.map(script), fauxAssistantMessage("done")]);
  await pal.chats.submit(chat.id, `input-${Date.now()}`, { text: "exercise workspace tools" }, context);
  await conversation.waitForIdle(context);
  const history = await conversation.context(context);
  return history.messages.flatMap((message) =>
    message.role === "toolResult"
      ? [
          {
            error: message.isError,
            text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
          },
        ]
      : [],
  );
}

describe("immutable per-chat workspaces", () => {
  it("keeps Local, Read-only and Worktree usable through a configured data-directory alias", async () => {
    const { pal, dataRoot, project: source } = await aliasedPal();
    for (const mode of ["local", "read-only"] as const) {
      const project = await pal.projects.create(`alias-project-${mode}`, { name: mode });
      const chat = await pal.chats.createChat(
        `alias-chat-${mode}`,
        { projectId: project.id, workspace: mode },
        context,
      );
      const workspace = await pal.workspaces.info(chat.id);
      expect(workspace).toMatchObject({
        mode,
        state: "ready",
        root: join(dataRoot, "projects", project.id, "workspace"),
      });
      if (workspace === undefined) throw new Error("missing fixture workspace");
      await writeFile(join(workspace.root, "hello.txt"), "canonical workspace");
      expect(await pal.files.preview(project.id, "hello.txt", "primary", workspace.id)).toMatchObject({
        text: "canonical workspace",
      });
    }
    const chat = await pal.chats.createChat(
      "alias-worktree-chat",
      { projectId: source.id, workspace: "worktree" },
      context,
    );
    const workspace = await pal.workspaces.provision(chat.id);
    expect(workspace, JSON.stringify(workspace)).toMatchObject({
      mode: "worktree",
      state: "ready",
      root: join(dataRoot, "worktrees", workspace.id),
    });
    expect(await readFile(join(workspace.root, "file.txt"), "utf8")).toBe("committed needle\n");
  });

  it("does not follow later changes to the configured data-directory alias", async () => {
    const { pal, alias, root, dataRoot } = await aliasedPal();
    const redirected = join(root, "elsewhere");
    await mkdir(redirected);
    await unlink(alias);
    await symlink(redirected, alias);
    const project = await pal.projects.create("pinned-data-project", { name: "Pinned" });
    expect(project.root).toBe(join(dataRoot, "projects", project.id, "workspace"));
    expect((await pal.chats.createChat("pinned-data-chat", { projectId: project.id }, context)).id).toBeDefined();
    await expect(access(join(redirected, "data"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves legacy/local request identity, pins committed worktree bytes and refuses admission before readiness", async () => {
    const fixture = await setup();
    const { pal, project, source } = fixture;
    const local = await pal.chats.createChat("local-request", { projectId: project.id }, context);
    expect(await pal.chats.createChat("local-request", { projectId: project.id, workspace: "local" }, context)).toEqual(
      local,
    );
    await expect(
      pal.chats.createChat("local-request", { projectId: project.id, workspace: "worktree" }, context),
    ).rejects.toThrow(/different/);
    await writeFile(join(source, "file.txt"), "manual dirt\n");
    await writeFile(join(source, "untracked.txt"), "manual untracked\n");
    const { chat, workspace } = await fixture.chat("worktree", "pending-worktree", false);
    expect(workspace).toMatchObject({ mode: "worktree", source, state: "provisioning" });
    await expect(pal.chats.submit(chat.id, "not-ready", { text: "not yet" }, context)).rejects.toThrow(/not ready/);
    expect(pal.chats.stopped).toBe(false);
    expect(await pal.store.database.get("SELECT 1 FROM pal_admissions WHERE chat_id = ?", chat.id)).toBeUndefined();
    const [first, duplicate] = await Promise.all([
      pal.workspaces.provision(chat.id),
      pal.workspaces.provision(chat.id),
    ]);
    expect(first).toEqual(duplicate);
    expect(first.state).toBe("ready");
    expect(await readFile(join(first.root, "file.txt"), "utf8")).toBe("committed needle\n");
    await expect(access(join(first.root, "untracked.txt"))).rejects.toThrow();
    expect(await readFile(join(source, "file.txt"), "utf8")).toBe("manual dirt\n");
    expect((await pal.harness.conversation(chat.conversationId, context))?.id).toBe(chat.conversationId);
    expect((await (await pal.harness.conversation(chat.conversationId, context))?.agent(context))?.cwd).toBe(
      first.root,
    );
    const reopened = await fixture.reopen();
    expect(await reopened.workspaces.info(chat.id)).toEqual(first);
    expect(await reopened.chats.list(project.id)).toHaveLength(2);
    expect((await git(source, "worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(2);
  });

  it("uses the actual worktree for native Code Mode files, shell, search, review and owner Terminal", async () => {
    const { pal, project, source, chat } = await setup();
    const created = await chat("worktree");
    const { workspace } = created;
    await pal.approvals.setMode(created.chat.id, "full");
    const output = await run(pal, created.chat, [
      'await tools.files_write({path:"new.txt",content:"worktree-only needle",expectedHash:null}); return await tools.shell_run({command:"pwd",timeout:2});',
      "return await tools.files_folders({});",
      'return await tools.files_search({query:"worktree-only",mode:"text"});',
    ]);
    expect(output).toHaveLength(3);
    expect(output.every((result) => !result.error)).toBe(true);
    expect(output[0]?.text).toContain(workspace.root);
    expect(output[1]?.text).toContain(workspace.root);
    expect(output[2]?.text).toContain("new.txt");
    expect(await pal.files.preview(project.id, "new.txt", "primary", workspace.id)).toMatchObject({
      text: "worktree-only needle",
    });
    await expect(access(join(source, "new.txt"))).rejects.toThrow();
    const changes = await pal.changes.list(project.id, "normal", workspace.id);
    expect(changes.base).toBe(workspace.base);
    expect(changes.files).toMatchObject([{ path: "new.txt", status: "A" }]);
    expect((await pal.changes.list(project.id)).files).toEqual([]);
    const terminal = await pal.terminals.create(project.id, { cols: 80, rows: 24 }, workspace.id);
    expect(terminal.cwd).toBe(workspace.root);
    await pal.terminals.remove(project.id, terminal.id);
  });

  it("hides agent writes/shell in read-only mode and enforces the lease independently of discovery", async () => {
    const { pal, project, source, chat } = await setup();
    const created = await chat("read-only");
    const output = await run(pal, created.chat, [
      "return await tools.files_folders({});",
      'return await tools.files_read({path:"file.txt"});',
      'return await tools.files_write({path:"bad.txt",content:"bad",expectedHash:null});',
      'return await tools.shell_run({command:"printf bad > bad.txt",timeout:2});',
    ]);
    expect(output[0]).toMatchObject({ error: false, text: expect.stringContaining('"access":"read"') });
    expect(output[1]).toMatchObject({ error: false, text: expect.stringContaining("committed needle") });
    expect(output[2]?.error).toBe(true);
    expect(output[3]?.error).toBe(true);
    await expect(access(join(source, "bad.txt"))).rejects.toThrow();
    const tools = fileTools({
      root: async () => source,
      deny: [],
      privateFiles: await PrivateFiles.open([]),
      folders: {
        list: () => pal.folders.list(project.id, created.workspace.id),
        open: () => pal.folders.owner(project.id, "primary", created.workspace.id),
      },
    });
    const write = tools.tools?.find((tool) => tool.name === "files_write") as ToolRegistration;
    await expect(
      write.execute({ path: "bad.txt", content: "bad", expectedHash: null } as never, {} as ToolExecutionApi, context),
    ).rejects.toThrow(/read-only/);
    const terminal = await pal.terminals.create(project.id, { cols: 80, rows: 24 }, created.workspace.id);
    expect(terminal.cwd).toBe(source);
    await pal.terminals.remove(project.id, terminal.id);
  });

  it("isolates revision marks/comments/discard between worktrees and retains the pinned baseline after a manual commit", async () => {
    const { pal, project, source, chat } = await setup();
    const one = await chat("worktree", "workspace-one");
    const two = await chat("worktree", "workspace-two");
    for (const root of [one.workspace.root, two.workspace.root, source])
      await writeFile(join(root, "file.txt"), "same new bytes\n");
    await git(one.workspace.root, "add", "file.txt");
    await git(one.workspace.root, "commit", "-qm", "manual commit");
    const first = (await pal.changes.list(project.id, "normal", one.workspace.id)).files[0];
    if (first === undefined) throw new Error("fixture diff missing");
    expect(first.patch).toContain("-committed needle");
    await pal.changes.review(project.id, first.path, first.revision, true, "normal", one.workspace.id);
    const comment = await pal.changes.comment(
      project.id,
      first.path,
      first.revision,
      1,
      "Only workspace one",
      "normal",
      one.workspace.id,
    );
    for (const id of [two.workspace.id, undefined]) {
      const other = await pal.changes.list(project.id, "normal", id);
      expect(other.files[0]?.reviewed).toBe(false);
      expect(other.comments).toEqual([]);
      await pal.changes.uncomment(project.id, comment.id, id);
    }
    expect((await pal.changes.list(project.id, "normal", one.workspace.id)).comments).toHaveLength(1);
    await pal.changes.discard(project.id, first.path, first.revision, "normal", one.workspace.id);
    expect(await readFile(join(one.workspace.root, "file.txt"), "utf8")).toBe("committed needle\n");
    expect(await readFile(join(two.workspace.root, "file.txt"), "utf8")).toBe("same new bytes\n");
    expect(await readFile(join(source, "file.txt"), "utf8")).toBe("same new bytes\n");
  });

  it("rejects forged project/workspace scopes and a run pinned to another chat, and revokes replaced roots", async () => {
    const { pal, project, root, chat } = await setup();
    const first = await chat("worktree", "first-workspace");
    const second = await chat("worktree", "second-workspace");
    const other = await pal.projects.create("other-project", { name: "Other" });
    for (const read of [
      () => pal.folders.owner(other.id, "primary", first.workspace.id),
      () => pal.files.preview(other.id, "file.txt", "primary", first.workspace.id),
      () => pal.changes.list(other.id, "normal", first.workspace.id),
      () => pal.terminals.create(other.id, { cols: 80, rows: 24 }, first.workspace.id),
    ])
      await expect(read()).rejects.toThrow();
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const conversation = await pal.harness.conversation(first.chat.conversationId, context);
    if (conversation === undefined) throw new Error("fixture conversation missing");
    const model = faux.getModel();
    await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    faux.setResponses([
      async () => {
        const row = await pal.store.database.get<{ folder_scope: string }>(
          "SELECT folder_scope FROM pal_admissions WHERE chat_id = ?",
          first.chat.id,
        );
        const scope = JSON.parse(row?.folder_scope ?? "null");
        await pal.store.database.run(
          "UPDATE pal_admissions SET folder_scope = ? WHERE chat_id = ?",
          JSON.stringify({ ...scope, workspace: second.workspace.id }),
          first.chat.id,
        );
        return script('return await tools.files_read({path:"file.txt"});');
      },
      fauxAssistantMessage("done"),
    ]);
    await pal.chats.submit(first.chat.id, "forged-run", { text: "try a forged scope" }, context);
    await conversation.waitForIdle(context);
    const history = await conversation.context(context);
    expect(JSON.stringify(history.messages)).toContain("does not belong to this chat");
    const lease = await pal.folders.owner(project.id, "primary", first.workspace.id);
    await rename(first.workspace.root, join(root, "old-worktree"));
    await mkdir(first.workspace.root);
    await expect(lease.check()).rejects.toThrow(/replaced/);
    await expect(pal.folders.capture(project.id, first.chat.id)).rejects.toThrow(/replaced/);
  });

  it("shares only explicitly granted project references and releases revoked workspace search results", async () => {
    const { pal, project, root, chat } = await setup();
    const reference = join(root, "reference");
    await mkdir(reference);
    await writeFile(join(reference, "guide.txt"), "reference-only needle");
    const granted = await pal.folders.add(project.id, "grant-reference", { folder: reference, indexed: false });
    const { workspace, chat: created } = await chat("worktree");
    expect((await pal.folders.list(project.id, workspace.id)).map((entry) => entry.root)).toEqual([
      workspace.root,
      reference,
    ]);
    const output = await run(pal, created, [
      `return await tools.files_read({folder:${JSON.stringify(granted.id)},path:"guide.txt"});`,
    ]);
    expect(output[0]).toMatchObject({ error: false, text: expect.stringContaining("reference-only") });
    const lease = await pal.folders.owner(project.id, "primary", workspace.id);
    const original = pal.search.search.bind(pal.search);
    vi.spyOn(pal.search, "search").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await pal.chats.remove(created.id, context);
      return result;
    });
    await expect(searchFolder(pal.search, lease, "needle", "text")).rejects.toThrow(/revoked/);
    expect(pal.search.size).toBe(0);
    expect(await readFile(join(reference, "guide.txt"), "utf8")).toBe("reference-only needle");
  });

  it("does not return a reference revoked during the last workspace identity check", async () => {
    const { pal, project, root, chat } = await setup();
    const reference = join(root, "reference");
    await mkdir(reference);
    const grant = await pal.folders.add(project.id, "revoked-reference", { folder: reference, indexed: false });
    const { workspace } = await chat("worktree");
    const original = pal.workspaces.lease.bind(pal.workspaces);
    let checks = 0;
    vi.spyOn(pal.workspaces, "lease").mockImplementation(async (...args) => {
      const lease = await original(...args);
      return {
        ...lease,
        check: async () => {
          await lease.check();
          if (++checks === 2) await pal.folders.remove(project.id, grant.id);
        },
      };
    });
    expect((await pal.folders.list(project.id, workspace.id)).some((folder) => folder.id === grant.id)).toBe(false);
    expect(checks).toBeGreaterThanOrEqual(2);
  });

  it("does not revive reference discovery while validating a run's pinned workspace", async () => {
    const { pal, project, root, chat } = await setup();
    const reference = join(root, "reference");
    await mkdir(reference);
    const grant = await pal.folders.add(project.id, "revoked-discovery", { folder: reference, indexed: false });
    const created = await chat("worktree");
    const original = pal.workspaces.lease.bind(pal.workspaces);
    let leases = 0;
    vi.spyOn(pal.workspaces, "lease").mockImplementation(async (...args) => {
      const lease = await original(...args);
      if (++leases === 3) await pal.folders.remove(project.id, grant.id);
      return lease;
    });
    const output = await run(pal, created.chat, ["return await tools.files_folders({});"]);
    expect(output[0]?.error).toBe(false);
    expect(output[0]?.text).not.toContain(grant.id);
    expect(leases).toBeGreaterThanOrEqual(3);
  });

  it("keeps failed preparation explicit without falling back, latching unrelated admission, or retrying on reopen", async () => {
    const fixture = await setup();
    const managed = await fixture.pal.projects.create("non-git-project", { name: "No Git" });
    const failed = await fixture.pal.chats.createChat(
      "failed-worktree",
      { projectId: managed.id, workspace: "worktree" },
      context,
    );
    expect(await fixture.pal.workspaces.info(failed.id)).toMatchObject({
      mode: "worktree",
      state: "failed",
      source: managed.root,
    });
    await expect(fixture.pal.chats.submit(failed.id, "blocked-work", { text: "blocked" }, context)).rejects.toThrow(
      /not ready/,
    );
    expect(fixture.pal.chats.stopped).toBe(false);
    await fixture.chat("local");
    const reopened = await fixture.reopen();
    expect(await reopened.workspaces.info(failed.id)).toMatchObject({ mode: "worktree", state: "failed" });
    expect(reopened.chats.stopped).toBe(false);
    await fixture.chat("read-only");
  });

  it("cancels preparation when its chat is removed before an external mutation and preserves all files", async () => {
    const { pal, project, source, chat } = await setup();
    const created = await chat("worktree", "remove-during-provision", false);
    const original = WorktreeFiles.prototype.provision;
    vi.spyOn(WorktreeFiles.prototype, "provision").mockImplementationOnce(async function (
      this: WorktreeFiles,
      intent,
      signal,
      record,
      check,
    ) {
      await pal.chats.remove(created.chat.id, context);
      return original.call(this, intent, signal, record, check);
    });
    await expect(pal.workspaces.provision(created.chat.id)).rejects.toThrow(/revoked/);
    expect((await git(source, "worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(1);
    await expect(access(created.workspace.root)).rejects.toThrow();
    expect(await pal.chats.list(project.id)).toEqual([]);
    expect(await readFile(join(source, "file.txt"), "utf8")).toBe("committed needle\n");
  });

  it("bounds concurrent preparation and retained worktree intents; close leaves pending intent for reconciliation", async () => {
    const fixture = await setup();
    const entries = [];
    for (let i = 0; i < 9; i++) entries.push(await fixture.chat("worktree", `bounded-worktree-${i}`, false));
    expect(entries[8]?.workspace).toMatchObject({ state: "failed", error: expect.stringContaining("8 retained") });
    const original = WorktreeFiles.prototype.provision;
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let count = 0;
    vi.spyOn(WorktreeFiles.prototype, "provision").mockImplementation(async function (this: WorktreeFiles, ...args) {
      if (++count === 2) entered.resolve(undefined);
      await release.promise;
      return original.apply(this, args);
    });
    const [first, second, third] = entries;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error("fixture workspaces missing");
    const one = fixture.pal.workspaces.provision(first.chat.id);
    const two = fixture.pal.workspaces.provision(second.chat.id);
    const settled = Promise.allSettled([one, two]);
    await entered.promise;
    await expect(fixture.pal.workspaces.provision(third.chat.id)).rejects.toMatchObject({ code: "workspace_busy" });
    const closing = fixture.pal.workspaces.close();
    release.resolve(undefined);
    await closing;
    await settled;
    expect(await fixture.pal.workspaces.info(first.chat.id)).toMatchObject({ state: "provisioning" });
    expect((await git(fixture.source, "worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(1);
  });

  it.each(["recorded", "registered", "identified", "materialized", "ready"])(
    "reconciles SIGKILL at %s with one workspace/conversation and the original baseline",
    async (phase) => {
      const fixture = await setup();
      await fixture.pal.close();
      const child = spawn(
        process.execPath,
        [...process.execArgv, new URL("./fixtures/workspace-child.ts", import.meta.url).pathname, fixture.root, phase],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await once(child, "close");
        }
      });
      const lines = createInterface({ input: child.stdout });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk).slice(-4096);
      });
      const ready = await new Promise<{ phase: string; chatId: string }>((resolve, reject) => {
        lines.once("line", (line) => {
          try {
            resolve(JSON.parse(line));
          } catch (error) {
            reject(error);
          }
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`fixture exited ${code}: ${stderr}`)));
      });
      expect(ready.phase).toBe(phase);
      child.kill("SIGKILL");
      await once(child, "close");
      lines.close();
      const reopened = await fixture.reopen();
      const workspace = await reopened.workspaces.info(ready.chatId);
      if (workspace === undefined) throw new Error("recovered workspace missing");
      expect(workspace.state).toBe("ready");
      expect(workspace.mode).toBe("worktree");
      expect(await readFile(join(workspace.root, "file.txt"), "utf8")).toBe("committed needle\n");
      expect((await git(fixture.source, "worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(
        2,
      );
      const chats = await reopened.chats.list(fixture.project.id);
      expect(chats).toHaveLength(1);
      expect(chats[0]?.id).toBe(ready.chatId);
      expect((await reopened.changes.list(fixture.project.id, "normal", workspace.id)).base).toBe(workspace.base);
      expect(await reopened.workspaces.provision(ready.chatId)).toEqual(workspace);
    },
  );
});
