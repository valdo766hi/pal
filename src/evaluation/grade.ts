import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { checkout, type AnswerTask, type ProgramTask, type Task, TASKS } from "./tasks.ts";

const grader = fileURLToPath(import.meta.url);
const tasks = fileURLToPath(new URL("tasks.ts", import.meta.url));
const fixtures = fileURLToPath(new URL("../../test/fixtures/evaluation/", import.meta.url));
const timeoutMs = 2_000;
const maxOutputBytes = 16 * 1024;

/** A bounded directory digest; `frozen` also requires every path to be read-only, as a finished candidate is. */
async function snapshot(root: string, frozen = true) {
  if ((await realpath(root)) !== root) throw new Error("grading requires a canonical, frozen candidate path");
  const digest = createHash("sha256");
  let bytes = 0,
    files = 0,
    entries = 0;
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 8 || ++entries > 256) throw new Error("candidate exceeds its directory depth or entry limit");
    const info = await lstat(path);
    if (info.isSymbolicLink() || (frozen && (info.mode & 0o222) !== 0))
      throw new Error("candidate contains a symlink or writable path");
    if (info.isDirectory()) {
      const names: string[] = [];
      for await (const entry of await opendir(path)) {
        if (names.length >= 128) throw new Error("candidate directory contains too many entries");
        names.push(entry.name);
      }
      for (const name of names.sort()) await walk(join(path, name), depth + 1);
      return;
    }
    if (!info.isFile() || ++files > 128 || (bytes += info.size) > 1024 * 1024)
      throw new Error("candidate must contain at most 128 regular files and one MiB");
    const content = await readFile(path);
    digest.update(JSON.stringify([relative(root, path), content.length]));
    digest.update(content);
  }
  await walk(root, 0);
  return { path: root, digest: digest.digest("hex"), files, bytes };
}

/** The grader, task definitions and every starting snapshot: what a run must not be able to change. */
export async function authority(): Promise<string> {
  const digest = createHash("sha256")
    .update(await readFile(grader))
    .update(await readFile(tasks));
  for (const task of TASKS)
    digest.update((await snapshot(await realpath(join(fixtures, task.snapshot)), false)).digest);
  return digest.digest("hex");
}

/** The starting repository a run copies for `task`. */
export async function initialSnapshot(task: Task): Promise<string> {
  return realpath(join(fixtures, task.snapshot));
}

/** Digest of `task`'s starting repository, as the grader computes it. */
export async function repositoryDigest(task: Task): Promise<string> {
  return (await snapshot(await initialSnapshot(task), false)).digest;
}

type Case = {
  id: string;
  passed: boolean;
  failure: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  output: unknown;
  stderr: string;
};

function programCases(candidate: string, task: ProgramTask): Case[] {
  return task.cases.map((test) => {
    const started = performance.now();
    const result = spawnSync(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${candidate}`,
        "--max-old-space-size=64",
        join(candidate, task.entrypoint),
        grader,
        tasks,
      ],
      {
        cwd: candidate,
        env: { LANG: "C", TZ: "UTC" },
        input: JSON.stringify(test.input),
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: maxOutputBytes,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output: unknown = null;
    let failure: string | null = null;
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ETIMEDOUT") failure = "timeout";
    else if (code === "ENOBUFS") failure = "output_limit";
    else if (result.error !== undefined || result.status !== 0) failure = "execution_error";
    else {
      try {
        output = JSON.parse(result.stdout) as unknown;
        if (!isDeepStrictEqual(output, test.expected)) failure = "incorrect_output";
      } catch {
        failure = "invalid_json";
      }
    }
    return {
      id: test.id,
      passed: failure === null,
      failure,
      exitCode: result.status,
      signal: result.signal,
      elapsedMs: Math.round(performance.now() - started),
      output,
      stderr: (result.stderr ?? "").slice(0, maxOutputBytes),
    };
  });
}

async function answerCases(candidate: string, initial: string, task: AnswerTask): Promise<Case[]> {
  const started = performance.now();
  const read = async (): Promise<{ output: unknown; failure: string | null }> => {
    const info = await lstat(join(candidate, task.answer.file)).catch(() => undefined);
    if (!info?.isFile()) return { output: null, failure: "missing_answer" };
    if (info.size > maxOutputBytes) return { output: null, failure: "output_limit" };
    try {
      const output = JSON.parse(await readFile(join(candidate, task.answer.file), "utf8")) as unknown;
      return { output, failure: isDeepStrictEqual(output, task.answer.expected) ? null : "incorrect_output" };
    } catch {
      return { output: null, failure: "invalid_json" };
    }
  };
  const result = (id: string, output: unknown, failure: string | null): Case => ({
    id,
    passed: failure === null,
    failure,
    exitCode: null,
    signal: null,
    elapsedMs: Math.round(performance.now() - started),
    output,
    stderr: "",
  });
  const { output, failure } = await read();
  const cases = [result("answer", output, failure)];
  for (const path of task.unchanged) {
    const before = (await snapshot(join(initial, path), false)).digest;
    const after = await snapshot(join(candidate, path)).catch(() => undefined);
    cases.push(result(`unchanged:${path}`, null, after?.digest === before ? null : "changed"));
  }
  return cases;
}

/** Grade frozen artifacts, never a candidate's tests, commands or self-reported success. */
export async function grade(candidate: string, task: Task = checkout) {
  const artifact = await snapshot(candidate);
  const original = await initialSnapshot(task);
  const initial = await snapshot(original, false);
  const source = createHash("sha256")
    .update(await readFile(grader))
    .update(await readFile(tasks))
    .digest("hex");
  const cases = task.kind === "program" ? programCases(candidate, task) : await answerCases(candidate, original, task);
  return {
    schema: 1,
    kind: "independent-development-grade",
    task: {
      id: task.id,
      version: task.version,
      split: task.split,
      digest: createHash("sha256").update(JSON.stringify(task)).digest("hex"),
      initial,
    },
    candidate: artifact,
    grader: { path: grader, digest: source },
    environment: { platform: process.platform, arch: process.arch, node: process.versions.node },
    budget: { timeoutMsPerCase: timeoutMs, maxOutputBytesPerCase: maxOutputBytes },
    passed: cases.every((test) => test.passed),
    cases,
  };
}
