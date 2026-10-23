{
  lib,
  runCommand,
  nodejs_24,
}:
let
  root = ../.;
  source = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      ../src/evaluation
      ../test/fixtures/evaluation
    ];
  };
  malformed = runCommand "pal-grading-malformed-artifacts" { } ''
    mkdir -p "$out"/{symlink/src,bytes,files/a,files/b,deep,wide,entries}
    ln -s ${source}/test/fixtures/evaluation/fixed/src/main.mjs "$out/symlink/src/main.mjs"
    head -c 1048577 /dev/zero > "$out/bytes/large"
    for n in $(seq 1 65); do touch "$out/files/a/$n" "$out/files/b/$n"; done
    path="$out/deep"
    for n in $(seq 1 9); do path="$path/$n"; mkdir "$path"; done
    for n in $(seq 1 129); do touch "$out/wide/$n"; done
    for a in $(seq 1 3); do
      for b in $(seq 1 95); do mkdir -p "$out/entries/$a/$b"; done
    done
    for name in changed-test missing-test; do
      cp -R ${source}/test/fixtures/evaluation/slug-fixed "$out/$name"
      chmod -R u+w "$out/$name"
    done
    printf 'process.exit(0);\n' > "$out/changed-test/test.mjs"
    rm "$out/missing-test/test.mjs"
    cp -R ${source}/test/fixtures/evaluation/dependency-plan-fixed "$out/stale-policy"
    chmod -R u+w "$out/stale-policy"
    substituteInPlace "$out/stale-policy/src/plan.mjs" \
      --replace-fail 'const found = ignored.has(root) ? undefined : closure(modules, root);' \
      'const found = closure(modules, root); if (found && [...found].some(id => ignored.has(id))) { blocked.push(root); continue; }'
  '';
in
runCommand "pal-evaluation-controls" { nativeBuildInputs = [ nodejs_24 ]; } ''
  node ${source}/src/evaluation/controls.ts "$out" ${malformed}
''
