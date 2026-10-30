# Pal

TypeScript, Node 24, Svelte 5, Pi Durable/AI/Code Mode, SQLite, fff and Nix.
Read relevant code, docs and skills before editing. Preserve the Quiet design.

## Engineering

- Make the smallest clear change that solves the actual problem. Fix causes, not symptoms.
- Reuse existing patterns. Avoid speculative features, dependencies, abstractions and configuration.
- Comment only non-obvious intent or constraints. Never narrate fixes, restate code, leave commented-out code or add unused placeholders.
- Keep validation, security, durability, error handling and accessibility intact. Shorter must not mean weaker.
- Preserve unrelated edits and untracked files. Update existing docs when necessary; do not create status documents or speculative TODOs.

## Product boundaries

- Pi owns durable work; one database owner. Reconcile unknown external effects before retrying.
- Model-initiated MCP calls use Pi Code Mode and host-granted durable tasks. Preserve grants, approval and implementation pins.
- Keep provider choices neutral. Never silently switch providers, spend money or reuse credentials across destinations.
- Human terminals use the host's configured shell and startup files dynamically. Do not force a shell, generate a Pal prompt or edit host dotfiles.
- Keep credentials and Pal's private data out of tools, logs and command environments. A folder or dev shell is not a sandbox.

## Verify and ship

- Reproduce bugs before fixing them; add focused regression coverage. Never weaken tests or suppress real findings to get green.
- Run typecheck, lint, formatting and active Pi Lens checks. For application changes, verify package, smoke, tests, browser and e2e on the exact tree in a supported environment.
- Use isolated fake/local fixtures. Native macOS claims need native evidence; skips and Linux passes are not parity. Real-provider evaluations are owner-run.
- Stage explicit paths and inspect the staged diff. Commit and push only when authorized; never force-push or bypass hooks/protections.
- Separate unrelated changes. Use short, imperative, one-line Conventional Commits, at most 72 characters; no body or co-author trailers.
- Never commit secrets, runtime data, private handoffs, screenshots or raw designs.
