import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";

export const MIN_PASSPHRASE_CHARS = 12;
export const SESSION_COOKIE = "pal_session";
const SESSION_MS = 30 * 24 * 60 * 60_000;
// scrypt N=2^15, r=8: about 32 MiB and tens of milliseconds per attempt.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 10;

export class OwnerError extends Error {
  readonly code: "exists" | "invalid_setup" | "weak_passphrase" | "wrong_passphrase" | "throttled";

  constructor(code: OwnerError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The installation's single owner: a passphrase, set once through a setup token shown only on the host's terminal,
 * and opaque session tokens of which only hashes are stored.
 */
export class Owner {
  readonly #database: SqliteDatabase;
  readonly #now: () => number;
  /** Shown on the terminal at startup while no owner exists; valid until used or the process stops. */
  readonly setupToken: string = randomBytes(24).toString("base64url");
  #failures: number[] = [];
  #pending = 0;

  constructor(database: SqliteDatabase, now: () => number = Date.now) {
    this.#database = database;
    this.#now = now;
  }

  async exists(): Promise<boolean> {
    return (await this.#database.get("SELECT 1 AS present FROM pal_owner")) !== undefined;
  }

  /** Create the owner and return a session token. */
  async setup(setupToken: string, passphrase: string): Promise<string> {
    if (!equal(setupToken, this.setupToken)) throw new OwnerError("invalid_setup", "the setup link is not valid");
    if ([...passphrase].length < MIN_PASSPHRASE_CHARS) {
      throw new OwnerError("weak_passphrase", `use at least ${MIN_PASSPHRASE_CHARS} characters`);
    }
    const stored = await hashPassphrase(passphrase);
    const created = await this.#database.transaction(async (tx) => {
      if ((await tx.get("SELECT 1 AS present FROM pal_owner")) !== undefined) return false;
      await tx.run("INSERT INTO pal_owner (singleton, passphrase, created_at) VALUES (1, ?, ?)", stored, this.#now());
      return true;
    });
    if (!created) throw new OwnerError("exists", "this Pal already has an owner");
    return this.#startSession();
  }

  async signIn(passphrase: string): Promise<string> {
    const now = this.#now();
    this.#failures = this.#failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    if (this.#failures.length + this.#pending >= MAX_FAILURES)
      throw new OwnerError("throttled", "too many attempts; try again later");
    this.#pending++;
    try {
      const row = await this.#database.get<{ passphrase: string }>("SELECT passphrase FROM pal_owner");
      if (row === undefined || !(await verifyPassphrase(passphrase, row.passphrase))) {
        this.#failures.push(this.#now());
        throw new OwnerError("wrong_passphrase", "that passphrase is not correct");
      }
      return await this.#startSession();
    } finally {
      this.#pending--;
    }
  }

  /** Whether a cookie's token is a live session. */
  async authenticate(token: string | undefined): Promise<boolean> {
    return (await this.sessionExpiry(token)) !== undefined;
  }

  /** Live observers expire with their cookie, even when no input arrives. */
  async sessionExpiry(token: string | undefined): Promise<number | undefined> {
    if (token === undefined || token === "") return undefined;
    const row = await this.#database.get<{ expires_at: number }>(
      "SELECT expires_at FROM pal_sessions WHERE token_hash = ?",
      tokenHash(token),
    );
    return row !== undefined && row.expires_at > this.#now() ? row.expires_at : undefined;
  }

  async signOut(token: string | undefined): Promise<void> {
    if (token !== undefined)
      await this.#database.run("DELETE FROM pal_sessions WHERE token_hash = ?", tokenHash(token));
  }

  async #startSession(): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const now = this.#now();
    await this.#database.transaction(async (tx) => {
      await tx.run("DELETE FROM pal_sessions WHERE expires_at <= ?", now);
      await tx.run(
        "INSERT INTO pal_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
        tokenHash(token),
        now,
        now + SESSION_MS,
      );
    });
    return token;
  }
}

export const SESSION_MAX_AGE_SECONDS = SESSION_MS / 1000;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(passphrase.normalize("NFC"), salt, 32, SCRYPT, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${salt.toString("base64url")}$${(await derive(passphrase, salt)).toString("base64url")}`;
}

async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const [scheme, n, r, salt, key] = stored.split("$");
  if (
    scheme !== "scrypt" ||
    Number(n) !== SCRYPT.N ||
    Number(r) !== SCRYPT.r ||
    salt === undefined ||
    key === undefined
  ) {
    throw new Error("unknown passphrase format");
  }
  const expected = Buffer.from(key, "base64url");
  const actual = await derive(passphrase, Buffer.from(salt, "base64url"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
