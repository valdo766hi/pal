<p align="center"><img src="assets/pal-mark.svg" alt="Pal" width="128" height="128"></p>

# Pal

**Beta · version 0.0.0.** Pal is under active development. Interfaces, the data format and its migrations can still
change between commits, and there are no release builds yet. Keep backups of your data directory.

Pal is a self-hosted, workspace-first AI assistant. You run it on your own computer or server and use it from a
browser on any device. Chats belong to projects with real folders. The agent reads, edits and searches those files,
runs commands, looks things up online and drives a sandboxed browser. You review every change in a diff view and
decide how much it may do without asking.

Runs are durable: a chat keeps going when you close the tab, and a restart resumes interrupted work instead of
silently repeating it.

Unsent drafts and saved sends stay in this tab's memory: 32 chats, 100,000 characters and 10 files per draft.
Navigation keeps them; reloading or signing out clears them. If a send was unconfirmed, inspect chat history before
sending again. **Retry saved send** preserves the original request and destination.

## Philosophy

**Everything is an extension or a package.** Pal should be a small, dependable core with capabilities you can add,
choose and customize. Tools, panels, integrations, workflows and interface extras belong in composable extensions,
not an ever-growing core.

The goal is for anyone to create extensions, add their own tools, customize Pal and share reusable packages.
Built-ins are a starting point, not the limit.

