import { spawn } from "node:child_process";
import { directoryIdentity } from "./workspace-root.ts";
import { gnuTimeout } from "./timeout.ts";

/** A fixed trusted worker, not agent-supplied JavaScript. Relative operations stay on its inherited cwd inode. */
async function writer() {
  const { promises: fs, constants } = process.getBuiltinModule("node:fs");
  const { createHash, randomUUID } = process.getBuiltinModule("node:crypto");
  let temporary: string | undefined;
  let input: { directory: string; identity: string; name: string; content: string; expected: string | null };
  let phase = "start";
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const identity = async (path: string) => {
    const info = await fs.lstat(path, { bigint: true });
    if (!info.isDirectory() || (await fs.realpath(path)) !== input.directory) throw new Error("write parent changed");
    return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
  };
  const check = async () => {
    if (
      !process.connected ||
      (await identity(".")) !== input.identity ||
      (await identity(input.directory)) !== input.identity
    )
      throw new Error("write parent changed or writer disconnected");
  };
  const read = async () => {
    let handle;
    try {
      handle = await fs.open(input.name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 256 * 1024) throw new Error("file changed while preparing the write");
      const bytes = Buffer.alloc(256 * 1024 + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = (await handle.read(bytes, size, bytes.length - size, size)).bytesRead;
        if (read === 0) break;
        size += read;
      }
      if (size > 256 * 1024) throw new Error("file changed while preparing the write");
      return { hash: digest(bytes.subarray(0, size)), mode: info.mode & 0o777 };
    } finally {
      await handle.close();
    }
  };
  const cleanup = async () => {
    if (temporary !== undefined) {
      await fs.unlink(temporary).catch(() => {});
      temporary = undefined;
    }
  };
  let chain = Promise.resolve();
  process.on("message", (message: typeof input | { commit: true }) => {
    chain = chain
      .then(async () => {
        if (phase === "start" && "directory" in message) {
          input = message;
          if (
            input.name === "" ||
            input.name.includes("/") ||
            input.name.includes("\0") ||
            input.name === "." ||
            input.name === ".." ||
            Buffer.byteLength(input.content) > 256 * 1024
          )
            throw new Error("invalid file write");
          await check();
          const before = await read();
          if ((before?.hash ?? null) !== input.expected) throw new Error("file changed before preparing the write");
          if (before !== undefined) await fs.access(input.name, constants.W_OK);
          temporary = `.pal-${randomUUID()}.tmp`;
          const handle = await fs.open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(input.content);
            await handle.chmod(before?.mode ?? 0o600);
            await handle.sync();
          } finally {
            await handle.close();
          }
          phase = "prepared";
          process.send?.({ prepared: true });
        } else if (phase === "prepared" && "commit" in message) {
          if (((await read())?.hash ?? null) !== input.expected)
            throw new Error("file changed while preparing the write");
          await check();
          if (temporary === undefined) throw new Error("missing prepared write");
          if (input.expected === null) await fs.link(temporary, input.name);
          else await fs.rename(temporary, input.name);
          const directory = await fs.open(".", constants.O_RDONLY | constants.O_DIRECTORY);
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          await cleanup();
          phase = "done";
          process.send?.({ done: true });
          process.disconnect?.();
        } else throw new Error("invalid file writer transition");
      })
      .catch(async (error: unknown) => {
        await cleanup();
        if (process.connected) {
          process.send?.({ error: error instanceof Error ? error.message : "file write failed" });
          process.disconnect?.();
        }
        process.exitCode = 1;
      });
  });
  process.once("disconnect", () => {
    void chain.then(cleanup);
  });
  process.send?.({ ready: true });
}

/** The worker's cwd is checked before I/O; replacing any ancestor cannot redirect its relative reads/publication. */
export async function writeTextFile(options: {
  directory: string;
  identity: string;
  name: string;
  content: string;
  expected: string | null;
  check(): Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  options.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      gnuTimeout(),
      [
        "--kill-after=1s",
        "10s",
        process.execPath,
        "--max-old-space-size=64",
        "--input-type=module",
        "--eval",
        `(${writer.toString()})()`,
      ],
      {
        cwd: options.directory,
        detached: true,
        env: {},
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let done = false;
    let failure: unknown;
    let chain = Promise.resolve();
    const kill = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    };
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child.connected) child.disconnect();
      cancellationTimer ??= setTimeout(kill, 1000);
    };
    const timer = setTimeout(kill, 11_500);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(cancellationTimer);
      options.signal?.removeEventListener("abort", stop);
      kill();
    };
    child.on("message", (message: { ready?: boolean; prepared?: boolean; done?: boolean; error?: string }) => {
      chain = chain
        .then(async () => {
          if (message.error !== undefined) throw new Error(message.error);
          if (message.done) {
            done = true;
            return;
          }
          await options.check();
          options.signal?.throwIfAborted();
          if ((await directoryIdentity(options.directory)) !== options.identity)
            throw new Error("write parent changed");
          if (message.ready)
            child.send({
              directory: options.directory,
              identity: options.identity,
              name: options.name,
              content: options.content,
              expected: options.expected,
            });
          else if (message.prepared) child.send({ commit: true });
          else throw new Error("invalid file writer response");
        })
        .catch((error: unknown) => {
          failure = error;
          if (child.connected) child.disconnect();
        });
    });
    child.once("error", (error) => {
      failure = error;
      cleanup();
      reject(error);
    });
    // There are no output pipes to drain; explicit IPC disconnect need not emit ChildProcess's close event.
    child.once("exit", (code) => {
      cleanup();
      void chain.then(() => {
        if (failure !== undefined) reject(failure);
        else if (options.signal?.aborted) reject(options.signal.reason);
        else if (code !== 0 || !done) reject(new Error("file writer stopped; inspect the file before retrying"));
        else resolve();
      });
    });
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
  });
}
