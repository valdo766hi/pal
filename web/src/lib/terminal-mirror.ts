import type { Terminal } from "@xterm/xterm";

/** The host emulator answers terminal queries; a viewer must not send a second reply as keyboard input. */
export function terminalMirror(terminal: Pick<Terminal, "parser">) {
  for (const id of [
    { final: "c" },
    { prefix: ">", final: "c" },
    { final: "n" },
    { prefix: "?", final: "n" },
    { intermediates: "$", final: "p" },
    { prefix: "?", intermediates: "$", final: "p" },
  ])
    terminal.parser.registerCsiHandler(id, () => true);
  terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, () => true);
  for (const code of [4, 10, 11, 12]) terminal.parser.registerOscHandler(code, (data) => data.split(";").includes("?"));
}
