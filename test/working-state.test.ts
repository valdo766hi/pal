import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getSystemMessageText,
  type Message,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const goal = {
  revision: 0,
  text: "owner-critical-goal",
  constraints: ["owner-critical-constraint"],
  acceptance: ["owner-critical-check"],
};
const checkpoint = {
  revision: 0,
  goalRevision: 1,
  summary: "agent-unverified-marker",
  plan: ["Inspect the code", "Apply a small patch"],
  next: "Run meaningful checks",
  questions: [],
};
const code = (body: string) =>
  fauxAssistantMessage(fauxToolCall("codemode", { code: body }), { stopReason: "toolUse" });
const save = (value: unknown = checkpoint) => code(`return await tools.working_checkpoint(${JSON.stringify(value)});`);

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-working-state-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const options = {
    dataRoot: join(root, "data"),
    installRoot: join(root, "install"),
    guidanceHome: join(root, "home"),
  };
  let pal = await openPal(options, context);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("working-project", { name: "Working state fixture" });
  const chat = await pal.chats.createChat("working-chat", { projectId: project.id }, context);
  const faux = fauxProvider();
  const requests: (readonly Message[])[] = [];
  let sequence = 0;
  const conversation = async () => {
    const value = await pal.harness.conversation(chat.conversationId, context);
    if (value === undefined) throw new Error("missing working-state conversation");
    return value;
  };
  const run = async (responses: AssistantMessage[], text = "continue the fixture") => {
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const model = faux.getModel();
    const convo = await conversation();
    await convo.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    faux.setResponses(
      responses.map((response) => (request) => {
        requests.push(request.messages);
        return response;
      }),
    );
    await pal.chats.submit(chat.id, `working-input-${++sequence}`, { text }, context);
    await convo.waitForIdle(context);
    return convo.context(context);
  };
  return {
    project,
    chat,
    faux,
    requests,
    conversation,
    run,
    get pal() {
      return pal;
    },
    reopen: async () => {
      await pal.close();
      pal = await openPal(options, context);
    },
  };
}

it("retains a scoped owner goal and idempotent unverified checkpoint across reopen", async () => {
  const f = await fixture();
  await f.pal.working.setGoal(f.chat, goal, context);
  expect(f.faux.state.callCount).toBe(0);
  await f.run([save(), fauxAssistantMessage("saved")]);
  const first = await f.pal.working.inspect(f.chat, context);
  expect(first.checkpoint).toMatchObject({ ...checkpoint, revision: 1 });
  expect(first.notice).toContain("may be stale");
  await f.run([save(), fauxAssistantMessage("same checkpoint")]);
  expect(await f.pal.working.inspect(f.chat, context)).toEqual(first);
  first.goal.constraints.push("must not mutate storage");
  expect((await f.pal.working.inspect(f.chat, context)).goal.constraints).toEqual(goal.constraints);
  const other = await f.pal.chats.createChat("other-working-chat", { projectId: f.project.id }, context);
  expect((await f.pal.working.inspect(other, context)).goal.revision).toBe(0);
  await f.reopen();
  const current = await f.pal.working.inspect(f.chat, context);
  expect(current.goal).toEqual({ ...goal, revision: 1 });
  expect(current.checkpoint?.revision).toBe(1);
  expect(current.checkpoint?.at).toBe(first.checkpoint?.at);
  await f.run([save({ ...checkpoint, summary: "stale checkpoint overwrite" }), fauxAssistantMessage("conflict")]);
  expect(await f.pal.working.inspect(f.chat, context)).toEqual(current);
  await f.run([save({ ...checkpoint, revision: 1, next: "Review the tested diff" }), fauxAssistantMessage("updated")]);
  expect((await f.pal.working.inspect(f.chat, context)).checkpoint).toMatchObject({
    revision: 2,
    goalRevision: 1,
    next: "Review the tested diff",
  });
});

it("invalidates notes on owner correction/clear and refuses checkpoints for an obsolete goal", async () => {
  const f = await fixture();
  await f.pal.working.setGoal(f.chat, goal, context);
  await f.run([save(), fauxAssistantMessage("saved")]);
  await f.pal.working.setGoal(f.chat, { ...goal, revision: 1, text: "corrected-owner-goal" }, context);
  expect((await f.pal.working.inspect(f.chat, context)).checkpoint).toBeNull();
  await f.run([save(), fauxAssistantMessage("stale checkpoint refused")]);
  expect(await f.pal.working.inspect(f.chat, context)).toMatchObject({
    goal: { revision: 2, text: "corrected-owner-goal" },
    checkpoint: null,
  });
  await f.pal.working.setGoal(f.chat, { revision: 2, text: "", constraints: [], acceptance: [] }, context);
  await f.run([code("return await tools.working_read();"), fauxAssistantMessage("cleared")]);
  expect((await f.pal.working.inspect(f.chat, context)).checkpoint).toBeNull();
  const messages = f.requests.at(-1) ?? [];
  const system = getCurrentSystemPrompt(messages);
  expect(system).not.toContain("owner-critical-goal");
  expect(system).not.toContain("corrected-owner-goal");
  const patch = messages
    .filter((message) => message.role === "system" && "working-state" in (message.sections ?? {}))
    .at(-1);
  expect(patch?.role === "system" && patch.sections?.["working-state"]).toBeNull();
  const inspected = await f.pal.context.prompt(f.chat, { offset: 0 }, context);
  expect(inspected.sections.some((section) => section.name === "working-state")).toBe(false);
});