Today, Pal ships compiled, version-pinned built-ins and accepts custom tools through MCP. A public extension SDK
and package installer are not available yet. See [extension architecture](docs/architecture.md#extensions-and-releases).

## Features

- **Models.** Use the provider you have: a ChatGPT subscription (sign-in, no API key), an API key for OpenRouter,
  OpenCode Zen or Go, the OpenAI API, the Anthropic API or the DeepSeek API, or any OpenAI-compatible endpoint such as
  a local Ollama server. You choose the model and reasoning level per chat. Pal never switches provider or falls back
  to another one on its own.
- **Projects and workspaces.** A project is either a Pal-managed folder or an existing folder on the server, plus
  read-only reference folders and uploads from your device. Each chat runs in **Local** (the folder itself),
  **Worktree** (a separate Git worktree from `HEAD`) or **Read-only** mode.
- **Agent tools through Code Mode.** The model writes small scripts in a QuickJS sandbox that call host tools: files
  (list, read, find, search, write, edit), shell commands, project memory, internet tools and the browser. Each tool
  call is a durable task with its own receipt.
- **Command approval.** Per chat, **Ask** (the default) shows each shell command, its folder and timeout, and waits
  for **Approve once** or **Deny**. **Full access** runs commands without asking.
- **Internet tools (MCP).** Exa search/fetch and Context7 documentation presets, custom Streamable HTTP servers and
  owner-approved local programs. Grants are per project, lookups are cached with explicit freshness, and results
  render as source cards.
- **Review.** The Changes panel shows real Git diffs against a recorded baseline, with reviewed marks, line comments
  you can copy to the composer, and discards bound to the revision you looked at. Comments remain recoverable until
  an input containing their unchanged feedback is durably admitted; copying or editing it is not acknowledgement.
  Previously copied comments without admission receipts are offered again. The Files panel has fast
  [fff](https://github.com/dmtrKovalenko/fff)-powered search.
- **Human terminal.** A real shell in the browser (node-pty + xterm). Reconnect from your phone and take over
  control.
- **Context.** Source-linked project memory, pinned chat instructions, bounded global/project/scoped AGENTS.md
  guidance with provenance and disabling, and inspection of the latest retained prepared context.
- **Browser** (Linux). A per-project Chromium with its own profile, running in a network-less sandbox whose only
  egress is a broker that admits public addresses. You drive it from the panel. The agent may use it only after
  you hand it control.
- **Compact command output** (opt-in). Commands with an [rtk](https://github.com/rtk-ai/rtk) equivalent, such as
  `git status` or `ls`, run as it in Full access, so long outputs cost the model fewer tokens. Approved commands,
  pipes and redirects always run unchanged, and receipts show what actually ran.
- **Extensions and releases.** Built-in tools and panels can be toggled for new chats and are pinned per chat. On
  Linux with Nix, `pal check-release` and `pal supervise` test a candidate build and activate it only after your
  explicit approval, with health checks and rollback.
- Responsive layouts from desktop to phone, keyboard support, and dark, light and system themes.

## Quick start

You need **Node.js 24.21 or newer**, **pnpm 11** and **Git**, on Linux or macOS. Pal pins its pnpm version, and
`corepack enable` provides it.

```sh
git clone https://github.com/valdo766hi/pal.git
cd pal
corepack enable   # once, if pnpm is not installed
pnpm install
pnpm start        # builds the web UI and server, then listens on http://127.0.0.1:7337
```

The server prints a one-time setup link. Open it, choose an owner passphrase, then connect a model provider: ChatGPT
sign-in, an API key, or an OpenAI-compatible endpoint. Arguments after `pnpm start` go to the server, for example
`pnpm start --port 8080 --data-dir /srv/pal`. Run `pnpm serve` to start an existing build without rebuilding.

Stop Pal before changing its runtime or dependencies. Unfinished work needs the same implementation bytes;
keep an intact build for recovery. See [source-installation resume safety](docs/development.md#mutable-installations-and-resume-safety).

Platform notes:

- **macOS:** agent shell commands and Git-backed features (Changes, Worktree chats) need GNU `timeout`.
  Run `brew install coreutils`; Pal finds its `gtimeout` automatically.
- **Linux:** the terminal's `node-pty` is compiled during install, which needs Python 3 and a C/C++ toolchain
  (for example `build-essential`).
- **Nix-only features:** the sandboxed browser, local MCP programs and the release supervisor need programs the
  Nix package pins. Without them, those features report that they are unavailable; everything else works.

To check your host, run `node dist/main.js probe`. It tests SQLite FTS5, fff, Code Mode and the terminal.

### With Nix

The flake provides the package, a development shell and the full test suite for `x86_64-linux` and
`aarch64-darwin`:

```sh
nix run github:valdo766hi/pal            # run Pal
nix develop --no-pure-eval               # development shell (devenv) with Node, pnpm and tools
nix build .#checks.x86_64-linux.tests    # also: package, smoke, browser, e2e
```

## Configuration

```
pal [serve] [--host <address>] [--port <number>] [--data-dir <path>] [--public-origin <url>]
pal probe
pal supervise [serve options]                        # Linux + Nix
pal check-release --candidate <worktree> [--data-dir <path>]
```

| Option            | Default                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `--host`          | `127.0.0.1`. Any other address also requires `--public-origin`.                       |
| `--port`          | `7337` (`0` picks a free port)                                                        |
| `--data-dir`      | `$XDG_DATA_HOME/pal` or `~/.local/share/pal` (Linux), `~/Library/Application Support/pal` (macOS) |
| `--public-origin` | None. Set it to the exact origin browsers use, such as `https://pal.example`.         |

See [docs/configuration.md](docs/configuration.md) for remote access, providers, internet tools and environment
variables.

## Security model in brief

- One owner. A passphrase protects the app and sessions are HTTP-only cookies. Requests must name Pal's own host,
  and anything that changes state must come from its exact origin.
- **The agent's shell commands and file writes are not sandboxed.** They run on the host as the user running Pal,
  starting in the project folder. File tools refuse Pal's own data and credentials; shell commands cannot be
  confined that way. Keep chats in **Ask** mode unless you trust what they will run.
- Model and service keys are encrypted at rest (AES-256-GCM) with a key file in the data directory. They are never
  sent back to the browser, and commands start with a clean environment.
- Pal listens on loopback by default. Expose it only through HTTPS or a private network you trust.

Details: [docs/security.md](docs/security.md).

## Documentation

- [Architecture](docs/architecture.md): how the server, durable runtime, storage and web UI fit together
- [Configuration](docs/configuration.md): options, remote access, providers, internet tools, environment
- [Security](docs/security.md): trust boundaries, what is and is not isolated
- [Development](docs/development.md): scripts, tests, project layout, Nix checks

## Built with

TypeScript on Node.js 24, [Pi](https://github.com/earendil-works/pi) Durable, AI and Code Mode, SQLite (Node's
built-in `node:sqlite`), Svelte 5 and Vite, fff, node-pty and xterm.js, Playwright for the browser runtime and tests,
and Nix for reproducible builds.

## License

Pal is licensed under the [Apache License, Version 2.0](LICENSE). Bundled agent skills under `.agents/skills/` keep
their own licenses.
