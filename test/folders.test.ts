import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { NativeFinder } from "../src/core/native-finder.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { ChatService } from "../src/core/chats.ts";
import { searchFolder } from "../src/core/files.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-folders-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const installRoot = join(root, "install");
  const referenceRoot = join(root, "reference");
  await mkdir(installRoot);
  await mkdir(referenceRoot);
  await writeFile(join(referenceRoot, "guide.txt"), "reference needle\n");
  await writeFile(join(referenceRoot, "AGENTS.md"), "untrusted fixture instructions");
  let pal = await openPal({ dataRoot, installRoot }, context);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("project-create", { name: "Workspace" });
  const add = (key = "reference", indexed = false) =>
    pal.folders.add(project.id, `folder-${key}`, { folder: referenceRoot, indexed });
  const reopen = async () => {
    await pal.close();
    pal = await openPal({ dataRoot, installRoot }, context);
    return pal;
  };
  return {
    get pal() {
      return pal;
    },
    root,
    dataRoot,
    installRoot,
    referenceRoot,
    project,
    add,
    reopen,
  };
}

function script(code: string) {
  return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
}

async function agent(pal: Awaited<ReturnType<typeof openPal>>, projectId: string) {
  const faux = fauxProvider();
  (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  const chat = await pal.chats.createChat("chat-create", { projectId }, context);
  const conversation = await pal.harness.conversation(chat.conversationId, context);
  if (conversation === undefined) throw new Error("fixture conversation missing");
  const model = faux.getModel();
  await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
  return { faux, chat, conversation };
}

async function results(conversation: Awaited<ReturnType<typeof agent>>["conversation"]) {
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

describe("reference folder grants", () => {
  it("persists explicit read-only/index-off authority without copying, trusting or deleting files", async () => {
    const native = vi.spyOn(NativeFinder, "open");
    const fixture = await setup();
    const granted = await fixture.add();
    expect(granted).toMatchObject({
      root: fixture.referenceRoot,
      access: "read",
      indexed: false,
      instructions: "untrusted",
    });
    expect(await fixture.add()).toEqual(granted);
    await expect(fixture.add("reference", true)).rejects.toThrow(/different/);
    await expect(fixture.pal.files.preview(fixture.project.id, "guide.txt")).rejects.toThrow(/does not exist/);
    expect(await fixture.pal.files.preview(fixture.project.id, "guide.txt", granted.id)).toMatchObject({
      text: "reference needle\n",
    });
    const lease = await fixture.pal.folders.owner(fixture.project.id, granted.id);
    await expect(searchFolder(fixture.pal.search, lease, "needle", "text")).rejects.toThrow(/indexing is off/);
    expect(native).not.toHaveBeenCalled();
    const reopened = await fixture.reopen();
    expect((await reopened.folders.list(fixture.project.id)).map((entry) => entry.id)).toEqual(["primary", granted.id]);
    await reopened.folders.remove(fixture.project.id, granted.id);
    await expect(lease.check()).rejects.toThrow();
    await expect(reopened.files.preview(fixture.project.id, "guide.txt", granted.id)).rejects.toThrow(/revoked/);
    await expect(fixture.add()).rejects.toThrow(/revoked/);
    const again = await fixture.add("new-grant");
    expect(again.id).not.toBe(granted.id);
    await reopened.projects.remove(fixture.project.id);
    await expect(reopened.folders.owner(fixture.project.id, again.id)).rejects.toThrow(/ready project/);
    expect(await readFile(join(fixture.referenceRoot, "guide.txt"), "utf8")).toBe("reference needle\n");
  });

  it("rejects private/overlapping/relative/missing roots and canonical duplicates, with bounded grant count", async () => {
    const { pal, project, root, dataRoot, installRoot, referenceRoot } = await setup();
    await symlink(referenceRoot, join(root, "reference-link"));
    for (const [index, folder] of [
      dataRoot,
      installRoot,
      root,
      project.root,
      "/nix/store",
      "relative",
      join(root, "missing"),
    ].entries()) {
      await expect(
        pal.folders.add(project.id, `blocked-folder-${index}`, { folder, indexed: false }),
      ).rejects.toThrow();
    }
    const granted = await pal.folders.add(project.id, "canonical", {
      folder: join(root, "reference-link"),
      indexed: false,
    });
    expect(granted.root).toBe(referenceRoot);
    await expect(pal.folders.add(project.id, "duplicate", { folder: referenceRoot, indexed: false })).rejects.toThrow(
      /overlap/,
    );
    for (let i = 1; i < 8; i++) {
      const folder = join(root, `reference-${i}`);
      await mkdir(folder);
      await pal.folders.add(project.id, `folder-grant-${i}`, { folder, indexed: false });
    }
    const folder = join(root, "ninth");
    await mkdir(folder);
    await expect(pal.folders.add(project.id, "ninth-grant", { folder, indexed: false })).rejects.toThrow(/at most 8/);
    expect(await pal.folders.list(project.id)).toHaveLength(9);
  });

  it("rejects replaced reference roots and symlink escapes, including after a lease was acquired", async () => {
    const { pal, project, root, referenceRoot, add } = await setup();
    const granted = await add();
    const lease = await pal.folders.owner(project.id, granted.id);
    await writeFile(join(root, "outside.txt"), "private fixture");
    await symlink(join(root, "outside.txt"), join(referenceRoot, "escape.txt"));
    await expect(pal.files.preview(project.id, "escape.txt", granted.id)).rejects.toThrow(/outside/);
    await rename(referenceRoot, join(root, "old-reference"));
    await mkdir(referenceRoot);
    await writeFile(join(referenceRoot, "guide.txt"), "different directory");
    await expect(lease.check()).rejects.toThrow(/replaced/);
    await expect(pal.files.preview(project.id, "guide.txt", granted.id)).rejects.toThrow(/replaced/);
  });

  it("drops revoked in-flight indexes and never returns their results", async () => {
    const { pal, project, add } = await setup();
    const granted = await add("indexed", true);
    const lease = await pal.folders.owner(project.id, granted.id);
    const entered = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const original = NativeFinder.prototype.waitForScan;
    vi.spyOn(NativeFinder.prototype, "waitForScan").mockImplementationOnce(async function (
      this: NativeFinder,
      timeout,
    ) {
      const result = await original.call(this, timeout);
      entered.resolve(undefined);
      await finish.promise;
      return result;
    });
    const searching = searchFolder(pal.search, lease, "needle", "text").catch((error: unknown) => error);
    await entered.promise;
    let revoked = false;
    const revoking = pal.folders.remove(project.id, granted.id).then(() => {
      revoked = true;
    });
    try {
      await expect.poll(() => revoked, { timeout: 5000 }).toBe(true);
      expect(pal.search.size).toBe(0);
      finish.resolve(undefined);
      expect(await searching).toBeInstanceOf(Error);
      expect(pal.search.size).toBe(0);
    } finally {
      finish.resolve(undefined);
      await revoking;
      await searching;
    }
  });

  it("rechecks after search starts late, when revocation already forgot the earlier index", async () => {
    const { pal, project, add } = await setup();
    const granted = await add("indexed", true);
    const lease = await pal.folders.owner(project.id, granted.id);
    const entered = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const original = pal.search.search.bind(pal.search);
    vi.spyOn(pal.search, "search").mockImplementationOnce(async (...args) => {
      entered.resolve(undefined);
      await finish.promise;
      return original(...args);
    });
    const searching = searchFolder(pal.search, lease, "needle", "text").catch((error: unknown) => error);
    await entered.promise;
    await pal.folders.remove(project.id, granted.id);
    finish.resolve(undefined);
    expect(await searching).toBeInstanceOf(Error);
    expect(pal.search.size).toBe(0);
  });

  it("pins grants through multiple generation rounds and steer inputs; a later run sees new grants", async () => {
    const { pal, project, root, add } = await setup();
    const first = await add();
    const { faux, chat, conversation } = await agent(pal, project.id);
    let later: string | undefined;
    faux.setResponses([
      script(`return await tools.files_read({ folder: ${JSON.stringify(first.id)}, path: "guide.txt" });`),
      async () => {
        const folder = join(root, "later");
        await mkdir(folder);
        await writeFile(join(folder, "late.txt"), "late authority");
        later = (await pal.folders.add(project.id, "later-folder", { folder, indexed: false })).id;
        await pal.chats.submit(chat.id, "steer-input", { text: "steer", whenBusy: "steer" }, context);
        return script("return await tools.files_folders({});");
      },
      () => script(`return await tools.files_read({ folder: ${JSON.stringify(later)}, path: "late.txt" });`),
      fauxAssistantMessage("done"),
    ]);
    await pal.chats.submit(chat.id, "first-run", { text: "read the reference" }, context);
    await conversation.waitForIdle(context);
    const output = await results(conversation);
    expect(output).toHaveLength(3);
    expect(output[0]).toMatchObject({ error: false, text: expect.stringContaining("reference needle") });
    expect(output[1]?.text).toContain(first.id);
    expect(output[1]?.text).not.toContain(later);
    expect(output[2]).toMatchObject({
      error: true,
      text: expect.stringContaining("not granted when the run was admitted"),
    });
    faux.setResponses([
      script(`return await tools.files_read({ folder: ${JSON.stringify(later)}, path: "late.txt" });`),
      fauxAssistantMessage("done"),
    ]);
    await pal.chats.submit(chat.id, "later-run", { text: "read the new reference" }, context);
    await conversation.waitForIdle(context);
    expect((await results(conversation)).at(-1)).toMatchObject({
      error: false,
      text: expect.stringContaining("late authority"),
    });
  });

  it("refuses reference writes through native Code Mode validation and revokes an active run immediately", async () => {
    const { pal, project, referenceRoot, add } = await setup();
    const granted = await add();
    const { faux, chat, conversation } = await agent(pal, project.id);
    faux.setResponses([
      script(
        `return await tools.files_write({ folder: ${JSON.stringify(granted.id)}, path: "guide.txt", expectedHash: null, content: "bad" });`,
      ),
      async () => {
        await pal.folders.remove(project.id, granted.id);
        return script(`return await tools.files_read({ folder: ${JSON.stringify(granted.id)}, path: "guide.txt" });`);
      },
      fauxAssistantMessage("done"),
    ]);
    await pal.chats.submit(chat.id, "try-write", { text: "try the reference" }, context);
    await conversation.waitForIdle(context);
    expect((await results(conversation)).map((result) => result.error)).toEqual([true, true]);
    expect(await readFile(join(referenceRoot, "guide.txt"), "utf8")).toBe("reference needle\n");
    expect(await readFile(join(project.root, "guide.txt"), "utf8").catch(() => undefined)).toBeUndefined();
  });

  it.each(["files_read", "files_folders"])(
    "rechecks revocation after the final durable run lookup in %s",
    async (tool) => {
      const { pal, project, add } = await setup();
      const granted = await add();
      const { faux, chat, conversation } = await agent(pal, project.id);
      const lookup = pal.store.storage.submission.bind(pal.store.storage);
      let reads = 0;
      vi.spyOn(pal.store.storage, "submission").mockImplementation(async (...args) => {
        const record = await lookup(...args);
        if (++reads === 2) await pal.folders.remove(project.id, granted.id);
        return record;
      });
      const args = tool === "files_read" ? { folder: granted.id, path: "guide.txt" } : {};
      faux.setResponses([script(`return await tools.${tool}(${JSON.stringify(args)});`), fauxAssistantMessage("done")]);
      await pal.chats.submit(chat.id, "late-revocation", { text: "read" }, context);
      await conversation.waitForIdle(context);
      expect(reads).toBeGreaterThanOrEqual(2);
      const result = (await results(conversation)).at(-1);
      expect(result?.text).not.toContain("reference needle");
      expect(result?.text).not.toContain(granted.id);
      if (tool === "files_read") expect(result?.error).toBe(true);
    },
  );

  it("authorizes a fast nested read before Pal records Pi's acknowledgement, and retries without recapturing authority", async () => {
    const { pal, project, add, root } = await setup();
    const granted = await add();
    const { faux, chat, conversation } = await agent(pal, project.id);
    const entered = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const admissions = await ChatService.open(
      {
        database: pal.store.database,
        harness: pal.harness,
        agentFor: async () => undefined,
        folderScope: (id) => pal.folders.capture(id),
        barrier: async (point) => {
          if (point === "input-submitted") {
            entered.resolve(undefined);
            await finish.promise;
          }
        },
      },
      context,
    );
    faux.setResponses([
      script(`return await tools.files_read({ folder: ${JSON.stringify(granted.id)}, path: "guide.txt" });`),
      fauxAssistantMessage("done"),
    ]);
    const admitted = admissions.submit(chat.id, "acknowledgement-race", { text: "read" }, context);
    await entered.promise;
    await conversation.waitForIdle(context);
    expect((await results(conversation)).at(-1)).toMatchObject({
      error: false,
      text: expect.stringContaining("reference needle"),
    });
    expect(
      await pal.store.database.get(
        "SELECT submission_id FROM pal_admissions WHERE request_id = 'acknowledgement-race'",
      ),
    ).toMatchObject({ submission_id: null });
    finish.resolve(undefined);
    const receipt = await admitted;
    await rename(project.root, join(root, "moved-workspace"));
    expect(await pal.chats.submit(chat.id, "acknowledgement-race", { text: "read" }, context)).toEqual(receipt);
    expect(pal.chats.stopped).toBe(false);
  });

  it("fails closed on corrupt persisted folder scope instead of falling back to current grants", async () => {
    const { pal, project, add } = await setup();
    await add();
    const { faux, chat, conversation } = await agent(pal, project.id);
    const admissions = await ChatService.open(
      {
        database: pal.store.database,
        harness: pal.harness,
        agentFor: async () => undefined,
        folderScope: (id) => pal.folders.capture(id),
        barrier: async (point) => {
          if (point === "input-recorded")
            await pal.store.database.run(
              "UPDATE pal_admissions SET folder_scope = '{broken' WHERE chat_id = ?",
              chat.id,
            );
        },
      },
      context,
    );
    faux.setResponses([script("return await tools.files_folders({});"), fauxAssistantMessage("done")]);
    await admissions.submit(chat.id, "corrupt-scope", { text: "read" }, context);
    await conversation.waitForIdle(context);
    expect((await results(conversation)).at(-1)).toMatchObject({
      error: true,
      text: expect.stringMatching(/JSON|Unexpected/),
    });
  });

  it("keeps the admission scope through an interrupted acknowledgement and restart reconciliation", async () => {
    const fixture = await setup();
    const granted = await fixture.add();
    const { pal } = fixture;
    const { chat, conversation, faux } = await agent(pal, fixture.project.id);
    faux.setResponses([fauxAssistantMessage("done")]);
    let recorded = false;
    const admissions = await ChatService.open(
      {
        database: pal.store.database,
        harness: pal.harness,
        agentFor: async () => undefined,
        folderScope: (id) => pal.folders.capture(id),
        barrier: (point) => {
          if (point === "input-recorded") {
            recorded = true;
            throw new Error("fixture interrupted admission");
          }
        },
      },
      context,
    );
    await expect(admissions.submit(chat.id, "interrupted", { text: "frozen" }, context)).rejects.toThrow(/interrupted/);
    expect(recorded).toBe(true);
    const before = await pal.store.database.get<{ folder_scope: string }>(
      "SELECT folder_scope FROM pal_admissions WHERE request_id = 'interrupted'",
    );
    expect(JSON.parse(before?.folder_scope ?? "null")).toMatchObject({ references: [granted.id] });
    await pal.folders.remove(fixture.project.id, granted.id);
    await fixture.add("replacement");
    await conversation.configure({ model: null }, context);
    const reopened = await fixture.reopen();
    const after = await reopened.store.database.get<{ folder_scope: string; state: string }>(
      "SELECT folder_scope, state FROM pal_admissions WHERE request_id = 'interrupted'",
    );
    expect(after).toMatchObject({ folder_scope: before?.folder_scope, state: "admitted" });
    const recoveredChat = await reopened.chats.get(chat.id);
    expect(recoveredChat?.conversationId).toBe(chat.conversationId);
    expect(reopened.chats.stopped).toBe(false);
  });
});
