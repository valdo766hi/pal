import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { BuiltinExtensions, releaseIdentity } from "../../src/core/extensions.ts";
import { createPalCodemode } from "../../src/pi/codemode.ts";
import { openStore } from "../../src/storage/store.ts";

const [mode, install, dataRoot, marker] = process.argv.slice(2);
if (install === undefined || dataRoot === undefined || marker === undefined)
  throw new Error("missing implementation fixture arguments");
const registry = createRegistry();
const store = await openStore(dataRoot);
let harness: Harness | undefined;
let pinned: BuiltinExtensions | undefined;
try {
  pinned = await BuiltinExtensions.open(
    store.database,
    registry,
    () => {
      if (harness === undefined) throw new Error("fixture harness is not open");
      return harness;
    },
    await releaseIdentity(install, dataRoot),
  );
} catch (error) {
  await store.close();
  console.log(JSON.stringify({ blocked: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 2;
  process.disconnect?.();
}
if (pinned !== undefined) {
  registry.install(pinned.extension);
  const implementation = (await import(pathToFileURL(join(install, "src/tool.mjs")).href)) as { value: string };
  let effectCalls = 0;
  registry.install(
    defineExtension({
      name: "fixture.implementation",
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call) => {
            if (mode === "start" && call.name === "fx_commit") {
              process.send?.("before-effect");
              await new Promise<never>(() => {});
            }
          },
        }),
      ],
      tools: [
        defineTool({
          name: "fx_commit",
          description: "Write one idempotent fixture receipt",
          callers: ["tools"],
          parameters: Type.Object({}),
          // An exclusive create never rewrites an existing receipt, including after interrupted replay.
          replay: "safe",
          execute: async () => {
            effectCalls++;
            await writeFile(marker, implementation.value, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
            });
            return { output: [{ type: "text", text: await readFile(marker, "utf8") }] };
          },
        }),
      ],
    }),
  );
  const codemode = createPalCodemode({ allows: (_conversation, name) => name === "fx_commit" });
  for (const extension of codemode.extensions) registry.install(extension);
  const faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    ...(mode === "start"
      ? [
          fauxAssistantMessage(fauxToolCall("codemode", { code: "return await tools.fx_commit({});" }), {
            stopReason: "toolUse",
          }),
        ]
      : []),
    fauxAssistantMessage("done"),
  ]);
  harness = await Harness.open(store.storage, { models, registry }, context);
  const model = faux.getModel();
  const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  if (mode === "start")
    await root.submit(
      { type: "input", requestId: "implementation-input", content: "write the fixture receipt" },
      context,
    );
  harness.resume();
  if (mode === "start") setInterval(() => {}, 60_000);
  else {
    await root.waitForIdle(context);
    console.log(
      JSON.stringify({
        effect: await readFile(marker, "utf8"),
        effectCalls,
        userMessages: (await root.context(context)).messages.filter((message) => message.role === "user").length,
      }),
    );
    await harness.close(context);
    await codemode.sandbox.close();
    await store.close();
    process.disconnect?.();
  }
}
