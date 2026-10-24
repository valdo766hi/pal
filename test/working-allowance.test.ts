import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { defineDoc } from "@earendil-works/pi-durable";
import { openPal } from "../src/core/app.ts";
import { helperViews } from "../src/core/delegation.ts";
import { migrate, MIGRATIONS } from "../src/storage/migrations.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const call = (code: string) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
const policy = { revision: 0, goalRevision: 1, limits: { steps: 1, calls: 16 } };

async function fixture(helpers = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-working-allowance-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const options = {
    dataRoot: join(root, "data"),
    installRoot: join(root, "install"),
    guidanceHome: join(root, "home"),
  };
  let pal = await openPal(options, context);
  cleanups.push(() => pal.close());
  if (helpers) {
    const view = await pal.extensions.view();
    await pal.extensions.select({ selected: [...view.selected, { id: "helpers", version: 1 }], digest: view.digest });
  }
  const project = await pal.projects.create("allowance-project", { name: "Execution allowance" });
  const chat = await pal.chats.createChat("allowance-chat", { projectId: project.id }, context);
  await pal.working.setGoal(
    chat,
    { revision: 0, text: "Finish the bounded fixture", constraints: [], acceptance: ["Inspect actual effects"] },
    context,
  );
  await pal.approvals.setMode(chat.id, "full");
  const faux = fauxProvider();
  let input = 0;
  const conversation = async () => {
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const model = faux.getModel();
    const handle = await pal.harness.conversation(chat.conversationId, context);
    if (handle === undefined) throw new Error("missing allowance conversation");
    await handle.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    return handle;
  };
  return {
    root,
    project,
    chat,
    faux,
    conversation,
    get pal() {
      return pal;
    },
    run: async (responses: ReturnType<typeof fauxAssistantMessage>[]) => {
      const handle = await conversation();
      faux.setResponses(responses);
      await pal.chats.submit(chat.id, `allowance-input-${++input}`, { text: "Continue the fixture" }, context);
      await handle.waitForIdle(context);
    },
    reopen: async () => {
      await pal.close();
      pal = await openPal(options, context);
    },
  };
}

it("prevents older stores' runtime from silently ignoring the new execution policy", async () => {
  const f = await fixture();
  await f.pal.working.configureAllowance(f.chat, policy, context);
  await expect(
    migrate(
      f.pal.store.database,
      MIGRATIONS.filter((migration) => migration.version <= 21),
    ),
  ).rejects.toThrow(/migration 22/);
  expect(await f.pal.store.database.get("SELECT max(version) AS version FROM pal_migrations")).toEqual({ version: 22 });
  expect(f.faux.state.callCount).toBe(0);
});

it("fails closed on an unreadable newer allowance instead of letting advisory request hooks continue", async () => {
  const f = await fixture();
  const future = defineDoc({
    kind: "pal.working-allowance",
    version: 2,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ future: true }),
  });
  await f.pal.harness.commit(async (tx) => {
    await tx.doc(future, f.chat.conversationId);
  }, context);
  await f.run([fauxAssistantMessage("must not run with an unreadable policy")]);
  expect(f.faux.state.callCount).toBe(0);
});

it("keeps ordinary goals unmetered until explicit owner configuration and saving never starts work", async () => {
  const f = await fixture();
  expect((await f.pal.working.inspect(f.chat, context)).allowance).toMatchObject({ state: "disabled", revision: 0 });
  await f.run([fauxAssistantMessage("ordinary answer")]);
  expect(f.faux.state.callCount).toBe(1);
  const before = await (await f.conversation()).entries({}, 100, undefined, context);
  const saved = await f.pal.working.configureAllowance(f.chat, policy, context);
  expect(saved.allowance).toMatchObject({
    state: "ready",
    revision: 1,
    goalRevision: 1,
    used: { steps: 0, calls: 0 },
    limits: policy.limits,
  });
  expect((await (await f.conversation()).entries({}, 100, undefined, context)).items).toEqual(before.items);
  expect(f.faux.state.callCount).toBe(1);
});

it("aborts before another native model step and preserves the allowance and effects across restart", async () => {
  const f = await fixture();
  await f.pal.working.configureAllowance(f.chat, policy, context);
  await f.run([
    call('return await tools.shell_run({command:"printf once > step-marker"});'),
    fauxAssistantMessage("must not request this answer"),
  ]);
  expect(f.faux.state.callCount).toBe(1);
  expect(await readFile(join(f.project.root, "step-marker"), "utf8")).toBe("once");
  const stopped = (await f.pal.working.inspect(f.chat, context)).allowance;
  expect(stopped).toMatchObject({ state: "blocked", used: { steps: 1, calls: 2 }, blocked: { reason: "steps" } });
  await f.reopen();
  expect((await f.pal.working.inspect(f.chat, context)).allowance).toEqual(stopped);
  await f.pal.working.configureAllowance(f.chat, policy, context);
  await f.run([fauxAssistantMessage("still blocked")]);
  expect(f.faux.state.callCount).toBe(1);
  expect(await readFile(join(f.project.root, "step-marker"), "utf8")).toBe("once");
  expect((await f.pal.working.inspect(f.chat, context)).goal.text).toBe("Finish the bounded fixture");
});

