{
  lib,
  nodejs_24,
  bashInteractive,
  git,
  coreutils,
  writeShellApplication,
  ui,
  pal,
}:
writeShellApplication {
  name = "pal-benchmark-activation";
  runtimeInputs = [
    nodejs_24
    git
    coreutils
  ];
  text = ''
    umask 077
    work=$(mktemp -d)
    trap 'rm -rf -- "$work"' EXIT
    mkdir "$work/home"
    env -i HOME="$work/home" TMPDIR="$work" PATH="$PATH" \
      XDG_RUNTIME_DIR="''${XDG_RUNTIME_DIR-}" PAL_BASH=${lib.getExe bashInteractive} \
      ${
        lib.concatStringsSep " " (
          lib.mapAttrsToList (name: value: lib.escapeShellArg "${name}=${value}") pal.browserEnv
        )
      } \
      node ${ui.fixture}/scripts/benchmark-activation.ts "$@"
  '';
}
