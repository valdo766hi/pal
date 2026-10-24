{ pkgs, ... }:
{
  # Node and pnpm come from the flake's nixpkgs so the shell, package and checks share one ABI.
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    pnpm = {
      enable = true;
      package = pkgs.pnpm_11;
    };
  };

  # node-pty is compiled against Nix's Node headers instead of downloaded headers or its prebuilds,
  # whose 1.1.0 darwin spawn-helper is published without the executable bit.
  env.npm_config_nodedir = "${pkgs.nodejs_24}";
  env.npm_config_build_from_source = "true";
  env.PAL_RELEASE_LOCK = pkgs.lib.getExe (pkgs.callPackage ./nix/release-lock.nix { });
  env.PAL_TEST_PROCESS = pkgs.lib.getExe (pkgs.callPackage ./nix/process-probe.nix { });
  env.PAL_BASH = pkgs.lib.getExe pkgs.bashInteractive;
  env.PAL_TEST_FISH = pkgs.lib.getExe pkgs.fish;
  env.PAL_TEST_ZSH = pkgs.lib.getExe pkgs.zsh;
  packages = [
    pkgs.git
    pkgs.python3
    pkgs.rtk
  ];

  # `devenv up`: API server on 7338 plus Vite on 5173, which forwards /api to it.
  processes.pal.exec = "pnpm dev";
}
