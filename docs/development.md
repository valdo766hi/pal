# Development

## Setup

Node.js 24.21+, pnpm 11 (`corepack enable`) and Git. Nix is optional but gives the exact toolchain and the full
test suite.

```sh
pnpm install
pnpm check     # typecheck, lint, format check
pnpm test      # unit and integration tests
pnpm start     # build, then serve on http://127.0.0.1:7337
```

With Nix, `nix develop --no-pure-eval` opens a devenv shell with Node, pnpm, Git, coreutils and the native
libraries. direnv users can rely on `.envrc`.

## Scripts

| Script             | What it does                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `pnpm start`       | Builds, then runs `dist/main.js`. Extra arguments go to the server.                           |
| `pnpm serve`       | Runs an existing build.                                                                       |
| `pnpm dev`         | Watches the server on `127.0.0.1:7338` and runs Vite's UI server, which forwards `/api` to it. |
| `pnpm build`       | Vite builds `web/` into `dist/public`; esbuild bundles `src/main.ts` into `dist/`.            |
| `pnpm check`       | `tsc`, `svelte-check --fail-on-warnings`, ESLint and Prettier.                                |
| `pnpm test`        | Vitest unit and integration tests (`test/*.test.ts`).                                         |
| `pnpm test:e2e`    | Playwright tests of the built UI (`test/e2e`). Needs `pnpm build`, and Chromium through `PLAYWRIGHT_BROWSERS_PATH`. |
| `pnpm test:feasibility` | Checks that the pinned Playwright drives the matching Chromium with a persistent profile. |

`pnpm dev` uses your default data directory. Its UI proxy forwards plain HTTP only, so the Terminal and Browser
panels, which use WebSockets, need the built app (`pnpm start`).

## Mutable installations and resume safety

Nix packages keep their immutable store-output identity. Source and other non-Nix installations instead
snapshot the actual `src/` and `dist/` bytes, package/lock manifests, installed production/optional/peer
dependency graph, and Node runtime/flags at startup. Dependency versions alone are not enough: edited
installed files change the pin. Missing, linked, special or over-limit runtime files fail closed.
The snapshot is bounded to 256 packages, 20,000 directory entries/files, 256 MiB total and 128 MiB per file.

**Stop Pal before editing, rebuilding or reinstalling its runtime, and keep it unchanged while running.**
This startup snapshot is not an atomic filesystem snapshot, sandbox or custom-loader/monkeypatch guarantee.
Keep data, projects and credentials outside the installation; Pal never includes its private data in the
digest. It does not freeze external programs, OS state, MCP services or their effects.

Pal persists the pin before admitting work and checks it before starting unfinished tasks. A changed or
unverifiable installation cannot resume them: use the intact retained build and dependencies instead.
There is no unsafe override. Finish/reconcile unfinished work before updating; do not edit database pins
or discard work to bypass the check. Older source installations used an unverifiable `development` label:
finish their work with the original installation before upgrading, since its original bytes cannot be
reconstructed from that label.

## Tests

Tests use real temporary SQLite databases, Git repositories and folders, with loopback fixture services standing
in for OpenAI's sign-in and model APIs, the other model providers and MCP servers (`test/fixtures`). They never use
real accounts or keys. Crash recovery is tested by killing child Pal processes with SIGKILL at fixed points and
reopening their data.

A few tests assume Linux (`/proc`, PTY behavior) or Nix-store programs (local MCP programs, the browser runtime).
The complete, reproducible run is the flake's checks on Linux:

```sh
nix build .#checks.x86_64-linux.package   # the installable package
nix build .#checks.x86_64-linux.smoke     # starts the packaged server and probes native features
nix build .#checks.x86_64-linux.tests     # pnpm check + pnpm test + build
nix build .#checks.x86_64-linux.browser   # Playwright/Chromium feasibility
nix build .#checks.x86_64-linux.e2e       # UI and browser-runtime tests; keeps screenshots in the output
```

The e2e output contains screenshots at 1440, 768 and 390 px widths for review. Any change to `package.json` or
`pnpm-lock.yaml` may change the pnpm dependency hash in `nix/package.nix`; the build reports the new value.

