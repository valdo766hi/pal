import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { McpReceipt } from "../src/pi/mcp-source.ts";
import { startCachedMcp } from "../test/fixtures/cached-mcp.ts";
import { distribution, sampleCount } from "./benchmark-startup.ts";

/** Full Code Mode round trips against a fresh loopback MCP fixture; no model or internet service is called. */
export async function sampleMcp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-mcp-benchmark-")));
  let fixture: Awaited<ReturnType<typeof startCachedMcp>> | undefined;
  try {
    fixture = await startCachedMcp(join(root, "data"));
    const { pal } = fixture;
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const model = faux.getModel();
    const project = await pal.projects.create("benchmark-project", { name: "MCP benchmark" });
    const chat = await pal.chats.createChat("benchmark-chat", { projectId: project.id }, context);
    const conversation = await pal.harness.conversation(chat.conversationId, context);
    assert(conversation !== undefined);
    await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    let lists = 0;
    fixture.fixture.state.beforeList = async () => {
      lists++;
    };
    const samples = [];
    for (const phase of ["first-read", "cached-read", "forced-live"] as const) {
      const before = {
        requests: fixture.fixture.requests.length,
        calls: fixture.fixture.calls.length,
        modelCalls: faux.state.callCount,
        lists,
      };
      const started = performance.now();
      const args = { query: "durable", ...(phase === "forced-live" ? { _pal_freshness: "live" } : {}) };
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("codemode", { code: `return await tools.mcp__exa__web_search_exa(${JSON.stringify(args)});` }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      await pal.chats.submit(chat.id, `benchmark-${phase}`, { text: "Read the fixture source." }, context);
      await conversation.waitForIdle(context);
      const roundTripMs = performance.now() - started;
      const history = await conversation.context(context);
      const receipt = history.entries
        .flatMap((entry) => (entry.kind === "pal.mcp" ? [(entry.data as { mcp: McpReceipt }).mcp] : []))
        .at(-1);
      assert(receipt !== undefined && !receipt.isError && receipt.sources.length > 0, "Missing successful receipt.");
      assert(receipt.cache?.hit === (phase === "cached-read"), "The cache path did not match the scenario.");
      assert(receipt.cache?.bypassed === (phase === "forced-live"));
      const toolCalls = fixture.fixture.calls.length - before.calls;
      assert(toolCalls === (phase === "cached-read" ? 0 : 1), "Unexpected remote tool call count.");
      assert(faux.state.callCount - before.modelCalls === 2, "The scripted agent did not finish its round trip.");
      samples.push({
        phase,
        roundTripMs,
        receiptMs: receipt.elapsedMs,
        httpRequests: fixture.fixture.requests.length - before.requests,
        catalogLists: lists - before.lists,
        toolCalls,
        rssBytes: process.memoryUsage().rss,
      });
    }
    return samples;
  } finally {
    try {
      await fixture?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function main(args: readonly string[]) {
  assert(args.length <= 1, "Usage: pal-benchmark-mcp [3–25 samples]");
  const count = sampleCount(args[0]);
  const samples: Awaited<ReturnType<typeof sampleMcp>>[] = [];
  for (let i = 0; i < count; i++) samples.push(await sampleMcp());
  return {
    format: 1,
    scenario: "loopback-mcp-code-mode-cache",
    identity: { source: await realpath(join(import.meta.dirname, "..")) },
    limits:
      "This immutable runner's in-process Pal, journal and scripted model, not provider or internet latency. " +
      "First-read excludes owner setup/enablement. RSS is this process after each phase, not peak or aggregate memory. " +
      "Samples share a process and filesystem caches; each gets a fresh guidance scope/store/server/chat.",
    host: {
      os: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
    },
    samples,
    summary: ["first-read", "cached-read", "forced-live"].map((phase) => {
      const rows = samples.flat().filter((sample) => sample.phase === phase);
      return {
        phase,
        ...Object.fromEntries(
          (["roundTripMs", "receiptMs", "httpRequests", "catalogLists", "toolCalls", "rssBytes"] as const).map(
            (key) => [key, distribution(rows.map((sample) => sample[key]))],
          ),
        ),
      };
    }),
  };
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`pal-benchmark-mcp: ${error instanceof Error ? error.message : "measurement failed"}\n`);
    process.exitCode = 1;
  }
}
