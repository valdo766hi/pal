import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { tracingChannel } from "node:diagnostics_channel";
import { realpath } from "node:fs/promises";
import { writeTextFile } from "../../src/core/file-write.ts";
import { directoryIdentity } from "../../src/core/workspace-root.ts";

let worker: ChildProcess | undefined;
tracingChannel("child_process.spawn").end.subscribe((message) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "process" in message &&
    message.process instanceof ChildProcess
  )
    worker = message.process;
});
const directory = await realpath(process.argv[2] ?? "");
let checks = 0;
await writeTextFile({
  directory,
  identity: await directoryIdentity(directory),
  name: "main.txt",
  content: "must not publish\n",
  expected: createHash("sha256").update("original\n").digest("hex"),
  check: async () => {
    if (++checks === 2) {
      process.send?.({ prepared: true, worker: worker?.pid });
      await new Promise(() => {});
    }
  },
});
