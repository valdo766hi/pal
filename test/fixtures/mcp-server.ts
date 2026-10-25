// A loopback Streamable HTTP MCP server with JSON responses, recording every request and tool call it receives.
// Tests can change its tool list, force an HTTP status, or run a hook before a tool call answers.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { CallToolResult } from "@earendil-works/pi-mcp";

type Call = { name: string; arguments: Record<string, unknown> };

const TOOLS = [
  {
    name: "search",
    description: "Search the fixture web index",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: { url: { type: "string" }, title: { type: "string" }, score: { type: "number" } },
            required: ["url", "title", "score"],
          },
        },
      },
      required: ["results"],
    },
  },
  {
    name: "fetch",
    description: "Fetch one page of the fixture web",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "delete_everything",
    description: "A destructive tool the owner never grants",
    inputSchema: { type: "object", properties: {} },
    annotations: { destructiveHint: true },
  },
];

const PAGES: Record<string, string> = {
  "https://fixture.invalid/durable": "Durable agents\nWork survives restarts.",
  "https://fixture.invalid/codemode": "Code Mode\nScripts call tools.",
};

function callTool({ name, arguments: args }: Call) {
  if (name === "search") {
    const results = [
      { url: "https://fixture.invalid/durable", title: "Durable agents", score: 0.92 },
      { url: "https://fixture.invalid/codemode", title: "Code Mode", score: 0.71 },
      { url: "https://fixture.invalid/spam", title: "Unrelated", score: 0.08 },
    ];
    return { content: [{ type: "text", text: JSON.stringify(results) }], structuredContent: { results } };
  }
  if (name === "fetch") {
    const page = PAGES[String(args.url)];
    if (page === undefined) return { content: [{ type: "text", text: `404 ${String(args.url)}` }], isError: true };
    return { content: [{ type: "text", text: page }] };
  }
  return { content: [{ type: "text", text: "deleted everything" }] };
}

export async function startMcpFixture() {
  const calls: Call[] = [];
  const requests: { path: string; headers: IncomingHttpHeaders }[] = [];
  const state: {
    tools: typeof TOOLS;
    status: number | undefined;
    beforeCall: ((call: Call) => Promise<void>) | undefined;
    beforeList: (() => Promise<void>) | undefined;
    result: CallToolResult | undefined;
    headers: Record<string, string>;
  } = {
    tools: structuredClone(TOOLS),
    status: undefined,
    beforeCall: undefined,
    beforeList: undefined,
    result: undefined,
    headers: {},
  };
  const server = createServer(async (request, response) => {
    requests.push({ path: request.url ?? "", headers: request.headers });
    if (request.url === "/redirect") {
      response.writeHead(307, { location: "/mcp" }).end();
      return;
    }
    if (state.status !== undefined) {
      response.writeHead(state.status, { "content-type": "text/plain" }).end(`forced ${state.status}`);
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body) as { id?: number | string; method: string; params?: Record<string, unknown> };
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }

    let result: unknown;
    const headers: Record<string, string> = { "content-type": "application/json", ...state.headers };
    if (message.method === "initialize") {
      headers["mcp-session-id"] = randomUUID();
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      await state.beforeList?.();
      result = { tools: state.tools };
    } else if (message.method === "tools/call") {
      const call = message.params as Call;
      calls.push(call);
      await state.beforeCall?.(call);
      result = state.result ?? callTool(call);
    } else if (message.method === "ping") {
      result = {};
    }
    const reply =
      result === undefined
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } }
        : { jsonrpc: "2.0", id: message.id, result };
    response.writeHead(200, headers).end(JSON.stringify(reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    calls,
    requests,
    state,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((done) => server.close(() => done()));
    },
  };
}
