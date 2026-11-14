// Loopback stand-in for the System One classifier protocol that TypeSafe (/v1/systemone) and OpenRouter
// (/api/v1/systemone) both serve, plus OpenRouter's free key check. It records which key and model each request used.
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type SystemOneRequest = { path: string; key: string | undefined; model?: string; state?: unknown };
/** One scripted reply: a verdict, an HTTP failure, a delay or an unparseable answer. */
export type SystemOneReply =
  | { choice: string; confidence: number; delayMs?: number }
  | { status: number }
  | { delayMs: number }
  | { malformed: true };

export async function startSystemOneFixture(keys: readonly string[]) {
  const replies: SystemOneReply[] = [];
  const requests: SystemOneRequest[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    const key = request.headers.authorization?.replace(/^Bearer /, "");
    const body = text === "" ? {} : (JSON.parse(text) as { model?: string; state?: unknown });
    requests.push({ path, key, ...(body.model === undefined ? {} : { model: body.model, state: body.state }) });
    const json = (status: number, value: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (key === undefined || !keys.includes(key)) return json(401, { error: { message: "invalid key" } });
    if (path === "/api/v1/key" && request.method === "GET") return json(200, { data: { usage: 0.5, limit: 10 } });
    if (path !== "/v1/systemone" && path !== "/api/v1/systemone") return json(404, {});
    const reply = replies.shift() ?? { choice: "run", confidence: 0.96 };
    if ("delayMs" in reply && reply.delayMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    if ("status" in reply) return json(reply.status, { error: { message: "fixture failure" } });
    if ("malformed" in reply) return json(200, { answers: { verdict: { type: "choice" } } });
    if (!("choice" in reply)) return json(200, { answers: {} });
    const other = reply.choice === "run" ? "ask" : "run";
    return json(200, {
      answers: {
        verdict: {
          type: "choice",
          choice: reply.choice,
          probabilities: { [reply.choice]: reply.confidence, [other]: 1 - reply.confidence },
          confidence: reply.confidence,
        },
      },
      usage: { input_tokens: 120, output_tokens: 1 },
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    replies,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
