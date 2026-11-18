import { type ChildProcess, spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { browse } from "./fixtures/openai-server.ts";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** Run one listener in its own process (`fixtures/listener-host.ts`) and read the JSON lines it prints. */
function host(kind: "chatgpt" | "relay") {
  const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/listener-host.ts"), kind], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const next = async (): Promise<Record<string, any>> => JSON.parse((await lines.next()).value ?? "{}");
  return { child, exited, next };
}

/** Send a request whose target no URL parser accepts; the status the listener answers, if it answers at all. */
function rawStatus(origin: string, target: string): Promise<number | undefined> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve) => {
    let text = "";
    const socket = connect(Number(port), hostname, () =>
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`),
    );
    socket.on("data", (chunk) => (text += chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(text)?.[1];
      resolve(status === undefined ? undefined : Number(status));
    });
  });
}

describe("loopback listeners", () => {
  it("answer a malformed ChatGPT callback target with 400 and still complete the sign-in", async () => {
    const chatgpt = host("chatgpt");
    const { authUrl } = await chatgpt.next();
    const redirect = new URL(new URL(authUrl).searchParams.get("redirect_uri") ?? "");
    expect(await rawStatus(redirect.origin, "//[")).toBe(400);
    expect((await browse(authUrl)).status).toBe(200);
    expect(await chatgpt.next()).toEqual({ signedIn: "user-1" });
    expect(await chatgpt.exited).toBe(0);
  });

  it("answer a malformed Claude Code relay target with 400 and still relay the turn", async () => {
    const relay = host("relay");
    const { baseUrl } = await relay.next();
    expect(await rawStatus(baseUrl, "//[")).toBe(400);
    const relayed = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
    expect(relayed.status).toBe(418);
    expect(relay.child.exitCode).toBeNull();
  });
});
