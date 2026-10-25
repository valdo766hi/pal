import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";

function denied(work) {
  try {
    work();
    return false;
  } catch (error) {
    return error.code === "ERR_ACCESS_DENIED";
  }
}
process.stdout.write(
  JSON.stringify({
    passed: true,
    denied: {
      readGrader: denied(() => readFileSync(process.argv[2])),
      writeGrader: denied(() => writeFileSync(process.argv[2], "process.exit(0)")),
      writeTask: denied(() => writeFileSync(process.argv[3], "{}")),
      spawn: denied(() => spawnSync(process.execPath, ["-e", ""])),
      worker: denied(() => new Worker("", { eval: true })),
    },
  }),
);
