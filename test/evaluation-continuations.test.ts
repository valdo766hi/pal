import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
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