it("counts nested calls before effects and renews only through an explicit owner revision", async () => {
  const f = await fixture();
  const limits = { steps: 4, calls: 2 };
  await f.pal.working.configureAllowance(f.chat, { ...policy, limits }, context);
  await f.run([
    call(
      'await tools.shell_run({command:"printf first > first-marker"}); return await tools.shell_run({command:"printf unsafe > denied-marker"});',
    ),
    fauxAssistantMessage("must not buy another step after exhaustion"),
  ]);
  expect(f.faux.state.callCount).toBe(1);
  expect(await readFile(join(f.project.root, "first-marker"), "utf8")).toBe("first");
  expect(await readFile(join(f.project.root, "denied-marker"), "utf8").catch(() => undefined)).toBeUndefined();
  expect((await f.pal.working.inspect(f.chat, context)).allowance).toMatchObject({
    state: "blocked",
    used: { steps: 1, calls: 2 },
    blocked: { reason: "calls" },
  });
  await f.reopen();
  await f.pal.working.configureAllowance(f.chat, { ...policy, limits }, context);
  expect((await f.pal.working.inspect(f.chat, context)).allowance.used.calls).toBe(2);
  await expect(
    f.pal.working.configureAllowance(f.chat, { ...policy, limits: { steps: 4, calls: 3 } }, context),
  ).rejects.toMatchObject({ status: 409 });
  const renewed = await f.pal.working.configureAllowance(
    f.chat,
    { ...policy, revision: 1, limits: { steps: 4, calls: 16 } },
    context,
  );
  expect(renewed.allowance).toMatchObject({ revision: 2, state: "ready", used: { steps: 0, calls: 0 }, blocked: null });
  expect(f.faux.state.callCount).toBe(1);
  await f.run([
    call('return await tools.shell_run({command:"printf resumed > resumed-marker"});'),
    fauxAssistantMessage("resumed after a new owner input"),
  ]);
  expect(await readFile(join(f.project.root, "resumed-marker"), "utf8")).toBe("resumed");
});

it("never silently drops an enabled allowance on goal correction and permits explicit disabling", async () => {
  const f = await fixture();
  await f.pal.working.configureAllowance(f.chat, policy, context);
  await f.pal.working.setGoal(
    f.chat,
    { revision: 1, text: "Corrected goal", constraints: [], acceptance: [] },
    context,
  );
  expect((await f.pal.working.inspect(f.chat, context)).allowance.state).toBe("goal-changed");
  await f.run([fauxAssistantMessage("must not dispatch after goal correction")]);
  expect(f.faux.state.callCount).toBe(0);
  await expect(f.pal.working.configureAllowance(f.chat, { ...policy, revision: 1 }, context)).rejects.toMatchObject({
    status: 409,
  });
  await f.pal.working.configureAllowance(f.chat, { revision: 1, goalRevision: 2, limits: null }, context);
  expect((await f.pal.working.inspect(f.chat, context)).allowance.state).toBe("disabled");
  expect(f.faux.state.callCount).toBe(0);
  await f.run([fauxAssistantMessage("ordinary work after explicit disabling")]);
  expect(f.faux.state.callCount).toBe(1);
});

it.each([1, 2])("includes native compaction in the shared %i-step allowance", async (steps) => {
  const f = await fixture();
  await f.pal.working.configureAllowance(f.chat, { ...policy, limits: { steps, calls: 16 } }, context);
  await f.run([fauxAssistantMessage("initial checkpoint")]);
  const handle = await f.conversation();
  for (let i = 0; i < 2; i++) {
    await handle.submit(
      {
        type: "write",
        entry: { kind: "pi.user", model: [{ role: "user", content: "older ".repeat(20_000), timestamp: Date.now() }] },
      },
      context,
    );
    await handle.submit(
      { type: "write", entry: { kind: "pi.assistant", model: [fauxAssistantMessage("recent ".repeat(20_000))] } },
      context,
    );
    f.faux.setResponses([fauxAssistantMessage("native summary")]);
    await handle.compact(undefined, context);
    await f.pal.harness.waitForIdle(context);
    expect(f.faux.state.callCount).toBe(Math.min(i + 2, steps));
  }
  expect((await f.pal.working.inspect(f.chat, context)).allowance).toMatchObject({
    state: "blocked",
    used: { steps },
    blocked: { reason: "steps" },
  });
});

it("charges a helper's native model step to the parent allowance instead of bypassing it", async () => {
  const f = await fixture(true);
  await f.pal.working.configureAllowance(f.chat, policy, context);
  await f.run([
    call('return await tools.agents_delegate({purpose:"Check shared allowance",task:"Answer one harmless question"});'),
    fauxAssistantMessage("neither child nor parent may buy another step"),
  ]);
  expect(f.faux.state.callCount).toBe(1);
  expect(await helperViews(f.pal.harness, f.pal.store.storage, f.chat.conversationId, context)).toMatchObject([
    { status: "unanswered" },
  ]);
  expect((await f.pal.working.inspect(f.chat, context)).allowance).toMatchObject({
    state: "blocked",
    used: { steps: 1 },
    blocked: { reason: "steps" },
  });
});
