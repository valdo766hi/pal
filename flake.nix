{
  description = "Pal: a durable, workspace-first personal AI application";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    devenv.url = "github:cachix/devenv/v2.4.0";
  };

  outputs =
    {
      self,
      nixpkgs,
      devenv,
      ...
    }@inputs:
    let
      # Only systems with a builder that has evaluated and tested these outputs.
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forSystems (
        pkgs:
        let
          pal = pkgs.callPackage ./nix/package.nix { pkgsPath = pkgs.path; };
          ui = pkgs.callPackage ./nix/ui-fixture.nix {
            tests = pkgs.callPackage ./nix/tests.nix { inherit pal; };
          };
          startupBenchmarkSource = pkgs.lib.fileset.toSource {
            root = ./scripts;
            fileset = pkgs.lib.fileset.unions [
              ./scripts/benchmark-startup.ts
              ./scripts/benchmark-startup-observer.mjs
            ];
          };
        in
        {
          default = pal;
          ui-check = pkgs.callPackage ./nix/ui-check.nix { inherit ui; };
          native-check = pkgs.callPackage ./nix/native-check.nix { inherit ui pal; };
          transcript-benchmark = pkgs.callPackage ./nix/transcript-benchmark.nix { inherit ui; };
          evaluate = pkgs.callPackage ./nix/evaluate.nix { inherit ui; };
          startup-benchmark = pkgs.writeShellApplication {
            name = "pal-benchmark-startup";
            runtimeInputs = [
              pkgs.nodejs_24
              pkgs.nix
            ];
            text = ''exec node ${startupBenchmarkSource}/benchmark-startup.ts "$@"'';
          };
        }
      );

      apps = forSystems (pkgs: {
        default = {
          type = "app";
          program = pkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
      });

      checks = forSystems (
        pkgs:
        let
          pal = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
          tests = pkgs.callPackage ./nix/tests.nix { inherit pal; };
        in
        {
          package = pal;
          smoke = pkgs.callPackage ./nix/smoke.nix { inherit pal; };
          inherit tests;
          portable = tests.override { portable = true; };
          evaluation = pkgs.callPackage ./nix/evaluation.nix { };
        }
        # Chromium's macOS sandbox cannot start inside Nix's darwin build sandbox, and disabling it is not an option.
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          browser = pkgs.callPackage ./nix/browser.nix { inherit pal; };
          e2e = pkgs.callPackage ./nix/e2e.nix { inherit tests pal; };
        }
      );

      devShells = forSystems (pkgs: {
        default = devenv.lib.mkShell {
          inherit inputs pkgs;
          modules = [ ./devenv.nix ];
        };
      });
    };
}
