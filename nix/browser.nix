{
  lib,
  stdenv,
  nodejs_24,
  pnpm_11,
  pnpmConfigHook,
  playwright-driver,
  pal,
}:
let
  root = ../.;
  browsers = playwright-driver.browsers.override {
    withFirefox = false;
    withWebkit = false;
    withFfmpeg = false;
  };
in
stdenv.mkDerivation {
  pname = "pal-browser-feasibility";
  inherit (pal) version pnpmDeps;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/pnpm-lock.yaml")
      (root + "/pnpm-workspace.yaml")
      (root + "/.pnpmfile.cjs")
      (root + "/vitest.feasibility.config.ts")
      (root + "/test/feasibility")
    ];
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
  ];
  __darwinAllowLocalNetworking = true;

  env = {
    PLAYWRIGHT_BROWSERS_PATH = browsers;
    PAL_EXPECTED_PLAYWRIGHT = playwright-driver.version;
  };

  buildPhase = ''
    runHook preBuild
    pnpm test:feasibility
    runHook postBuild
  '';

  installPhase = ''
    touch $out
  '';
}
