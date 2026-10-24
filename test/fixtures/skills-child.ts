import { dirname } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { ChatService } from "../../src/core/chats.ts";
import { GuidanceFiles } from "../../src/core/guidance-files.ts";
import { PrivateFiles } from "../../src/core/file-policy.ts";
import { Projects } from "../../src/core/projects.ts";
import { ProjectSkills, SKILLS_NAMESPACE } from "../../src/core/skills.ts";
import { Workspaces } from "../../src/core/workspaces.ts";
import { createPalCodemode } from "../../src/pi/codemode.ts";
import { openStore } from "../../src/storage/store.ts";

const [mode, configuredData, home, service] = process.argv.slice(2);
if (
  (mode !== "start" && mode !== "resume") ||
  configuredData === undefined ||
  home === undefined ||
  service === undefined
)
  throw new Error("usage: skills-child.ts <start|resume> <dataRoot> <home> <service>");
const store = await openStore(configuredData);
const dataRoot = dirname(store.path);
const projects = await Projects.open({ database: store.database, dataRoot, installRoot: "/nonexistent-install" });
const workspaces = await Workspaces.open(store.database, projects, dataRoot, "/nonexistent-install");
const files = new GuidanceFiles({
  deny: [dataRoot, "/nix/store"],
  privateFiles: await PrivateFiles.open([store.path, `${store.path}-wal`, `${store.path}-shm`]),
});
let bodyReads = 0;
const read = files.read.bind(files);
files.read = async (...args) => {
  if (args[1].endsWith("SKILL.md") && args[2].headerBytes === undefined) bodyReads++;
  return read(...args);
};
const skills = new ProjectSkills({ database: store.database, workspaces, files, home, harness: () => running });
const registry = createRegistry();
registry.install(skills.extension);
registry.install(
  defineExtension({
    name: "fixture",
    tools: [
      defineTool({
        name: "fx_pause",
        description: "A parent-owned fixture request interrupted by SIGKILL",
        parameters: Type.Object({}),
        callers: ["tools"],
        execute: async (_args, _api, ctx) => {
          const response = await fetch(`${service}?bodyReads=${bodyReads}`, {
            method: "POST",
            signal: ctx.abortSignal ?? null,
          });
          return { output: [{ type: "text", text: await response.text() }] };
        },
      }),
    ],
  }),
);
const codemode = createPalCodemode({
  allows: (_conversation, name) => ["skills_search", "skills_read", "fx_pause"].includes(name),
  namespaces: [SKILLS_NAMESPACE],
});
for (const extension of codemode.extensions) registry.install(extension);
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const running = await Harness.open(store.storage, { models, registry }, context);
const model = faux.getModel();
const chats = await ChatService.open(
  {
    database: store.database,
    harness: running,
    agentFor: async (projectId, chatId, mode = "local") => {
      const project = await projects.get(projectId);
      if (project?.state !== "ready") return undefined;
      const workspace = chatId === undefined ? undefined : await workspaces.allocate(chatId, projectId, mode);
      return { model: { provider: model.provider, modelId: model.id }, cwd: workspace?.root ?? project.root };
    },
  },
  context,
);
const project = await projects.create("skills-replay-project", { name: "Replay fixture" });
const chat = await chats.createChat("skills-replay-chat", { projectId: project.id }, context);
const conversation = await running.conversation(chat.conversationId, context);
if (conversation === undefined) throw new Error("missing replay conversation");
if (mode === "start") {
  const item = (await skills.inspect(chat.conversationId, context)).current.catalog[0];
  if (item === undefined) throw new Error("missing replay skill");
  const code = `const value = await tools.skills_read(${JSON.stringify({ id: item.id, revision: item.revision })}); try { await tools.fx_pause({}); } catch {} return value;`;
  faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" })]);
  await chats.submit(chat.id, "skill-replay-input", { text: "Read then pause" }, context);
  running.resume();
} else {
  faux.setResponses([fauxAssistantMessage("Done")]);
  running.resume();
  await conversation.waitForIdle(context);
  const { messages } = await conversation.context(context);
  console.log(
    JSON.stringify({
      bodyReads,
      system: getCurrentSystemPrompt(messages),
      results: messages.flatMap((message) =>
        message.role === "toolResult"
          ? [
              {
                isError: message.isError,
                text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
              },
            ]
          : [],
      ),
    }),
  );
  await workspaces.close();
  await running.close(context);
  await codemode.sandbox.close();
  await store.close();
}
