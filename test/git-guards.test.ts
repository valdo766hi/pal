import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateFiles } from "../src/core/release-policy.ts";

const scripts = join(import.meta.dirname, "..", "scripts");
// Isolate from the developer's global Git configuration (hooksPath, signing, templates).
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Pal Test",
  GIT_AUTHOR_EMAIL: "test@pal.invalid",
  GIT_COMMITTER_NAME: "Pal Test",
  GIT_COMMITTER_EMAIL: "test@pal.invalid",
};
const repos: string[] = [];

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pal-guard-test-"));
  repos.push(dir);
  git(dir, "init", "-q", "-b", "main");
  cpSync(scripts, join(dir, "scripts"), { recursive: true });
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
}

function run(dir: string, command: string, ...args: string[]) {
  const result = spawnSync(command, args, { cwd: dir, env, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function commit(dir: string, message: string) {
  writeFileSync(join(dir, "message.txt"), message);
  return run(dir, "git", "commit", "-q", "--cleanup=strip", "-F", "message.txt");
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("public agent guidance", () => {
  it("lets a clone track AGENTS.md through candidate enumeration, the guard installer and the commit hook", () => {
    const dir = repo();
    cpSync(join(import.meta.dirname, "..", ".gitignore"), join(dir, ".gitignore"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "main.ts"), "export {};\n");
    writeFileSync(join(dir, "AGENTS.md"), "# Guidance\n");
    git(dir, "add", "-A");
    const index = git(dir, "ls-files", "--stage", "-z");
    const paths = index
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(entry.indexOf("\t") + 1));
    expect(paths).toContain("AGENTS.md");
    const build = paths.filter((path) => /^(?:src|web|test|nix|scripts)\//.test(path));
    expect(() => candidateFiles(index, build)).not.toThrow();
    expect(run(dir, "bash", "scripts/prepare-local.sh")).toMatchObject({ status: 0 });
    expect(commit(dir, "docs: add agent guidance")).toMatchObject({ status: 0 });
  });
});

describe("prepare-local.sh", () => {
  it("installs idempotent excludes that hide every case variant of the private docs", () => {
    const dir = repo();
    expect(run(dir, "bash", "scripts/prepare-local.sh").status).toBe(0);
    expect(run(dir, "bash", "scripts/prepare-local.sh").status).toBe(0);
    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/>>> pal-local-guard/g)).toHaveLength(1);

    for (const name of ["CLAUDE.local.md", "stack.md", "Plan.MD", "nested/plan.md", ".design/approved/x.png"]) {
      expect(run(dir, "git", "check-ignore", "-q", name).status, name).toBe(0);
    }
    for (const name of ["src/plan.ts", "AGENTS.md"])
      expect(run(dir, "git", "check-ignore", "-q", name).status, name).toBe(1);
  });

  it("refuses foreign hooks, a hooksPath, and private docs already in the index", () => {
    const foreign = repo();
    writeFileSync(join(foreign, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    expect(run(foreign, "bash", "scripts/prepare-local.sh")).toMatchObject({ status: 1 });
    expect(readFileSync(join(foreign, ".git", "hooks", "pre-commit"), "utf8")).toBe("#!/bin/sh\nexit 0\n");

    const managed = repo();
    git(managed, "config", "core.hooksPath", ".husky");
    expect(run(managed, "bash", "scripts/prepare-local.sh").output).toMatch(/core.hooksPath/);

    const tracked = repo();
    writeFileSync(join(tracked, "PLAN.md"), "private");
    git(tracked, "add", "PLAN.md");
    expect(run(tracked, "bash", "scripts/prepare-local.sh").output).toMatch(/git rm --cached/);
  });
});

describe("guard hooks", () => {
  it("block force-added private files but allow untracking them", () => {
    const dir = repo();
    run(dir, "bash", "scripts/prepare-local.sh");
    writeFileSync(join(dir, "Stack.md"), "private");
    writeFileSync(join(dir, "app.ts"), "export {};\n");
    git(dir, "add", "-f", "Stack.md", "app.ts");
    const blocked = commit(dir, "feat: add app");
    expect(blocked.status).toBe(1);
    expect(blocked.output).toContain("Stack.md");

    git(dir, "rm", "-q", "--cached", "Stack.md");
    expect(commit(dir, "feat: add app").status).toBe(0);
  });

  it.each([
    ["add app", /type\(scope\): purpose/],
    ["feat: add app\n\nWith a body.", /exactly one/],
    ["feat: add app\n\nCo-authored-by: Someone <x@y.z>", /exactly one/],
    [`feat: ${"x".repeat(67)}`, /73 bytes/],
    ["Feat: add app", /type\(scope\): purpose/],
  ])("reject the commit message %j", (message, reason) => {
    const dir = repo();
    run(dir, "bash", "scripts/prepare-local.sh");
    writeFileSync(join(dir, "app.ts"), "export {};\n");
    git(dir, "add", "app.ts");
    const result = commit(dir, message);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(reason);
  });

  it("accept one Conventional Commit line, ignoring Git's comment lines", () => {
    const dir = repo();
    run(dir, "bash", "scripts/prepare-local.sh");
    writeFileSync(join(dir, "app.ts"), "export {};\n");
    git(dir, "add", "app.ts");
    expect(commit(dir, "# Please enter a message\nfeat(core): add app\n\n# comment\n").status).toBe(0);
    expect(git(dir, "log", "--format=%B").trim()).toBe("feat(core): add app");
  });
});
