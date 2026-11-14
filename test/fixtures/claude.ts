import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/** Install the fake Claude Code at `path`, run by this Node directly: build sandboxes have no `/usr/bin/env`. */
export async function installFakeClaude(path: string): Promise<void> {
  const source = await readFile(join(import.meta.dirname, "fake-claude.mjs"), "utf8");
  await writeFile(path, `#!${process.execPath}\n${source.slice(source.indexOf("\n") + 1)}`, { mode: 0o755 });
}

type Block = { type: string; text?: string; content?: unknown };
export type UpstreamRequest = {
  readonly headers: IncomingHttpHeaders;
  readonly body: { messages: { role: string; content: Block[] }[]; tools?: { name: string }[] };
  /** The connection closed before the reply ended. */
  cut: boolean;
};

const USAGE = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/**
 * A loopback Anthropic Messages API that Pal's relay forwards to. The last user message picks the reply: a
 * `codemode` call for "call-tool" (until its result is sent), a 529 the first time for "overloaded-once", a stream
 * that never ends for "hold", and otherwise reasoning plus "Hello from Claude Code".
 */
export async function startFakeAnthropic() {
  const requests: UpstreamRequest[] = [];
  let overloaded = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const seen: UpstreamRequest = {
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as UpstreamRequest["body"],
        cut: false,
      };
      requests.push(seen);
      response.on("close", () => (seen.cut = !response.writableFinished));
      const last = seen.body.messages.at(-1)?.content ?? [];
      const said = last.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      if (said.includes("overloaded-once") && overloaded++ === 0) return void response.writeHead(529).end();
      response.writeHead(200, { "content-type": "text/event-stream", "request-id": `req_fake_${requests.length}` });
      const send = (event: { type: string } & Record<string, unknown>) =>
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const message = { id: `msg_fake_${requests.length}`, type: "message", role: "assistant", content: [] };
      send({ type: "message_start", message: { ...message, stop_reason: null, usage: USAGE } });
      if (said.includes("hold")) return;
      const blocks: [Record<string, unknown>, Record<string, unknown>][] =
        said.includes("call-tool") && !last.some((block) => block.type === "tool_result")
          ? [
              [
                { type: "tool_use", id: "toolu_fake", name: "mcp__pi__codemode", input: {} },
                { type: "input_json_delta", partial_json: JSON.stringify({ code: "return 'tool ran';" }) },
              ],
            ]
          : [
              [
                { type: "thinking", thinking: "", signature: "" },
                { type: "thinking_delta", thinking: "Fixture reasoning" },
              ],
              [
                { type: "text", text: "" },
                { type: "text_delta", text: "Hello from Claude Code" },
              ],
            ];
      blocks.forEach(([block, delta], index) => {
        send({ type: "content_block_start", index, content_block: block });
        send({ type: "content_block_delta", index, delta });
        if (block.type === "thinking")
          send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
        send({ type: "content_block_stop", index });
      });
      const stop = blocks[0]?.[0].type === "tool_use" ? "tool_use" : "end_turn";
      send({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } });
      send({ type: "message_stop" });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
