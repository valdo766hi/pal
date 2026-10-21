import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { distribution, sampleCount, sampleStartup } from "../scripts/benchmark-startup.ts";

const roots: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), "pal-benchmark-fixture-"));
  roots.push(root);
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "bin/pal"), `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return root;
}

const server = `
import {createServer} from 'node:http';
const server=createServer((_,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',name:'pal'}));});
server.listen(0,'127.0.0.1',()=>process.stdout.write('listening on http://127.0.0.1:'+server.address().port+'\\n'));
process.once('SIGTERM',()=>server.close());
`;

describe("packaged startup measurement", () => {
  it("reports nearest-rank percentiles without mutating or discarding raw values", () => {
    const values = [40, 10, 30, 20];
    expect(distribution(values)).toEqual({ min: 10, p50: 20, p95: 40, max: 40 });
    expect(values).toEqual([40, 10, 30, 20]);
    expect(distribution([0])).toEqual({ min: 0, p50: 0, p95: 0, max: 0 });
    for (const invalid of [[], [-1], [NaN], [Infinity]]) expect(() => distribution(invalid)).toThrow();
  });

  it("requires a bounded repeated sample count", () => {
    expect(sampleCount()).toBe(7);
    expect(sampleCount("3")).toBe(3);
    expect(sampleCount("25")).toBe(25);
    for (const invalid of ["0", "1", "2", "26", "100", "3.0", "03", "3x", "-7"])
      expect(() => sampleCount(invalid)).toThrow();
  });

  it("uses fresh private homes/stores, strips inherited secrets, measures the owned process and removes fixtures", async () => {
    const packagePath = await fixture(`
import {appendFileSync} from 'node:fs';
appendFileSync(new URL('../observations',import.meta.url), JSON.stringify({pid:process.pid,home:process.env.HOME,data:process.argv.at(-1),secret:process.env.PAL_BENCHMARK_SECRET,cwd:process.cwd()})+'\\n');
${server}`);
    vi.stubEnv("PAL_BENCHMARK_SECRET", "must-not-enter-the-child");
    const first = await sampleStartup(packagePath);
    const second = await sampleStartup(packagePath);
    for (const sample of [first, second]) {
      expect(sample.readyMs).toBeGreaterThan(0);
      expect(sample.readyMs).toBeLessThan(5000);
      expect(sample.rssBytes).toBeGreaterThan(0);
      expect(Number.isSafeInteger(sample.rssBytes)).toBe(true);
    }
    const observations = (await readFile(join(packagePath, "observations"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { pid: number; home: string; data: string; secret?: string; cwd: string });
    expect(observations).toHaveLength(2);
    expect(observations[0]?.home).not.toBe(observations[1]?.home);
    for (const observation of observations) {
      expect(observation.secret).toBeUndefined();
      expect(observation.home).toBe(join(observation.cwd, "home"));
      expect(observation.data).toBe(join(observation.cwd, "data"));
      await expect(access(observation.cwd)).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => process.kill(observation.pid, 0)).toThrow();
    }
  });

  it("does not require host process inspection or inherit Node preload options", async () => {
    const packagePath = await fixture(server);
    await writeFile(join(packagePath, "bin/ps"), `#!${process.execPath}\nprocess.exit(77)`, { mode: 0o700 });
    vi.stubEnv("PATH", join(packagePath, "bin"));
    vi.stubEnv("NODE_OPTIONS", "--import=data:text/javascript,process.exit(71)");
    expect((await sampleStartup(packagePath)).rssBytes).toBeGreaterThan(0);
  });

  it.each([0, 1.5])("rejects an invalid self-reported RSS of %s", async (rssBytes) => {
    const packagePath = await fixture(`
process.removeAllListeners('message');
process.on('message',message=>process.send({...message,pid:process.pid,rssBytes:${rssBytes}}));
process.channel?.unref();
${server}`);
    await expect(sampleStartup(packagePath)).rejects.toThrow("Package returned an invalid RSS report.");
  });

  it("bounds a missing RSS report instead of inventing a measurement", async () => {
    const packagePath = await fixture(`process.removeAllListeners('message');process.channel?.unref();${server}`);
    await expect(sampleStartup(packagePath)).rejects.toThrow("Package did not report its RSS.");
  });

  it("waits for a complete readiness origin across output chunks", async () => {
    const packagePath = await fixture(
      server.replace(
        "()=>process.stdout.write('listening on http://127.0.0.1:'+server.address().port+'\\n')",
        "()=>{process.stdout.write('listening on http://127.');setTimeout(()=>process.stdout.write('0.0.1:'+server.address().port+'\\n'),20);}",
      ),
    );
    expect((await sampleStartup(packagePath)).rssBytes).toBeGreaterThan(0);
  });

  it("bounds discarded startup output without publishing setup tokens or raw errors", async () => {
    const packagePath = await fixture(
      `process.stdout.write('x'.repeat(100000)+'\\n');process.stderr.write('private-setup-token');${server}`,
    );
    const sample = await sampleStartup(packagePath);
    expect(Object.keys(sample).sort()).toEqual(["readyMs", "rssBytes"]);
    const failed = await fixture("process.stderr.write('private-setup-token');process.exit(1)");
    await expect(sampleStartup(failed)).rejects.toThrow("Package exited before readiness.");
  });

  it("rejects missing executables and unhealthy packages", async () => {
    const missing = await fixture("process.exit(0)");
    await rm(join(missing, "bin/pal"));
    await expect(sampleStartup(missing)).rejects.toThrow("Package could not be started.");
    const unhealthy = await fixture(server.replace("status:'ok'", "status:'unavailable'"));
    await expect(sampleStartup(unhealthy)).rejects.toThrow("Package returned invalid health.");
  });

  it("rejects non-loopback readiness and redirects rather than fetching another host", async () => {
    const remote = await fixture(
      "process.stdout.write('listening on http://example.invalid:80\\n');setInterval(()=>{},1000)",
    );
    await expect(sampleStartup(remote)).rejects.toThrow("Package did not announce a loopback HTTP origin.");
    const redirected = await fixture(
      server.replace(
        "res.setHeader('content-type','application/json');",
        "res.statusCode=302;res.setHeader('location','http://example.invalid');",
      ),
    );
    await expect(sampleStartup(redirected)).rejects.toThrow();
  });

  it("bounds a startup that never becomes ready and kills its owned process group", async () => {
    const packagePath = await fixture(`
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
writeFileSync(new URL('../pids',import.meta.url),JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);
`);
    await expect(sampleStartup(packagePath)).rejects.toThrow("Package startup exceeded 5000 ms.");
    const pids: number[] = JSON.parse(await readFile(join(packagePath, "pids"), "utf8"));
    expect(pids).toHaveLength(2);
    await vi.waitFor(() => {
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    });
  });

  it("stops the launched process if its measurement parent dies", async () => {
    const packagePath = await fixture(`
import {writeFileSync} from 'node:fs';
writeFileSync(new URL('../launched',import.meta.url),JSON.stringify({pid:process.pid,cwd:process.cwd()}));
setInterval(()=>{},1000);
`);
    const source = new URL("../scripts/benchmark-startup.ts", import.meta.url).href;
    const parent = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {sampleStartup} from ${JSON.stringify(source)};await sampleStartup(${JSON.stringify(packagePath)});`,
      ],
      { stdio: "ignore" },
    );
    const exited = once(parent, "exit");
    let launched: { pid: number; cwd: string } | undefined = undefined;
    stops.push(async () => {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      await exited;
      if (launched !== undefined && launched.pid > 0) {
        try {
          process.kill(-launched.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    });
    launched = await vi.waitFor(
      async () => JSON.parse(await readFile(join(packagePath, "launched"), "utf8")) as { pid: number; cwd: string },
    );
    roots.push(launched.cwd);
    const pid = launched.pid;
    parent.kill("SIGKILL");
    await exited;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it("does not accept a successful measurement if orderly shutdown fails", async () => {
    const packagePath = await fixture(server.replace("server.close()", "process.exit(9)"));
    await expect(sampleStartup(packagePath)).rejects.toThrow("Package did not shut down cleanly.");
  });
});
