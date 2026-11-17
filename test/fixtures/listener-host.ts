// Runs one of Pal's loopback listeners alone in this process, so a request that crashes the listener ends it.
// `chatgpt` prints {"authUrl"}, then {"signedIn"} once the browser's callback completes the sign-in and exits;
// `relay` prints {"baseUrl"} for a Claude Code turn relay in front of an upstream that answers 418, and serves until
// killed.
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnRelay } from "../../plugins/claude-code/vendor/turn-relay.ts";
import { ChatGPTConnection } from "../../src/pi/chatgpt.ts";
import { loadMasterKey, SqliteCredentialStore } from "../../src/storage/credentials.ts";
import { openStore } from "../../src/storage/store.ts";
import { startOpenAIFixture } from "./openai-server.ts";

const print = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);

if (process.argv[2] === "relay") {
  const upstream = createServer((request, response) => {
    request.resume();
    request.once("end", () => response.writeHead(418).end());
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const relay = new TurnRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  print({ baseUrl: await relay.start() });
} else {
  const fixture = await startOpenAIFixture();
  const dataRoot = await mkdtemp(join(tmpdir(), "pal-listener-host-"));
  try {
    const store = await openStore(dataRoot);
    const credentials = new SqliteCredentialStore(
      store.database,
      await loadMasterKey(join(dataRoot, "credentials.key")),
      store.installationId,
    );
    const connection = new ChatGPTConnection(credentials, {
      endpoints: fixture.endpoints,
      installationId: store.installationId,
      agentName: "Pal",
    });
    const credential = await connection.signIn({
      signal: new AbortController().signal,
      notify: (event) => {
        if (event.type === "auth_url") print({ authUrl: event.url });
      },
      prompt: () => new Promise(() => {}),
    });
    print({ signedIn: credential.accountId });
    await store.close();
  } finally {
    await fixture.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}
