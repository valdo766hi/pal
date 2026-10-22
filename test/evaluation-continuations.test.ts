import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { baselineHarness, externalHarness, palHarness } from "../src/evaluation/harnesses.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-evaluation-continuations-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return {
    root,
    input: {
      workspace,
      runId: "continued",
      prompt: "Retain the original half-up unit rounding rule.",
      continuations: [{ prompt: "Owner correction: also ignore cancelled lines.", owner: true }],
      budget: { seconds: 10, turns: 2 },
    },
  };
}

async function agent(kind: string) {
  const { root, input } = await fixture();
  const pal = await openPal(
    { dataRoot: join(root, "data"), installRoot: join(root, "install"), guidanceHome: join(root, "guidance") },
    context,
  );
  cleanups.push(() => pal.close());
  const faux = fauxProvider();
  (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  const model = faux.getModel();
  const choice = { provider: model.provider, modelId: model.id, effort: "off" } as const;
  const harness = kind === "pal" ? palHarness(pal, choice) : baselineHarness(pal.models, model, choice);
  return { input, faux, harness, pal };
}

it("includes Pal project/chat preparation in the original run deadline", async () => {
  const { input, faux, harness, pal } = await agent("pal");
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const create = pal.projects.create.bind(pal.projects);
  vi.spyOn(pal.projects, "create").mockImplementationOnce(async (...args) => {
    const project = await create(...args);
    now += 2000;
    return project;
  });
  faux.setResponses([fauxAssistantMessage("must not run"), fauxAssistantMessage("must not run either")]);
  expect(await harness.run({ ...input, budget: { seconds: 1, turns: 10 } })).toMatchObject({
    status: "budget_exceeded",
  });
  expect(faux.state.callCount).toBe(0);
});

it.each(["pal", "baseline"])("%s retains earlier context across a scheduled owner correction", async (kind) => {
  const { input, faux, harness } = await agent(kind);
  const requests: string[] = [];
  faux.setResponses([
    (request) => {
      requests.push(JSON.stringify(request.messages));
      return fauxAssistantMessage("first checkpoint");
    },
    (request) => {
      requests.push(JSON.stringify(request.messages));
      return fauxAssistantMessage("continued");
    },
  ]);
  const outcome = await harness.run(input);
  expect(outcome).toMatchObject({ status: "completed", turns: 2, interventions: 1 });
  expect(faux.state.callCount).toBe(2);
  expect(requests[0]).not.toContain(input.continuations[0]?.prompt);
  expect(requests[1]).toContain(input.prompt);
  expect(requests[1]).toContain(input.continuations[0]?.prompt);
  expect(JSON.stringify(outcome.trace)).toContain(input.prompt);
  expect(JSON.stringify(outcome.trace)).toContain(input.continuations[0]?.prompt);
});

it.each(["pal", "baseline"])("%s cannot reset its spent request budget at a continuation", async (kind) => {
  const { input, faux, harness } = await agent(kind);
  faux.setResponses([fauxAssistantMessage("first checkpoint"), fauxAssistantMessage("must not run")]);
  const outcome = await harness.run({ ...input, budget: { seconds: 10, turns: 1 } });
  expect(outcome.status).toBe("budget_exceeded");
  expect(faux.state.callCount).toBe(1);
});

it.each(["pal", "baseline"])("%s retains the original wall deadline at a continuation", async (kind) => {
  const { input, faux, harness } = await agent(kind);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  faux.setResponses([
    () => {
      now += 2000;
      return fauxAssistantMessage("first checkpoint");
    },
    fauxAssistantMessage("must not run"),
  ]);
  expect(await harness.run({ ...input, budget: { seconds: 1, turns: 10 } })).toMatchObject({
    status: "budget_exceeded",
  });
  expect(faux.state.callCount).toBe(1);
});

it.each(["pal", "baseline"])("%s does not deliver a continuation after a provider error", async (kind) => {
  const { input, faux, harness } = await agent(kind);
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture provider unavailable" }),
    fauxAssistantMessage("must not run"),
  ]);
  expect(await harness.run(input)).toMatchObject({ status: "harness_error", interventions: 0 });
  expect(faux.state.callCount).toBe(1);
});

it.each(["pal", "baseline"])("%s does not continue after an aborted provider response", async (kind) => {
  const { input, faux, harness } = await agent(kind);
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "fixture provider aborted" }),
    fauxAssistantMessage("must not run"),
  ]);
  expect(await harness.run(input)).toMatchObject({ status: "harness_error", interventions: 0 });
  expect(faux.state.callCount).toBe(1);
});

it("continues after a recovered native provider retry while retaining its failure evidence and shared allowance", async () => {
  const { input, faux, harness } = await agent("pal");
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" }),
    fauxAssistantMessage("Recovered first checkpoint"),
    fauxAssistantMessage("Continued after retry"),
  ]);
  const outcome = await harness.run(input);
  expect(outcome).toMatchObject({ status: "completed", turns: 2, interventions: 1 });
  expect(faux.state.callCount).toBe(3);
  expect(JSON.stringify(outcome.trace)).toContain("429 Too Many Requests");
  expect(JSON.stringify(outcome.trace)).toContain("Continued after retry");
});