### CI and coverage boundaries

`.github/workflows/checks.yml` checks pushes and pull requests targeting `development`, using the exact
pushed or PR-head commit, not an implicit merge commit. Dependencies come from the frozen lockfiles through
Nix. The native targets are Ubuntu 24.04 x86-64 and macOS 15 Apple Silicon; these are test targets, not a
full-feature support claim or established minimum OS versions. Intel macOS and ARM64 Linux support remain
undecided. Required branch-protection checks must be configured by the repository owner.

Both targets run static checks, a portable subset and the build:

```sh
nix build .#checks.x86_64-linux.portable
nix build .#checks.aarch64-darwin.portable
# With the pinned development tools already available:
pnpm exec vitest run --config vitest.portable.config.ts
```

The Linux portable job runs the full unit suite. Darwin's Nix build sandbox denies cross-process
inspection, so its portable job excludes exactly `mcp-local`, `mcp-stdio` and `process-probe`; both native
jobs must also run those suites from the immutable `native-check` artifact outside the build sandbox.
The host runner verifies every named suite executed and fails on zero tests, skips or todos. Its test-only
probe uses Linux `/proc` or macOS `libproc`; unavailable/failed inspection is an error, never evidence that
a process died. Positive controls check a live process and its exact cwd before cleanup assertions.
The host runner also executes `instructions` and `skills` on its temporary filesystem and records its case
sensitivity. A run on a case-sensitive volume does not verify a case-insensitive one, or vice versa.
Neither portable counts alone nor Linux host results establish native macOS process coverage.

```sh
nix build --out-link native-runner .#native-check
./native-runner/bin/pal-native-check "$(mktemp -d)"
```

Both native jobs run packaged core/backup CLI smoke with isolated temporary data and retain its integrity reports.
Release policy/selection, descriptor confinement and inherited-lock controls run in both portable jobs;
they do not enable the full macOS release lifecycle. Descriptor inspection includes an inherited positive control.
The full `tests` check runs all suites on Linux. A separate Ubuntu 22.04 job runs all five packaged checks above: its
user-namespace support lets Chromium keep its sandbox, unlike the restricted Ubuntu 24.04 hosted image.
No host policy is disabled. Nix may reuse an identical derivation; a successful build request is not
necessarily a fresh runtime execution. Both full and portable checks repeat the PTY suite with readline-enabled
Bash, testing bracketed paste on/off without assuming a newline immediately precedes command output.

The macOS job also runs independent chat UI, provider onboarding, browser DOM-policy and filesystem-watcher
fixtures (loading, failure/retry, navigation, cross-provider conflicts, bounded rendering, sensitive fields and
native file changes). Onboarding uses fresh stores and loopback providers for ChatGPT, API-key, keyless endpoint,
skip/resume, explicit-default and interruption/restart controls at desktop and phone widths.
One test file runs at a time to retain the single-browser resource bound. Its artifact is built by Nix, then run
on the native host: Chromium's
macOS sandbox cannot nest inside Nix's build sandbox. Chromium's own sandbox stays enabled; production browser
confinement is not replaced by this fixture. The same runner can be exercised on a capable Linux host:

```sh
nix build .#ui-check
./result/bin/pal-ui-check "$(mktemp -d)"
```

It uses a private temporary copy, local fake providers and isolated Pal data. The results directory contains counts
and fixture screenshots; zero tests, skips and todos fail the gate. The DOM-policy suite uses only controlled
pages; it proves neither production browser confinement nor real-site credential recognition. The watcher case
uses the pinned native fff through `ProjectSearch`, recording real notifications and checking create/modify/rename/
remove outcomes, Unicode paths, UTF-8 match ranges and index release. It does not inject events; simulated gap
controls remain separate. These are chat/onboarding/DOM/watcher subsets, not a full macOS browser-runtime or
release-security gate.

