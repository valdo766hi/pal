import { Terminal } from "@xterm/headless";
import { expect, it } from "vitest";
import { terminalMirror } from "../web/src/lib/terminal-mirror.ts";

it("leaves query replies to the host emulator without swallowing keyboard input or visible output", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const replies: string[] = [];
  terminal.onData((data) => replies.push(data));
  const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  const queries = "\x1b[0c\x1b[>0c\x1b[5n\x1b[6n\x1b[?6n\x1b[?7$p\x1bP$qm\x1b\\";
  try {
    await write(queries);
    expect(replies.length).toBeGreaterThan(0);
    replies.length = 0;
    terminalMirror(terminal);
    await write(queries + "visible output");
    expect(replies).toEqual([]);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain("visible output");
    terminal.input("typed\r", true);
    expect(replies).toEqual(["typed\r"]);
  } finally {
    terminal.dispose();
  }
});
