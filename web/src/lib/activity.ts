// Plain words for an agent's tool calls: one line for a whole run, and a verb with its object for a single call.
export type Call = { name: string; args?: string | undefined };

type Kind = "read" | "list" | "search" | "edit" | "run" | "browse" | "ask" | "tool";
const KINDS: Record<string, Kind> = {
  files_read: "read",
  files_attachment: "read",
  skills_read: "read",
  files_list: "list",
  files_find: "search",
  files_search: "search",
  skills_search: "search",
  memory_search: "search",
  files_write: "edit",
  files_edit: "edit",
  shell_run: "run",
  browser_observe: "browse",
  browser_act: "browse",
  agents_delegate: "ask",
};
const kind = (call: Call): Kind => KINDS[call.name] ?? "tool";
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const PHRASES: Record<Kind, (n: number) => string> = {
  read: (n) => `read ${plural(n, "file")}`,
  list: () => "listed files",
  search: (n) => (n === 1 ? "searched" : `searched ${n} times`),
  edit: (n) => `edited ${plural(n, "file")}`,
  run: (n) => `ran ${plural(n, "command")}`,
  browse: () => "used the browser",
  ask: (n) => (n === 1 ? "asked a helper" : `asked ${n} helpers`),
  tool: (n) => `used ${plural(n, "tool")}`,
};
const VERBS: Record<Kind, string> = {
  read: "Read",
  list: "Listed",
  search: "Searched",
  edit: "Edited",
  run: "Ran",
  browse: "Browser",
  ask: "Asked a helper",
  tool: "Used",
};

/** The argument that names what a call acted on; a script's recorded arguments may be cut short. */
function target(call: Call): string | undefined {
  if (call.args === undefined) return undefined;
  let args: unknown;
  try {
    args = JSON.parse(call.args);
  } catch {
    return undefined;
  }
  if (typeof args !== "object" || args === null) return undefined;
  for (const key of ["path", "command", "query", "pattern", "url", "name", "purpose"]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** `mcp__exa__web_search_exa` reads as "exa · web_search_exa". */
export function toolLabel(name: string): string {
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name) ?? [];
  return server === undefined || tool === undefined ? name : `${server} · ${tool}`;
}

/** "Read 3 files, ran 2 commands": calls by what they did, in the order each kind first happened; "" for none. */
export function summarize(calls: readonly Call[]): string {
  const seen = new Map<Kind, Set<string>>();
  calls.forEach((call, index) => {
    const type = kind(call);
    const things = seen.get(type) ?? new Set();
    // Reading or editing one file twice is still one file.
    things.add(type === "read" || type === "edit" ? (target(call) ?? `#${index}`) : `#${index}`);
    seen.set(type, things);
  });
  const line = [...seen].map(([type, things]) => PHRASES[type](things.size)).join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** One call as a verb and what it acted on; several calls as their summary. */
export function describe(calls: readonly Call[]): { verb: string; object?: string } {
  const [call] = calls;
  if (calls.length !== 1 || call === undefined) return { verb: summarize(calls) };
  const type = kind(call);
  const object = type === "tool" ? toolLabel(call.name) : target(call);
  if (object === undefined) return { verb: summarize(calls) };
  return { verb: VERBS[type], object };
}
