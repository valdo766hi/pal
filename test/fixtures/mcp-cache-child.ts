import { openStore } from "../../src/storage/store.ts";
import { McpQueryCache } from "../../src/pi/mcp-cache.ts";

const store = await openStore(process.argv[2] ?? "");
if (process.argv[3] === "inserted") {
  const transaction = store.database.transaction.bind(store.database);
  store.database.transaction = (callback) =>
    transaction(async (tx) =>
      callback({
        exec: tx.exec.bind(tx),
        get: tx.get.bind(tx),
        all: tx.all.bind(tx),
        runCounted: tx.runCounted.bind(tx),
        run: async (sql, ...args) => {
          await tx.run(sql, ...args);
          if (sql.startsWith("INSERT INTO pal_mcp_cache")) {
            console.log("cache barrier");
            await new Promise(() => {});
          }
        },
      }),
    );
}
setInterval(() => {}, 1000);
await new McpQueryCache(store.database).put(
  { key: "recovery-cache-key", project: "fixture-project", server: "fixture-server" },
  { content: [{ type: "text", text: "committed source" }], isError: false },
  Date.now(),
  300_000,
);
console.log("cache barrier");
