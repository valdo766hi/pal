// A Pal process in Auto mode that dies the moment its advisor's decision is stored, before the command dispatches.
import { appendFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { openPal } from "../../src/core/app.ts";
import { fakeAdvisor, RUN, withAdvisor } from "./advisor.ts";

const [dataRoot = "", calls = "", command = ""] = process.argv.slice(2);
const { capability } = fakeAdvisor(() => {
  appendFileSync(calls, "x");
  return RUN;
});
const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context, withAdvisor(capability));
const faux = fauxProvider();
(pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
const project = await pal.projects.create("auto-project", { name: "Fixture" });
const chat = await pal.chats.createChat("auto-chat", { projectId: project.id }, context);
const conversation = await pal.harness.conversation(chat.conversationId, context);
if (conversation === undefined) throw new Error("fixture conversation missing");
const model = faux.getModel();
await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
await pal.approvals.setMode(chat.id, "auto");
const code = `return await tools.shell_run({ command: ${JSON.stringify(command)}, timeout: 30 });`;
faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" })]);
console.log(JSON.stringify({ root: project.root, chatId: chat.id }));
// The listener runs synchronously after the decision commits and before the hook lets the command run.
pal.approvals.watch(chat.id, () => process.kill(process.pid, "SIGKILL"));
await pal.chats.submit(chat.id, "auto-input", { text: "run the fixture" }, context);
setInterval(() => {}, 1000);
