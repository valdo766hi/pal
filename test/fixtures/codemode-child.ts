// Child process for code mode recovery tests: Pal's store and code mode policy over a parent-owned HTTP fixture.
// `start` admits one input whose script reads, writes and reads again, and runs until the parent kills it;
// `resume` reopens the same store, lets the Harness finish, and prints the tool results.
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { createPalCodemode, DEFAULT_CODEMODE_CAPS } from "../../src/pi/codemode.ts";
import { openStore } from "../../src/storage/store.ts";
import {
  evaluationBudget,
  evaluationBudgetExceeded,
  evaluationBudgetTurns,
  setEvaluationBudget,
} from "../../src/pi/evaluation-budget.ts";

export const SCRIPT = `
const a = await tools.fx_read({ key: "a" });
let b;
try { b = await tools.fx_write({ key: "b" }); } catch (error) { b = "unknown: " + error.message; }
const c = await tools.fx_read({ key: "c" });
return { a, b, c };
`;

const [mode, dataRoot, service, heap, budget] = process.argv.slice(2);
const limited = heap === "budget" || heap === "budget-journal";
const evaluating = heap === "evaluation";
let script = SCRIPT;
if (heap === "budget-journal") {
  script = `
const pending = tools.fx_write({ key: "b" }).catch(error => "unknown: " + error.message);
const a = await tools.fx_read({ key: "a" });
await searchTools("read");
let discovery;
try { await describeTool("fx_read"); discovery = "unexpected"; } catch (error) { discovery = error.message; }
const b = await pending;
return { a, b, discovery };
`;
} else if (limited) {
  script = `
const a = await tools.fx_read({ key: "a" });
await describeTool("fx_read");
let b;
try { b = await tools.fx_write({ key: "b" }); } catch (error) { b = "unknown: " + error.message; }
let discovery, c;
try { await searchTools("read"); discovery = "unexpected"; } catch (error) { discovery = error.message; }
try { c = await tools.fx_read({ key: "c" }); } catch (error) { c = error.message; }
return { a, b, discovery, c };
`;
}
if (dataRoot === undefined || service === undefined) {
  throw new Error("usage: codemode-child.ts <start|resume> <dataRoot> <serviceUrl> [heapBytes|budget [maxCalls]]");
}

async function call(path: string, key: string, method: string): Promise<string> {
  const response = await fetch(`${service}/${path}?key=${key}`, { method });
  return await response.text();
}

const registry = createRegistry();
if (evaluating) registry.install(evaluationBudget(() => harness));
registry.install(
  defineExtension({
    name: "fixture",
    tools: [
      defineTool({
        name: "fx_read",
        description: "Read a fixture value",
        parameters: Type.Object({ key: Type.String() }),
        callers: ["tools"],
        replay: "safe",
        execute: async (args) => ({ output: [{ type: "text", text: await call("read", args.key, "GET") }] }),
      }),
      defineTool({
        name: "fx_write",
        description: "Mutate the fixture service",
        parameters: Type.Object({ key: Type.String() }),
        callers: ["tools"],
        execute: async (args) => ({ output: [{ type: "text", text: await call("write", args.key, "POST") }] }),
      }),
    ],
  }),
);
const { extensions, sandbox } = createPalCodemode({
  allows: () => true,
  caps: {
    ...DEFAULT_CODEMODE_CAPS,
    memoryLimitBytes:
      heap === undefined || limited || evaluating ? DEFAULT_CODEMODE_CAPS.memoryLimitBytes : Number(heap),
    maxCalls: limited ? Number(budget ?? 3) : DEFAULT_CODEMODE_CAPS.maxCalls,
  },
});
for (const extension of extensions) registry.install(extension);
if (mode === "start" && heap === "budget-journal") {
  const start = sandbox.start.bind(sandbox);
  let announced = false;
  sandbox.start = (code, options) =>
    start(code, {
      ...options,
      onIdle: (seq, issued) => {
        options.onIdle?.(seq, issued);
        if (!announced && seq >= 3 && issued >= 4) {
          announced = true;
          process.send?.("budget-journaled");
        }
      },
    });
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// The resumed process only answers after the script: its first request comes after the tool result.
faux.setResponses([
  ...(mode === "start"
    ? [fauxAssistantMessage(fauxToolCall("codemode", { code: script }), { stopReason: "toolUse" })]
    : []),
  fauxAssistantMessage(fauxText("Done.")),
]);

const store = await openStore(dataRoot);
const harness = await Harness.open(store.storage, { models, registry }, context);
const model = faux.getModel();
const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });

if (evaluating) {
  await setEvaluationBudget(harness, root.id, 1, Number(budget), context);
  await assert.rejects(
    setEvaluationBudget(harness, root.id, 1, Number(budget) + 1, context),
    /cannot be changed after assignment/,
  );
}

if (mode === "start") {
  await root.submit({ type: "input", content: "go", requestId: "recovery-1" }, context);
  harness.resume();
  setInterval(() => {}, 60_000);
} else if (mode === "resume") {
  harness.resume();
  await root.waitForIdle(context);
  const { messages } = await root.context(context);
  const results = messages.flatMap((message): ({ isError: boolean; text: string } | { answer: string })[] =>
    message.role === "toolResult"
      ? [
          {
            isError: message.isError,
            text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          },
        ]
      : message.role === "assistant"
        ? [{ answer: message.content.map((block) => (block.type === "text" ? block.text : "")).join("") }]
        : [],
  );
  console.log(
    JSON.stringify(
      evaluating
        ? {
            results,
            turns: await evaluationBudgetTurns(harness, root.id, context),
            exceeded: await evaluationBudgetExceeded(harness, root.id, context),
            modelCallsAfterRestart: faux.state.callCount,
            budgetChangeRefused: true,
          }
        : results,
    ),
  );
  await harness.close(context);
  await sandbox.close();
  await store.close();
} else {
  throw new Error(`unknown mode ${mode}`);
}
