{
  nodejs_24,
  writeShellApplication,
  ui,
}:
writeShellApplication {
  name = "pal-benchmark-mcp";
  runtimeInputs = [ nodejs_24 ];
  text = ''
    umask 077
    work=$(mktemp -d)
    trap 'rm -rf -- "$work"' EXIT
    mkdir "$work/home"
    export HOME="$work/home" TMPDIR="$work"
    node ${ui.fixture}/scripts/benchmark-mcp.ts "$@"
  '';
}
