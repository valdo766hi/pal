#!/usr/bin/env node
// A stand-in for the Claude Code CLI, adapted from pi-claude-code's tests (MIT): `auth status`, `--version` and the
// stream-json mode. It reads its behaviour from `fake-claude.json` beside it, because Pal starts it with an allowlisted
// environment, and appends what it saw (PID, mode, environment names, whether a planted secret leaked) to
// `fake-claude.log`.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";

const here = dirname(process.argv[1]);
// Read again for every turn: a warm process serves several.
const settings = () =>
  existsSync(join(here, "fake-claude.json")) ? JSON.parse(readFileSync(join(here, "fake-claude.json"), "utf8")) : {};
const config = settings();
const mode = process.argv.includes("auth") ? "status" : process.argv.includes("--version") ? "version" : "stream";
const secret = config.secret ?? "";
appendFileSync(
  join(here, "fake-claude.log"),
  `${JSON.stringify({
    pid: process.pid,
    mode,
    request: process.argv.includes("--system-prompt-file"),
    cwd: process.cwd(),
    env: Object.keys(process.env).sort(),
    leaked: secret !== "" && Object.values(process.env).some((value) => value?.includes(secret)),
  })}\n`,
);
if (mode === "status") {
  console.log(JSON.stringify(config.auth ?? { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));
  process.exit(0);
}
if (mode === "version") {
  console.log("2.1.0 (Claude Code)");
  process.exit(0);
}

const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const echoUuid = (frame) => (frame.uuid ? { user_message_uuids: [frame.uuid] } : {});
const texts = (frame) =>
  (Array.isArray(frame.message?.content) ? frame.message.content : [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
let turn = 0;
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
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", num_turns: 0, ...echoUuid(frame) }));
    continue;
  }
  if (frame.type !== "user") continue;
  turn += 1;
  const id = `m_fake_${process.pid}_${turn}`;
  if (texts(frame).includes("call-tool")) {
    const content = [
      { type: "tool_use", id: "tool_fake", name: "mcp__pi__codemode", input: { code: "return 'tool ran';" } },
    ];
    console.log(JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }));
    console.log(
      JSON.stringify({
        type: "assistant",
        message: { id, role: "assistant", content, stop_reason: "tool_use", usage },
      }),
    );
    console.log(
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, usage, ...echoUuid(frame) }),
    );
    continue;
  }
  const current = settings();
  const reply = current.reply ?? "Hello from Claude Code";
  const events = [
    { type: "message_start", message: { id, role: "assistant", content: [], usage } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Fixture reasoning" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: reply } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
    { type: "message_stop" },
  ];
  for (const event of events) console.log(JSON.stringify({ type: "stream_event", event }));
  const content = [
    { type: "thinking", thinking: "Fixture reasoning", signature: "sig" },
    { type: "text", text: reply },
  ];
  console.log(
    JSON.stringify({ type: "assistant", message: { id, role: "assistant", content, stop_reason: "end_turn", usage } }),
  );
  console.log(
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        isUsingOverage: current.overage === true,
        overageStatus: "allowed",
      },
    }),
  );
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage, ...echoUuid(frame) }));
}
