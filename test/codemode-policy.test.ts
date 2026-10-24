import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type ToolResultMessage,
  Type,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { type CodemodeCaps, createPalCodemode, DEFAULT_CODEMODE_CAPS, type ToolPolicy } from "../src/pi/codemode.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A conversation whose model makes the given rounds of `codemode` calls, then answers. */
async function setup(options: {
  scripts: string[][];
  tools?: ToolRegistration[];
  caps?: Partial<CodemodeCaps>;
  allows?: ToolPolicy;
}) {
  const { extensions, sandbox } = createPalCodemode({
    allows: options.allows ?? (() => true),
    caps: { ...DEFAULT_CODEMODE_CAPS, ...options.caps },
    namespaces: [{ name: "fixture", prefix: "fx_", description: "Fixture tools" }],
  });
  cleanups.push(() => sandbox.close());
  const registry = createRegistry();
  registry.install(defineExtension({ name: "fixture", tools: options.tools ?? [] }));
  for (const extension of extensions) registry.install(extension);

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    ...options.scripts.map((round) =>
      fauxAssistantMessage(
        round.map((code) => fauxToolCall("codemode", { code })),
        { stopReason: "toolUse" },
      ),
    ),
    fauxAssistantMessage(fauxText("Done.")),
  ]);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  cleanups.push(() => harness.close(context));
  const model = faux.getModel();
  const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  return { root };
}

async function run(root: Awaited<ReturnType<typeof setup>>["root"]): Promise<ToolResultMessage[]> {
  const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
  expect(settled.status).toBe("done");
  const { messages } = await root.context(context);
  return messages.flatMap((message) => (message.role === "toolResult" ? [message] : []));
}

function text(result: ToolResultMessage | undefined): string {
  return result?.content.map((block) => (block.type === "text" ? block.text : "")).join("\n") ?? "";
}

/** A fixture tool that counts its executions. */
function counter(name: string, onCall?: () => void): { calls: number; registration: ToolRegistration } {
  const state = { calls: 0 };
  const registration = defineTool({
    name,
    description: `Fixture tool ${name}`,
    parameters: Type.Object({}),
    callers: ["tools"],
    execute: async () => {
      state.calls += 1;
      onCall?.();
      return { output: [{ type: "text" as const, text: `${name} ${state.calls}` }] };
    },
  });
  return Object.assign(state, { registration });
}

