{
  lib,
  nodejs_24,
  coreutils,
  writeShellApplication,
}:
let
  source = lib.fileset.toSource {
    root = ../scripts;
    fileset = lib.fileset.unions [
      ../scripts/check-performance.ts
      ../scripts/benchmark-startup.ts
    ];
  };
in
writeShellApplication {
  name = "pal-check-performance";
  runtimeInputs = [
    nodejs_24
    coreutils
  ];
  text = ''
    exec env -i PATH="$PATH" node ${source}/check-performance.ts "$@"
  '';
}
