import { contentText, type Message } from "@earendil-works/pi-ai";
import {
  estimateContextTokens,
  estimateTextAndImageContentTokens,
  estimateTextTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import type { Agent } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";

const MAX_ITEMS = 50;
const MAX_LABEL = 120;

export type UsageItem = { label: string; tokens: number };
/** Estimated tokens of one part of a prepared request; `more` counts items beyond the listed ones. */
export type UsageCategory = { id: string; label: string; tokens: number; items?: UsageItem[]; more?: number };
/** Tools a run can reach that the request neither offers nor declares inline, such as through Code Mode discovery. */
export type UnloadedTools = { id: string; label: string; count: number; items: string[] };
export type ContextBreakdown = {
  /** Pi's estimate: the last provider-reported usage plus estimates of what came after it. */
  usedTokens: number;
  reported?: { provider: string; tokens: number };
  categories: UsageCategory[];
  unloaded: UnloadedTools[];
};
/** Who contributed an extension's tools and sections, as the owner sees it. */
export type Owner = { id: string; label: string };

const SECTIONS: Readonly<Record<string, string>> = {
  pinned: "Pinned instructions",
  scoped_instructions: "Project instructions",
  skills: "Skills",
  "working-state": "Working state",
  internet: "MCP guidance",
  mcp_provenance: "MCP lookups",
};
const MESSAGES = "Messages";

/**
 * Where the tokens of a prepared request go, from its native messages: labels and estimated counts only, never text.
 * Replaying every system message counts each section and tool declaration as often as Pi's estimate does.
 */
export function contextBreakdown(
  messages: readonly Message[],
  agent: Pick<Agent, "extensions" | "tools" | "callable" | "deferred">,
  owner: (extension: string) => Owner,
): ContextBreakdown {
  const tools = new Map<string, Owner>();
  const sections = new Map<string, Owner>();
  for (const extension of agent.extensions) {
    const found = owner(extension.name);
    for (const tool of extension.tools ?? []) tools.set(tool.name, found);
    for (const section of extension.sections ?? []) sections.set(section.key, found);
  }
  const totals = new Map<string, { label: string; tokens: number; items: Map<string, number> }>();
  const add = (id: string, label: string, tokens: number, item?: string) => {
    const category = totals.get(id) ?? { label, tokens: 0, items: new Map<string, number>() };
    totals.set(id, category);
    category.tokens += tokens;
    if (item !== undefined) category.items.set(item, (category.items.get(item) ?? 0) + tokens);
  };
  const tool = (name: string, tokens: number, item = name) => {
    const found = tools.get(name) ?? { id: "other", label: "Other" };
    add(`tools:${found.id}`, `Tools · ${found.label}`, tokens, item);
  };
  let inlined = new Set<string>();

  for (const message of messages) {
    if (message.role === "system") {
      add("system", "System prompt", estimateTextTokens(contentText(message.content)));
      for (const [key, text] of Object.entries(message.sections ?? {})) {
        if (text === null) continue;
        if (key === "instructions") add("system", "System prompt", estimateTextTokens(text));
        else if (key === CODEMODE_TOOL_NAME) inlined = codemode(text, tools, add, tool);
        else {
          const found = sections.get(key);
          const label = SECTIONS[key] ?? (found === undefined ? key : `${found.label} · ${key}`);
          const items = sectionItems(key, text);
          if (items === undefined) add(`section:${key}`, label, estimateTextTokens(text));
          else {
            add(`section:${key}`, label, estimateTextTokens(text) - items.reduce((sum, item) => sum + item.tokens, 0));
            for (const item of items) add(`section:${key}`, label, item.tokens, item.label);
          }
        }
      }
      for (const added of message.toolsAdded ?? []) tool(added.name, estimateTextTokens(JSON.stringify(added)));
      for (const removed of message.toolsRemoved ?? []) tool(removed.name, estimateTextTokens(JSON.stringify(removed)));
    } else if (message.role === "user") {
      if (typeof message.content === "string") {
        add("messages", MESSAGES, estimateTextTokens(message.content), "Your messages");
        continue;
      }
      // Pal labels each attachment's text; an image follows its label.
      let attachment: string | undefined;
      for (const block of message.content) {
        if (block.type === "image") {
          add("images", "Images", estimateTextAndImageContentTokens([block]), attachment ?? "Your messages");
          continue;
        }
        attachment = /^<attachment id="[^"]*" name="([^"]*)"/.exec(block.text)?.[1];
        if (attachment === undefined) add("messages", MESSAGES, estimateTextTokens(block.text), "Your messages");
        else add("attachments", "Attachments", estimateTextTokens(block.text), attachment);
      }
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") add("messages", MESSAGES, estimateTextTokens(block.text), "Replies");
        else if (block.type === "thinking") add("messages", MESSAGES, estimateTextTokens(block.thinking), "Reasoning");
        else add("messages", MESSAGES, estimateTextTokens(block.name + JSON.stringify(block.arguments)), "Tool calls");
      }
    } else {
      for (const block of message.content) {
        if (block.type === "image")
          add("images", "Images", estimateTextAndImageContentTokens([block]), message.toolName);
        else add("messages", MESSAGES, estimateTextTokens(block.text), `Tool results · ${message.toolName}`);
      }
    }
  }

  const categories: UsageCategory[] = [...totals]
    .map(([id, { label, tokens, items }]) => {
      const listed = [...items]
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ label: name.slice(0, MAX_LABEL), tokens: count }));
      return {
        id,
        label,
        tokens,
        ...(listed.length === 0 ? {} : { items: listed.slice(0, MAX_ITEMS) }),
        ...(listed.length > MAX_ITEMS ? { more: listed.length - MAX_ITEMS } : {}),
      };
    })
    .filter((category) => category.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const estimate = estimateContextTokens(messages);
  const anchor = estimate.lastUsageIndex === null ? undefined : messages[estimate.lastUsageIndex];
  let reported: ContextBreakdown["reported"];
  if (anchor?.role === "assistant") {
    reported = { provider: anchor.provider, tokens: estimate.usageTokens };
    // The provider counted the request up to its reply exactly; show that against the estimates rather than scaling them.
    const difference = estimate.tokens - categories.reduce((sum, category) => sum + category.tokens, 0);
    if (difference !== 0)
      categories.push({ id: "reported", label: "Difference from the provider's count", tokens: difference });
  }

  const offered = new Set(agent.tools.map((offer) => offer.name));
  const unloaded = new Map<string, UnloadedTools>();
  for (const reachable of [...agent.callable, ...agent.deferred]) {
    if (offered.has(reachable.name) || inlined.has(reachable.name)) continue;
    const found = tools.get(reachable.name) ?? { id: "other", label: "Other" };
    const group = unloaded.get(found.id) ?? { id: found.id, label: found.label, count: 0, items: [] };
    unloaded.set(found.id, group);
    if (group.items.includes(reachable.name)) continue;
    group.count++;
    if (group.items.length < MAX_ITEMS) group.items.push(reachable.name.slice(0, MAX_LABEL));
  }
  return {
    usedTokens: estimate.tokens,
    ...(reported === undefined ? {} : { reported }),
    categories,
    unloaded: [...unloaded.values()].sort((a, b) => b.count - a.count),
  };
}

