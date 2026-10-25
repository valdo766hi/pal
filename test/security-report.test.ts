import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectReport, commentUpdate, formatReport, marker } from "../scripts/security-report.ts";

const sha = "a".repeat(40);
const url = "https://github.com/owner/pal/actions/runs/42";
const clean = { trivy: { exitCode: 0, findings: [] }, gitleaks: { exitCode: 0, findings: [] } };
const directories: string[] = [];

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

describe("security reports", () => {
  it("includes dependency, configuration and secret locations without secret values or messages", () => {
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
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("private");
    const body = formatReport(report, sha, url);
    expect(body).toContain("| Trivy | Findings | 2 |");
    expect(body).toContain("| Gitleaks | Findings | 1 |");
    expect(body).toContain("CVE-fixture");
    expect(body).toContain("config-fixture");
    expect(body).toContain("src/example.ts:12");
  });

  it("reports scanner failures and missing or invalid output as errors, never as clean", () => {
    const directory = fixture({}, []);
    expect(collectReport(directory, 0, 0).trivy.exitCode).toBe(2);
    rmSync(join(directory, "gitleaks.json"));
    const report = collectReport(directory, 2, 0);
    expect(report.gitleaks.exitCode).toBe(2);
    const body = formatReport(report, sha, url);
    expect(body.match(/Scan error/g)).toHaveLength(2);
    expect(body).not.toContain("Passed");
  });

  it("renders a short clean summary", () => {
    const directory = fixture({ SchemaVersion: 2, Results: [] }, []);
    expect(collectReport(directory, 0, 0)).toEqual(clean);
    const body = formatReport(clean, sha, url);
    expect(body).toContain("| Trivy | Passed | 0 |");
    expect(body).toContain("| Gitleaks | Passed | 0 |");
    expect(body).not.toContain("<details>");
  });

  it("escapes untrusted table cells and bounds the comment size", () => {
    const report = {
      ...clean,
      gitleaks: {
        exitCode: 10,
        findings: Array.from({ length: 1000 }, () => ["rule", "<script>|`@owner\n" + "|".repeat(1000), sha]),
      },
    };
    const body = formatReport(report, sha, url);
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("@owner");
    expect(body).toContain("Showing the first 30 findings");
    expect(body.length).toBeLessThan(65536);
    const worstCase = {
      trivy: { exitCode: 10, findings: Array.from({ length: 1000 }, () => Array<string>(6).fill("|".repeat(1000))) },
      gitleaks: report.gitleaks,
    };
    expect(formatReport(worstCase, sha, url).length).toBeLessThan(65536);
  });

  it("rejects malformed artifacts, contradictory results and untrusted run links", () => {
    expect(() => formatReport({}, sha, url)).toThrow();
    expect(() =>
      formatReport({ ...clean, trivy: { exitCode: 0, findings: [["hidden finding"]] } }, sha, url),
    ).toThrow();
    expect(() => formatReport({ ...clean, gitleaks: { exitCode: 10, findings: [] } }, sha, url)).toThrow();
    expect(() => formatReport(clean, "invalid", url)).toThrow();
    expect(() => formatReport(clean, sha, "https://example.com")).toThrow();
  });
});

describe("one updatable PR comment", () => {
  const bot = { login: "github-actions[bot]" };

  it("creates the first comment and updates that same comment after a fix", () => {
    const initial = commentUpdate([], `${marker}\nFindings`, 42, 1);
    expect(initial).not.toHaveProperty("comment_id");
    const comments = [{ id: 7, user: bot, body: initial?.body ?? null }];
    const update = commentUpdate(comments, `${marker}\nPassed`, 43, 1);
    expect(update).toEqual({ comment_id: 7, body: `${marker}\nPassed\n<!-- pal-security-run:43:1 -->` });
  });

  it("does not overwrite human comments or unrelated bot comments", () => {
    const comments = [
      { id: 1, user: { login: "owner" }, body: marker },
      { id: 2, user: bot, body: "Other CI report" },
    ];
    expect(commentUpdate(comments, marker, 42, 1)).not.toHaveProperty("comment_id");
  });

  it("does not let older runs or rerun attempts replace a newer report", () => {
    const comments = [{ id: 7, user: bot, body: `${marker}\n<!-- pal-security-run:43:2 -->` }];
    expect(commentUpdate(comments, marker, 42, 1)).toBeNull();
    expect(commentUpdate(comments, marker, 43, 1)).toBeNull();
    expect(commentUpdate(comments, marker, 43, 3)?.comment_id).toBe(7);
  });
});
