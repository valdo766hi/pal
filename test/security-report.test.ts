import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { collectReport } from "../scripts/security-report.ts";

const workflow = parse(readFileSync(new URL("../.github/workflows/security-comment.yml", import.meta.url), "utf8"));
const script: string = workflow.jobs.comment.steps.find(
  (step: { name?: string }) => step.name === "Update the security report",
).with.script;
const marker = "<!-- pal-security-report -->";
const sha = "a".repeat(40);
const url = "https://github.com/owner/pal/actions/runs/42";
const clean = { trivy: { exitCode: 0, findings: [] }, gitleaks: { exitCode: 0, findings: [] } };
const directories: string[] = [];
type Comment = { id: number; body: string; user: { login: string } };
type Update = { body: string; comment_id?: number; issue_number?: number };

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(trivy: unknown, gitleaks: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "pal-security-test-"));
  directories.push(directory);
  writeFileSync(join(directory, "trivy.json"), JSON.stringify(trivy));
  writeFileSync(join(directory, "gitleaks.json"), JSON.stringify(gitleaks));
  return directory;
}

function reporter(input: unknown = clean) {
  const state = {
    report: input,
    comments: [] as Comment[],
    exists: true,
    size: 100,
    run: {
      id: 42,
      run_attempt: 1,
      event: "pull_request",
      conclusion: "success",
      head_sha: sha,
      html_url: url,
      head_repository: { id: 1 },
    },
    pr: { number: 39, state: "open", head: { sha, repo: { id: 1 } } },
  };
  const routes = { pulls: Symbol("pulls"), comments: Symbol("comments") };
  const create = vi.fn(async (request: Update) => {
    state.comments.push({ id: 7, body: request.body, user: { login: "github-actions[bot]" } });
  });
  const update = vi.fn(async (request: Update) => {
    const comment = state.comments.find((comment) => comment.id === request.comment_id);
    assert(comment);
    comment.body = request.body;
  });
  const core = { setFailed: vi.fn() };
  const github = {
    rest: {
      actions: { getWorkflowRun: vi.fn(async () => ({ data: state.run })) },
      repos: { listPullRequestsAssociatedWithCommit: routes.pulls },
      pulls: { get: vi.fn(async () => ({ data: state.pr })) },
      issues: { listComments: routes.comments, createComment: create, updateComment: update },
    },
    paginate: vi.fn(async (route: symbol, parameters: { per_page: number }) => {
      expect(parameters.per_page).toBe(100);
      return route === routes.pulls ? [{ number: state.pr.number }] : state.comments;
    }),
  };
  const execute = () =>
    new Script(`(async () => {${script}\n})()`).runInNewContext({
      github,
      context: { repo: { owner: "owner", repo: "pal" } },
      process: { env: { RUN_ID: String(state.run.id), REPORT_PATH: "/security/report.json" } },
      core,
      Buffer,
      require: (name: string) => {
        if (name === "node:assert/strict") return assert;
        assert.equal(name, "node:fs");
        return {
          statSync: () => {
            assert(state.exists);
            return { size: state.size };
          },
          readFileSync: () => JSON.stringify(state.report),
        };
      },
    }) as Promise<void>;
  const body = () => state.comments.find((comment) => comment.user.login === "github-actions[bot]")?.body ?? "";
  return { state, execute, body, create, update, core };
}

