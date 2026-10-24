# The built UI test tree, plus the browsers and fonts its host runners use outside the Nix build sandbox.
{
  playwright-driver,
  makeFontsConf,
  dejavu_fonts,
  tests,
}:
{
  fixture = tests.overrideAttrs {
    pname = "pal-ui-fixture";
    buildPhase = ''
      runHook preBuild
      pnpm build
      runHook postBuild
    '';
    installPhase = ''
      mkdir -p $out
      cp -a . $out/
    '';
  };
  browsers = playwright-driver.browsers.override {
    withFirefox = false;
    withWebkit = false;
    withFfmpeg = false;
  };
  fonts = makeFontsConf { fontDirectories = [ dejavu_fonts ]; };
}
