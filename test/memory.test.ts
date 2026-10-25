import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import type { MemoryInput } from "../src/core/memory.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const note = (body = "Use SQLite for the durable journal"): MemoryInput => ({
  title: "Storage decision",
  body,
  source: { kind: "owner" },
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-memory-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  let pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("memory-project", { name: "Memory" });
  const faux = fauxProvider();
  let sequence = 0;
  const agent = async (projectId = project.id) => {
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const chat = await pal.chats.createChat(`memory-chat-${++sequence}`, { projectId }, context);
    const conversation = await pal.harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing fixture conversation");
    const model = faux.getModel();
    await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    const run = async (query: string) => {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("codemode", { code: `return await tools.memory_search({query:${JSON.stringify(query)}});` }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      await pal.chats.submit(chat.id, `memory-input-${++sequence}`, { text: "retrieve the earlier decision" }, context);
      await conversation.waitForIdle(context);
      const history = await conversation.context(context);
      const text =
        history.messages
          .findLast((message) => message.role === "toolResult")
          ?.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("") ?? "";
      return { text, history };
    };
    return { chat, conversation, run };
  };
  return {
    root,
    dataRoot,
    project,
    agent,
    faux,
    get pal() {
      return pal;
    },
    reopen: async () => {
      await pal.close();
      pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
    },
  };
}

