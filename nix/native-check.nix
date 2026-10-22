{
  lib,
  nodejs_24,
  git,
  coreutils,
  bash,
  writeShellApplication,
  ui,
  pal,
}:
writeShellApplication {
  name = "pal-native-check";
  runtimeInputs = [
    nodejs_24
    git
    coreutils
  ];
  text = ''
    if [ "$#" -ne 1 ]; then
      echo 'Usage: pal-native-check <results-directory>' >&2
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
    mkdir home
    export HOME="$work/home"
    export PAL_BASH=${lib.getExe bash}
    export PAL_TIMEOUT=${coreutils}/bin/timeout
    export PAL_RELEASE_LOCK=${lib.getExe pal.nativeLock}
    export PAL_TEST_PROCESS=${lib.getExe ui.fixture.processProbe}
    status=0
    node node_modules/vitest/vitest.mjs run \
      test/mcp-local.test.ts test/mcp-stdio.test.ts test/process-probe.test.ts \
      --maxWorkers 2 --reporter=default --reporter=json \
      --outputFile="$output/results.json" || status=$?
    node --input-type=module - "$output" <<'JS'
    import assert from "node:assert/strict";
    import { readFileSync, writeFileSync } from "node:fs";
    import { basename } from "node:path";
    const output = process.argv[2];
    const result = JSON.parse(readFileSync(output + "/results.json", "utf8"));
    const files = result.testResults.map(suite => basename(suite.name)).sort();
    const summary = Object.fromEntries(["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"].map(key => [key, result[key]]));
    writeFileSync(output + "/summary.json", JSON.stringify({ ...summary, files }, null, 2) + "\n");
    assert.deepEqual(files, ["mcp-local.test.ts", "mcp-stdio.test.ts", "process-probe.test.ts"]);
    assert(result.success && result.testResults.every(suite => suite.assertionResults.length > 0));
    assert.equal(result.numPassedTests, result.numTotalTests);
    assert.equal(result.numPendingTests, 0);
    assert.equal(result.numTodoTests, 0);
    JS
    exit "$status"
  '';
}