it("refuses a multi-turn external comparison instead of silently grading only its initial prompt", async () => {
  const { input } = await fixture();
  const outcome = await externalHarness("single-prompt", "printf ignored > ignored.txt").run(input);
  expect(outcome).toMatchObject({ status: "harness_error", error: expect.stringMatching(/continuation/) });
  await expect(readFile(join(input.workspace, "ignored.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

async function compactionAgent(kind: string) {
  const fixture = await agent(kind);
  const complete = vi.spyOn(fixture.pal.models, "completeSimple");
  const constraint = "Retain the original rounding constraint across compaction.";
  if (kind === "pal") {
    const submit = fixture.pal.chats.submit.bind(fixture.pal.chats);
    vi.spyOn(fixture.pal.chats, "submit").mockImplementationOnce(async (...args) => {
      const admission = await submit(...args);
      const native = await fixture.pal.harness.submission(admission.submissionId, context);
      if (native === undefined) throw new Error("missing fixture submission");
      const settled = await native.wait(context);
      await fixture.pal.harness.waitForIdle(context);
      const conversation = await fixture.pal.harness.conversation(settled.conversationId, context);
      if (conversation === undefined) throw new Error("missing fixture conversation");
      // Native compaction retains a recent tail; older history makes this a real summary rather than a no-op.
      for (let i = 0; i < 50; i++)
        await conversation.submit(
          {
            type: "write",
            entry: {
              kind: "pi.assistant",
              model: [fauxAssistantMessage(`${constraint} Checkpoint ${i}: ${"reference context ".repeat(250)}`)],
            },
          },
          context,
        );
      return admission;
    });
  }
  const requests: string[] = [];
  fixture.faux.setResponses(
    ["first checkpoint", `retained-summary-marker: ${constraint}`, "continued after compaction"].map(
      (text) => (request) => {
        requests.push(JSON.stringify(request.messages));
        return fauxAssistantMessage(text);
      },
    ),
  );
  return {
    ...fixture,
    requests,
    constraint,
    complete,
    input: {
      ...fixture.input,
      prompt: `${constraint} ${fixture.input.prompt}`,
      continuations: fixture.input.continuations.map((next) => ({ ...next, compact: true })),
      budget: { seconds: 20, turns: 3 },
    },
  };
}

it.each(["pal", "baseline"])("%s applies a compaction checkpoint before the next prompt", async (kind) => {
  const { input, faux, harness, requests, constraint, complete } = await compactionAgent(kind);
  const outcome = await harness.run(input);
  expect(outcome).toMatchObject({ status: "completed", turns: 3, interventions: 1 });
  expect(faux.state.callCount).toBe(3);
  expect(requests[1]).toContain(constraint);
  expect(requests[1]).not.toContain(input.continuations[0]?.prompt);
  expect(requests[2]).toContain("retained-summary-marker");
  expect(requests[2]).toContain(input.continuations[0]?.prompt);
  expect(requests[2]).not.toContain("first checkpoint");
  expect(JSON.stringify(outcome.trace)).toContain("first checkpoint");
  expect(JSON.stringify(outcome.trace)).toContain(constraint);
  expect(JSON.stringify(outcome.trace)).toContain("retained-summary-marker");
  const model = faux.getModel();
  const summary = complete.mock.calls[kind === "pal" ? 0 : 1];
  expect(summary?.[0]).toMatchObject({ id: model.id, provider: model.provider });
  expect(summary?.[2]).toMatchObject({
    maxTokens: Math.min(
      Math.floor(0.8 * DEFAULT_COMPACTION_POLICY.reserveTokens),
      model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
    ),
    cacheRetention: "none",
  });
  expect(summary?.[2]?.reasoning).toBeUndefined();
});

it.each(["pal", "baseline"])("%s charges a compaction checkpoint to the original turn allowance", async (kind) => {
  const { input, faux, harness } = await compactionAgent(kind);
  expect(await harness.run({ ...input, budget: { seconds: 20, turns: 2 } })).toMatchObject({
    status: "budget_exceeded",
    turns: 2,
  });
  expect(faux.state.callCount).toBe(2);
});

it("allows a native no-op checkpoint without pretending a summary request occurred", async () => {
  const { input, faux, harness } = await agent("pal");
  faux.setResponses([fauxAssistantMessage("small checkpoint"), fauxAssistantMessage("continued")]);
  expect(
    await harness.run({ ...input, continuations: input.continuations.map((next) => ({ ...next, compact: true })) }),
  ).toMatchObject({ status: "completed", turns: 2 });
  expect(faux.state.callCount).toBe(2);
});

it.each(["pal", "baseline"])("%s stops when a checkpoint summary fails", async (kind) => {
  const { input, faux, harness } = await compactionAgent(kind);
  faux.setResponses([
    fauxAssistantMessage("first checkpoint"),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture summary rejected (400)" }),
    fauxAssistantMessage("must not run"),
  ]);
  const outcome = await harness.run(input);
  expect(outcome).toMatchObject({ status: "harness_error", turns: 2, interventions: 0 });
  expect(outcome.error).toContain("fixture summary rejected (400)");
  expect(faux.state.callCount).toBe(2);
});

it.each(["pal", "baseline"])("%s retains the original deadline through a checkpoint summary", async (kind) => {
  const { input, faux, harness } = await compactionAgent(kind);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  faux.setResponses([
    fauxAssistantMessage("first checkpoint"),
    () => {
      now += 20_000;
      return fauxAssistantMessage("summary after the original deadline");
    },
    fauxAssistantMessage("must not run"),
  ]);
  expect(await harness.run({ ...input, budget: { seconds: 10, turns: 3 } })).toMatchObject({
    status: "budget_exceeded",
    turns: 2,
    interventions: 0,
  });
  expect(faux.state.callCount).toBe(2);
});
