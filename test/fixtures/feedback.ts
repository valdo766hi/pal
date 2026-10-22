import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { Changes } from "../../src/core/changes.ts";
import { type Barrier, ChatService } from "../../src/core/chats.ts";
import { Projects } from "../../src/core/projects.ts";
import { PrivateFiles } from "../../src/core/file-policy.ts";
import { Workspaces } from "../../src/core/workspaces.ts";
import { openStore } from "../../src/storage/store.ts";

export async function openFeedback(dataRoot: string, barrier?: (point: Barrier) => void | Promise<void>) {
  const store = await openStore(dataRoot);
  const projects = await Projects.open({ database: store.database, dataRoot, installRoot: "/nonexistent" });
  const workspaces = await Workspaces.open(store.database, projects, dataRoot, "/nonexistent");
  const privateFiles = await PrivateFiles.open([store.path, `${store.path}-wal`, `${store.path}-shm`]);
  const changes = new Changes(store.database, projects, dataRoot, privateFiles, undefined, workspaces);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage(fauxText("ok"))));
  const model = faux.getModel();
  const harness = await Harness.open(store.storage, { models, registry: createRegistry() }, context);
  try {
    const chats = await ChatService.open(
      {
        database: store.database,
        harness,
        feedback: changes,
        agentFor: async (projectId, chatId, mode = "local") => {
          if ((await projects.get(projectId))?.state !== "ready") return undefined;
          if (chatId !== undefined) await workspaces.allocate(chatId, projectId, mode);
          return { model: { provider: model.provider, modelId: model.id } };
        },
        ...(barrier === undefined ? {} : { barrier }),
      },
      context,
    );
    return {
      store,
      projects,
      workspaces,
      changes,
      chats,
      harness,
      close: async () => {
        await workspaces.close();
        await harness.close(context);
        await store.close();
      },
    };
  } catch (error) {
    await workspaces.close();
    await harness.close(context);
    await store.close();
    throw error;
  }
}
