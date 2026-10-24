import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { BigIntStats } from "node:fs";
import {
  appendFile,
  cp,
  type FileHandle,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  rename,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseIdentity } from "../src/core/extensions.ts";
import { openStore } from "../src/storage/store.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function installation() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-identity-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const install = join(root, "install");
  await mkdir(join(install, "src"), { recursive: true });
  await mkdir(join(install, "node_modules/fixture-dep"), { recursive: true });
  await writeFile(
    join(install, "package.json"),
    JSON.stringify({ name: "pal", dependencies: { "fixture-dep": "1.0.0" } }),
  );
  await writeFile(join(install, "pnpm-lock.yaml"), "fixture-lock-v1\n");
  await writeFile(join(install, "src/tool.mjs"), "export const value = 'one';\n");
  await writeFile(
    join(install, "node_modules/fixture-dep/package.json"),
    JSON.stringify({ name: "fixture-dep", version: "1.0.0", type: "module", exports: "./index.mjs" }),
  );
  await writeFile(join(install, "node_modules/fixture-dep/index.mjs"), "export const value = 'one';\n");
  return { root, install };
}

describe("mutable implementation identity", () => {
  it("hashes partial reads exactly without redundant EOF reads", async () => {
    const { root, install } = await installation();
    await writeFile(join(install, "src/empty.mjs"), "");
    await writeFile(join(install, "src/large.mjs"), "x".repeat(128 * 1024 + 17));
    const expected = await releaseIdentity(install);
    const copy = join(root, "copy");
    await cp(install, copy, { recursive: true });
    const handle = await open(join(copy, "src/tool.mjs"), "r");
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    const read = prototype.read;
    let reads = 0,
      empty = 0;
    const spy = vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, ...args: unknown[]) {
      if (typeof args[2] === "number") args[2] = Math.min(args[2], 1024);
      const part = (await Reflect.apply(read, this, args)) as Awaited<ReturnType<FileHandle["read"]>>;
      reads++;
      if (part.bytesRead === 0) empty++;
      return part;
    });
    try {
      expect(await releaseIdentity(copy)).toBe(expected);
      expect(reads).toBeGreaterThan(128);
      expect(empty).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["grow", "shrink"] as const)("refuses files that %s after the descriptor size check", async (change) => {
    const { install } = await installation();
    const path = join(install, "src/tool.mjs");
    const inode = (await stat(path, { bigint: true })).ino;
    const handle = await open(path, "r");
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    const inspect = prototype.stat;
    let changed = false;
    const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (this: FileHandle, ...args: unknown[]) {
      const info = (await Reflect.apply(inspect, this, args)) as BigIntStats;
      if (String(info.ino) === String(inode) && !changed) {
        changed = true;
        if (change === "grow") await appendFile(path, "changed during hashing");
        else await truncate(path, 0);
      }
      return info;
    });
    try {
      await expect(releaseIdentity(install)).rejects.toThrow(/implementation/);
      expect(changed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("hashes actual implementation bytes, even when length and mtime are restored", async () => {
    const { install } = await installation();
    const first = await releaseIdentity(install);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await releaseIdentity(install)).toBe(first);
    const path = join(install, "src/tool.mjs"),
      before = await stat(path);
    await writeFile(path, "export const value = 'two';\n");
    await utimes(path, before.atime, before.mtime);
    expect(await releaseIdentity(install)).not.toBe(first);
    await writeFile(path, "export const value = 'one';\n");
    expect(await releaseIdentity(install)).toBe(first);
    await writeFile(join(install, "src/policy.ts"), "export const permitted = false;\n");
    expect(await releaseIdentity(install)).not.toBe(first);
    await unlink(join(install, "src/policy.ts"));
    expect(await releaseIdentity(install)).toBe(first);
  });

  it("includes installed transitive and optional dependencies, not only their declared versions", async () => {
    const { install } = await installation();
    const dependency = join(install, "node_modules/fixture-dep");
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "fixture-dep",
        dependencies: { transitive: "1.0.0" },
        optionalDependencies: { optional: "1.0.0" },
      }),
    );
    await mkdir(join(install, "node_modules/transitive"));
    await writeFile(join(install, "node_modules/transitive/package.json"), JSON.stringify({ name: "transitive" }));
    const path = join(install, "node_modules/transitive/index.js");
    await writeFile(path, "original dependency\n");
    const first = await releaseIdentity(install);
    await writeFile(path, "modified dependency\n");
    expect(await releaseIdentity(install)).not.toBe(first);
    await writeFile(path, "original dependency\n");
    expect(await releaseIdentity(install)).toBe(first);
    await mkdir(join(install, "node_modules/optional"));
    await writeFile(join(install, "node_modules/optional/package.json"), JSON.stringify({ name: "optional" }));
    expect(await releaseIdentity(install)).not.toBe(first);
    await rm(join(install, "node_modules/transitive"), { recursive: true });
    await expect(releaseIdentity(install)).rejects.toThrow(/implementation|dependency/i);
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ name: "fixture-dep", dependencies: { constructor: "1.0.0" } }),
    );
    await expect(releaseIdentity(install)).rejects.toThrow(/implementation|dependency/i);
  });

  it("binds compiled server code and lockfile bytes without reading handoffs, projects or credentials", async () => {
    const { install } = await installation();
    await mkdir(join(install, "dist"));
    await writeFile(join(install, "dist/main.js"), "export const value = 1;\n");
    const first = await releaseIdentity(install);
    for (const path of ["AGENTS.md", "PLAN.md", "STACK.md", ".env", "credentials.key"])
      await writeFile(join(install, path), "private fixture, not implementation");
    await mkdir(join(install, "projects"));
    await writeFile(join(install, "projects/unrelated.js"), "not Pal code");
    expect(await releaseIdentity(install)).toBe(first);
    await writeFile(join(install, "dist/main.js"), "export const value = 2;\n");
    expect(await releaseIdentity(install)).not.toBe(first);
    await writeFile(join(install, "dist/main.js"), "export const value = 1;\n");
    await writeFile(join(install, "pnpm-lock.yaml"), "fixture-lock-v2\n");
    expect(await releaseIdentity(install)).not.toBe(first);
  });

  it("verifies the real runtime graph with a mutable native Node executable", async () => {
    const { root } = await installation();
    const script = join(root, "identity.mjs");
    const module = pathToFileURL(join(import.meta.dirname, "../src/core/extensions.ts")).href;
    await writeFile(
      script,
      `import { releaseIdentity } from ${JSON.stringify(module)}; console.log(await releaseIdentity(process.argv[2]));`,
    );
    const node = join(root, "node-one");
    await cp(await realpath(process.execPath), node);
    const identify = async (executable: string) =>
      (
        await promisify(execFile)(executable, [...process.execArgv, script, dirname(import.meta.dirname)], {
          timeout: 10_000,
        })
      ).stdout.trim();
    const first = await identify(node);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    await cp(node, join(root, "node-two"));
    expect(await identify(join(root, "node-two"))).toBe(first);
  });

  it("keeps unchanged bytes stable through installation moves and root aliases", async () => {
    const { root, install } = await installation();
    const first = await releaseIdentity(install);
    await cp(install, join(root, "copy"), { recursive: true });
    await symlink(install, join(root, "alias"));
    expect(await releaseIdentity(join(root, "copy"))).toBe(first);
    expect(await releaseIdentity(join(root, "alias"))).toBe(first);
  });

  it("pins the loaded package when an embedding supplies only a protected directory", async () => {
    const { root } = await installation();
    const protectedRoot = join(root, "protected-install");
    await mkdir(protectedRoot);
    const actual = await releaseIdentity(dirname(import.meta.dirname));
    expect(actual).toMatch(/^[a-f0-9]{64}$/);
    expect(await releaseIdentity(protectedRoot)).toBe(actual);
    await writeFile(join(protectedRoot, "unrelated.js"), "not the loaded Pal implementation");
    expect(await releaseIdentity(protectedRoot)).toBe(actual);
  });

  it("fails closed for unverifiable, linked, oversized or excessively deep runtime files", async () => {
    const { root, install } = await installation();
    const path = join(install, "src/tool.mjs");
    await unlink(path);
    await writeFile(join(root, "outside.mjs"), "outside the implementation snapshot");
    await symlink(join(root, "outside.mjs"), path);
    await expect(releaseIdentity(install)).rejects.toThrow(/implementation|link/i);
    await unlink(path);
    await writeFile(path, "");
    await truncate(path, 128 * 1024 * 1024 + 1);
    await expect(releaseIdentity(install)).rejects.toThrow(/implementation|large|limit/i);
    await unlink(path);
    await writeFile(path, "original");
    const deep = join(install, "src", ...Array<string>(34).fill("nested"));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "tool.js"), "too deep");
    await expect(releaseIdentity(install)).rejects.toThrow(/implementation|deep|limit/i);
    await rm(join(install, "src/nested"), { recursive: true });
    await unlink(join(install, "pnpm-lock.yaml"));
    await expect(releaseIdentity(install)).rejects.toThrow(/implementation|lock/i);
  });

  it.each(["source", "dependency", "database hardlink", "key hardlink"])(
    "refuses private data in %s without dropping its owner lock",
    async (location) => {
      const { root, install } = await installation();
      const dataRoot = location === "source" ? join(install, "src/private-data") : join(root, "data");
      const store = await openStore(dataRoot);
      cleanups.push(() => store.close());
      const module = pathToFileURL(join(import.meta.dirname, "../src/storage/store.ts")).href;
      async function stillOwned() {
        await expect(
          promisify(execFile)(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              `import { openStore } from ${JSON.stringify(module)}; await (await openStore(${JSON.stringify(dataRoot)})).close();`,
            ],
            { timeout: 10_000 },
          ),
        ).rejects.toThrow(/DatabaseOwnedError/);
      }
      if (location === "dependency") {
        await rm(join(install, "node_modules/fixture-dep"), { recursive: true });
        await symlink(dataRoot, join(install, "node_modules/fixture-dep"));
      }
      if (location === "database hardlink") await link(store.path, join(install, "src/private.sqlite"));
      if (location === "key hardlink") {
        await writeFile(join(dataRoot, "credentials.key"), "private fixture only");
        await link(join(dataRoot, "credentials.key"), join(install, "src/private.key"));
      }
      const failure = await releaseIdentity(install, dataRoot).then(
        () => undefined,
        (error: unknown) => error,
      );
      await stillOwned();
      expect(failure).toBeInstanceOf(Error);
      await symlink(dataRoot, join(root, "data-alias"));
      await expect(releaseIdentity(install, join(root, "data-alias"))).rejects.toThrow(/implementation/i);
      await stillOwned();
    },
  );

  it("retains the immutable Nix output identity", async () => {
    const output = `/nix/store/${"a".repeat(32)}-pal`;
    expect(await releaseIdentity(`${output}/lib/pal`)).toBe(hash(output));
    expect(await releaseIdentity(`${output}/another/path`)).toBe(hash(output));
    const actual = /^\/nix\/store\/[a-z0-9]{32}-[^/]+/.exec(process.execPath)?.[0];
    if (actual !== undefined) expect(await releaseIdentity(dirname(process.execPath))).toBe(hash(actual));
  });

  it.each(["source", "dependency", "builtin-named dependency"])(
    "blocks changed %s bytes before resuming an interrupted real Code Mode tool",
    async (change) => {
      const { root, install } = await installation();
      const name = change === "builtin-named dependency" ? "events" : "fixture-dep";
      if (name === "events") {
        await rename(join(install, "node_modules/fixture-dep"), join(install, "node_modules/events"));
        await writeFile(
          join(install, "node_modules/events/package.json"),
          JSON.stringify({ name, type: "module", exports: { "./fixture": "./index.mjs" } }),
        );
        await writeFile(
          join(install, "package.json"),
          JSON.stringify({ name: "pal", dependencies: { events: "1.0.0" } }),
        );
      }
      const source = join(install, "src/tool.mjs"),
        dependency = join(install, "node_modules", name, "index.mjs");
      const specifier = name === "events" ? "events/fixture" : name;
      await writeFile(source, `export { value } from ${JSON.stringify(specifier)};\n`);
      const before = await releaseIdentity(install);
      const childPath = join(import.meta.dirname, "fixtures/implementation-child.ts");
      async function child(mode: string) {
        const proc = spawn(
          process.execPath,
          [...process.execArgv, childPath, mode, install, join(root, "data"), join(root, "effect")],
          {
            stdio: ["ignore", "pipe", "inherit", "ipc"],
          },
        );
        let output = "";
        if (proc.stdout === null) throw new Error("fixture stdout is not piped");
        proc.stdout.on("data", (chunk) => {
          output += chunk;
        });
        const done = once(proc, "exit");
        if (mode === "start") {
          try {
            const message = await Promise.race([
              once(proc, "message", { signal: AbortSignal.timeout(15_000) }),
              done.then(() => {
                throw new Error(`fixture exited before its barrier: ${output}`);
              }),
            ]);
            expect(message[0]).toBe("before-effect");
          } finally {
            if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
          }
        }
        const [code, signal] = await done;
        return { code, signal, output };
      }
      expect(await child("start")).toEqual({ code: null, signal: "SIGKILL", output: "" });
      expect(await readFile(join(root, "effect"), "utf8").catch(() => undefined)).toBeUndefined();
      const changed = change === "source" ? source : dependency;
      const original = await readFile(changed, "utf8");
      await writeFile(changed, "export const value = 'two';\n");
      const blocked = await child("resume");
      expect(blocked.code, blocked.output).toBe(2);
      expect(await releaseIdentity(install)).not.toBe(before);
      expect(JSON.parse(blocked.output)).toMatchObject({
        blocked: "unfinished work needs its retained Pal release; refusing to change extension implementations",
      });
      expect(await readFile(join(root, "effect"), "utf8").catch(() => undefined)).toBeUndefined();
      await writeFile(changed, original);
      expect(await releaseIdentity(install)).toBe(before);
      const recovered = await child("resume");
      expect(recovered.code).toBe(0);
      expect(JSON.parse(recovered.output)).toMatchObject({ effect: "one", userMessages: 1, effectCalls: 1 });
      expect(await readFile(join(root, "effect"), "utf8")).toBe("one");
    },
  );
});
