import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Install the fake Claude Code at `path`, run by this Node directly: build sandboxes have no `/usr/bin/env`. */
export async function installFakeClaude(path: string): Promise<void> {
  const source = await readFile(join(import.meta.dirname, "fake-claude.mjs"), "utf8");
  await writeFile(path, `#!${process.execPath}\n${source.slice(source.indexOf("\n") + 1)}`, { mode: 0o755 });
}
