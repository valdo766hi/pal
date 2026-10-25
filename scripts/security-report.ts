import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const marker = "<!-- pal-security-report -->";

type Scan = { exitCode: number; findings: string[][] };
type Report = { trivy: Scan; gitleaks: Scan };

function readScan<T>(path: string, exitCode: number, rows: (data: T) => string[][]): Scan {
  if (exitCode !== 0 && exitCode !== 10) return { exitCode, findings: [] };
  try {
    return { exitCode, findings: rows(JSON.parse(readFileSync(path, "utf8"))) };
  } catch {
    return { exitCode: 2, findings: [] };
  }
}

export function commentUpdate(
  comments: { id: number; body?: string | null; user?: { login: string } | null }[],
  body: string,
  runId: number,
  attempt: number,
): { body: string; comment_id?: number } | null {
  const existing = comments.find(
    (comment) => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(marker),
  );
  const previous = existing?.body?.match(/<!-- pal-security-run:(\d+):(\d+) -->/);
  if (previous && (Number(previous[1]) > runId || (Number(previous[1]) === runId && Number(previous[2]) > attempt)))
    return null;
  const update = { body: `${body}\n<!-- pal-security-run:${runId}:${attempt} -->` };
  return existing ? { ...update, comment_id: existing.id } : update;
}

export function collectReport(directory: string, trivyCode: number, gitleaksCode: number): Report {
  const trivy = readScan(
    join(directory, "trivy.json"),
    trivyCode,
    (data: {
      SchemaVersion: number;
      Results?: {
        Target: string;
        Vulnerabilities?: {
          Severity: string;
          VulnerabilityID: string;
          PkgName: string;
          InstalledVersion: string;
          FixedVersion?: string;
        }[];
        Misconfigurations?: { Severity: string; ID: string; Status: string; Title: string }[];
      }[];
    }) => {
      assert(data.SchemaVersion === 2);
      return (data.Results ?? []).flatMap((result) => [
        ...(result.Vulnerabilities ?? []).map((v) => [
          v.Severity,
          v.VulnerabilityID,
          v.PkgName,
          v.InstalledVersion,
          v.FixedVersion ?? "Not available",
          result.Target,
        ]),
        ...(result.Misconfigurations ?? []).flatMap((m) =>
          m.Status === "FAIL" ? [[m.Severity, m.ID, m.Title, "—", "Review configuration", result.Target]] : [],
        ),
      ]);
    },
  );
  const gitleaks = readScan(
    join(directory, "gitleaks.json"),
    gitleaksCode,
    (
      data: {
        RuleID: string;
        File: string;
        StartLine: number;
        Commit: string;
      }[],
    ) => data.map((finding) => [finding.RuleID, `${finding.File}:${finding.StartLine}`, finding.Commit]),
  );
  return { trivy, gitleaks };
}

function scan(value: unknown, width: number): Scan {
  assert(value && typeof value === "object");
  const candidate = value as Scan;
  assert(Number.isSafeInteger(candidate.exitCode) && candidate.exitCode >= 0);
  assert(
    Array.isArray(candidate.findings) &&
      candidate.findings.every(
        (row) => Array.isArray(row) && row.length === width && row.every((cell) => typeof cell === "string"),
      ),
  );
  assert(candidate.exitCode !== 0 || candidate.findings.length === 0);
  assert(candidate.exitCode !== 10 || candidate.findings.length > 0);
  return candidate;
}

function cell(value: string): string {
  return value.replace(/[&<>|`@\\[\]()!*_#~\r\n]/g, (character) => `&#${character.charCodeAt(0)};`).slice(0, 180);
}

function table(headers: string[], rows: string[][]): string {
  return [headers, headers.map(() => "---"), ...rows].map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n");
}

export function formatReport(value: unknown, sha: string, runUrl: string): string {
  assert(value && typeof value === "object");
  assert(/^[a-f0-9]{40}$/.test(sha));
  assert(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl));
  const input = value as Report;
  const report = { trivy: scan(input.trivy, 6), gitleaks: scan(input.gitleaks, 3) };
  const status = (result: Scan) => {
    if (result.exitCode === 0) return "Passed";
    if (result.exitCode === 10) return "Findings";
    return `Scan error (exit ${result.exitCode})`;
  };
  const details = (name: string, result: Scan, headers: string[]) => {
    if (!result.findings.length) return "";
    return `\n\n<details>\n<summary>${name} report (${result.findings.length})</summary>\n\n${table(headers, result.findings.slice(0, 30))}${result.findings.length > 30 ? "\n\nShowing the first 30 findings; the sanitized report is in the scan artifact." : ""}\n\n</details>`;
  };
  return `${marker}\n### Security scan\n\n${table(
    ["Scanner", "Result", "Findings"],
    [
      ["Trivy", status(report.trivy), String(report.trivy.findings.length)],
      ["Gitleaks", status(report.gitleaks), String(report.gitleaks.findings.length)],
    ],
  )}\n\nCommit \`${sha.slice(0, 7)}\` · [Scan run](${runUrl})\n\nScope: all Trivy severities and Git history. Secret values are omitted.${details("Trivy", report.trivy, ["Severity", "ID", "Package / check", "Installed", "Fixed", "File"])}${details("Gitleaks", report.gitleaks, ["Rule", "Location", "Commit"])}`;
}

if (import.meta.main) {
  const [directory, trivyCode, gitleaksCode] = process.argv.slice(2);
  assert(directory);
  const report = collectReport(directory, Number(trivyCode), Number(gitleaksCode));
  writeFileSync(join(directory, "report.json"), JSON.stringify(report));
  process.exitCode = report.trivy.exitCode === 0 && report.gitleaks.exitCode === 0 ? 0 : 1;
}
