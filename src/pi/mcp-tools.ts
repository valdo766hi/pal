import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { type CallToolResult, toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { safeMcpResult } from "./mcp-result.ts";

/** The parts of an MCP tool listing an approval covers. */
export type McpToolDefinition = {
  readonly remote: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
};

export const MCP_FRESHNESS = "_pal_freshness";

/** Complex or colliding schemas stay live-only rather than weakening their remote constraints. */
export function supportsCacheControl(tool: McpToolDefinition): boolean {
  const schema = tool.inputSchema;
  const properties = schema.properties;
  return (
    schema.type === "object" &&
    properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    !Object.hasOwn(properties, MCP_FRESHNESS) &&
    !(Array.isArray(schema.required) && schema.required.includes(MCP_FRESHNESS)) &&
    Object.keys(schema).every((key) =>
      ["type", "properties", "required", "additionalProperties", "description", "title", "$schema"].includes(key),
    )
  );
}

/** Calls one server's tools; the caller decides connection, limits and whether the tool may still run. */
export type McpConnection = {
  call(
    remote: string,
    args: Record<string, unknown>,
    api: ToolExecutionApi,
    context: Context,
    freshness?: "live",
  ): Promise<CallToolResult>;
};

/**
 * `mcp__<server>__<tool>`, provider-safe (at most 64 of [A-Za-z0-9_-]). A remote name that had to change gets a hash
 * suffix, so two remote names never map to one tool.
 */
export function mcpToolName(server: string, remote: string): string {
  const prefix = `mcp__${server}__`;
  const safe = remote.replace(/[^A-Za-z0-9_-]/g, "_");
  if (safe === remote && prefix.length + safe.length <= 64) return prefix + safe;
  const suffix = createHash("sha256").update(remote).digest("hex").slice(0, 8);
  return `${prefix}${safe.slice(0, 64 - prefix.length - suffix.length - 1)}_${suffix}`;
}

/**
 * Durable tools for one server's approved tools. `callers: ["tools"]` keeps them out of model declarations: the model
 * reaches them only through `codemode`, whose nested calls run under Durable validation, hooks and replay policy.
 * `replay: "safe"` is for reviewed read-only search/docs tools; anything else is never re-run after a crash.
 */
export function mcpTools(
  server: string,
  connection: McpConnection,
  tools: readonly McpToolDefinition[],
  replay: "safe" | "unsafe",
  /** Per remote tool, required arguments filled from another argument when omitted; reviewed presets only. */
  defaults: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
): ToolRegistration[] {
  return tools.map((tool) => {
    const structured = tool.outputSchema !== undefined;
    const filled = defaults[tool.remote] ?? {};
    const required = Array.isArray(tool.inputSchema.required)
      ? (tool.inputSchema.required as string[]).filter((name) => filled[name] === undefined)
      : undefined;
    const properties = {
      ...((tool.inputSchema.properties as Record<string, Record<string, unknown>> | undefined) ?? {}),
    };
    for (const [name, source] of Object.entries(filled)) {
      const property = properties[name];
      if (property !== undefined) {
        properties[name] = {
          ...property,
          description: `${String(property.description ?? "")} Defaults to \`${source}\` when omitted.`.trim(),
        };
      }
    }
    const cacheControl = replay === "safe" && supportsCacheControl(tool);
    if (cacheControl)
      properties[MCP_FRESHNESS] = {
        type: "string",
        const: "live",
        description: "Pal-only: bypass its query cache for a requested live lookup. Not sent to the MCP server.",
      };
    return defineTool({
      name: mcpToolName(server, tool.remote),
      description: tool.description,
      // Providers require an object schema, and some reject one without `properties`.
      parameters: Type.Unsafe<Record<string, unknown>>({
        ...tool.inputSchema,
        type: "object",
        properties,
        ...(required === undefined ? {} : { required }),
      }),
      ...(structured ? { structuredOutputSchema: Type.Unsafe(tool.outputSchema) } : {}),
      callers: ["tools"],
      replay,
      outputLimits: { maxBytes: 64 * 1024, maxLines: 2000 },
      execute: async (args, api, context) => {
        const { _pal_freshness: palFreshness, ...remoteArgs } = args;
        const sent = cacheControl ? remoteArgs : { ...args };
        const freshness = cacheControl && palFreshness === "live" ? "live" : undefined;
        for (const [name, source] of Object.entries(filled)) {
          if (sent[name] === undefined && typeof sent[source] === "string") sent[name] = sent[source];
        }
        const result = safeMcpResult(await connection.call(tool.remote, sent, api, context, freshness));
        return {
          output: toLlmContent(result),
          isError: result.isError === true,
          ...(structured && result.structuredContent !== undefined
            ? { structuredOutput: result.structuredContent as JsonValue }
            : {}),
        };
      },
    });
  });
}