describe("Pal code mode policy", () => {
  it("imposes the host deadline on scripts that ask for more or set none", async () => {
    const spin = "while (true) {}";
    const { root } = await setup({
      caps: { timeoutMs: 300 },
      scripts: [[`// @options: {"timeout_ms": 3600000}\n${spin}`], [spin]],
    });
    const started = Date.now();
    const results = await run(root);
    expect(results.map((result) => result.isError)).toEqual([true, true]);
    for (const result of results) expect(text(result)).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("caps output tokens and VM memory", async () => {
    const { root } = await setup({
      caps: { maxOutputTokens: 50, memoryLimitBytes: 16 * 1024 * 1024 },
      scripts: [
        [`// @options: {"max_output_tokens": 1000000}\nreturn "word ".repeat(20000);`],
        [`const chunks = []; while (true) chunks.push("x".repeat(1 << 20));`],
      ],
    });
    const [output, memory] = await run(root);
    expect(text(output).length).toBeLessThan(2_000);
    expect(memory?.isError).toBe(true);
    expect(text(memory)).toMatch(/out of memory/i);
  });

  it("blocks calls past the per-script limit", async () => {
    const tool = counter("fx_count");
    const { root } = await setup({
      tools: [tool.registration],
      caps: { maxCalls: 3 },
      scripts: [
        [
          `const seen = [];
for (let i = 0; i < 5; i++) {
  try { seen.push(await tools.fx_count({})); } catch (error) { seen.push(error.message); }
}
return seen;`,
        ],
      ],
    });
    const [result] = await run(root);
    expect(tool.calls).toBe(3);
    expect(text(result).match(/call limit of 3 reached/g)).toHaveLength(2);
  });

  it.each(['searchTools("Fixture")', 'describeTool("fx_count")', 'describeNamespace("fixture")'])(
    "counts discovery calls through %s against the script budget",
    async (call) => {
      const tool = counter("fx_count");
      const { root } = await setup({
        tools: [tool.registration],
        caps: { maxCalls: 3 },
        scripts: [
          [
            `let allowed = 0; const errors = [];
for (let i = 0; i < 5; i++) {
  try { await ${call}; allowed++; } catch (error) { errors.push(error.message); }
}
return { allowed, errors };`,
          ],
        ],
      });
      const [result] = await run(root);
      expect(result?.isError).toBe(false);
      expect(text(result)).toContain('"allowed":3');
      expect(text(result).match(/call limit of 3 reached/g)).toHaveLength(2);
      expect(tool.calls).toBe(0);
    },
  );

  it.each([false, true])("shares the budget across mixed calls (concurrent: %s)", async (concurrent) => {
    const tool = counter("fx_count");
    const calls = [
      'searchTools("Fixture")',
      "tools.fx_count({})",
      'describeNamespace("fixture")',
      'describeTool("fx_count")',
      "tools.fx_count({})",
    ];
    const code = concurrent
      ? `const outcomes = await Promise.allSettled([${calls.join(",")}]);
return { allowed: outcomes.filter(x => x.status === "fulfilled").length,
 errors: outcomes.filter(x => x.status === "rejected").map(x => x.reason.message) };`
      : `let allowed = 0; const errors = [];
for (const call of [${calls.map((call) => `() => ${call}`).join(",")}]) {
 try { await call(); allowed++; } catch (error) { errors.push(error.message); }
}
return { allowed, errors };`;
    const { root } = await setup({ tools: [tool.registration], caps: { maxCalls: 3 }, scripts: [[code]] });
    const [result] = await run(root);
    expect(result?.isError).toBe(false);
    expect(text(result)).toContain('"allowed":3');
    expect(text(result).match(/call limit of 3 reached/g)).toHaveLength(2);
    expect(tool.calls).toBe(1);
  });

  it("keeps separate script budgets and does not charge local output or store helpers", async () => {
    const tool = counter("fx_count");
    const code = `store("k", 1); text(load("k")); console.log(ALL_TOOLS.length);
await searchTools("Fixture"); await describeTool("fx_count");
return await tools.fx_count({});`;
    const { root } = await setup({
      tools: [tool.registration],
      caps: { maxCalls: 3 },
      scripts: [[code], [code]],
    });
    const results = await run(root);
    expect(results.map((result) => result.isError)).toEqual([false, false]);
    expect(tool.calls).toBe(2);
  });

  it("returns a bounded error at the first over-budget discovery call", async () => {
    const { root } = await setup({
      caps: { maxCalls: 3 },
      scripts: [[`for (let i = 0; i < 4; i++) await searchTools("anything");`]],
    });
    const [result] = await run(root);
    expect(result?.isError).toBe(true);
    expect(text(result)).toContain("script call limit of 3 reached");
    expect(text(result).length).toBeLessThan(1000);
  });

  it("applies a revoked grant to the script's next call", async () => {
    const granted = new Set(["fx_act"]);
    const tool = counter("fx_act", () => granted.delete("fx_act"));
    const { root } = await setup({
      tools: [tool.registration],
      allows: (_conversation, name) => granted.has(name),
      scripts: [
        [
          `const first = await tools.fx_act({});
let second;
try { second = await tools.fx_act({}); } catch (error) { second = error.message; }
return { first, second };`,
        ],
      ],
    });
    const [result] = await run(root);
    expect(tool.calls).toBe(1);
    expect(text(result)).toContain('"first":"fx_act 1"');
    expect(text(result)).toMatch(/"second":"[^"]*fx_act is not granted to this conversation/);
  });

  it("refuses scripts beyond the worker limit while one is running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = defineTool({
      name: "fx_wait",
      description: "Wait for the test",
      parameters: Type.Object({}),
      callers: ["tools"],
      execute: async () => {
        setTimeout(release, 200);
        await gate;
        return { output: [{ type: "text", text: "released" }] };
      },
    });
    const { root } = await setup({
      tools: [wait],
      caps: { maxWorkers: 1 },
      scripts: [["return await tools.fx_wait({});", "return await tools.fx_wait({});"]],
    });
    const results = await run(root);
    expect(results.map((result) => result.isError).sort()).toEqual([false, true]);
    expect(results.map(text).join("\n")).toMatch(/at most 1 scripts may run at once/);
  });

  it("keeps store() writes of successful scripts only", async () => {
    const { root } = await setup({
      scripts: [
        [`store("k", "from failed"); throw new Error("boom");`],
        [`return { k: load("k") ?? null };`],
        [`store("k", "from success"); return "ok";`],
        [`return { k: load("k") };`],
      ],
    });
    const results = await run(root);
    expect(results.map((result) => result.isError)).toEqual([true, false, false, false]);
    expect(text(results[1])).toContain('"k":null');
    expect(text(results[3])).toContain('"k":"from success"');
  });

  it("aborts the running nested call when the conversation is stopped", async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const hang = defineTool({
      name: "fx_hang",
      description: "Run until aborted",
      parameters: Type.Object({}),
      callers: ["tools"],
      execute: async (_args, _api, callContext) => {
        started();
        await new Promise<void>((resolve) => callContext.abortSignal?.addEventListener("abort", () => resolve()));
        aborted = true;
        return { output: [{ type: "text", text: "stopped" }] };
      },
    });
    const { root } = await setup({ tools: [hang], scripts: [["return await tools.fx_hang({});"]] });
    const submission = await root.submit({ type: "input", content: "go" }, context);
    await running;
    await root.abort(context);
    expect(aborted).toBe(true);
    expect((await submission.wait(context)).status).not.toBe("done");
  });
});