it("preserves owner constraints through a real native summary/reopen without promoting agent notes to system context", async () => {
  const f = await fixture();
  await f.pal.working.setGoal(f.chat, goal, context);
  await f.run([save(), fauxAssistantMessage("checkpoint stored")]);
  const convo = await f.conversation();
  for (let i = 0; i < 50; i++)
    await convo.submit(
      {
        type: "write",
        entry: {
          kind: "pi.assistant",
          model: [fauxAssistantMessage(`Old reference ${i}: ${"reference context ".repeat(250)}`)],
        },
      },
      context,
    );
  const before = (await convo.context(context)).messages.length;
  f.faux.setResponses([fauxAssistantMessage("Summary deliberately omits the goal and checkpoint.")]);
  const receipt = await f.pal.harness.waitForTask(await convo.compact(undefined, context), context);
  if (receipt.state.outcome.status !== "completed" || receipt.state.outcome.result.submissionId === undefined)
    throw new Error("the fixture did not produce a native summary");
  const submission = await f.pal.harness.submission(receipt.state.outcome.result.submissionId, context);
  if (submission === undefined) throw new Error("missing summary placement");
  expect((await submission.wait(context)).status).toBe("done");
  expect((await convo.context(context)).messages.length).toBeLessThan(before);
  await f.reopen();
  await f.run([fauxAssistantMessage("continued after restart")]);
  const system = (f.requests.at(-1) ?? [])
    .flatMap((message) => (message.role === "system" ? [getSystemMessageText(message)] : []))
    .join("\n");
  for (const text of [goal.text, ...goal.constraints, ...goal.acceptance]) expect(system).toContain(text);
  expect(system).not.toContain(checkpoint.summary);
  const inspected = await f.pal.context.prompt(f.chat, { offset: 0 }, context);
  expect(inspected.sections.find((section) => section.name === "working-state")?.text).toContain(goal.text);
  expect(JSON.stringify(inspected.sections)).not.toContain(checkpoint.summary);
  const read = await f.run([code("return await tools.working_read();"), fauxAssistantMessage("checkpoint recovered")]);
  expect(JSON.stringify(read.messages.filter((message) => message.role === "toolResult"))).toContain(
    checkpoint.summary,
  );
  expect((await f.pal.working.inspect(f.chat, context)).checkpoint?.summary).toBe(checkpoint.summary);
});

it("requires an owner goal, rejects forged authority/oversized notes and never lets a checkpoint rewrite the goal", async () => {
  const f = await fixture();
  await f.run([save(), fauxAssistantMessage("no goal")]);
  expect((await f.pal.working.inspect(f.chat, context)).checkpoint).toBeNull();
  await f.pal.working.setGoal(f.chat, goal, context);
  await f.run([save({ ...checkpoint, goal: "forged-owner-goal" }), fauxAssistantMessage("forgery refused")]);
  await f.run([save({ ...checkpoint, plan: Array(8).fill("界".repeat(200)) }), fauxAssistantMessage("budget refused")]);
  expect(await f.pal.working.inspect(f.chat, context)).toMatchObject({
    goal: { ...goal, revision: 1 },
    checkpoint: null,
  });
  await expect(f.pal.working.setGoal(f.chat, { ...goal, revision: 1, text: "" }, context)).rejects.toMatchObject({
    code: "working_goal",
  });
});

it("does not expose retained working state after a chat is removed", async () => {
  const f = await fixture();
  await f.pal.working.setGoal(f.chat, goal, context);
  await f.pal.chats.remove(f.chat.id, context);
  await expect(f.pal.working.inspect(f.chat, context)).rejects.toMatchObject({ status: 404 });
});

it("freezes the complete owner update before waiting for its durable commit", async () => {
  const f = await fixture();
  const reached = Promise.withResolvers<undefined>(),
    release = Promise.withResolvers<undefined>();
  const commit = f.pal.harness.commit.bind(f.pal.harness);
  vi.spyOn(f.pal.harness, "commit").mockImplementationOnce(async (...args) => {
    reached.resolve(undefined);
    await release.promise;
    return commit(...args);
  });
  const body = { ...goal, constraints: [...goal.constraints], acceptance: [...goal.acceptance] };
  const pending = f.pal.working.setGoal(f.chat, body, context);
  await reached.promise;
  body.revision = 99;
  body.text = "concurrent caller mutation";
  body.constraints.push("not part of admitted goal");
  release.resolve(undefined);
  expect((await pending).goal).toEqual({ ...goal, revision: 1 });
});
