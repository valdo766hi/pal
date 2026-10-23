import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  type FauxResponseStep,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal, type Pal } from "../src/core/app.ts";
import type { Chat } from "../src/core/chats.ts";
import { HELPER_LIMITS, type HelperLimits, HelperLinks, helperViews } from "../src/core/delegation.ts";
import { startMcpFixture } from "./fixtures/mcp-server.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

const code = (body: string) =>
  fauxAssistantMessage(fauxToolCall("codemode", { code: body }), { stopReason: "toolUse" });
const DELEGATE =
  'return await tools.agents_delegate({purpose:"Find the fact", task:"Read notes.txt; report line one."});';

async function fixture(options: { helpers?: boolean; limits?: HelperLimits } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-helpers-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = {
    dataRoot: join(root, "data"),
    installRoot: "/nonexistent-install",
    guidanceHome: join(root, "home"),
    ...(options.limits === undefined ? {} : { helperLimits: options.limits }),
  };
  let pal = await openPal(settings, context);
  cleanups.push(() => pal.close());
  if (options.helpers !== false) {
    const view = await pal.extensions.view();
    await pal.extensions.select({ selected: [...view.selected, { id: "helpers", version: 1 }], digest: view.digest });
  }
  const project = await pal.projects.create("helpers-project", { name: "Helpers" });
  await writeFile(join(project.root, "notes.txt"), "HELPER-FACT\nsecond line\n");
  const faux = fauxProvider();
  const model = faux.getModel();
  const useFaux = () => (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  useFaux();
  let sequence = 0;
  return {
    root,
    project,
    faux,
    get pal(): Pal {
      return pal;
    },
    async chat(key: string): Promise<Chat> {
      const chat = await pal.chats.createChat(key, { projectId: project.id }, context);
      await (
        await pal.harness.conversation(chat.conversationId, context)
      )?.configure({ model: { provider: model.provider, modelId: model.id } }, context);
      return chat;
    },
    /** Admit one input with the model turns of the parent and its helpers, in the order they are requested. */
    async send(chat: Chat, turns: FauxResponseStep[], wait = true) {
      faux.setResponses(turns);
      await pal.chats.submit(chat.id, `helpers-input-${++sequence}`, { text: "go" }, context);
      if (wait) await pal.harness.waitForIdle(context);
    },
    async results(conversation: ConversationId) {
      const handle = await pal.harness.conversation(conversation, context);
      return ((await handle?.context(context))?.messages ?? [])
        .flatMap((message) => (message.role === "toolResult" ? [message] : []))
        .map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
    },
    helpers: (chat: Chat) => helperViews(pal.harness, pal.store.storage, chat.conversationId, context),
    async reopen(beforeOpen?: () => void) {
      await pal.close();
      beforeOpen?.();
      pal = await openPal(settings, context);
      useFaux();
    },
  };
}

describe("research helpers", () => {
  it("answer through a helper that reads only the parent run's granted folder", async () => {
    const f = await fixture();
    const chat = await f.chat("helper-chat");
    await f.send(chat, [
      code(DELEGATE),
      code('return await tools.files_read({path:"notes.txt"});'),
      fauxAssistantMessage("Line one is HELPER-FACT."),
      fauxAssistantMessage("The helper found it."),
    ]);
    const [result] = await f.results(chat.conversationId);
    expect(result).toContain("Line one is HELPER-FACT.");
    const [helper] = await f.helpers(chat);
    expect(helper).toMatchObject({ purpose: "Find the fact", status: "answered", turns: 2, unknownEffects: [] });
    expect((await f.results(helper?.conversation as ConversationId))[0]).toContain("HELPER-FACT");
    const agent = await (
      await f.pal.harness.conversation(helper?.conversation as ConversationId, context)
    )?.agent(context);
    const names = agent?.extensions.map((extension) => extension.name) ?? [];
    expect(names).toContain("pal.files");
    for (const excluded of ["pal.helpers", "pal.shell", "pal.browser"]) expect(names).not.toContain(excluded);
  });

  it("narrows native folder leases and listings without narrowing the parent's lease", async () => {
    const f = await fixture();
    const chat = await f.chat("helper-readonly-leases");
    const access: string[] = [];
    const forTool = f.pal.folders.forTool.bind(f.pal.folders);
    vi.spyOn(f.pal.folders, "forTool").mockImplementation(async (...args) => {
      const lease = await forTool(...args);
      access.push(lease.access);
      return lease;
    });
    await f.send(chat, [
      code(DELEGATE),
      code("return await tools.files_folders({});"),
      code('return await tools.files_read({path:"notes.txt"});'),
      fauxAssistantMessage("Found."),
      code('return await tools.files_read({path:"notes.txt"});'),
      fauxAssistantMessage("done"),
    ]);
    const [helper] = await f.helpers(chat);
    const [folders] = await f.results(helper?.conversation as ConversationId);
    expect(folders).toMatch(/access[^a-z]+read/);
    expect(folders).not.toMatch(/access[^a-z]+write/);
    expect(access).toEqual(["read", "write"]);
  });

  it("refuses writes, commands, browser, working state and nested helpers inside a helper", async () => {
    const f = await fixture();
    const chat = await f.chat("authority-chat");
    await f.pal.working.setGoal(
      chat,
      { revision: 0, text: "Parent-only goal", constraints: [], acceptance: [] },
      context,
    );
    const attempts = [
      'tools.files_write({path:"made-by-helper.txt", content:"x", expectedHash:null})',
      'tools.shell_run({command:"printf x > shell-by-helper.txt"})',
      'tools.agents_delegate({purpose:"again", task:"recurse"})',
      "tools.browser_observe({})",
      "tools.working_read({})",
      'tools.working_checkpoint({revision:0,goalRevision:1,summary:"helper note",plan:[],next:"",questions:[]})',
    ];
    await f.send(chat, [
      code(DELEGATE),
      code(
        `const out = []; for (const call of [${attempts.map((attempt) => `() => ${attempt}`).join(", ")}]) { try { await call(); out.push("ran"); } catch (error) { out.push(String(error.message ?? error)); } } return out;`,
      ),
      fauxAssistantMessage("Nothing was allowed."),
      fauxAssistantMessage("done"),
    ]);
    const [helper] = await f.helpers(chat);
    const output = (await f.results(helper?.conversation as ConversationId))[0] ?? "";
    // The policy hides them from a helper's scripts; none ran.
    expect(output.match(/does not exist/g)).toHaveLength(attempts.length);
    expect(output).not.toContain('"ran"');
    for (const name of ["made-by-helper.txt", "shell-by-helper.txt"])
      expect(await readFile(join(f.project.root, name), "utf8").catch(() => undefined)).toBeUndefined();
    expect(await f.helpers(chat)).toHaveLength(1);
    expect(await f.pal.working.inspect(chat, context)).toMatchObject({
      goal: { revision: 1, text: "Parent-only goal" },
      checkpoint: null,
    });
  });

  it("keeps the parent's admitted folder scope and immediately honours revocation", async () => {
    const f = await fixture();
    const folder = join(f.root, "reference");
    await mkdir(folder);
    await writeFile(join(folder, "fact.txt"), "SCOPED-FACT");
    const grant = await f.pal.folders.add(f.project.id, "reference-before-run", { folder, indexed: false });
    const chat = await f.chat("helper-grants");
    let later = "";
    await f.send(chat, [
      code(DELEGATE),
      code(`return await tools.files_read({folder:${JSON.stringify(grant.id)},path:"fact.txt"});`),
      async () => {
        await f.pal.folders.remove(f.project.id, grant.id);
        const folder = join(f.root, "later");
        await mkdir(folder);
        await writeFile(join(folder, "fact.txt"), "LATE-FACT");
        later = (await f.pal.folders.add(f.project.id, "reference-during-run", { folder, indexed: false })).id;
        return code("return await tools.files_folders({});");
      },
      () =>
        code(
          `const out = []; for (const folder of ${JSON.stringify([grant.id, later])}) { try { out.push(await tools.files_read({folder,path:"fact.txt"})); } catch(error) { out.push(String(error.message ?? error)); } } return out;`,
        ),
      fauxAssistantMessage("Only the original granted read was allowed."),
      fauxAssistantMessage("done"),
    ]);
    const [helper] = await f.helpers(chat);
    const output = await f.results(helper?.conversation as ConversationId);
    expect(output[0]).toContain("SCOPED-FACT");
    expect(output[1]).not.toContain(later);
    expect(output[2]).toContain("revoked");
    expect(output[2]).toContain("not granted when the run was admitted");
    expect(output[2]).not.toContain("SCOPED-FACT");
    expect(output[2]).not.toContain("LATE-FACT");
  });

  it("uses only the parent's current project internet grants", async () => {
    const f = await fixture();
    const mcp = await startMcpFixture();
    cleanups.push(mcp.close);
    const server = await f.pal.mcp.add({ name: "Web", url: mcp.url, auth: { kind: "none" }, private: true });
    await f.pal.mcp.test(server.id);
    await f.pal.mcp.approve(server.id, ["search"], (await f.pal.mcp.get(server.id)).catalog);
    await f.pal.mcp.setEnabled(server.id, true);
    const chat = await f.chat("helper-internet-grants");
    const name = `mcp__${server.id}__search`;
    await f.send(chat, [
      code(DELEGATE),
      code(`return await tools.${name}({query:"before"});`),
      async () => {
        const current = (await f.pal.mcp.grants.view(f.project.id)).servers.find((item) => item.id === server.id);
        if (current === undefined) throw new Error("missing project internet grant");
        await f.pal.mcp.grants.set(f.project.id, server.id, { mode: "subset", tools: [], revision: current.revision });
        return code(`return await tools.${name}({query:"after"});`);
      },
      fauxAssistantMessage("The grant was revoked."),
      fauxAssistantMessage("done"),
    ]);
    const [helper] = await f.helpers(chat);
    const results = await f.results(helper?.conversation as ConversationId);
    expect(results[0]).toContain("Durable agents");
    expect(results[1]).toContain("does not exist");
    expect(mcp.calls).toEqual([{ name: "search", arguments: { query: "before" } }]);
    expect((await f.pal.mcp.get(server.id)).enabled).toBe(true);
    const other = await f.pal.projects.create("other-helper-project", { name: "Other" });
    expect((await f.pal.mcp.grants.decision(other.id, server.id, "search")).allowed).toBe(true);
  });

  it("offers no helper tool unless the owner opts in, and ordinary chat is unaffected", async () => {
    const f = await fixture({ helpers: false });
    const chat = await f.chat("plain-chat");
    const agent = await (await f.pal.harness.conversation(chat.conversationId, context))?.agent(context);
    expect(agent?.callable.map((tool) => tool.name)).not.toContain("agents_delegate");
    await f.send(chat, [code(DELEGATE), fauxAssistantMessage("No helpers here.")]);
    expect((await f.results(chat.conversationId))[0]).toMatch(/agents_delegate/);
    expect(await f.helpers(chat)).toEqual([]);
    const conversation = await f.pal.harness.conversation(chat.conversationId, context);
    expect((await conversation?.context(context))?.messages.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("starts at most the per-run number of helpers and stops a helper at its request budget", async () => {
    const f = await fixture();
    const chat = await f.chat("budget-chat");
    const many = `const out = []; for (let i = 0; i < ${HELPER_LIMITS.perRun + 1}; i++) { try { out.push((await tools.agents_delegate({purpose:"p"+i, task:"answer"})).status); } catch (error) { out.push(String(error.message ?? error)); } } return out;`;
    await f.send(chat, [
      code(many),
      ...Array.from({ length: HELPER_LIMITS.perRun }, (_, index) => fauxAssistantMessage(`answer ${index}`)),
      fauxAssistantMessage("done"),
    ]);
    const output = (await f.results(chat.conversationId))[0] ?? "";
    expect(output.match(/answered/g)).toHaveLength(HELPER_LIMITS.perRun);
    expect(output).toContain(`already started ${HELPER_LIMITS.perRun} helpers`);
    expect(await f.helpers(chat)).toHaveLength(HELPER_LIMITS.perRun);

    const looping = await f.chat("looping-chat");
    await f.send(looping, [
      code(DELEGATE),
      ...Array.from({ length: HELPER_LIMITS.turns }, () => code('return "again";')),
      fauxAssistantMessage("done"),
    ]);
    const [stopped] = await f.helpers(looping);
    expect(stopped).toMatchObject({ status: "unanswered", turns: HELPER_LIMITS.turns });
    expect(stopped?.reason).toContain(`${HELPER_LIMITS.turns} model requests`);
    const reported = (await f.results(looping.conversationId))[0] ?? "";
    expect(reported).toContain('"status":"unanswered"');
    expect(reported).toContain(`${HELPER_LIMITS.turns} model requests`);
  });

  it("does not spend uncounted summary requests for bounded helpers", async () => {
    const f = await fixture({ limits: { ...HELPER_LIMITS, turns: 1 } });
    const chat = await f.chat("helper-compaction-budget");
    await f.send(chat, [code(DELEGATE), fauxAssistantMessage("Found."), fauxAssistantMessage("done")]);
    const [helper] = await f.helpers(chat);
    const child = await f.pal.harness.conversation(helper?.conversation as ConversationId, context);
    const parent = await f.pal.harness.conversation(chat.conversationId, context);
    if (child === undefined || parent === undefined) throw new Error("missing fixture conversation");
    const pad = async (conversation: typeof child) => {
      await conversation.submit(
        {
          type: "write",
          entry: {
            kind: "pi.user",
            model: [{ role: "user", content: "older ".repeat(20_000), timestamp: Date.now() }],
          },
        },
        context,
      );
      await conversation.submit(
        { type: "write", entry: { kind: "pi.assistant", model: [fauxAssistantMessage("recent ".repeat(20_000))] } },
        context,
      );
    };
    await pad(child);
    f.faux.setResponses([fauxAssistantMessage("A summary is an extra paid request.")]);
    const task = await child.compact(undefined, context);
    await f.pal.harness.waitForIdle(context);
    const afterHelper = f.faux.state.callCount;
    // Ordinary chats keep native compaction; only bounded helpers decline it.
    await pad(parent);
    f.faux.setResponses([fauxAssistantMessage("The parent can still compact.")]);
    const ordinary = await parent.compact(undefined, context);
    await f.pal.harness.waitForIdle(context);
    expect(f.faux.state.callCount).toBe(afterHelper + 1);
    expect((await f.pal.harness.getTask(ordinary, context))?.state).toMatchObject({
      status: "terminal",
      outcome: { status: "completed", result: { submissionId: expect.any(Number) } },
    });
    expect(afterHelper).toBe(3);
    expect((await f.pal.harness.getTask(task, context))?.state).toMatchObject({
      status: "terminal",
      outcome: { status: "completed", result: {} },
    });
  });

  it("lets the final permitted request use its tools without making another helper request", async () => {
    const f = await fixture({ limits: { ...HELPER_LIMITS, turns: 1 } });
    const chat = await f.chat("last-helper-turn");
    await f.send(chat, [
      code(DELEGATE),
      code('return await tools.files_read({path:"notes.txt"});'),
      fauxAssistantMessage("done"),
    ]);
    const [helper] = await f.helpers(chat);
    expect(helper).toMatchObject({ status: "unanswered", turns: 1, calls: 2 });
    expect((await f.results(helper?.conversation as ConversationId)).join("\n")).toContain("HELPER-FACT");
    expect(f.faux.state.callCount).toBe(3);
  });

  it("cancels a blocked helper at its persisted wall-clock deadline", async () => {
    const f = await fixture({ limits: { ...HELPER_LIMITS, minutes: 0.05 } });
    const mcp = await startMcpFixture();
    cleanups.push(mcp.close);
    const server = await f.pal.mcp.add({ name: "Web", url: mcp.url, auth: { kind: "none" }, private: true });
    await f.pal.mcp.test(server.id);
    await f.pal.mcp.approve(server.id, ["search"], (await f.pal.mcp.get(server.id)).catalog);
    await f.pal.mcp.setEnabled(server.id, true);
    const held = Promise.withResolvers<undefined>(),
      release = Promise.withResolvers<undefined>();
    mcp.state.beforeCall = async () => {
      held.resolve(undefined);
      await release.promise;
    };
    cleanups.push(async () => release.resolve(undefined));
    const chat = await f.chat("helper-deadline");
    await f.send(
      chat,
      [
        code(DELEGATE),
        code(`return await tools.mcp__${server.id}__search({query:"x"});`),
        fauxAssistantMessage("done"),
      ],
      false,
    );
    await held.promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        f.pal.harness.waitForIdle(context).then(() => "ended"),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still-running"), 5000);
        }),
      ]);
      const [helper] = await f.helpers(chat);
      expect(outcome, JSON.stringify({ helper, modelCalls: f.faux.state.callCount })).toBe("ended");
      expect(helper).toMatchObject({ status: "unanswered", unknownEffects: [{ tool: `mcp__${server.id}__search` }] });
      expect(helper?.reason).toContain("0.05-minute limit");
    } finally {
      clearTimeout(timer);
    }
  });

  it("stops helpers at their own token and tool-call budgets and at the run's shared token budget", async () => {
    const limits = { ...HELPER_LIMITS };
    const f = await fixture({ limits });
    const answer = [code('return "looked";'), fauxAssistantMessage("found")];
    // Identical helpers spend identical tokens with this model; measure one.
    const measured = await f.chat("measured-chat");
    await f.send(measured, [code(DELEGATE), ...answer, fauxAssistantMessage("done")]);
    const each = (await f.helpers(measured))[0]?.tokens ?? 0;
    expect(each).toBeGreaterThan(0);

    limits.tokens = 1;
    const greedy = await f.chat("greedy-chat");
    await f.send(greedy, [code(DELEGATE), ...answer, fauxAssistantMessage("done")]);
    expect((await f.helpers(greedy))[0]).toMatchObject({ status: "unanswered", turns: 1 });
    expect((await f.helpers(greedy))[0]?.reason).toContain("its 1 tokens");

    // Two helpers stay under their own limits but use up the run's; the third never makes a request.
    limits.tokens = HELPER_LIMITS.tokens;
    limits.runTokens = 2 * each;
    const shared = await f.chat("shared-chat");
    await f.send(shared, [
      code(
        'const out = []; for (const p of ["a","b","c"]) out.push((await tools.agents_delegate({purpose:"Find the fact", task:"Read notes.txt; report line one."})).status); return out;',
      ),
      ...answer,
      ...answer,
      fauxAssistantMessage("done"),
    ]);
    const views = await f.helpers(shared);
    expect(views.map((view) => [view.status, view.turns])).toEqual([
      ["answered", 2],
      ["answered", 2],
      ["unanswered", 0],
    ]);
    expect(views[2]?.reason).toContain(`${2 * each} tokens`);

    limits.runTokens = HELPER_LIMITS.runTokens;
    limits.calls = 5;
    const busy = await f.chat("busy-chat");
    await f.send(busy, [
      code(DELEGATE),
      code("let n = 0; for (let i = 0; i < 10; i++) { try { await tools.files_list({}); n++; } catch {} } return n;"),
      fauxAssistantMessage("done"),
    ]);
    const [calls] = await f.helpers(busy);
    expect(calls).toMatchObject({ status: "unanswered", calls: 5 });
    expect(calls?.reason).toContain("5 tool calls");
  });

  it("retains project slots while restored delegate invocations have not resumed", async () => {
    const f = await fixture();
    let calls = 0;
    const finish = Promise.withResolvers<undefined>();
    const hold: FauxResponseStep = async (_request, options) => {
      calls++;
      await new Promise<void>((resolve) => {
        const stop = () => resolve();
        if (options?.signal?.aborted) stop();
        else options?.signal?.addEventListener("abort", stop, { once: true });
        void finish.promise.then(stop).finally(() => options?.signal?.removeEventListener("abort", stop));
      });
      return fauxAssistantMessage("Interrupted.");
    };
    cleanups.push(async () => finish.resolve(undefined));
    const parent = await f.chat("two-helpers-before-restart");
    const release = Promise.withResolvers<undefined>();
    const seen = new Set<number>();
    const chatFor = HelperLinks.prototype.chat;
    const native = Object.getPrototypeOf(f.pal.harness) as Harness;
    const snapshot = native.snapshot;
    try {
      await f.send(
        parent,
        [
          code('return await Promise.all(["a","b"].map(purpose => tools.agents_delegate({purpose,task:"Answer"})));'),
          hold,
          hold,
        ],
        false,
      );
      await expect.poll(() => calls, { timeout: 3000 }).toBe(2);
      const old = await f.helpers(parent);
      expect(old).toHaveLength(2);
      const children = new Set(old.map((helper) => helper.conversation));
      await f.reopen(() => {
        vi.spyOn(HelperLinks.prototype, "chat").mockImplementation(async function (this: HelperLinks, conversation) {
          if (conversation === parent.conversationId) await release.promise;
          return chatFor.call(this, conversation);
        });
        vi.spyOn(native, "snapshot").mockImplementation(async function (this: Harness, ...args) {
          const [token, scope] = args;
          if (token.definition.kind === "pal.helper" && typeof scope === "number" && children.has(scope)) {
            seen.add(scope);
            await release.promise;
          }
          return Reflect.apply(snapshot, this, args);
        });
      });
      await expect.poll(() => seen.size, { timeout: 3000 }).toBe(2);
      const third = await f.chat("third-helper-during-recovery");
      await f.send(third, [code(DELEGATE), fauxAssistantMessage("No slot yet.")], false);
      await (await f.pal.harness.conversation(third.conversationId, context))?.waitForIdle(context);
      expect(await f.helpers(third)).toEqual([]);
      expect((await f.results(third.conversationId)).join("\n")).toContain("helpers are already running");
    } finally {
      f.faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("Recovered.")));
      release.resolve(undefined);
      finish.resolve(undefined);
      await f.pal.harness.waitForIdle(context);
    }
  });

  it("reports a cancelled helper's in-flight internet call as an unknown outcome", async () => {
    const f = await fixture();
    const mcp = await startMcpFixture();
    cleanups.push(mcp.close);
    const server = await f.pal.mcp.add({ name: "Web", url: mcp.url, auth: { kind: "none" }, private: true });
    await f.pal.mcp.test(server.id);
    await f.pal.mcp.approve(server.id, ["search"], (await f.pal.mcp.get(server.id)).catalog);
    await f.pal.mcp.setEnabled(server.id, true);
    const held = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    mcp.state.beforeCall = async () => {
      held.resolve(undefined);
      await release.promise;
    };
    cleanups.push(async () => release.resolve(undefined));
    const chat = await f.chat("cancel-chat");
    await f.send(chat, [code(DELEGATE), code(`return await tools.mcp__${server.id}__search({query:"x"});`)], false);
    await held.promise;
    await (await f.pal.harness.conversation(chat.conversationId, context))?.abort(context);
    const [helper] = await f.helpers(chat);
    expect(helper).toMatchObject({ status: "stopped", unknownEffects: [{ tool: `mcp__${server.id}__search` }] });
  });

  it.each(["requests", "aggregate tokens"])(
    "keeps parent fan-out and spent %s limits across restart",
    async (budget) => {
      const limits = { ...HELPER_LIMITS, perRun: 1 };
      const f = await fixture({ limits });
      const mcp = await startMcpFixture();
      cleanups.push(mcp.close);
      const server = await f.pal.mcp.add({ name: "Web", url: mcp.url, auth: { kind: "none" }, private: true });
      await f.pal.mcp.test(server.id);
      await f.pal.mcp.approve(server.id, ["search"], (await f.pal.mcp.get(server.id)).catalog);
      await f.pal.mcp.setEnabled(server.id, true);
      const held = Promise.withResolvers<undefined>(),
        release = Promise.withResolvers<undefined>();
      mcp.state.beforeCall = async () => {
        held.resolve(undefined);
        await release.promise;
      };
      cleanups.push(async () => release.resolve(undefined));
      const chat = await f.chat("helper-restart-budgets");
      const parent =
        'const out = []; for (const purpose of ["first","second"]) { try { out.push(await tools.agents_delegate({purpose,task:"Search"})); } catch(error) { out.push(String(error.message ?? error)); } } return out;';
      await f.send(chat, [code(parent), code(`return await tools.mcp__${server.id}__search({query:"x"});`)], false);
      await held.promise;
      if (budget === "requests") limits.turns = 1;
      else limits.runTokens = 1;
      mcp.state.beforeCall = undefined;
      f.faux.setResponses([fauxAssistantMessage("done")]);
      await f.reopen();
      f.faux.setResponses([fauxAssistantMessage("done")]);
      await f.pal.harness.waitForIdle(context);
      const helpers = await f.helpers(chat);
      expect(helpers).toHaveLength(1);
      expect(helpers[0]).toMatchObject({ status: "unanswered", turns: 1 });
      expect(helpers[0]?.reason).toContain(
        budget === "requests" ? "its 1 model requests" : "this run's helpers used their 1 tokens",
      );
      expect(helpers[0]?.tokens).toBeGreaterThan(0);
      expect((await f.results(chat.conversationId)).join("\n")).toContain("already started 1 helpers");
      expect(f.faux.state.callCount).toBe(3);
    },
  );

  it("completes a helper interrupted by a restart once, under one result, with its counters kept", async () => {
    const f = await fixture();
    const mcp = await startMcpFixture();
    cleanups.push(mcp.close);
    const server = await f.pal.mcp.add({ name: "Web", url: mcp.url, auth: { kind: "none" }, private: true });
    await f.pal.mcp.test(server.id);
    await f.pal.mcp.approve(server.id, ["search"], (await f.pal.mcp.get(server.id)).catalog);
    await f.pal.mcp.setEnabled(server.id, true);
    const held = Promise.withResolvers<undefined>();
    mcp.state.beforeCall = async () => {
      held.resolve(undefined);
      await new Promise(() => {});
    };
    const chat = await f.chat("restart-chat");
    await f.send(chat, [code(DELEGATE), code(`return await tools.mcp__${server.id}__search({query:"x"});`)], false);
    await held.promise;
    mcp.state.beforeCall = undefined;
    f.faux.setResponses([fauxAssistantMessage("Found after restart."), fauxAssistantMessage("done")]);
    await f.reopen();
    f.faux.setResponses([fauxAssistantMessage("Found after restart."), fauxAssistantMessage("done")]);
    await f.pal.harness.waitForIdle(context);
    const helpers = await f.helpers(chat);
    expect(helpers).toHaveLength(1);
    expect(helpers[0]).toMatchObject({
      status: "answered",
      turns: 2,
      unknownEffects: [{ tool: `mcp__${server.id}__search` }],
    });
    const handle = await f.pal.harness.conversation(chat.conversationId, context);
    const entries = (await handle?.entries({}, 200, undefined, context))?.items ?? [];
    const results = entries.flatMap((entry) => {
      const result =
        entry.kind === "pal.helper" ? (entry.data as { result?: { task: number; id: string } }).result : undefined;
      return result === undefined ? [] : [result];
    });
    expect(results).toEqual([expect.objectContaining({ task: helpers[0]?.task, id: `helper-${helpers[0]?.task}` })]);
    expect((await f.results(chat.conversationId)).join("\n")).toContain("Found after restart.");
  });
});
