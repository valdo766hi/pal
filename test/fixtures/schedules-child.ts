// Child process for scheduled-message recovery tests over Pal's real store, chat admission and a faux model.
// `run <dataRoot> <barrier>` schedules one message and lets it fire, SIGKILLing itself at the barrier;
// `inspect <dataRoot>` reopens at the same time, ticks again and prints what was admitted.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { type Barrier, chatConfiguration, ChatService } from "../../src/core/chats.ts";
import { Schedules } from "../../src/core/schedules.ts";
import { openStore } from "../../src/storage/store.ts";

const [mode, dataRoot, crashAt] = process.argv.slice(2);
if (dataRoot === undefined) throw new Error("usage: schedules-child.ts <run|inspect> <dataRoot> [barrier]");

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage(fauxText("ok"))));
const model = faux.getModel();
const crash = (point: string) => {
  if (point === crashAt) process.kill(process.pid, "SIGKILL");
};

const store = await openStore(dataRoot);
const harness = await Harness.open(store.storage, { models, registry: createRegistry() }, context);
const chats = await ChatService.open(
  {
    database: store.database,
    harness,
    agentFor: async (projectId: string) =>
      projectId === "project-1" ? { model: { provider: model.provider, modelId: model.id } } : undefined,
    barrier: (point: Barrier) => crash(point),
  },
  context,
);
const clock = { now: Date.UTC(2030, 0, 14, 8) };
const settings = async (chatId: string) => {
  const chat = await chats.get(chatId);
  const conversation = chat === undefined ? undefined : await harness.conversation(chat.conversationId, context);
  return conversation === undefined
    ? undefined
    : { configuration: chatConfiguration(await conversation.agent(context)), mode: "ask" as const };
};
const schedules = await Schedules.open({
  database: store.database,
  now: () => clock.now,
  settings,
  submit: (chatId, requestId, body) => chats.submit(chatId, requestId, body, context),
  running: async (id) => {
    const state = await (await harness.submission(id as SubmissionId, context))?.status(context);
    return state?.status === "queued" || state?.status === "placed";
  },
  barrier: crash,
});

const chat = await chats.createChat("chat-request-1", { projectId: "project-1", title: "Scheduled" }, context);
if (mode === "run") {
  await schedules.setEnabled(true);
  const current = await settings(chat.id);
  await schedules.create(chat.id, "schedule-request-1", {
    text: "Scheduled check",
    timezone: "UTC",
    rule: { kind: "once", date: "2030-01-14", time: "09:00" },
    missed: "skip",
    configuration: current?.configuration,
    mode: "ask",
    acknowledged: true,
  });
}
clock.now = Date.UTC(2030, 0, 14, 9, 0, 30);
await schedules.tick();
await harness.waitForIdle(context);

if (mode === "inspect") {
  const conversation = await harness.conversation(chat.conversationId, context);
  const { messages } = (await conversation?.context(context)) ?? { messages: [] };
  console.log(
    JSON.stringify({
      userMessages: messages.filter((message) => message.role === "user").length,
      admissions: await store.database.all("SELECT request_id, state, submission_id FROM pal_admissions"),
      schedule: (await schedules.list(chat.id))[0],
    }),
  );
}
await schedules.close();
await harness.close(context);
