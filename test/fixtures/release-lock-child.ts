import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";

const inherited = fstatSync(4, { bigint: true });
assert(inherited.isFile());
const scan = `
  import { readdirSync, fstatSync } from 'node:fs';
  const [dev, ino] = process.argv.slice(1);
  const directory = process.platform === 'darwin' ? '/dev/fd' : '/proc/self/fd';
  const leaked = readdirSync(directory).some(fd => {
    try {
      const s = fstatSync(Number(fd), { bigint: true });
      return String(s.dev) === dev && String(s.ino) === ino;
    } catch { return false; }
  });
  process.exitCode = leaked ? 1 : 0;
`;
function inspect(inherit: boolean) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", scan, String(inherited.dev), String(inherited.ino)],
    {
      stdio: inherit ? ["ignore", "pipe", "pipe", "ignore", 4] : ["ignore", "pipe", "pipe"],
      env: { LANG: "C" },
      timeout: 5000,
      maxBuffer: 4096,
    },
  );
}
const positive = inspect(true);
assert.equal(positive.status, 1, `inherited-descriptor positive control failed: ${positive.stderr}`);
// A shell/tool grandchild must not retain the supervisor's lifetime lock at any descriptor number.
const ordinary = inspect(false);
assert.equal(ordinary.status, 0, `lifetime lock leaked to a tool grandchild: ${ordinary.stderr}`);
process.send?.({ ready: true });
process.once("message", () => process.disconnect());
