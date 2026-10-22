{
  nodejs_24,
  git,
  coreutils,
  writeShellApplication,
  ui,
}:
writeShellApplication {
  name = "pal-ui-check";
  runtimeInputs = [
    nodejs_24
    git
    coreutils
  ];
  text = ''
    if [ "$#" -ne 1 ]; then
      echo 'Usage: pal-ui-check <results-directory>' >&2
      exit 2
    fi
    umask 077
    mkdir -p -- "$1"
    output=$(realpath -- "$1")
    work=$(mktemp -d)
    trap 'rm -rf -- "$work"' EXIT
    cp -a ${ui.fixture}/. "$work/"
    chmod -R u+w "$work"
    cd "$work"
    export PLAYWRIGHT_BROWSERS_PATH=${ui.browsers}
    export FONTCONFIG_FILE=${ui.fonts}
    export PAL_E2E_SCREENSHOTS="$output/screenshots"
    status=0
    node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts \
      test/e2e/chat-settings.test.ts test/e2e/browser-page.test.ts \
      test/e2e/search-watch.test.ts test/e2e/onboarding.test.ts --maxWorkers 1 \
      --reporter=default --reporter=json --outputFile="$output/results.json" || status=$?
    node --input-type=module - "$output" <<'JS'
    import assert from "node:assert/strict";
    import { readFileSync, writeFileSync } from "node:fs";
    const output = process.argv[2];
    const result = JSON.parse(readFileSync(output + "/results.json", "utf8"));
    const summary = Object.fromEntries(["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"].map(key => [key, result[key]]));
    writeFileSync(output + "/summary.json", JSON.stringify(summary, null, 2) + "\n");
    assert(result.success && result.numTotalTests > 0);
    assert.equal(result.numPassedTests, result.numTotalTests);
    assert.equal(result.numPendingTests, 0);
    assert.equal(result.numTodoTests, 0);
    JS
    exit "$status"
  '';
}
