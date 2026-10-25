import { scrypt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Owner, OwnerError } from "../src/core/owner.ts";
import { openStore } from "../src/storage/store.ts";

vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof import("node:crypto")>();
  return { ...crypto, scrypt: vi.fn(crypto.scrypt) };
});

const passphrase = "correct horse battery";
const windowMs = 10 * 60_000;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pal-owner-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = await openStore(root);
  cleanups.push(() => store.close());
  let now = Date.now();
  const owner = new Owner(store.database, () => now);
  await owner.setup(owner.setupToken, passphrase);
  vi.mocked(scrypt).mockClear();
  const wrong = () =>
    owner.signIn("incorrect").then(
      () => "accepted",
      (error: unknown) => {
        if (!(error instanceof OwnerError)) throw error;
        return error.code;
      },
    );
  return { owner, database: store.database, wrong, advance: (ms: number) => (now += ms) };
}

describe("owner sign-in admission", () => {
  it.each(["sequential", "concurrent"])("bounds real scrypt submissions for %s wrong attempts", async (mode) => {
    const { owner, wrong, advance } = await setup();
    const results: string[] = [];
    if (mode === "concurrent") results.push(...(await Promise.all(Array.from({ length: 30 }, wrong))));
    else for (let i = 0; i < 30; i++) results.push(await wrong());
    expect(results.filter((code) => code === "wrong_passphrase")).toHaveLength(10);
    expect(results.filter((code) => code === "throttled")).toHaveLength(20);
    expect(scrypt).toHaveBeenCalledTimes(10);
    await expect(owner.signIn(passphrase)).rejects.toMatchObject({ code: "throttled" });
    advance(windowMs + 1);
    const token = await owner.signIn(passphrase);
    expect(await owner.authenticate(token)).toBe(true);
    expect(scrypt).toHaveBeenCalledTimes(11);
  });

  it("does not age out pending reservations while their database reads wait", async () => {
    const { owner, database, wrong, advance } = await setup();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const locked = database.transaction(async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;
    const pending = Array.from({ length: 10 }, wrong);
    advance(windowMs + 1);
    const extra = wrong();
    release.resolve(undefined);
    await locked;
    expect(await Promise.all(pending)).toEqual(Array(10).fill("wrong_passphrase"));
    expect(await extra).toBe("throttled");
    expect(scrypt).toHaveBeenCalledTimes(10);
    await expect(owner.signIn(passphrase)).rejects.toMatchObject({ code: "throttled" });
    advance(windowMs + 1);
    expect(await owner.authenticate(await owner.signIn(passphrase))).toBe(true);
  });

  it("releases successful attempts without consuming the failure window", async () => {
    const { owner } = await setup();
    for (let i = 0; i < 12; i++) {
      const token = await owner.signIn(passphrase);
      expect(await owner.authenticate(token)).toBe(true);
      await owner.signOut(token);
    }
    expect(scrypt).toHaveBeenCalledTimes(12);
  });

  it.each(["verification", "session"])("releases reservations after %s exceptions", async (phase) => {
    const { owner, database } = await setup();
    const stored = await database.get<{ passphrase: string }>("SELECT passphrase FROM pal_owner");
    if (stored === undefined) throw new Error("missing fixture owner");
    if (phase === "verification") await database.run("UPDATE pal_owner SET passphrase = 'invalid-format'");
    else
      await database.exec(`
        CREATE TEMP TRIGGER reject_session BEFORE INSERT ON pal_sessions
        BEGIN SELECT RAISE(ABORT, 'fixture session failure'); END;
      `);
    for (let i = 0; i < 12; i++)
      await expect(owner.signIn(passphrase)).rejects.toThrow(
        phase === "verification" ? "unknown passphrase format" : "fixture session failure",
      );
    if (phase === "verification") await database.run("UPDATE pal_owner SET passphrase = ?", stored.passphrase);
    else await database.exec("DROP TRIGGER reject_session");
    expect(await owner.authenticate(await owner.signIn(passphrase))).toBe(true);
  });
});
