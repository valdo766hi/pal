import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openPal } from "../../src/core/app.ts";
import { projectMemory } from "../../plugins/memory/server.ts";

const pal = await openPal({ dataRoot: process.argv[2] ?? "", installRoot: "/nonexistent-install" }, context);
const project = await pal.projects.create("recovery-memory-project", { name: "Memory recovery" });
if (process.argv[3] === "projected") {
  const original = pal.store.database.transaction.bind(pal.store.database);
  pal.store.database.transaction = (callback) =>
    original(async (tx) =>
      callback({
        exec: tx.exec.bind(tx),
        get: tx.get.bind(tx),
        all: tx.all.bind(tx),
        runCounted: tx.runCounted.bind(tx),
        run: async (sql, ...args) => {
          await tx.run(sql, ...args);
          if (sql.startsWith("INSERT INTO pal_memory_fts")) {
            console.log(JSON.stringify({ project: project.id }));
            await new Promise(() => {});
          }
        },
      }),
    );
}
setInterval(() => {}, 1000);
await projectMemory(pal.capabilities).save(
  project.id,
  "recovery-memory-note",
  { title: "Journal", body: "Use SQLite", source: { kind: "owner" } },
  context,
);
console.log(JSON.stringify({ project: project.id }));
