import type { CallToolResult } from "@earendil-works/pi-mcp";
import { defineDoc } from "@earendil-works/pi-durable";

export type McpCacheInfo = { hit: boolean; fetchedAt: number; expiresAt: number; bypassed: boolean };
type Lookup = {
  server: string;
  tool: string;
  receivedAt: number;
  fetchedAt: number;
  hit: boolean;
  bypassed: boolean;
  isError: boolean;
};
export const McpProvenance = defineDoc({
  kind: "pal.mcpProvenance",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ lookups: [] as Lookup[] }),
});

export type McpSource = { url: string; title: string; kind: "reported" | "requested" };
export type McpReceipt = {
  callId: string;
  server: string;
  serverName: string;
  tool: string;
  receivedAt: number;
  elapsedMs: number;
  query: string;
  library: string;
  isError: boolean;
  sources: McpSource[];
  cache?: McpCacheInfo;
};

/** Best-effort reported links, never instructions or proof that a linked page was fetched. */
export function mcpEvidence(
  result: CallToolResult,
  args: Record<string, unknown>,
  key?: string,
): Pick<McpReceipt, "query" | "library" | "isError" | "sources"> {
  const redact = (value: string) => (key ? value.split(key).join("[redacted]") : value);
  const textArg = (name: string, max: number) =>
    typeof args[name] === "string" ? redact(args[name]).slice(0, max) : "";
  const sources: McpSource[] = [];
  const evidence = {
    query: textArg("query", 1000) || textArg("objective", 1000),
    library: textArg("libraryId", 400) || textArg("libraryName", 400),
    isError: result.isError === true,
    sources,
  };
  if (evidence.isError) return evidence;
  function add(uri: unknown, title: unknown, kind: McpSource["kind"] = "reported") {
    if (typeof uri !== "string" || uri.length > 2048 || /[\p{Cc}\s]/u.test(uri) || sources.length >= 20) return;
    try {
      const url = new URL(redact(uri));
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        sources.some((source) => source.url === url.href)
      )
        return;
      sources.push({
        url: url.href,
        title: typeof title === "string" ? redact(title).slice(0, 160) : url.hostname,
        kind,
      });
    } catch {
      // Not a usable HTTP link; never repair it into a different destination.
    }
  }
  let visited = 0;
  function walk(value: unknown, depth = 0) {
    if (depth > 8 || ++visited > 2048 || sources.length >= 20 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (visited >= 2048 || sources.length >= 20) break;
        walk(item, depth + 1);
      }
    } else {
      const record = value as Record<string, unknown>;
      add(record.url ?? record.uri, record.title ?? record.name);
      for (const item of Object.values(record)) {
        if (visited >= 2048 || sources.length >= 20) break;
        walk(item, depth + 1);
      }
    }
  }
  walk(result.structuredContent);
  for (const block of result.content) {
    if (block.type !== "text" || sources.length >= 20) continue;
    if (/^\s*[[{]/.test(block.text)) {
      try {
        walk(JSON.parse(block.text));
      } catch {
        // Providers may return prose that only starts like JSON; inspect explicit link formats below.
      }
    }
    let title: string | undefined;
    for (const line of block.text.split("\n", 2000)) {
      const heading = /^Title:\s*(.+)$/i.exec(line);
      if (heading) title = heading[1];
      const source = /^(?:URL|Source):\s*(https?:\/\/\S+)$/i.exec(line);
      if (source) {
        add(source[1], title);
        title = undefined;
      }
    }
    for (const link of block.text.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)) {
      if (sources.length >= 20) break;
      add(link[2], link[1]);
    }
  }
  const requested = Array.isArray(args.urls) ? args.urls.slice(0, 20) : [args.url];
  for (const uri of requested) add(uri, undefined, "requested");
  return evidence;
}