/**
 * Pi's `codemode` section lists each inlined tool under "### `id`" (or "### `id` (`name`)"), grouped under "## <name>"
 * namespace headings; the rest is Code Mode's own text. Returns the inlined tools' names.
 */
function codemode(
  text: string,
  tools: ReadonlyMap<string, Owner>,
  add: (id: string, label: string, tokens: number, item?: string) => void,
  tool: (name: string, tokens: number, item?: string) => void,
): Set<string> {
  const inlined = new Set<string>();
  let namespace: string | undefined;
  for (const chunk of text.split(/\n(?=## |### `)/)) {
    const heading = /^### `([^`]+)`(?: \(`([^`]+)`\))?/.exec(chunk);
    const name = heading?.[2] ?? heading?.[1];
    if (name === undefined) {
      namespace = /^## ([^\n (]+)/.exec(chunk)?.[1] ?? namespace;
      add("tools:codemode", "Tools · Code Mode", estimateTextTokens(chunk));
      continue;
    }
    inlined.add(name);
    // MCP tools are listed by server, the namespace they are declared under.
    tool(name, estimateTextTokens(chunk), tools.get(name)?.id === "mcp" && namespace !== undefined ? namespace : name);
  }
  return inlined;
}

/** Pal's own JSON sections: skills list their catalog, project instructions their files. */
function sectionItems(key: string, text: string): UsageItem[] | undefined {
  if (key !== "skills" && key !== "scoped_instructions") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n")));
  } catch {
    return undefined;
  }
  const record = value as { metadata?: { items?: unknown }; sources?: unknown } | null;
  const list = key === "skills" ? record?.metadata?.items : record?.sources;
  if (!Array.isArray(list)) return undefined;
  return list.map((item: { name?: unknown; path?: unknown }) => ({
    label: String(item.name ?? item.path ?? "Unnamed"),
    tokens: estimateTextTokens(JSON.stringify(item)),
  }));
}
