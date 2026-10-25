import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

if (import.meta.main) {
  const [directory, trivyCode, gitleaksCode] = process.argv.slice(2);
  assert(directory);
  const report = collectReport(directory, Number(trivyCode), Number(gitleaksCode));
  writeFileSync(join(directory, "report.json"), JSON.stringify(report));
  process.exitCode = report.trivy.exitCode === 0 && report.gitleaks.exitCode === 0 ? 0 : 1;
}
