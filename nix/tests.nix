{
  lib,
  stdenv,
  nodejs_24,
  pnpm_11,
  pnpmConfigHook,
  autoPatchelfHook,
  node-gyp,
  python3,
  git,
  bashInteractive,
  pal,
  sourceRoot ? ../.,
  portable ? false,
}:
let
  root = sourceRoot;
in
stdenv.mkDerivation {
  pname = if portable then "pal-portable-tests" else "pal-tests";
  inherit (pal) version pnpmDeps;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/pnpm-lock.yaml")
      (root + "/pnpm-workspace.yaml")
      (root + "/tsconfig.json")
      (root + "/vite.config.ts")
      (root + "/vitest.config.ts")
      (root + "/vitest.portable.config.ts")
      (root + "/vitest.feasibility.config.ts")
      (root + "/vitest.e2e.config.ts")
      (root + "/eslint.config.js")
      (root + "/.prettierrc.json")
      (root + "/.prettierignore")
      (root + "/src")
      (root + "/web")
      (root + "/test")
      (root + "/scripts")
    ];
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
    node-gyp
    python3
    git
  ]
  ++ lib.optional stdenv.hostPlatform.isLinux autoPatchelfHook;
  buildInputs = lib.optional stdenv.hostPlatform.isLinux stdenv.cc.cc.lib;
  __darwinAllowLocalNetworking = true;
  env = pal.releaseEnv;

  # Build node-pty and patch the prebuilt native libraries the tests load, as the package does; scripts need real shebangs.
  preBuild = ''
    patchShebangs scripts
    ${pal.buildNodePty}
  ''
  + lib.optionalString stdenv.hostPlatform.isLinux ''
    autoPatchelf node_modules
  '';

  buildPhase = ''
    runHook preBuild
    pnpm check
    ${
      if portable then
        ''
          pnpm exec vitest run --config vitest.portable.config.ts --reporter=default --reporter=json --outputFile=test-results.json
          node --input-type=module -e '
            import assert from "node:assert/strict";
            import { readFileSync, writeFileSync } from "node:fs";
            const result = JSON.parse(readFileSync("test-results.json", "utf8"));
            const summary = Object.fromEntries(["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"].map(key => [key, result[key]]));
            writeFileSync("summary.json", JSON.stringify(summary, null, 2) + "\n");
            assert(result.success && result.numTotalTests > 0);
            assert.equal(result.numPassedTests, result.numTotalTests);
            assert.equal(result.numPendingTests, 0);
            assert.equal(result.numTodoTests, 0);
          '
        ''
      else
        "pnpm test"
    }
    # Nix's default Bash has no readline; exercise its bracketed-paste behavior separately.
    PAL_BASH=${lib.getExe bashInteractive} pnpm exec vitest run test/terminals.test.ts
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    ${if portable then "mkdir -p $out; cp summary.json $out/" else "touch $out"}
  '';
}
