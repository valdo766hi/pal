# Owner-run evaluations from the built tree in the Nix store, so the grader, tasks and held-out cases a run is
# scored by cannot be edited by the agents under test.
{
  nodejs_24,
  git,
  bash,
  coreutils,
  writeShellApplication,
  ui,
}:
writeShellApplication {
  name = "pal-evaluate";
  runtimeInputs = [
    nodejs_24
    git
    bash
    coreutils
  ];
  text = ''exec node ${ui.fixture}/scripts/evaluate.ts "$@"'';
}
