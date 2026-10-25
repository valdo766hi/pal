import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** RTK rewrite exits 0/3 with an equivalent, 1 without one, or 2 for a denial. */
export async function fakeRtk() {
  const bin = await realpath(await mkdtemp(join(tmpdir(), "pal-fake-rtk-")));
  const log = join(bin, "calls");
  const slow = join(bin, "slow.pid");
  await writeFile(
    join(bin, "rtk"),
    `#!/bin/sh
printf '%s|%s\\n' "$HOME" "$*" >> '${log}'
if [ "$1" = rewrite ]; then
  case "$2" in
    "report "*) printf 'rtk %s\\n' "$2"; exit 3 ;;
    "allowed "*) printf 'rtk report %s\\n' "\${2#allowed }"; exit 0 ;;
    "denied "*) printf 'blocked by a pipeline rule\\n'; exit 2 ;;
    "slow "*) trap '' TERM; sleep 30 & printf '%s %s\\n' $$ $! > '${slow}'; wait; printf 'rtk report late 0\\n'; exit 3 ;;
    *) exit 1 ;;
  esac
fi
if [ "$1" = report ]; then printf 'compact:%s\\n' "$2"; exit "$3"; fi
exit 99
`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  return {
    calls: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [home = "", args = ""] = line.split("|");
          return { home, args };
        }),
    slowPids: async () => {
      const match = /^([1-9]\d*) ([1-9]\d*)\n$/.exec(await readFile(slow, "utf8").catch(() => ""));
      return match === null ? undefined : ([Number(match[1]), Number(match[2])] as const);
    },
    cleanup: async () => {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
      await rm(bin, { recursive: true, force: true });
    },
  };
}
