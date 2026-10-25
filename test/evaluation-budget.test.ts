import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { openPal } from "../src/core/app.ts";
import { evaluationBudgetExceeded, setEvaluationBudget } from "../src/pi/evaluation-budget.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.each([1, 2])("counts native summary requests within the shared %i-turn evaluation budget", async (turns) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-evaluation-summary-budget-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pal = await openPal(
    { dataRoot: join(root, "data"), installRoot: join(root, "install"), guidanceHome: join(root, "guidance") },
    context,
  );
  cleanups.push(() => pal.close());
  const faux = fauxProvider();
  (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  const model = faux.getModel();
  const project = await pal.projects.create("summary-budget-project", { name: "Summary budget" });
  const chat = await pal.chats.createChat("summary-budget-chat", { projectId: project.id }, context);
  const conversation = await pal.harness.conversation(chat.conversationId, context);
  if (conversation === undefined) throw new Error("missing fixture conversation");
  await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
  await setEvaluationBudget(pal.harness, chat.conversationId, turns, Date.now() + 60_000, context);
  faux.setResponses([fauxAssistantMessage("initial checkpoint")]);
  await pal.chats.submit(chat.id, "summary-budget-input", { text: "begin" }, context);
  await conversation.waitForIdle(context);
  expect(faux.state.callCount).toBe(1);
  for (let i = 0; i < 2; i++) {
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
    faux.setResponses([fauxAssistantMessage("A native summary consumes a model request.")]);
    await conversation.compact(undefined, context);
    await pal.harness.waitForIdle(context);
    expect(faux.state.callCount).toBe(Math.min(i + 2, turns));
  }
  expect(await evaluationBudgetExceeded(pal.harness, chat.conversationId, context)).toBe(true);
});
