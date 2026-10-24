import { supervise } from "../../src/core/supervise.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";

const [packagePath, dataRoot, shownPort] = process.argv.slice(2);
if (!packagePath || !dataRoot || !shownPort || !process.send)
  throw new Error("pass package, isolated data and port through the host fixture");
let selected = false,
  failedHealth = false,
  futureSchema = false,
  busyProject: string | undefined;
process.on("message", (message: { arm?: string; project?: string }) => {
  if (message.arm === "selected") selected = true;
  else if (message.arm === "health") failedHealth = true;
  else if (message.arm === "schema") futureSchema = true;
  else if (message.arm === "busy") busyProject = message.project;
  process.send?.({ armed: message.arm });
});
const disconnect = () => {
  process.kill(process.pid, "SIGTERM");
};
process.once("disconnect", disconnect);
process.exitCode = await supervise(
  `${packagePath}/lib/pal`,
  { host: "127.0.0.1", port: Number(shownPort), dataRoot },
  {
    selected: async (state) => {
      if (!selected) return;
      selected = false;
      process.send?.({ barrier: "selected", digest: state.next?.digest });
      await new Promise<never>(() => {});
    },
    health: async (artifact) => {
      if (failedHealth && artifact.package !== packagePath) {
        failedHealth = false;
        throw new Error("fixture rejected candidate health after the actual packaged HTTP probe");
      }
    },
    stopped: async () => {
      if (futureSchema) {
        futureSchema = false;
        const database = await openDatabase(`${dataRoot}/pal.sqlite`);
        try {
          await database.run(
            "INSERT INTO pal_migrations (version, name, applied_at) SELECT max(version) + 1, 'fixture-future', ? FROM pal_migrations",
            Date.now(),
          );
        } finally {
          await database.close();
        }
        return;
      }
      if (busyProject === undefined) return;
      const project = busyProject;
      busyProject = undefined;
      // The app child has exited; this connection closes before the supervisor's own stopped-data inspection.
      const database = await openDatabase(`${dataRoot}/pal.sqlite`);
      try {
        await database.run("UPDATE pal_projects SET state = 'provisioning' WHERE id = ?", project);
      } finally {
        await database.close();
      }
    },
  },
);
process.off("disconnect", disconnect);
if (process.connected) process.disconnect();
