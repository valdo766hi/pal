// Loopback stand-in for auth.openai.com and api.openai.com's Sign in with ChatGPT routes, with switchable misbehavior.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ChatGPTEndpoints } from "../../src/pi/chatgpt.ts";

export const DIRECT_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

export type FixtureBehavior = {
  accountId: string;
  callback: "ok" | "deny" | "omit_client" | "other_client";
  /** Overrides for the next ID tokens; `stranger` signs with a key the JWKS does not publish. */
  idToken: { nonce?: string; issuer?: string; audience?: string; expiresIn?: number; stranger?: boolean };
  scope: string;
  responses: "ok" | "truncated" | "usage_limit" | "script";
  /** In `script` mode, the first response calls `codemode` with this script; the follow-up answers in text. */
  script: string;
  /** The assistant's text answer. */
  reply: string;
  /** While set, JWKS responses wait for it, which holds ID-token verification mid-sign-in. */
  jwks?: Promise<unknown>;
};

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

function sse(events: object[]): string {
  return events
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

export async function startOpenAIFixture() {
  const signing = await generateKeyPair("RS256");
  const stranger = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: "fixture", alg: "RS256", use: "sig" };
  const behavior: FixtureBehavior = {
    accountId: "user-1",
    callback: "ok",
    idToken: {},
    scope: DIRECT_SCOPE,
    responses: "ok",
    script: "return 1;",
    reply: "Hello",
  };
  const authorizations: URLSearchParams[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const apiRequests: { path: string; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  let jwksRequests = 0;
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string; nonce: string }>();
  const liveRefreshTokens = new Set<string>();
  let counter = 0;
  let issuer = "";

  async function tokens(clientId: string, nonce: string | undefined) {
    counter += 1;
    const refresh = `refresh-${counter}`;
    liveRefreshTokens.add(refresh);
    const claims = behavior.idToken;
    const idToken = await new SignJWT({
      email: "owner@example.test",
      ...(nonce === undefined ? {} : { nonce: claims.nonce ?? nonce }),
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(claims.issuer ?? issuer)
      .setAudience(claims.audience ?? clientId)
      .setSubject(behavior.accountId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (claims.expiresIn ?? 600))
      .sign((claims.stranger ? stranger : signing).privateKey);
    return {
      access_token: `access-${counter}`,
      refresh_token: refresh,
      id_token: idToken,
      scope: behavior.scope,
      expires_in: 3600,
    };
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/oauth/authorize") {
      const params = url.searchParams;
      authorizations.push(params);
      const back = new URL(params.get("redirect_uri") ?? "");
      back.searchParams.set("state", params.get("state") ?? "");
      if (behavior.callback === "deny") {
        back.searchParams.set("error", "access_denied");
      } else {
        const issued =
          params.get("client_id") === "dynamic_agent_client" ? "oaiapp_fixture" : (params.get("client_id") ?? "");
        const code = `code-${++counter}`;
        codes.set(code, {
          challenge: params.get("code_challenge") ?? "",
          redirectUri: back.origin + back.pathname,
          clientId: issued,
          nonce: params.get("nonce") ?? "",
        });
        back.searchParams.set("code", code);
        if (behavior.callback === "ok") back.searchParams.set("client_id", issued);
        if (behavior.callback === "other_client") back.searchParams.set("client_id", "oaiapp_other");
      }
      response.writeHead(302, { location: back.toString() });
      response.end();
    } else if (url.pathname === "/oauth/token" && request.method === "POST") {
      const form = new URLSearchParams(await body(request));
      tokenRequests.push(form);
      if (form.get("grant_type") === "authorization_code") {
        const pending = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          pending === undefined ||
          pending.challenge !== challenge ||
          pending.redirectUri !== form.get("redirect_uri") ||
          pending.clientId !== form.get("client_id")
        ) {
          return json(400, { error: "invalid_grant" });
        }
        return json(200, await tokens(pending.clientId, pending.nonce));
      }
      const refresh = form.get("refresh_token") ?? "";
      if (!liveRefreshTokens.delete(refresh)) return json(400, { error: "refresh_token_reused" });
      return json(200, await tokens(form.get("client_id") ?? "", undefined));
    } else if (url.pathname === "/jwks") {
      jwksRequests++;
      await behavior.jwks;
      json(200, { keys: [jwk] });
    } else if (url.pathname.startsWith("/v1/")) {
      const text = request.method === "POST" ? await body(request) : "";
      apiRequests.push({
        path: url.pathname,
        authorization: request.headers.authorization,
        body: text === "" ? {} : JSON.parse(text),
      });
      if (url.pathname === "/v1/models") {
        return json(200, {
          models: [
            { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
            { slug: "internal-preview", display_name: "Hidden", visibility: "hide" },
            { slug: "gpt-unknown-next", display_name: "Next", visibility: "list" },
            { slug: "gpt-5.4-mini", display_name: "GPT-5.4 mini", visibility: "list" },
          ],
        });
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const created = { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } };
      const message = { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] };
      const done = {
        ...message,
        status: "completed",
        content: [{ type: "output_text", text: behavior.reply, annotations: [] }],
      };
      const usage = { input_tokens: 3, output_tokens: 1, total_tokens: 4 };
      const events: object[] = [created];
      // Dynamic prompt updates may follow the tool result without starting a new user turn.
      const latest = (apiRequests.at(-1)?.body.input as { type?: string; role?: string }[] | undefined)?.findLast(
        (item) => item.role !== "developer" && item.role !== "system",
      );
      const answered = latest?.type === "custom_tool_call_output" || latest?.type === "function_call_output";
      if (behavior.responses === "script" && !answered) {
        const call = {
          id: `fc_${counter}`,
          type: "function_call",
          call_id: `call_script_${++counter}`,
          name: "codemode",
          arguments: JSON.stringify({ code: behavior.script }),
          status: "completed",
        };
        events.push(
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...call, arguments: "", status: "in_progress" },
          },
          { type: "response.function_call_arguments.delta", output_index: 0, item_id: call.id, delta: call.arguments },
          {
            type: "response.function_call_arguments.done",
            output_index: 0,
            item_id: call.id,
            arguments: call.arguments,
          },
          { type: "response.output_item.done", output_index: 0, item: call },
          { type: "response.completed", response: { id: "resp_1", status: "completed", output: [call], usage } },
        );
      } else if (behavior.responses === "usage_limit") {
        events.push({
          type: "response.failed",
          response: {
            id: "resp_1",
            status: "failed",
            error: { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit reached" },
          },
        });
      } else {
        events.push(
          { type: "response.output_item.added", output_index: 0, item: message },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            item_id: "msg_1",
            delta: behavior.reply,
          },
        );
        if (behavior.responses !== "truncated") {
          events.push(
            { type: "response.output_item.done", output_index: 0, item: done },
            { type: "response.completed", response: { id: "resp_1", status: "completed", output: [done], usage } },
          );
        }
      }
      response.end(sse(events));
    } else {
      json(404, { error: "not_found" });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints: ChatGPTEndpoints = {
    issuer,
    authorizeUrl: `${issuer}/oauth/authorize`,
    tokenUrl: `${issuer}/oauth/token`,
    jwksUrl: `${issuer}/jwks`,
    apiBaseUrl: `${issuer}/v1`,
    callbackPort: 0,
  };
  return {
    endpoints,
    behavior,
    authorizations,
    tokenRequests,
    apiRequests,
    jwksRequests: () => jwksRequests,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Follow the authorize redirect to the callback, as the owner's browser would. */
export async function browse(authUrl: string): Promise<Response> {
  const redirect = await fetch(authUrl, { redirect: "manual" });
  const location = redirect.headers.get("location");
  if (location === null) throw new Error(`authorize answered ${redirect.status} without a redirect`);
  return await fetch(location);
}
