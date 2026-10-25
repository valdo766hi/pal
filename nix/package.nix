{
  lib,
  stdenv,
  nodejs_24,
  pnpm_11,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  bash,
  coreutils,
  git,
  rtk,
  autoPatchelfHook,
  node-gyp,
  python3,
  bubblewrap,
  socat,
  systemd,
  playwright-driver,
  makeFontsConf,
  dejavu_fonts,
  nix,
  util-linux,
  pkgsPath,
  sourceRoot ? ../.,
}:
let
  root = sourceRoot;
  nativeLock = import (root + "/nix/release-lock.nix") { inherit stdenv sourceRoot; };
  # Chromium must match the pinned Playwright client.
  browsers = playwright-driver.browsers.override {
    withChromium = false;
    withChromiumHeadlessShell = true;
    withFirefox = false;
    withWebkit = false;
    withFfmpeg = false;
  };
  headlessShell = "${browsers}/chromium_headless_shell-${playwright-driver.browsersJSON.chromium-headless-shell.revision}/chrome-headless-shell-linux64/chrome-headless-shell";
  browserEnv = lib.optionalAttrs stdenv.hostPlatform.isLinux {
    PAL_CHROMIUM = headlessShell;
    PAL_BWRAP = lib.getExe bubblewrap;
    PAL_SOCAT = lib.getExe socat;
    PAL_SYSTEMD_RUN = "${systemd}/bin/systemd-run";
    PAL_COREUTILS = "${coreutils}/bin";
    PAL_FONTCONFIG = "${makeFontsConf { fontDirectories = [ dejavu_fonts ]; }}";
  };
  # Explicit whitelist: private handoff docs, .design, credentials and runtime data never enter a derivation.
  manifests = [
    (root + "/package.json")
    (root + "/pnpm-lock.yaml")
    (root + "/pnpm-workspace.yaml")
  ];
  appFiles = manifests ++ [
    (root + "/tsconfig.json")
    (root + "/vite.config.ts")
    (root + "/src")
    (root + "/web")
    (root + "/scripts/release-manifest.ts")
  ];
  releaseSource = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions (
      appFiles
      ++ [
        (root + "/nix")
        (root + "/test")
        (root + "/scripts")
        (root + "/flake.nix")
        (root + "/flake.lock")
        (root + "/devenv.nix")
        (root + "/.envrc")
        (root + "/vitest.config.ts")
        (root + "/vitest.portable.config.ts")
        (root + "/vitest.e2e.config.ts")
        (root + "/vitest.feasibility.config.ts")
        (root + "/eslint.config.js")
        (root + "/.prettierrc.json")
        (root + "/.prettierignore")
      ]
    );
  };
  releaseEnv = {
    PAL_RELEASE_LOCK = lib.getExe nativeLock;
  }
  // lib.optionalAttrs stdenv.hostPlatform.isLinux {
    PAL_NIX = lib.getExe nix;
    PAL_FLOCK = "${util-linux}/bin/flock";
  };
  # Build node-pty against this Node ABI; pnpm skips install scripts.
  buildNodePty = ''
    pushd node_modules/node-pty
    node-gyp rebuild --nodedir=${nodejs_24}
    node scripts/post-install.js
    rm -rf prebuilds third_party deps
    popd
  '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "pal";
  version = (lib.importJSON (root + "/package.json")).version;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions appFiles;
  };

  pnpmDeps = fetchPnpmDeps {
    pname = "pal";
    # Only the manifests decide the dependency set, so source edits do not change this hash.
    src = lib.fileset.toSource {
      inherit root;
      fileset = lib.fileset.unions manifests;
    };
    pnpm = pnpm_11;
    fetcherVersion = 4;
    hash = "sha256-M6edxwWiErXj/N2xQ5ni4McRyK1Rj2NFJav05f67kjY=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
    makeWrapper
    node-gyp
    python3
  ]
  # Prebuilt fff/ffi-rs libraries are generic glibc binaries; point them at Nix's libraries.
  ++ lib.optional stdenv.hostPlatform.isLinux autoPatchelfHook;
  buildInputs = lib.optional stdenv.hostPlatform.isLinux stdenv.cc.cc.lib;

  buildPhase = ''
    runHook preBuild
    ${buildNodePty}
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    pnpm prune --prod --ignore-scripts
    mkdir -p $out/lib/pal $out/bin
    cp -r dist node_modules package.json $out/lib/pal/
    ln -s ${releaseSource} $out/lib/pal/release-source
    node scripts/release-manifest.ts ${releaseSource} "$out" ${pkgsPath} "$out/lib/pal/release.json"
    makeWrapper ${lib.getExe nodejs_24} $out/bin/pal --add-flags $out/lib/pal/dist/main.js \
      --prefix PATH : ${
        lib.makeBinPath [
          bash
          coreutils
          git
          nodejs_24
          rtk
        ]
      } \
      --set PAL_BASH ${lib.getExe bash} --set PAL_TIMEOUT ${coreutils}/bin/timeout \
      ${lib.concatStringsSep " " (
        lib.mapAttrsToList (name: value: "--set ${name} ${value}") (browserEnv // releaseEnv)
      )}
    runHook postInstall
  '';

  passthru = {
    inherit (finalAttrs) pnpmDeps;
    inherit
      buildNodePty
      browserEnv
      releaseEnv
      nativeLock
      ;
  };

  meta = {
    description = "A durable, workspace-first personal AI application";
    mainProgram = "pal";
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
})