describe("source-linked curated memory", () => {
  it("retrieves through native Code Mode, corrects with revision CAS, forgets immediately and retains no duplicate heads", async () => {
    const f = await setup();
    const id = await f.pal.memory.save(f.project.id, "memory-first", note(), context);
    expect(await f.pal.memory.save(f.project.id, "memory-first", note(), context)).toBe(id);
    expect(
      await f.pal.memory.save(
        f.project.id,
        "memory-first",
        { source: { kind: "owner" }, body: note().body, title: note().title },
        context,
      ),
    ).toBe(id);
    await expect(f.pal.memory.save(f.project.id, "memory-first", note("different"), context)).rejects.toThrow(
      /different/,
    );
    const a = await f.agent();
    const workspace = await f.pal.workspaces.info(a.chat.id);
    if (workspace === undefined) throw new Error("missing workspace");
    await expect(f.pal.memory.save(f.project.id, "memory-first", note(), context, workspace.id)).rejects.toThrow(
      /different/,
    );
    const result = await a.run("SQLite");
    expect(result.text).toContain("Use SQLite");
    expect(result.history.entries.some((entry) => entry.kind === "pal.memory")).toBe(true);
    await f.pal.memory.correct(f.project.id, id, 1, note("Use PostgreSQL for this corrected decision"), context);
    await expect(f.pal.memory.correct(f.project.id, id, 1, note(), context)).rejects.toThrow(/changed/);
    expect((await a.run("SQLite")).text).not.toContain("Use SQLite");
    expect((await a.run("PostgreSQL")).text).toContain("corrected decision");
    const other = await f.pal.projects.create("other-memory-project", { name: "Other" });
    expect((await (await f.agent(other.id)).run("PostgreSQL")).text).not.toContain("corrected decision");
    await f.pal.memory.forget(f.project.id, id, 2);
    expect((await a.run("PostgreSQL")).text).not.toContain("corrected decision");
    expect(await f.pal.memory.list(f.project.id, context)).toEqual([]);
    await expect(f.pal.memory.save(f.project.id, "memory-first", note(), context)).rejects.toThrow(/forgotten/);
    expect(await f.pal.store.database.get("SELECT count(*) AS n FROM pal_memory_versions WHERE id = ?", id)).toEqual({
      n: 2,
    });
  });

  it("retrieval-rank-v1 keeps an older relevant constraint ahead of recent distractors across compaction and reopen", async () => {
    const f = await setup();
    const body = "Preserve the zircon quorum ledger; the unresolved step is to repair the planner.";
    const id = await f.pal.memory.save(
      f.project.id,
      "rank-relevant",
      { title: "Zircon quorum ledger", body, source: { kind: "owner" } },
      context,
    );
    await f.pal.store.database.run("UPDATE pal_memory_versions SET updated_at = 1 WHERE id = ?", id);
    for (let index = 0; index < 20; index++) {
      const distractor = await f.pal.memory.save(
        f.project.id,
        `rank-distractor-${index}`,
        { title: `Recent note ${index}`, body: "Zircon unrelated housekeeping.", source: { kind: "owner" } },
        context,
      );
      await f.pal.store.database.run(
        "UPDATE pal_memory_versions SET updated_at = ? WHERE id = ?",
        index + 2,
        distractor,
      );
    }
    const ranked = await f.pal.store.database.all<{ id: string }>(
      "SELECT id FROM pal_memory_fts WHERE pal_memory_fts MATCH ? ORDER BY rank LIMIT 30",
      '"zircon" OR "quorum" OR "ledger"',
    );
    expect(ranked).toHaveLength(21);
    expect(ranked[0]?.id).toBe(id);
    const check = async (a: Awaited<ReturnType<typeof f.agent>>) => {
      const result = await a.run("zircon quorum ledger");
      expect(result.text).toContain(body);
      const lookup = (await f.pal.context.inspect(a.chat, context)).lookups.at(-1);
      expect(lookup?.candidates[0]).toEqual({ id, revision: 1 });
      expect(lookup?.candidates.length).toBeLessThanOrEqual(10);
      expect(lookup?.truncated).toBe(true);
    };
    const a = await f.agent();
    await check(a);
    await (
      await a.conversation.submit(
        {
          type: "write",
          entry: {
            kind: "fixture.context",
            model: [{ role: "user", content: "irrelevant history ".repeat(12_000), timestamp: 0 }],
          },
        },
        context,
      )
    ).wait(context);
    f.faux.setResponses([fauxAssistantMessage("Only unrelated housekeeping remains in this summary.")]);
    const compaction = await a.conversation.compact("Summarize the fixture history", context);
    await f.pal.harness.waitForTask(compaction, context);
    await a.conversation.waitForIdle(context);
    expect((await a.conversation.context(context)).head).toBeDefined();
    await check(a);
    await f.reopen();
    await check(await f.agent());
  });

  it("keeps chat sources across real compaction and restart, and suppresses a removed source chat", async () => {
    const f = await setup();
    const a = await f.agent();
    await a.run("missing decision");
    const entry = (await a.conversation.context(context)).entries.find((entry) =>
      entry.model?.some((message) => message.role === "user"),
    );
    if (entry === undefined) throw new Error("missing user source");
    const input: MemoryInput = { ...note(), source: { kind: "chat", chat: a.chat.id, entry: entry.id } };
    const id = await f.pal.memory.save(f.project.id, "chat-memory", input, context);
    await (
      await a.conversation.submit(
        {
          type: "write",
          entry: {
            kind: "fixture.context",
            model: [{ role: "user", content: "fixture ".repeat(12_000), timestamp: 0 }],
          },
        },
        context,
      )
    ).wait(context);
    f.faux.setResponses([fauxAssistantMessage("Earlier fixture messages were summarised.")]);
    const compaction = await a.conversation.compact("Keep only a brief fixture summary", context);
    await f.pal.harness.waitForTask(compaction, context);
    await a.conversation.waitForIdle(context);
    const compacted = await a.conversation.context(context);
    expect(compacted.head).toBeDefined();
    expect(compacted.entries.some((candidate) => candidate.id === entry.id)).toBe(false);
    expect((await f.pal.memory.source(f.project.id, id, context)).text).toContain("retrieve the earlier decision");
    await f.reopen();
    expect((await f.pal.memory.list(f.project.id, context))[0]).toMatchObject({
      id,
      source: { kind: "chat", entry: entry.id },
    });
    expect((await (await f.agent()).run("SQLite")).text).toContain("Use SQLite");
    await f.pal.chats.remove(a.chat.id, context);
    expect(await f.pal.memory.list(f.project.id, context)).toEqual([]);
  });

  it("requires matching file content and identity independently of memory age and indexing policy", async () => {
    const f = await setup();
    const ref = join(f.root, "reference");
    await mkdir(ref);
    await writeFile(join(ref, "decision.txt"), "Original SQLite source");
    const folder = await f.pal.folders.add(f.project.id, "memory-reference", { folder: ref, indexed: false });
    const input: MemoryInput = {
      ...note(),
      source: {
        kind: "file",
        folder: folder.id,
        path: "decision.txt",
        sha256: createHash("sha256").update("Original SQLite source").digest("hex"),
      },
    };
    const id = await f.pal.memory.save(f.project.id, "file-memory", input, context);
    const a = await f.agent();
    expect((await a.run("SQLite")).text).toContain("Use SQLite");
    await writeFile(join(ref, "decision.txt"), "Changed source");
    expect((await f.pal.memory.list(f.project.id, context))[0]?.state).toBe("changed");
    expect((await a.run("SQLite")).text).not.toContain("Use SQLite");
    await expect(f.pal.memory.correct(f.project.id, id, 1, input, context)).rejects.toThrow(/source changed/);
    await writeFile(join(ref, "decision.txt"), "Original SQLite source");
    await rename(ref, join(f.root, "old-reference"));
    await mkdir(ref);
    await writeFile(join(ref, "decision.txt"), "Original SQLite source");
    expect(await f.pal.memory.list(f.project.id, context)).toEqual([]);
    await f.pal.folders.remove(f.project.id, folder.id);
    expect((await a.run("SQLite")).text).not.toContain("Use SQLite");
  });

  it("rejects cross-project chats, private files, forged source grants and caller-supplied approval metadata", async () => {
    const f = await setup();
    const a = await f.agent();
    await a.run("missing");
    const entry = (await a.conversation.context(context)).entries.find((entry) =>
      entry.model?.some((message) => message.role === "user"),
    );
    if (entry === undefined) throw new Error("missing source");
    const other = await f.pal.projects.create("foreign-memory-project", { name: "Foreign" });
    await expect(
      f.pal.memory.save(
        other.id,
        "bad-chat-memory",
        { ...note(), source: { kind: "chat", chat: a.chat.id, entry: entry.id } },
        context,
      ),
    ).rejects.toThrow(/project/);
    const sha256 = "0".repeat(64);
    for (const path of ["../credentials.key", ".git/config", "/etc/passwd", "private-link"]) {
      if (path === "private-link") await symlink(join(f.dataRoot, "credentials.key"), join(f.project.root, path));
      await expect(
        f.pal.memory.save(
          f.project.id,
          "bad-file-memory",
          { ...note(), source: { kind: "file", folder: "primary", path, sha256 } },
          context,
        ),
      ).rejects.toThrow();
    }
    await expect(
      f.pal.memory.save(
        f.project.id,
        "bad-source-memory",
        { ...note(), source: { kind: "owner", identity: "forged" } },
        context,
      ),
    ).rejects.toThrow();
  });

  it("rebuilds a missing FTS projection and never retrieves an obsolete indexed revision", async () => {
    const f = await setup();
    const id = await f.pal.memory.save(f.project.id, "indexed-memory", note(), context);
    const a = await f.agent();
    await f.pal.store.database.run("DELETE FROM pal_memory_fts");
    expect((await a.run("SQLite")).text).not.toContain("Use SQLite");
    await f.pal.memory.rebuild(f.project.id);
    expect((await a.run("SQLite")).text).toContain("Use SQLite");
    await f.pal.memory.correct(f.project.id, id, 1, note("Use PostgreSQL"), context);
    await f.pal.store.database.run(
      "INSERT INTO pal_memory_fts (id, project_id, revision, title, body) VALUES (?, ?, 1, 'obsolete', 'SQLite')",
      id,
      f.project.id,
    );
    expect((await a.run("SQLite")).text).not.toContain("Use PostgreSQL");
    await f.pal.memory.forget(f.project.id, id, 2);
    await f.pal.memory.rebuild(f.project.id);
    expect(await f.pal.store.database.get("SELECT count(*) AS n FROM pal_memory_fts")).toEqual({ n: 0 });
  });

  it("drops a note corrected or revoked while the last owner identity check yields", async () => {
    const f = await setup();
    const id = await f.pal.memory.save(f.project.id, "race-memory", note(), context);
    const owner = f.pal.folders.owner.bind(f.pal.folders);
    let armed = true;
    vi.spyOn(f.pal.folders, "owner").mockImplementation(async (...args) => {
      const lease = await owner(...args);
      return {
        ...lease,
        check: async () => {
          await lease.check();
          if (armed) {
            armed = false;
            await f.pal.memory.correct(f.project.id, id, 1, note("corrected during lookup"), context);
          }
        },
      };
    });
    expect(await f.pal.memory.list(f.project.id, context)).toEqual([]);
    expect((await f.pal.memory.list(f.project.id, context))[0]?.body).toBe("corrected during lookup");
  });

  it("rechecks a forgotten note after the durable lookup receipt, not just before it", async () => {
    const f = await setup();
    const id = await f.pal.memory.save(f.project.id, "delivery-memory", note(), context);
    const a = await f.agent();
    const workspace = await f.pal.workspaces.info(a.chat.id);
    if (workspace === undefined) throw new Error("missing workspace");
    vi.spyOn(f.pal.folders, "forTool").mockImplementation(async (_api, _ctx, folder) =>
      f.pal.folders.owner(f.project.id, folder, workspace.id),
    );
    const tool = f.pal.memory.tools(async () => ({ id: f.project.id, workspace: workspace.id }))
      .tools?.[0] as ToolRegistration;
    const api = {
      conversationId: a.chat.conversationId,
      commit: async () => f.pal.memory.forget(f.project.id, id, 1),
    } as unknown as ToolExecutionApi;
    const result = await tool.execute({ query: "SQLite" }, api, context);
    expect(JSON.stringify(result)).not.toContain("Use SQLite");
  });

  it("withholds a reference note added after this run's admission scope was frozen", async () => {
    const f = await setup();
    const ref = join(f.root, "late-reference");
    await mkdir(ref);
    await writeFile(join(ref, "decision.txt"), "late private source");
    const a = await f.agent();
    const capture = f.pal.folders.capture.bind(f.pal.folders);
    vi.spyOn(f.pal.folders, "capture").mockImplementation(async (...args) => {
      const frozen = await capture(...args);
      const folder = await f.pal.folders.add(f.project.id, "late-memory-reference", { folder: ref, indexed: false });
      await f.pal.memory.save(
        f.project.id,
        "late-memory-note",
        {
          ...note("SQLite late private memory"),
          source: {
            kind: "file",
            folder: folder.id,
            path: "decision.txt",
            sha256: createHash("sha256").update("late private source").digest("hex"),
          },
        },
        context,
      );
      return frozen;
    });
    expect((await a.run("SQLite")).text).not.toContain("late private memory");
    expect((await f.pal.memory.list(f.project.id, context))[0]?.body).toContain("late private memory");
  });

  it("limits retained note count, including forgotten notes", async () => {
    const f = await setup();
    for (let i = 0; i < 200; i++) await f.pal.memory.save(f.project.id, `quota-memory-${i}`, note(), context);
    await expect(f.pal.memory.save(f.project.id, "excess-memory", note(), context)).rejects.toThrow(/200\/project/);
    const item = (await f.pal.memory.list(f.project.id, context))[0];
    if (item === undefined) throw new Error("missing quota fixture note");
    await f.pal.memory.forget(f.project.id, item.id, item.revision);
    await expect(f.pal.memory.save(f.project.id, "excess-memory", note(), context)).rejects.toThrow(/200\/project/);
    expect(await f.pal.store.database.get("SELECT count(*) AS n FROM pal_memory")).toEqual({ n: 200 });
  });

  it("rolls back a head when the retained byte budget is full and fails closed on corrupt stored data", async () => {
    const f = await setup();
    const id = await f.pal.memory.save(f.project.id, "budget-memory", note(), context);
    await f.pal.store.database.run(
      "UPDATE pal_memory_versions SET body = ? WHERE id = ?",
      "x".repeat(8 * 1024 * 1024),
      id,
    );
    await expect(f.pal.memory.save(f.project.id, "over-budget-memory", note(), context)).rejects.toThrow(/8 MiB/);
    expect(await f.pal.store.database.get("SELECT count(*) AS n FROM pal_memory")).toEqual({ n: 1 });
    await expect(f.pal.memory.list(f.project.id, context)).rejects.toThrow();
    await expect(f.pal.memory.source(f.project.id, id, context)).rejects.toThrow();
    await f.pal.store.database.run(
      "UPDATE pal_memory_versions SET body = 'valid', source = 'corrupt JSON' WHERE id = ?",
      id,
    );
    await expect(f.pal.memory.list(f.project.id, context)).rejects.toThrow();
  });

  it("caps concurrent memory lookups and releases reservations after completion", async () => {
    const f = await setup();
    await f.pal.memory.save(f.project.id, "concurrency-memory", note(), context);
    const gate = Promise.withResolvers<undefined>(),
      ready = Promise.withResolvers<undefined>();
    let waiting = 0;
    const owner = f.pal.folders.owner.bind(f.pal.folders);
    vi.spyOn(f.pal.folders, "owner").mockImplementation(async (...args) => {
      const lease = await owner(...args);
      return {
        ...lease,
        check: async () => {
          await lease.check();
          if (++waiting <= 2) {
            if (waiting === 2) ready.resolve(undefined);
            await gate.promise;
          }
        },
      };
    });
    const one = f.pal.memory.list(f.project.id, context),
      two = f.pal.memory.list(f.project.id, context);
    try {
      await ready.promise;
      await expect(f.pal.memory.list(f.project.id, context)).rejects.toThrow(/two memory/);
    } finally {
      gate.resolve(undefined);
      await Promise.all([one, two]);
    }
    expect(await f.pal.memory.list(f.project.id, context)).toHaveLength(1);
  });

  it("bounds retained revisions and UTF-8 model retrieval rather than injecting all notes", async () => {
    const f = await setup();
    for (let i = 0; i < 12; i++)
      await f.pal.memory.save(f.project.id, `bounded-memory-${i}`, note("SQLite " + "é".repeat(1800)), context);
    const result = await (await f.agent()).run("SQLite");
    expect(result.text).toContain("truncated");
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(3100);
    expect(result.text).not.toContain("�");
    const id = await f.pal.memory.save(f.project.id, "revision-memory", note(), context);
    for (let revision = 1; revision < 32; revision++)
      await f.pal.memory.correct(f.project.id, id, revision, note(`revision ${revision + 1}`), context);
    await expect(f.pal.memory.correct(f.project.id, id, 32, note(), context)).rejects.toThrow(/32 revisions/);
    await expect(f.pal.memory.save(f.project.id, "large-memory", note("x".repeat(2001)), context)).rejects.toThrow();
    expect(await readFile(join(f.dataRoot, "credentials.key"))).toHaveLength(32);
  });
});
