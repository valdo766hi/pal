import { once } from "node:events";
import { existsSync, fstatSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import pkg from "../package.json" with { type: "json" };
import type { Pal } from "./core/app.ts";
import type { ReleaseRpc } from "./core/release-rpc.ts";
import { parseCommand, USAGE, UsageError } from "./core/config.ts";
import { gnuTimeout } from "./core/timeout.ts";

// The build puts the frontend in dist/public next to this bundle; running from src has none.
const webRoot = fileURLToPath(new URL("public", import.meta.url));
const installRoot = fileURLToPath(new URL("..", import.meta.url));

async function main(argv: readonly string[]): Promise<number> {
  let command;
  try {
    command = parseCommand(argv, { env: process.env, platform: process.platform, home: homedir(), installRoot });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`pal: ${error.message}\nRun 'pal --help' for usage.\n`);
    return 2;
  }

  switch (command.kind) {
    case "help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case "version":
      process.stdout.write(`pal ${pkg.version}\n`);
      return 0;
    case "probe": {
      const { runProbes } = await import("./probe.ts");
      const results = await runProbes();
      for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
      return results.every((result) => result.ok) ? 0 : 1;
    }
    case "check-release": {
      const { evaluateRelease } = await import("./core/release-check.ts");
      try {
        const result = await evaluateRelease(installRoot, command.dataRoot, command.candidate);
        process.stdout.write(
          `${JSON.stringify({ digest: result.digest, package: result.package, changes: result.changes, checkedAt: result.checkedAt })}\n`,
        );
        return 0;
      } catch (error) {
        process.stderr.write(`pal: ${error instanceof Error ? error.message : "release check failed"}\n`);
        return 1;
      }
    }
    case "backup":
    case "restore": {
      const { backupCommand } = await import("./core/backup.ts");
      try {
        process.stdout.write(`${JSON.stringify(await backupCommand(command, pkg.version))}\n`);
        return 0;
      } catch (error) {
        process.stderr.write(
          `pal: ${error instanceof Error ? error.message.slice(0, 1000) : `${command.kind} failed`}\n`,
        );
        return 1;
      }
    }
    case "supervise": {
      const { supervise } = await import("./core/supervise.ts");
      try {
        return await supervise(installRoot, command.config);
      } catch (error) {
        process.stderr.write(`pal: ${error instanceof Error ? error.message.slice(0, 1000) : "supervisor failed"}\n`);
        return 1;
      }
    }
    case "serve": {
      const { host, port, dataRoot, publicOrigin } = command.config;
      const supervised = process.env.PAL_SUPERVISED === "1";
      let admitting = !supervised,
        stopping = false,
        runtimeEnded = false,
        closingServer = false,
        inFlight = 0;
      let pal: Pal | undefined, server: Server | undefined, closed: Promise<unknown> | undefined;
      let rpc: ReleaseRpc | undefined;
      const stop = () => {
        stopping = true;
        admitting = false;
        void pal?.terminals.close().catch(() => {});
        void pal?.browsers.close().catch(() => {});
        if (server !== undefined && !closingServer) {
          closingServer = true;
          const active = server;
          active.close();
          active.closeIdleConnections();
          setTimeout(() => active.closeAllConnections(), 5000).unref();
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (supervised) process.once("disconnect", stop);
      try {
        if (supervised) {
          const send = process.send?.bind(process);
          if (send === undefined || !process.connected || !fstatSync(4).isFile())
            throw new Error("supervised child requires its inherited private IPC and lifetime lock");
          const { ReleaseRpc } = await import("./core/release-rpc.ts");
          const { HttpError } = await import("./core/http.ts");
          rpc = new ReleaseRpc(
            process,
            (message) =>
              send(message, (error) => {
                if (error) rpc?.close();
              }),
            async (op, args) => {
              if (args === null || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0)
                throw new HttpError(400, "release_operation", "Expected an empty lifecycle command.");
              if (stopping || !process.connected)
                throw new HttpError(503, "release_disconnected", "Supervisor disconnected.");
              if (op === "promote" || op === "resume") {
                admitting = true;
                return { ready: true };
              }
              if (op !== "prepare") throw new HttpError(400, "release_operation", "Unsupported child operation.");
              admitting = false;
              try {
                const deadline = Date.now() + 5000;
                while (inFlight > 0) {
                  if (Date.now() >= deadline || stopping)
                    throw new HttpError(409, "release_busy", "Requests are still in flight; retry when idle.");
                  await sleep(25);
                }
                const current = pal;
                if (current === undefined) throw new HttpError(503, "release_starting", "Pal is still starting.");
                const { unfinishedWork } = await import("./core/release-state.ts");
                if (
                  current.terminals.releaseBusy ||
                  current.browsers.releaseBusy ||
                  (await unfinishedWork(current.store.database))
                )
                  throw new HttpError(
                    409,
                    "release_busy",
                    "Finish or stop pending work, and close all Terminal and Browser sessions before restarting.",
                  );
                return { prepared: true };
              } catch (error) {
                if (!stopping && process.connected) admitting = true;
                throw error;
              }
            },
          );
        }
        const [{ openPal }, { createApi }, { startServer }, { BACKGROUND_CONTEXT }] = await Promise.all([
          import("./core/app.ts"),
          import("./core/api.ts"),
          import("./core/server.ts"),
          import("@earendil-works/chord/context"),
        ]);
        if (stopping) return 0;
        pal = await openPal({ dataRoot, installRoot }, BACKGROUND_CONTEXT);
        if (stopping) return 0;
        const current = pal,
          api = createApi(current, publicOrigin, rpc);
        const available = () => admitting && !stopping && current.status === "ready";
        current.harness.subscribeClose(() => {
          if (stopping) return;
          runtimeEnded = true;
          admitting = false;
          process.stderr.write("pal: durable runtime stopped; restart to reconcile committed work\n");
          queueMicrotask(stop);
        });
        server = await startServer({
          host,
          port,
          version: pkg.version,
          publicOrigin,
          webRoot: existsSync(join(webRoot, "index.html")) ? webRoot : undefined,
          available,
          health: () => ({
            status: current.status === "ready" && !stopping ? "ok" : "unavailable",
            name: "pal",
            version: pkg.version,
            ...(supervised ? { release: current.extensions.release, admitting: available() } : {}),
          }),
          api: async (request, response, url) => {
            const counted = !/^\/api\/releases(?:\/|$)/.test(url.pathname);
            if (counted) inFlight++;
            try {
              await api(request, response, url);
            } finally {
              if (counted) inFlight--;
            }
          },
          upgrade: async (request, socket, head) => {
            inFlight++;
            try {
              await current.upgrade(request, socket, head, publicOrigin);
            } finally {
              inFlight--;
            }
          },
        });
        closed = once(server, "close");
        if (stopping) stop();
        else {
          const address = server.address() as AddressInfo;
          const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
          const origin = publicOrigin ?? `http://${shown}:${address.port}`;
          process.stdout.write(`pal ${pkg.version} listening on ${origin} (data: ${dataRoot})\n`);
          if (gnuTimeout() === "timeout") {
            process.stderr.write(
              "pal: GNU timeout was not found on PATH; agent shell commands and Git review will fail until coreutils is installed (gtimeout on macOS)\n",
            );
          }
          if (!(await current.owner.exists()))
            process.stdout.write(`Set up Pal by opening ${origin}/#setup=${current.owner.setupToken}\n`);
          if (!stopping) await rpc?.call("online", { port: address.port, release: current.extensions.release }, 5000);
        }
        await closed;
        return runtimeEnded ? 1 : 0;
      } catch (error) {
        if (stopping) return runtimeEnded ? 1 : 0;
        const { DatabaseOwnedError } = await import("./storage/sqlite.ts");
        if (!(error instanceof DatabaseOwnedError)) throw error;
        process.stderr.write(`pal: ${dataRoot} is in use by another Pal process\n`);
        return 1;
      } finally {
        stop();
        rpc?.close();
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        process.off("disconnect", stop);
        if (closed !== undefined) await closed;
        await pal?.close();
      }
    }
  }
}

process.exitCode = await main(process.argv.slice(2));
