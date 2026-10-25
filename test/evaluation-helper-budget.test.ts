import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { openPal } from "../src/core/app.ts";
import { evaluationBudgetExceeded, setEvaluationBudget } from "../src/pi/evaluation-budget.ts";
import { palHarness } from "../src/evaluation/harnesses.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-evaluation-helper-budget-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pal = await openPal(
    { dataRoot: join(root, "data"), installRoot: join(root, "install"), guidanceHome: join(root, "guidance") },
    context,
  );
  cleanups.push(() => pal.close());
  const extensions = await pal.extensions.view();
  await pal.extensions.select({
    selected: [...extensions.selected, { id: "helpers", version: 1 }],
    digest: extensions.digest,
  });
  const faux = fauxProvider();
  (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  const model = faux.getModel();
  return { root, pal, faux, model };
}

it("counts helper model turns against the parent's evaluation allowance before another turn can write", async () => {
  const { pal, faux, model } = await fixture();
  const project = await pal.projects.create("evaluation-helper-project", { name: "Helper budget" });
  const chat = await pal.chats.createChat("evaluation-helper-chat", { projectId: project.id }, context);
  const conversation = await pal.harness.conversation(chat.conversationId, context);
  if (conversation === undefined) throw new Error("missing fixture conversation");
  await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
  await setEvaluationBudget(pal.harness, chat.conversationId, 2, Date.now() + 60_000, context);
  const code = (body: string) =>
    fauxAssistantMessage(fauxToolCall("codemode", { code: body }), { stopReason: "toolUse" });
  faux.setResponses([
    code('return await tools.agents_delegate({purpose:"One fact",task:"Answer FIXTURE-FACT."});'),
    fauxAssistantMessage("FIXTURE-FACT"),
    code('await tools.files_write({path:"over-budget.txt",content:"must-not-write",expectedHash:null});'),
    fauxAssistantMessage("done"),
  ]);
  await pal.chats.submit(chat.id, "evaluation-helper-input", { text: "Use the shared allowance" }, context);
  await pal.harness.waitForIdle(context);
  expect.soft(faux.state.callCount).toBe(2);
  await expect(readFile(join(project.root, "over-budget.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await evaluationBudgetExceeded(pal.harness, chat.conversationId, context)).toBe(true);
});

it("reports owned helper turns, usage, tool failures and evidence without counting an unrelated chat", async () => {
  const { root, pal, faux, model } = await fixture();
  const unrelated = await pal.projects.create("unrelated-project", { name: "Unrelated" });
  const chat = await pal.chats.createChat("unrelated-chat", { projectId: unrelated.id }, context);
  const conversation = await pal.harness.conversation(chat.conversationId, context);
  if (conversation === undefined) throw new Error("missing unrelated conversation");
  await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
  faux.setResponses([fauxAssistantMessage("Unrelated evidence must not enter the report.")]);
  await pal.chats.submit(chat.id, "unrelated-input", { text: "Outside the evaluation" }, context);
  await pal.harness.waitForIdle(context);
  const tokens = async () =>
    Object.values((await pal.harness.usage(context)).models).reduce((sum, usage) => sum + usage.totalTokens, 0);
  const before = await tokens();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const code = (body: string) =>
    fauxAssistantMessage(fauxToolCall("codemode", { code: body }), { stopReason: "toolUse" });
  faux.setResponses([
    code('return await tools.agents_delegate({purpose:"One fact",task:"Research the fact."});'),
    code('throw new Error("controlled helper tool failure");'),
    fauxAssistantMessage("Recovered child evidence."),
    fauxAssistantMessage("Completed parent."),
  ]);
  const outcome = await palHarness(pal, { provider: model.provider, modelId: model.id, effort: "off" }).run({
    workspace,
    prompt: "Use the helper and retain its evidence",
    runId: "owned-helper-metrics",
    budget: { seconds: 10, turns: 6 },
  });
  expect(outcome).toMatchObject({ status: "completed", turns: 4, toolCalls: 2, failedToolCalls: 1 });
  expect(outcome.usage?.totalTokens).toBe((await tokens()) - before);
  expect(JSON.stringify(outcome.trace)).toContain("Recovered child evidence.");
  expect(JSON.stringify(outcome.trace)).toContain("controlled helper tool failure");
  expect(JSON.stringify(outcome.trace)).not.toContain("Unrelated evidence must not enter the report.");
  expect(outcome.trace).toMatchObject({
    root: expect.any(Number),
    conversations: [
      { conversation: expect.any(Number) },
      { conversation: expect.any(Number), parent: expect.any(Number), task: expect.any(Number) },
    ],
  });
});
