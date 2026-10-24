import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { openPal } from "../src/core/app.ts";
import { baselineHarness, externalHarness, palHarness } from "../src/evaluation/harnesses.ts";
import { evaluationBudgetExceeded, setEvaluationBudget } from "../src/pi/evaluation-budget.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-evaluation-harness-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function baseline() {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const choice = { provider: model.provider, modelId: model.id, effort: "off" } as const;
  return { faux, harness: baselineHarness(() => models, model, choice) };
}

const done = fauxAssistantMessage("done");

describe("evaluation harness controls", () => {
  it("lets the baseline inspect the workspace root", async () => {
    const root = await workspace();
    await writeFile(join(root, "known.txt"), "fixture");
    const { faux, harness } = baseline();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("list_files", { path: "." }), { stopReason: "toolUse" }),
      done,
    ]);
    const outcome = await harness.run({
      workspace: root,
      prompt: "List files",
      runId: "root",
      budget: { seconds: 5, turns: 2 },
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.failedToolCalls).toBe(0);
    expect(outcome.trace).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "toolResult", isError: false, content: [{ type: "text", text: "known.txt" }] }),
      ]),
    });
  });

  it("counts a nonzero baseline command as a tool failure", async () => {
    const root = await workspace();
    const { faux, harness } = baseline();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("run", { command: "exit 7" }), { stopReason: "toolUse" }),
      done,
    ]);
    const outcome = await harness.run({
      workspace: root,
      prompt: "Run command",
      runId: "exit",
      budget: { seconds: 5, turns: 2 },
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.failedToolCalls).toBe(1);
  });

  it("stops a baseline command at the run deadline, not its longer tool deadline", async () => {
    const root = await workspace();
    const { faux, harness } = baseline();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("run", { command: "sleep 2; printf late > late.txt" }), {
        stopReason: "toolUse",
      }),
      done,
    ]);
    const outcome = await harness.run({
      workspace: root,
      prompt: "Run command",
      runId: "deadline",
      budget: { seconds: 1, turns: 2 },
    });
    expect(outcome.status).toBe("budget_exceeded");
    await expect(lstat(join(root, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an external command's nonzero exit as a harness error", async () => {
    const root = await workspace();
    const outcome = await externalHarness("failure", "exit 7").run({
      workspace: root,
      prompt: "fixture",
      runId: "exit",
      budget: { seconds: 5, turns: 1 },
    });
    expect(outcome.status).toBe("harness_error");
  });

  it("does not mistake an external command's own SIGKILL for a budget timeout", async () => {
    const root = await workspace();
    const outcome = await externalHarness("signal", "kill -KILL $$").run({
      workspace: root,
      prompt: "fixture",
      runId: "signal",
      budget: { seconds: 5, turns: 1 },
    });
    expect(outcome.status).toBe("harness_error");
  });

  it("reaps an external command's background group when its leader exits", async () => {
    const root = await workspace();
    const outcome = await externalHarness(
      "background",
      "(sleep 1; printf orphan > orphan.txt) >/dev/null 2>&1 & exit 0",
    ).run({
      workspace: root,
      prompt: "fixture",
      runId: "background",
      budget: { seconds: 5, turns: 1 },
    });
    expect(outcome.status).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(lstat(join(root, "orphan.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives repeated run labels fresh projects and conversations", async () => {
    const root = await workspace();
    const first = join(root, "first"),
      second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    const pal = await openPal(
      { dataRoot: join(root, "data"), installRoot: join(root, "install"), guidanceHome: join(root, "guidance") },
      context,
    );
    cleanups.push(() => pal.close());
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses([done, done]);
    const harness = palHarness(pal, { provider: model.provider, modelId: model.id, effort: "off" });
    for (const folder of [first, second])
      expect(
        (
          await harness.run({
            workspace: folder,
            prompt: "fixture",
            runId: "repeated",
            budget: { seconds: 10, turns: 2 },
          })
        ).status,
      ).toBe("completed");
    expect(faux.state.callCount).toBe(2);
  });

  it("cannot reset a spent budget by reassigning it or reopening the store", async () => {
    const root = await workspace();
    const folder = join(root, "workspace");
    await mkdir(folder);
    const options = {
      dataRoot: join(root, "data"),
      installRoot: join(root, "install"),
      guidanceHome: join(root, "guidance"),
    };
    const pal = await openPal(options, context);
    cleanups.push(() => pal.close());
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses([done]);
    const project = await pal.projects.create("budget-project", { name: "fixture", folder });
    const chat = await pal.chats.createChat("budget-chat", { projectId: project.id, title: "fixture" }, context);
    await pal.chats.configure(
      chat.id,
      { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" },
      context,
    );
    const deadline = Date.now() + 60_000;
    await setEvaluationBudget(pal.harness, chat.conversationId, 1, deadline, context);
    await pal.chats.submit(chat.id, "first-budget-input", { text: "first" }, context);
    await (await pal.harness.conversation(chat.conversationId, context))?.waitForIdle(context);
    expect(faux.state.callCount).toBe(1);
    await setEvaluationBudget(pal.harness, chat.conversationId, 1, deadline, context);
    await expect(setEvaluationBudget(pal.harness, chat.conversationId, 2, deadline, context)).rejects.toThrow(
      "cannot be changed",
    );
    await pal.close();
    const reopened = await openPal(options, context);
    cleanups.push(() => reopened.close());
    const next = fauxProvider();
    (reopened.models as ReturnType<typeof createModels>).setProvider(next.provider);
    next.setResponses([done]);
    await reopened.chats.submit(chat.id, "second-budget-input", { text: "second" }, context);
    await (await reopened.harness.conversation(chat.conversationId, context))?.waitForIdle(context);
    expect(next.state.callCount).toBe(0);
    expect(await evaluationBudgetExceeded(reopened.harness, chat.conversationId, context)).toBe(true);
  });

  it("enforces Pal's model-turn budget before another turn can write files", async () => {
    const root = await workspace();
    const runRoot = join(root, "workspace");
    await mkdir(runRoot);
    const pal = await openPal(
      { dataRoot: join(root, "data"), installRoot: join(root, "install"), guidanceHome: join(root, "guidance") },
      context,
    );
    cleanups.push(() => pal.close());
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: "text('first turn');" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: 'await tools.files_write({path:"over-budget",content:"late",expectedHash:null});',
        }),
        { stopReason: "toolUse" },
      ),
      done,
    ]);
    const outcome = await palHarness(pal, { provider: model.provider, modelId: model.id, effort: "off" }).run({
      workspace: runRoot,
      prompt: "Use the first turn only",
      runId: "turn-budget",
      budget: { seconds: 10, turns: 1 },
    });
    expect(outcome.status).toBe("budget_exceeded");
    expect(faux.state.callCount).toBe(1);
    await expect(lstat(join(runRoot, "over-budget"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
