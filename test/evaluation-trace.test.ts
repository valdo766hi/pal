import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { palTrace } from "../src/evaluation/harnesses.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-evaluation-trace-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pal = await openPal(
    { dataRoot: join(root, "data"), installRoot: join(root, "install"), guidanceHome: join(root, "guidance") },
    context,
  );
  cleanups.push(() => pal.close());
  const conversation = await pal.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  return { pal, conversation };
}

it("exports paginated retained evidence from before native compaction, not only the active prompt", async () => {
  const { pal, conversation } = await fixture();
  const faux = fauxProvider();
  (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  const model = faux.getModel();
  await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
  await pal.harness.commit(async (tx) => {
    for (let i = 0; i < 130; i++)
      await tx.appendEntry(conversation.id, {
        kind: "fixture.evidence",
        model: [{ role: "user", content: `EVIDENCE-${i} ${"older ".repeat(200)}`, timestamp: Date.now() }],
      });
    await tx.appendEntry(conversation.id, {
      kind: "pi.assistant",
      model: [fauxAssistantMessage("recent ".repeat(20_000))],
    });
  }, context);
  faux.setResponses([fauxAssistantMessage("A deliberately lossy fixture summary.")]);
  await conversation.compact(undefined, context);
  await pal.harness.waitForIdle(context);
  expect(faux.state.callCount).toBe(1);
  expect(JSON.stringify((await conversation.context(context)).messages)).not.toContain("EVIDENCE-0 ");
  const recorded = await palTrace(pal, conversation.id);
  expect(recorded.trace.conversations).toHaveLength(1);
  expect(recorded.trace.conversations[0]?.entries.filter((entry) => entry.kind === "fixture.evidence")).toHaveLength(
    130,
  );
  expect(JSON.stringify(recorded.trace)).toContain("EVIDENCE-0 ");
  expect(JSON.stringify(recorded.trace)).toContain("EVIDENCE-129 ");
  expect(recorded.usage.reduce((sum, usage) => sum + usage.totalTokens, 0)).toBeGreaterThan(0);
});

it("refuses incomplete conversation coverage instead of silently truncating a report", async () => {
  const { pal, conversation } = await fixture();
  vi.spyOn(pal.store.storage, "scanConversations").mockResolvedValueOnce({ items: [], next: { more: true } });
  await expect(palTrace(pal, conversation.id)).rejects.toThrow(/conversation limit/);
});

it("bounds retained entries even when a storage page exceeds its requested size", async () => {
  const { pal, conversation } = await fixture();
  const entry = await pal.harness.commit(
    (tx) => tx.appendEntry(conversation.id, { kind: "fixture.evidence", data: "bounded" }),
    context,
  );
  vi.spyOn(pal.store.storage, "scanEntries").mockResolvedValueOnce({
    items: Array.from({ length: 32_769 }, () => entry),
  });
  await expect(palTrace(pal, conversation.id)).rejects.toThrow(/entry or byte limit/);
});
