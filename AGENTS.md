# Pal

A self-hosted, workspace-first AI assistant. One Node 24 process owns one SQLite file, runs Pi's durable agent
runtime and serves a Svelte 5 UI. Stack: TypeScript, Pi Durable/AI/Code Mode, SQLite, fff and Nix.

Before editing, read the code you touch and the relevant docs: `docs/architecture.md` (how it works),
`docs/development.md` (scripts, tests, plugins), `docs/configuration.md` and `docs/security.md` (what Pal enforces).

## How Pal works

- `src/main.ts` starts the server, `openPal()` in `src/core/app.ts` builds every service on the one store, and
  `src/core/api.ts` holds the routes. The UI in `web/src` talks only to this process.
- Pal's tables are `pal_*`; their migrations in `src/storage/migrations.ts` are append-only, and an applied one is
  never edited. Pi owns the `pi_*` tables and Pal never writes them. A second process on the same data refuses to start.
- A chat is a Pi conversation. Each input is admitted once per request ID. After a crash Pi resumes from its
  journal, and a replay-unsafe tool (shell command, file write) is reported as interrupted, never re-run.
- The model acts through Code Mode: QuickJS scripts call granted host tools as nested durable tasks. Grants, the
  shell timeout limit and command approval are checked before any tool runs.
- File tools share one path policy that keeps them inside the chat's folders and out of Pal's data. Every mutation
  records a Git baseline first, so the Changes panel can show it.
- Capabilities are skills, MCP servers or compiled plugins (`plugins/`, contract in `src/capabilities/contract.ts`).
  A chat keeps the plugins and versions it started with; a build that changes them won't start while work is unfinished.

## Principles

- A small, dependable core. New capabilities belong in extensions.
- Durable and honest: anything with an external effect is replay-unsafe or records its intent first, so a crash
  never repeats it blindly. Reconcile unknown outcomes before retrying, and report a failure as a failure.
- The owner decides. Providers stay neutral, with no silent switching or spending. Credentials and Pal's data never
  reach tools, logs or command environments; a folder or dev shell is not a sandbox.
- Human terminals use the host's own shell and startup files. Never force a shell or edit dotfiles.
- Quiet design: calm and restrained. Reuse existing components and the tokens in `web/src/app.css`.

## Changing code

- Make the smallest clear change that fixes the cause. Reuse existing patterns; add no speculative features,
  dependencies, abstractions or configuration.
- Reproduce a bug with a failing test first. Never weaken or skip a test, or suppress a finding, to get green.
- Shorter must not mean weaker: keep validation, security, durability, error handling and accessibility intact.
- Comment only non-obvious intent or constraints. No narration, commented-out code or TODOs.
- Strict TypeScript, ES modules and Node 24 APIs; Svelte 5 runes in the UI.
- Keep docs accurate when behaviour changes. Don't add status documents.

## Verify

- `pnpm check` and `pnpm test`. For UI changes, `pnpm build` then `pnpm test:e2e`.
- The full gate is the flake's checks: `nix build .#checks.x86_64-linux.{package,smoke,tests,browser,e2e}`, and
  `.#checks.aarch64-darwin.portable` on macOS. A skip or a Linux pass is not macOS evidence.
- Tests use local fixtures only: never real accounts, keys or paid model calls.

## Git

- Run `scripts/prepare-local.sh` once per clone, and never bypass its hooks.
- Stage explicit paths and read the staged diff. One-line Conventional Commits of at most 72 characters, with no
  body or trailers.
- Never commit secrets, runtime data, screenshots, raw designs or private notes (`PLAN.md`, `CLAUDE.local.md`).
- Never force-push or rewrite published history.