This is an initial CI foundation for [#15](https://github.com/valdo766hi/pal/issues/15), not full platform
acceptance. Build logs distinguish prerequisite errors from assertions; a failure before a suite runs
leaves that coverage unexecuted, not passed. CI retains commit/tree/OS identity, bounded counts and macOS UI-fixture
screenshots; it does not upload credentials, full transcripts or live runtime data. Sanitized rendered failure
artifacts and host-scope security/release gates remain required work. The Nix e2e suite's user-systemd-scope skip is also unexecuted coverage.

### Packaged startup measurements

```sh
nix build --out-link package .#default
nix build --out-link startup-benchmark .#startup-benchmark
./startup-benchmark/bin/pal-benchmark-startup "$PWD/package" 7 > startup.json
```

This optional runner starts only the explicitly selected trusted Nix package. Each sample has a fresh private
home/store, loopback port, no inherited credentials and no provider configuration. It checks HTTP health, measures
the main process RSS at readiness, then stops its own process group and removes only its fixtures. Startup output
(including the fresh setup token) is discarded. A timeout, invalid health, missing measurement or unclean shutdown
fails the run. JSON retains every sample, nearest-rank p50/p95, package/release and host identity, package NAR bytes
and closure NAR bytes. NAR size is not compressed download size or filesystem allocation.

Format 2 measures RSS through a fixed Node IPC preload rather than host process inspection (which Darwin's Nix
sandbox denies). The observer's cost is included for both packages; compare only like instrumentation, not old
format-1 measurements. It overwrites inherited Node preload options, runs no provider calls and does not extend
the measured process lifetime. These are explicitly trusted packages: self-reported memory is not tamper-proof
grading of untrusted code. The same process controls remain inside both native Nix test sandboxes.

CI measures the fixed pre-extraction `0ac668e` baseline and exact candidate package on the same native host after
builds finish. These are sequential batches with fresh processes/stores, **not flushed filesystem caches**, peak or
aggregate worker RSS, configured chat latency, model quality, or full platform acceptance. Compare like hosts and
repeat before attributing a difference to code. No regression budget or optimization claim is established by the
runner alone. Browser/PTY/search activation measurements and host-specific regression budgets remain required
for #14; do not change isolation without profiling and correctness regressions.

Optional capabilities start nothing until the owner uses them: `test/idle-capabilities.test.ts` checks that
startup and ordinary chat setup create no worker threads, child processes, terminal addon, browser or search index,
then shows the same observations detect a search index and terminal once used.

### Long-chat transcript measurements

```sh
nix build --out-link package .#default
nix build --out-link transcript-benchmark .#transcript-benchmark
./transcript-benchmark/bin/pal-benchmark-transcript "$PWD/package/lib/pal/dist/public" 7 > transcript.json
```

Each sample opens a fresh in-process Pal fixture with fake provider keys and 500 assistant history entries in a new
1440×900 sandboxed Chromium context limited to loopback, then sends 60 live text updates through the chat's own
event stream. JSON keeps every sample's Chromium task/script/layout/style time and animation-frame waits, their
nearest-rank p50/p95, and web-bundle, browser and host identity. A sample fails unless all history and the exact
live text render, the draft, focus and scroll position are unchanged, no provider request is made and the page
reports no errors. Only the web bundle is selected: the server, fixture and browser come from the runner's tree,
so compare bundles that speak the same API. These are not network, model or page-load latency results. CI runs
the same pre-extraction baseline and candidate bundles on macOS and on Ubuntu 22.04; hosted Ubuntu 24.04 disallows
the user namespaces Chromium's sandbox needs, and the runner never launches Chromium without its sandbox.

### Loopback MCP cache measurements

```sh
nix build --out-link mcp-benchmark .#mcp-benchmark
./mcp-benchmark/bin/pal-benchmark-mcp 7 > mcp.json
```

Each sample creates a fresh store, guidance scope, loopback MCP server and chat. A scripted model performs three
real Code Mode/durable-tool round trips: first read, cached read and explicitly forced live read. Assertions require
successful source receipts, the expected cache/bypass state and exact remote tool counts (1/0/1); failed samples
are errors, not fast successes. JSON retains raw round-trip and MCP receipt durations, HTTP request/catalog-list
counts, process RSS and nearest-rank p50/p95, plus immutable source and native host identity. Owner setup/enablement
is outside the measured phases. Samples share a process and filesystem caches; RSS is neither peak nor aggregate.
This measures this runner's Pal/journal/local transport overhead, not provider/internet latency or model quality.
CI retains seven samples on each native target. It is a baseline measurement, not evidence for connection pooling
or an optimization claim; cache hits still perform the conservative current catalog/authority checks.

### Platform acceptance matrix

[#30](https://github.com/valdo766hi/pal/issues/30) requires equivalent native behavior, not just a portable
job. No row below establishes parity without exact-artifact native evidence. Shared policy stays in core;
platform-specific isolation, locks and lifecycle belong behind narrow adapters.

| Surface | Linux implementation / test entry point | macOS gap or required native evidence |
| --- | --- | --- |
| Owner, providers, chat and responsive UI | `owner`, `providers`, `api`; `test/e2e/app.test.ts` | Native `ui-check` covers isolated chat regressions and DOM policy; full onboarding, revocation and immutable-submission flows still required |
| Projects, uploads, worktrees and review | `projects`, `uploads`, `workspaces`, `changes`; corresponding tests | Case/Unicode aliases, symlinks, permissions, long paths and revision rules |
| Durable runs, Code Mode, memory and search | Pi/SQLite/QuickJS/fff; recovery, context, search and probe tests | Real watcher/Unicode acceptance: `test/e2e/search-watch.test.ts` via `ui-check`; native locking, gap/crash recovery and the remaining filesystem matrix still required |
| Shell and human terminal | `execution`, `terminals`; process/PTY tests | Native descendant/deadline cleanup, Unicode, resize and reconnect |
| Remote and local MCP | `mcp`, `mcp-stdio`; consent, stdio and local recovery tests | Immutable programs, native liveness and parent-death cleanup; no `/proc` substitutes that falsely report death |
| Browser and private-login handoff | Bubblewrap, systemd scope and broker-only egress; `test/e2e/browser.test.ts` | Missing equivalent filesystem/network/resource isolation and protected native tests; proxy-only or disabled sandbox is not parity |
| Compiled capabilities | `extensions`; selection/pin tests | Same lifecycle, compatibility and replay checks as new package contracts arrive |
| Checked releases and supervision | Kernel flock and `/proc` source confinement; release tests/host fixtures | Native lock/descriptor-policy controls; complete protected exact-artifact evaluator and activation/recovery acceptance still required |
| Installation and data operations | Nix package/probes; smoke and schema tests; stopped-state backup/restore in `test/backup.test.ts` and the packaged smoke check | Packaged core/backup smoke plus portable tests; clean installs beyond Nix, launchd and sleep/wake still required |
| Planned workflows | Roadmap #20/#22/#23/#28 | Both platforms need the same grants, budgets, durability and recovery tests |

Browser and release activation currently fail closed without their Linux protections. Keep those gates until
replacements pass adversarial tests; do not count unavailable capabilities or skipped tests as completed
macOS support. Service installation or host security changes require a separately approved host plan.

### Saved working state

Owner-authenticated `GET /api/chats/:id/context/working-state` reads passive state. `PUT` sets
`{ revision, text, constraints, acceptance }`; use the returned goal revision for the next update.
A conflicting edit returns 409. An identical retry preserves the current revision and checkpoint.
Saving never selects a model, submits input, grants permissions or certifies completion.

The bounded Pi document survives restart and compaction. Only explicit owner goals enter the native system
section. Root-chat Code Mode tools `working_read` and `working_checkpoint` retain unverified summary, plan,
next action and questions; helpers cannot use them. Checkpoints bind both goal and checkpoint revisions.
Owner correction or clearing the goal invalidates them. Agent notes may be stale and never substitute for
source checks, durable effect receipts or tested-revision evidence. Clearing removes current state, not old
transcript entries or backups, and does not cancel running work. The prepared-context inspector shows the
owner section actually prepared for a request, not unsent edits. The Context panel lets the owner edit/clear
the goal, explicitly rebase a retained conflicting draft, and refresh unverified checkpoint notes. There is
no automated completion/budget workflow yet.

### Evaluations

Tasks are versioned in `src/evaluation/tasks.ts`, each with a frozen starting repository under
`test/fixtures/evaluation` and an independent grader: `checkout-rounding` (development; bug fix across two files),
`module-inventory` (development; repository understanding, answered in a file while sources stay unchanged),
`slug-test-repair` (held out, version 2; independent cases plus a byte-identical public test),
`checkout-owner-correction` (development; a later owner correction must preserve the earlier rounding rules), and
`checkout-verifier-fallback` (development; a deliberately unavailable local verifier and a working test fallback).
Continuations are delivered after an idle checkpoint in the same conversation/history, not concatenated into the
initial prompt. Scripted owner corrections count as interventions and remain visible in the trace.

```sh
nix build --out-link evaluate .#evaluate
./evaluate/bin/pal-evaluate --data-dir /absolute/evaluation-data --provider openrouter --model <id> \
  --output /absolute/new-report-dir [--effort off] [--repeats 3] [--split development|held-out|all] \
  [--harness pal,baseline] [--external name='command'] [--seconds 600] [--turns 40] [--approvals full|approve-all]
```

This is **owner-run and spends provider credit**. Use a separate evaluation data directory with the provider
configured; a running Pal (such as your normal one) holds its store and refuses to share it. Each task, harness and
repeat starts from a fresh copy of the task's repository. Pal runs as a chat over that copy; the baseline is a plain
loop of the same model object and credentials with four workspace tools, so their rows are **model-matched**.
`--external` runs another product's own command line in the copy with the prompt in `PAL_EVAL_PROMPT`; its model
and settings are outside Pal's control, so it is reported separately as **unmatched**. This single-prompt adapter
explicitly refuses continuation tasks before starting the command; it cannot claim a staged comparison by silently
ignoring later prompts. External commands get a fresh private HOME/TMPDIR and no ambient credentials;
configure the CLI with an explicitly approved evaluation profile,
never credentials in the command or prompt. Reports/traces are private and may contain repository content.

`--seconds` sets one execution deadline, including Pal project/chat preparation; trace export and independent
grading are outside it. Baseline shell calls use at most 30 seconds of the remaining time. Both use GNU timeout
for an independent process-group deadline. Pal's turn/deadline reservation is a Pi document that survives
reopen; exhausting it cancels the native generation task before another model request. Continuations share that
original deadline and turn allowance, including owned research helpers. Native summary tasks also consume the
allowance; their requests bypass Pi's generation request hook. Background summaries must settle within the same
deadline or be cancelled before grading. Provider retries within a native task are not separate turns, so this is not a strict
physical-request or billing cap. `--turns` cannot control an external product. There is no token/cost cap:
approve spending separately. Tool interfaces, prompts, context policy
and approvals differ between harnesses and are recorded, not claimed identical merely because the model matches.

After the run's owned work settles, the workspace is copied read-only and graded; the grader never runs the
candidate's tests or trusts its claims. Listed unchanged paths are checked against the frozen starting snapshot
for both program and answer tasks; changing or removing them fails even if every output is correct.
A run during which the grader, tasks or starting repositories changed is
recorded as `evaluator_changed`, not graded. From the Nix package those files are in the read-only store. The report
(`report.json`, `report.md`) keeps every run, including failures, budget overruns and approvals granted under
`--approvals approve-all` (counted as interventions). Each row links the task and starting-repository digests,
harness version/configuration, exact Pal/baseline runtime identity, model and budget, trace file and SHA-256, and
the graded candidate and grader digests. The candidate is read-only during grading; its digest pins the retained
inspectable copy. Success requires both a passing independent grade and completion within budget, with 95% Wilson
intervals per harness and split. Reports rank harness/grade/tool failures and interventions with example traces,
and aggregate tool-failure rates, latency, tokens and SDK cost estimates (not billed costs; subscription cost and
unreported external metrics are unknown). Pal's metrics include owned helpers, not unrelated chats. Tool counts
refer to model-facing calls/results, not Code Mode's nested host calls; missing result coverage is unknown, not
zero failures. Pal's trace names each conversation and owner edge and includes retained pre-compaction entries,
not just the current prompt. Export is limited to 256 conversations, 32,768 entries and 64 MiB; exceeding a limit
fails the run rather than silently dropping evidence. Treat these complete retained histories as private artifacts.
Results are only comparable between like model/settings/budget rows.
Version 4 of both harness adapters supports task-requested compaction checkpoints within the original deadline
and turn allowance. Summaries use the selected model/effort, Pi-default output-token cap and no cache retention.
Pal uses native prefix compaction and waits for its summary write before the next input; a short native history can
legitimately be a no-op. The baseline summarizes its whole active JSON transcript, omitting thinking, while keeping
the original audit history. These context policies are recorded harness differences, not identical input sequences.
Inspect the trace for an actual summary: a requested checkpoint alone does not prove one occurred.

The six-task initial corpus includes `checkout-context-checkpoint` version 2: a controlled idle restart before
compaction and the owner correction, with the same frozen snapshot/independent cases. Pal's controller closes and
reopens the same installation/implementation, reacquires the conversation and records a host journal witness.
Unfinished tasks/submissions prevent that restart; the original deadline and persisted turn allowance remain.
The baseline instead reloads its active context from a private, digest-checked JSON file (64 MiB maximum), retaining
its counters and audit history. This is explicitly **not** a baseline process restart. Failed Pal reopen retains the
last readable trace/usage rather than inventing recovery or retrying effects.
These are protocol/grading fixtures, not abrupt-process-crash, representative long-horizon or compaction-quality
benchmarks; those remain required for #26/#27. Ordinary checks use scripted fake models; those reports say so and
are not model or harness quality results. Real-provider results are owner-run.
The verifier-fallback fixture exits 69 without contacting a service; both its adapter and public test must remain
unchanged while the checkout fix passes independent cases. Inspect actual command/tool receipts before crediting
failure recovery: artifact correctness alone does not prove that the agent encountered the unavailable verifier.

The grading controls check correct, buggy, forged, hanging and flooding candidates, task starts and reference
solutions. The owner-correction control requires both the new cancellation rule and every original rounding case:

```sh
nix build .#checks.x86_64-linux.evaluation
nix build .#checks.aarch64-darwin.evaluation
```

Candidate programs get read-only access to their own frozen copy, no child processes, workers or addons, a per-case
deadline and bounded output. This is not a general sandbox for Pal's host shell or for the agents under test: the
read-only grader files and their digests keep the score honest, not the host safe.

## Project layout

```
src/
  main.ts          command line: serve, probe, supervise, check-release
  core/            HTTP API, owner auth and the application services
  pi/              model providers, Code Mode policy, MCP clients and browser tools
  storage/         SQLite store, migrations, encrypted credentials
web/src/
  components/      Svelte 5 views and panels
  lib/             API client, chat event stream, shared state, icons
test/              Vitest suites and fixture services; e2e/ for Playwright
nix/               package, checks and test derivations
```

See [architecture](architecture.md) for how the pieces connect.

## Adding capabilities

Prefer extensions and reusable packages over adding more responsibilities to core. The aim is for people to build
and share their own tools, integrations and customizations, not just use the bundled features. See
[extension architecture](architecture.md#extensions-and-releases) for the current scope and trust boundaries.

- **Custom tools today:** implement an MCP server and connect it through [Settings → MCP servers](configuration.md#internet-tools-mcp).
- **Built-in contributions today:** use `src/core/extensions.ts` and the existing native-tool and UI boundaries.
  Interface-only extras do not need a model tool or new permissions.
- **Shared guarantees:** keep owner consent, Code Mode-only model calls, durable receipts, version pins and resource
  limits intact. New defaults must not change active chats or runs.

## Conventions

- TypeScript in strict mode, ES modules and Node 24 APIs. Svelte 5 runes in the UI.
- Prettier formatting and ESLint, both enforced by `pnpm check`.
- **Migrations are append-only.** Add a new entry to `src/storage/migrations.ts`; never edit an applied one.
- **Durable operations.** Anything with an external effect is an unsafe-replay tool or records its intent first,
  so a crash never repeats it blindly. Tests cover the crash points.
- **Commits.** One-line Conventional Commits of at most 72 characters, such as `feat(web): add light theme`.