describe("security reports", () => {
  it("includes dependency, configuration and secret locations inline, without secret values or messages", async () => {
    const directory = fixture(
      {
        SchemaVersion: 2,
        Results: [
          {
            Target: "pnpm-lock.yaml",
            Vulnerabilities: [
              {
                Severity: "HIGH",
                VulnerabilityID: "CVE-fixture",
                PkgName: "dependency",
                InstalledVersion: "1",
                FixedVersion: "2",
              },
            ],
            Misconfigurations: [
              { Severity: "LOW", ID: "config-fixture", Status: "FAIL", Title: "Configuration check" },
            ],
          },
        ],
      },
      [
        {
          RuleID: "fixture-rule",
          File: "src/example.ts",
          StartLine: 12,
          Commit: sha,
          Secret: "private fixture value",
          Match: "private fixture match",
          Message: "private commit message",
        },
      ],
    );
    const report = collectReport(directory, 10, 10);
    expect(JSON.stringify(report)).not.toContain("private");
    const test = reporter(report);
    await test.execute();
    expect(test.body()).toContain("| Trivy | Findings | 2 |");
    expect(test.body()).toContain("| Gitleaks | Findings | 1 |");
    for (const value of ["CVE-fixture", "config-fixture", "src/example.ts:12"]) expect(test.body()).toContain(value);
    expect(test.body()).not.toContain("<details>");
    expect(test.body()).not.toContain("artifact");
    expect(test.body()).not.toContain("private");
  });

  it("reports scanner failures and missing or invalid output as errors, never as clean", async () => {
    const directory = fixture({}, []);
    expect(collectReport(directory, 0, 0).trivy.exitCode).toBe(2);
    rmSync(join(directory, "gitleaks.json"));
    const report = collectReport(directory, 2, 0);
    expect(report.gitleaks.exitCode).toBe(2);
    const test = reporter(report);
    await test.execute();
    expect(test.body().match(/Scan error/g)).toHaveLength(2);
    expect(test.body()).not.toContain("Passed");
  });

  it("renders a short clean summary", async () => {
    const directory = fixture({ SchemaVersion: 2, Results: [] }, []);
    expect(collectReport(directory, 0, 0)).toEqual(clean);
    const test = reporter(clean);
    await test.execute();
    expect(test.body()).toContain("| Trivy | Passed | 0 |");
    expect(test.body()).toContain("| Gitleaks | Passed | 0 |");
    expect(test.body()).not.toContain("####");
  });

  it("shows every finding when the report fits, not an arbitrary first 30", async () => {
    const test = reporter({
      ...clean,
      gitleaks: { exitCode: 10, findings: Array.from({ length: 40 }, (_, i) => ["rule", `file.ts:${i}`, sha]) },
    });
    await test.execute();
    expect(test.body()).toContain("file.ts:39");
    expect(test.body()).not.toContain("<details>");
    expect(test.body()).not.toContain("download");
  });

  it("escapes untrusted cells and respects GitHub's comment size limit", async () => {
    const test = reporter({
      trivy: { exitCode: 10, findings: Array.from({ length: 1000 }, () => Array<string>(6).fill("|".repeat(1000))) },
      gitleaks: {
        exitCode: 10,
        findings: Array.from({ length: 1000 }, () => ["rule", "<script>|`@owner\n" + "|".repeat(1000), sha]),
      },
    });
    await test.execute();
    expect(test.body()).not.toContain("<script>");
    expect(test.body()).not.toContain("@owner");
    expect(test.body()).toContain("GitHub comment size limit");
    expect(Buffer.byteLength(test.body())).toBeLessThan(65536);
  });

  it("posts an error and fails the job for malformed or contradictory artifacts", async () => {
    for (const input of [
      {},
      { ...clean, trivy: { exitCode: 0, findings: [["hidden finding"]] } },
      { ...clean, gitleaks: { exitCode: 10, findings: [] } },
    ]) {
      const test = reporter(input);
      await test.execute();
      expect(test.core.setFailed).toHaveBeenCalledOnce();
      expect(test.body().match(/Scan error/g)).toHaveLength(2);
    }
  });

  it("still comments when a scan did not produce an artifact", async () => {
    const test = reporter();
    test.state.exists = false;
    await test.execute();
    expect(test.core.setFailed).toHaveBeenCalledOnce();
    expect(test.body().match(/Scan error/g)).toHaveLength(2);
  });

  it("rejects oversized artifacts without reading them", async () => {
    const test = reporter();
    test.state.size = 11 * 1024 ** 2;
    await test.execute();
    expect(test.core.setFailed).toHaveBeenCalledOnce();
    expect(test.body()).not.toContain("Passed");
  });

  it("rejects invalid run metadata", async () => {
    const test = reporter();
    test.state.run.head_sha = "invalid";
    await expect(test.execute()).rejects.toThrow();
    test.state.run.head_sha = sha;
    test.state.run.html_url = "https://example.com";
    await expect(test.execute()).rejects.toThrow();
    expect(test.create).not.toHaveBeenCalled();
  });
});

describe("one bot-authored PR comment", () => {
  it("updates the same comment after a fixing push", async () => {
    const test = reporter({ ...clean, gitleaks: { exitCode: 10, findings: [["rule", "file.ts:1", sha]] } });
    await test.execute();
    expect(test.body()).toContain("Findings | 1");
    test.state.report = clean;
    test.state.run.id = 43;
    test.state.run.head_sha = "b".repeat(40);
    test.state.pr.head.sha = test.state.run.head_sha;
    await test.execute();
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.update).toHaveBeenCalledOnce();
    expect(test.state.comments).toHaveLength(1);
    expect(test.body()).toContain("| Gitleaks | Passed | 0 |");
    expect(test.body()).toContain("pal-security-run:43:1");
  });

  it("does not overwrite human comments or unrelated bot comments", async () => {
    const test = reporter();
    test.state.comments.push(
      { id: 1, body: marker, user: { login: "owner" } },
      { id: 2, body: "Other CI report", user: { login: "github-actions[bot]" } },
    );
    await test.execute();
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.update).not.toHaveBeenCalled();
    expect(test.state.comments[0]?.body).toBe(marker);
  });

  it("does not let older runs or rerun attempts replace a newer report", async () => {
    const test = reporter();
    test.state.comments.push({
      id: 7,
      body: `${marker}\n<!-- pal-security-run:43:2 -->`,
      user: { login: "github-actions[bot]" },
    });
    await test.execute();
    test.state.run.id = 43;
    await test.execute();
    expect(test.update).not.toHaveBeenCalled();
    test.state.run.run_attempt = 3;
    await test.execute();
    expect(test.update).toHaveBeenCalledOnce();
  });

  it("skips stale, unrelated-repository and closed PRs", async () => {
    const test = reporter();
    test.state.pr.head.sha = "b".repeat(40);
    await test.execute();
    test.state.pr.head.sha = sha;
    test.state.pr.head.repo.id = 2;
    await test.execute();
    test.state.pr.head.repo.id = 1;
    test.state.pr.state = "closed";
    await test.execute();
    expect(test.create).not.toHaveBeenCalled();
  });

  it("skips cancelled runs", async () => {
    const test = reporter();
    test.state.run.conclusion = "cancelled";
    await test.execute();
    expect(test.create).not.toHaveBeenCalled();
  });

  it("comments on same-repository PRs immediately without checking out PR code", () => {
    const caller = parse(readFileSync(new URL("../.github/workflows/security.yml", import.meta.url), "utf8"));
    expect(caller.jobs.comment.uses).toBe("./.github/workflows/security-comment.yml");
    expect(caller.jobs.comment.needs).toBe("scan");
    expect(caller.jobs.comment.if).toContain("always()");
    expect(caller.jobs.comment.if).toContain("head.repo.full_name == github.repository");
    expect(caller.jobs.comment.permissions["pull-requests"]).toBe("write");
    expect(workflow.on.workflow_call).toBeDefined();
    expect(JSON.stringify(workflow.jobs.comment.steps)).not.toContain("actions/checkout");
    expect(script).not.toContain("import(");
  });
});
