#!/usr/bin/env bash
set -euo pipefail

report_dir=$1
mkdir -p "$report_dir/source"
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$report_dir/source"

trivy_status=0
trivy fs --scanners vuln,misconfig --include-dev-deps --exit-code 10 \
	--format json --output "$report_dir/trivy.json" \
	"$report_dir/source" >"$report_dir/trivy.log" 2>&1 || trivy_status=$?
gitleaks_status=0
gitleaks git --log-opts=HEAD --redact=100 --no-banner --exit-code 10 \
	--report-format json --report-path "$report_dir/gitleaks.json" \
	. >"$report_dir/gitleaks.log" 2>&1 || gitleaks_status=$?

node scripts/security-report.ts "$report_dir" "$trivy_status" "$gitleaks_status"
