{
  stdenv,
  sourceRoot ? ../.,
}:
stdenv.mkDerivation {
  pname = "pal-test-process-probe";
  version = "1";
  src = sourceRoot + "/test/fixtures/process-probe.c";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    $CC -std=c17 -Wall -Wextra -Werror -O2 "$src" -o pal-test-process-probe
  '';
  installPhase = ''
    install -Dm755 pal-test-process-probe "$out/bin/pal-test-process-probe"
  '';
  meta.mainProgram = "pal-test-process-probe";
}
