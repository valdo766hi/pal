import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fstatSync } from "node:fs";
import { releaseLock } from "../../src/core/release-files.ts";

const [mode, path] = process.argv.slice(2);
if (mode === "inherited") {
  assert(fstatSync(4).isFile());
  process.send?.({ ready: true });
} else {
  assert.equal(mode, "owner");
  assert(path);
  const lock = await releaseLock(path);
  const child = spawn(process.execPath, [import.meta.filename, "inherited"], {
    stdio: ["ignore", "ignore", "ignore", "ipc", lock.fd],
    env: {
      PATH: process.env.PATH ?? "",
      PAL_RELEASE_LOCK: process.env.PAL_RELEASE_LOCK ?? "",
      PAL_FLOCK: process.env.PAL_FLOCK ?? "",
    },
  });
  await once(child, "message");
  process.send?.({ ready: true, child: child.pid });
}
// Keep the inherited reference alive even when its owner's IPC channel dies.
setInterval(() => {}, 1000);
