{
  nodejs_24,
  writeShellApplication,
  ui,
}:
writeShellApplication {
  name = "pal-benchmark-transcript";
  runtimeInputs = [ nodejs_24 ];
  text = ''
    export PLAYWRIGHT_BROWSERS_PATH=${ui.browsers}
    export FONTCONFIG_FILE=${ui.fonts}
    exec node ${ui.fixture}/scripts/benchmark-transcript.ts "$@"
  '';
}
