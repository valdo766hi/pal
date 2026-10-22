{
  stdenv,
  sourceRoot ? ../.,
}:
stdenv.mkDerivation {
  pname = "pal-release-lock";
  version = "1";
  src = sourceRoot + "/nix/release-lock.c";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    $CC -std=c17 -Wall -Wextra -Werror -O2 "$src" -o pal-release-lock
  '';
  installPhase = ''
    install -Dm755 pal-release-lock "$out/bin/pal-release-lock"
  '';
  meta = {
    mainProgram = "pal-release-lock";
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
}
