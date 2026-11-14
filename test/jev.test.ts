import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { openPal } from "../src/core/app.ts";
import { InvalidRequest } from "../src/core/requests.ts";
import { startSystemOneFixture } from "./fixtures/system-one-server.ts";

const TYPESAFE_KEY = "typesafe-fixture";
const OPENROUTER_KEY = "openrouter-fixture";
const REQUEST = {
  tool: "shell_run",
  command: "pnpm test",
  cwd: "/srv/project",
  timeoutSeconds: 120,
  folderAccess: "write",
} as const;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = await startSystemOneFixture([TYPESAFE_KEY, OPENROUTER_KEY]);
  cleanups.push(fixture.close);
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-jev-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install", providerOrigin: fixture.origin }, context);
  cleanups.push(() => pal.close());
  const jev = (method: string, path: string, body?: unknown) =>
    pal.capabilities.request(
      "jev",
      { method, path: path.split("/"), query: new URLSearchParams(), body },
      context,
    ) as Promise<Record<string, unknown>>;
  const advisor = pal.capabilities.advisor;
  if (advisor === undefined) throw new Error("Jev is not this build's advisor");
  const advise = () => advisor.advise(REQUEST, AbortSignal.timeout(10_000));
  return { pal, fixture, jev, advisor, advise };
}

describe("Jev advisor plugin", () => {
  it("decides through the chosen connection with only that connection's key and fixed model", async () => {
    const f = await setup();
    expect(f.advisor.label).toBe("Jev");
    expect(await f.advisor.status()).toEqual({ ready: false, note: "Add a Jev key in Settings → Jev" });
    await expect(f.advise()).rejects.toThrow("no TypeSafe key");
    expect(f.fixture.requests).toEqual([]);

    await f.jev("PUT", "keys/typesafe", { key: TYPESAFE_KEY });
    expect((await f.advisor.status()).note).toContain("sent to Jev through TypeSafe");
    expect(await f.advise()).toMatchObject({
      verdict: "run",
      confidence: 0.96,
      threshold: 0.9,
      model: "jev-latest",
      via: "TypeSafe",
      tokens: 121,
    });
    expect(f.fixture.requests).toEqual([
      { path: "/v1/systemone", key: TYPESAFE_KEY, model: "jev-latest", state: REQUEST },
    ]);

    // Switching never moves the key: OpenRouter has none until one is entered for it.
    await f.jev("PUT", "connection", { connection: "openrouter" });
    expect(await f.advisor.status()).toMatchObject({ ready: false });
    await f.jev("PUT", "keys/openrouter", { key: OPENROUTER_KEY });
    await f.jev("PUT", "threshold", { threshold: 0.8 });
    f.fixture.replies.push({ choice: "ask", confidence: 0.7 });
    const advice = await f.advise();
    expect(advice).toMatchObject({
      verdict: "ask",
      confidence: 0.7,
      threshold: 0.8,
      model: "typesafe/jev-1.14",
      via: "OpenRouter",
    });
    expect(advice.costUsd).toBeGreaterThan(0);
    expect(f.fixture.requests.at(-1)).toEqual({
      path: "/api/v1/systemone",
      key: OPENROUTER_KEY,
      model: "typesafe/jev-1.14",
      state: REQUEST,
    });
  });

  it("fails without retrying or trying the other connection, and reports why", async () => {
    const f = await setup();
    await f.jev("PUT", "keys/typesafe", { key: TYPESAFE_KEY });
    await f.jev("PUT", "keys/openrouter", { key: OPENROUTER_KEY });
    await f.jev("PUT", "connection", { connection: "openrouter" });
    f.fixture.replies.push({ status: 500 }, { malformed: true });
    await expect(f.advise()).rejects.toThrow(/500/);
    await expect(f.advise()).rejects.toThrow(/did not return a choice answer|an unexpected answer/);
    expect(f.fixture.requests.map((request) => request.path)).toEqual(["/api/v1/systemone", "/api/v1/systemone"]);
    const status = await f.jev("GET", "status");
    expect(status.recent).toMatchObject([
      { connection: "openrouter", command: "pnpm test", error: expect.any(String) },
      { connection: "openrouter", command: "pnpm test", error: expect.any(String) },
    ]);
  });

  it("keeps keys sealed, apart and write-only, and checks each connection's key", async () => {
    const f = await setup();
    await f.jev("PUT", "keys/typesafe", { key: TYPESAFE_KEY });
    await f.jev("PUT", "keys/openrouter", { key: OPENROUTER_KEY });
    const status = await f.jev("GET", "status");
    expect(status.connections).toMatchObject([
      { id: "typesafe", keySet: true, model: "jev-latest", bills: "TypeSafe credits" },
      { id: "openrouter", keySet: true, model: "typesafe/jev-1.14", bills: "OpenRouter credits" },
    ]);
    const database = f.pal.store.database;
    const stored = [
      JSON.stringify(status),
      JSON.stringify(await database.all("SELECT * FROM pal_settings")),
      JSON.stringify(await database.all("SELECT provider_id, type, retained FROM pal_credentials")),
      Buffer.concat(
        (await database.all<{ sealed: Uint8Array }>("SELECT sealed FROM pal_credentials WHERE sealed IS NOT NULL")).map(
          (row) => Buffer.from(row.sealed),
        ),
      ).toString("latin1"),
    ].join("\n");
    for (const key of [TYPESAFE_KEY, OPENROUTER_KEY]) expect(stored).not.toContain(key);
    expect(
      (await database.all<{ provider_id: string }>("SELECT provider_id FROM pal_credentials ORDER BY provider_id")).map(
        (row) => row.provider_id,
      ),
    ).toEqual(["plugin:jev:openrouter-key", "plugin:jev:typesafe-key"]);

    expect(await f.jev("POST", "keys/openrouter/check")).toEqual({ ok: true, detail: "OpenRouter accepted the key." });
    expect(f.fixture.requests.at(-1)).toMatchObject({ path: "/api/v1/key", key: OPENROUTER_KEY });
    expect(await f.jev("POST", "keys/typesafe/check")).toEqual({
      ok: true,
      detail: "TypeSafe answered a test classification (billed).",
    });
    expect(f.fixture.requests.at(-1)).toMatchObject({ path: "/v1/systemone", key: TYPESAFE_KEY });
    await f.jev("PUT", "keys/openrouter", { key: "openrouter-wrong" });
    expect(await f.jev("POST", "keys/openrouter/check")).toEqual({ ok: false, detail: "OpenRouter refused the key." });

    await f.jev("DELETE", "keys/typesafe");
    expect(await f.advisor.status()).toMatchObject({ ready: false });
    await expect(f.jev("POST", "keys/typesafe/check")).rejects.toMatchObject({ code: "jev_no_key" });
    for (const [path, body] of [
      ["connection", { connection: "anthropic" }],
      ["keys/typesafe", { key: "short" }],
      ["threshold", { threshold: 0.2 }],
    ] as const)
      await expect(f.jev("PUT", path, body)).rejects.toBeInstanceOf(InvalidRequest);
  });
});
