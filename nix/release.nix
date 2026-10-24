# Evaluated from the running immutable package, never a candidate's flake or recipes.
{ candidate, nixpkgs }:
let
  pkgs = import nixpkgs { };
  pal = pkgs.callPackage ./package.nix {
    sourceRoot = candidate;
    pkgsPath = nixpkgs;
  };
  tests = pkgs.callPackage ./tests.nix {
    inherit pal;
    sourceRoot = candidate;
  };
  smoke = pkgs.callPackage ./smoke.nix { inherit pal; };
  browser = pkgs.callPackage ./browser.nix { inherit pal; };
  e2e = pkgs.callPackage ./e2e.nix { inherit tests pal; };
  grading = pkgs.callPackage ./evaluation.nix { };
  evals = tests.overrideAttrs {
    pname = "pal-release-evals";
    buildPhase = ''
      runHook preBuild
      pnpm exec vitest run test/codemode-policy.test.ts test/approvals.test.ts test/context.test.ts
      runHook postBuild
    '';
    installPhase = "touch $out";
  };
in
[
  pal
  smoke
  tests
  browser
  e2e
  grading
  evals
]
