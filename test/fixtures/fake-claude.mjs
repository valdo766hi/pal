#!/usr/bin/env node
// A stand-in for the Claude Code CLI, adapted from pi-claude-code's tests (MIT): `auth status`, `--version` and the
// stream-json mode. Like the real CLI, a request process starts the MCP servers in `--mcp-config` and lists their
// tools, merges `CLAUDE_CODE_EXTRA_BODY` from `--settings` into each request, adds a reminder to the user message,
// sends it to `ANTHROPIC_BASE_URL` (Pal's relay) with its own login, retries once after a 5xx, streams the reply and
// calls the MCP tool a reply asks for. It reads its behaviour from `fake-claude.json` beside it, because Pal starts
// it with an allowlisted environment, and appends what it saw (PID, mode, environment names, whether a planted
// secret leaked, the tool inventory and request attempts) to `fake-claude.log`.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";

const here = dirname(process.argv[1]);
// Read again for every turn: a warm process serves several.
const settings = () =>
  existsSync(join(here, "fake-claude.json")) ? JSON.parse(readFileSync(join(here, "fake-claude.json"), "utf8")) : {};
const config = settings();
const mode = process.argv.includes("auth") ? "status" : process.argv.includes("--version") ? "version" : "stream";
const option = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const log = (entry) =>
  appendFileSync(join(here, "fake-claude.log"), `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const secret = config.secret ?? "";
log({
  mode,
  request: process.argv.includes("--system-prompt-file"),
  cwd: process.cwd(),
  env: Object.keys(process.env).sort(),
  leaked: secret !== "" && Object.values(process.env).some((value) => value?.includes(secret)),
});
if (mode === "status") {
  console.log(JSON.stringify(config.auth ?? { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));
  process.exit(0);
}
if (mode === "version") {
  console.log("2.1.0 (Claude Code)");
  process.exit(0);
}

/** A minimal MCP client over stdio for the `pi` server Pal configures. */
function startMcp(server) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: "pipe" });
  const pending = new Map();
  let id = 0;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return { call, close: () => child.kill() };
}

// Discovery passes no servers; a request process gets Pal's inert `pi` inventory.
const server = JSON.parse(option("--mcp-config") ?? "{}").mcpServers?.pi;
const mcp = server === undefined ? undefined : startMcp(server);
await mcp?.call("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
const inventory = (await mcp?.call("tools/list"))?.tools ?? [];
if (mcp !== undefined) log({ mcp: server.args[0], tools: inventory.map(({ name }) => name) });
const settingsFile = option("--settings");
const extraBody =
  settingsFile === undefined
    ? {}
    : JSON.parse(JSON.parse(readFileSync(settingsFile, "utf8")).env?.CLAUDE_CODE_EXTRA_BODY ?? "{}");
const systemFile = option("--system-prompt-file");
const system = systemFile === undefined ? "" : readFileSync(systemFile, "utf8");

/** Rebuild the assistant message from the relayed event stream, as Claude Code does. */
function assemble(events) {
  let message;
  const json = new Map();
  for (const event of events) {
    if (event.type === "message_start") message = { ...event.message, content: [] };
    else if (event.type === "content_block_start") message.content[event.index] = { ...event.content_block };
    else if (event.type === "content_block_delta") {
      const block = message.content[event.index];
      const { delta } = event;
      if (delta.type === "text_delta") block.text += delta.text;
      else if (delta.type === "thinking_delta") block.thinking += delta.thinking;
      else if (delta.type === "signature_delta") block.signature += delta.signature;
      else if (delta.type === "input_json_delta")
        json.set(event.index, (json.get(event.index) ?? "") + delta.partial_json);
    } else if (event.type === "content_block_stop" && json.has(event.index))
      message.content[event.index].input = JSON.parse(json.get(event.index));
    else if (event.type === "message_delta")
      Object.assign(message, event.delta, { usage: { ...message.usage, ...event.usage } });
  }
  return message;
}

const sse = (text) =>
  text
    .split(/\n\n/)
    .flatMap((frame) => frame.split("\n").filter((line) => line.startsWith("data:")))
    .map((line) => JSON.parse(line.slice(5)));
const echoUuid = (frame) => (frame.uuid ? { user_message_uuids: [frame.uuid] } : {});
const reminder = { type: "text", text: "<system-reminder>fixture reminder</system-reminder>" };
const history = [];
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
    console.log(
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: frame.request_id,
          response: {
            models: [
              {
                value: "sonnet",
                resolvedModel: "claude-sonnet-4-5",
                displayName: "Sonnet",
                description: "Fixture model",
                supportsAdaptiveThinking: true,
              },
            ],
          },
        },
      }),
    );
    continue;
  }
  if (frame.type === "assistant") {
    history.push(frame.message);
    continue;
  }
  if (frame.type !== "user") continue;
  history.push(frame.message);
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", num_turns: 0, ...echoUuid(frame) }));
    continue;
  }
  const latest = { ...frame.message, content: [reminder, ...frame.message.content] };
  const body = {
    model: option("--model"),
    max_tokens: 32_000,
    stream: true,
    system: [{ type: "text", text: system }],
    messages: [...history.slice(0, -1), latest],
    tools: inventory.map((tool) => ({
      name: `mcp__pi__${tool.name}`,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
    ...extraBody,
  };
  const attempts = [];
  let events;
  for (let attempt = 0; attempt < 2 && events === undefined; attempt++) {
    const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: "Bearer fake-claude-code-login",
      },
      body: JSON.stringify(body),
    }).catch((error) => ({ status: 0, text: async () => String(error) }));
    const text = await response.text().catch((error) => String(error));
    attempts.push({ status: response.status, body: text.slice(0, 200) });
    if (response.status === 200) events = sse(text);
    else if (response.status < 500) break;
  }
  log({ attempts });
  if (events === undefined) {
    console.log(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, ...echoUuid(frame) }),
    );
    continue;
  }
  for (const event of events) console.log(JSON.stringify({ type: "stream_event", event }));
  const message = assemble(events);
  history.push({ role: "assistant", content: message.content });
  console.log(JSON.stringify({ type: "assistant", message }));
  const calls = message.content.filter((block) => block.type === "tool_use");
  if (calls.length > 0) {
    // Claude Code runs the call itself before its one-turn limit ends the request; Pal's inventory only denies it.
    for (const call of calls) {
      const result = await mcp.call("tools/call", { name: call.name.replace(/^mcp__pi__/, ""), arguments: call.input });
      log({ toolCall: call.name, denied: result.isError === true, text: result.content?.[0]?.text });
    }
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        usage: message.usage,
        ...echoUuid(frame),
      }),
    );
    continue;
  }
  console.log(
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        isUsingOverage: settings().overage === true,
        overageStatus: "allowed",
      },
    }),
  );
  console.log(
    JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: message.usage, ...echoUuid(frame) }),
  );
}
mcp?.close();
