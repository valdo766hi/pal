# Architecture

Pal is one Node.js process, `pal serve`. It owns a single SQLite database, runs the durable agent runtime and serves
the web UI and its API. The browser UI is a Svelte single-page app that talks to that process only.

```
 browser (Svelte SPA)
   │  JSON API · server-sent events · WebSockets (terminal, browser)
   ▼
 HTTP server ── owner session, exact Host/Origin checks           src/core/server.ts, http.ts, owner.ts
   │
 API routes                                                      src/core/api.ts
   │
 services: chats, projects, workspaces, changes, files, search,  src/core/*.ts
           terminals, browsers, approvals, memory, context, …
   │
 Pi Durable harness ── conversations, tasks, tool receipts       @earendil-works/pi-durable
   ├─ Pi AI models: ChatGPT sign-in + API-key providers           src/pi/chatgpt.ts, providers.ts
   ├─ Code Mode: QuickJS sandbox calling granted host tools       src/pi/codemode.ts
   └─ MCP clients for internet tools                             src/pi/mcp*.ts
   │
 one SQLite file: pal_* tables (Pal) + pi_* tables (Pi)          src/storage/
```

`openPal()` in `src/core/app.ts` builds every service on the one store and returns them together. `src/main.ts`
parses the command line (see [configuration](configuration.md)) and starts the HTTP server around it.

## Storage

- **One owner.** `openStore()` takes exclusive ownership of `pal.sqlite` (WAL, `synchronous=FULL`). A second
  process on the same data directory refuses to start.
- **Pal's schema** lives in `pal_` tables. `src/storage/migrations.ts` applies them in one transaction. The list is
  append-only, and a database written by a newer Pal is refused rather than opened.
- **Pi's durable state** (conversations, entries, tasks, submissions, documents) lives in `pi_` tables of the same
  file. Pal never writes them directly.
- **Credentials** (ChatGPT tokens, provider and MCP keys) are sealed with AES-256-GCM, bound to the installation
  and provider, with a 32-byte key in `credentials.key` outside the database (`src/storage/credentials.ts`).

## Chats and durable runs

A chat is a Pal record mapped to a Pi conversation (`src/core/chats.ts`).

1. `POST /api/chats/:id/inputs` carries a client request ID. Admission is bound to that ID and a digest of the
   body, so a retried request is admitted once, and a different body under the same ID is refused.
2. Pi admits the input. The response is sent only after admission is durable, then a generation task streams the
   model's answer.
3. The model has one tool, `codemode`. Its script runs in a QuickJS worker with wall-clock, memory, output and
   call-count caps, and calls host tools as **nested durable tasks**.
4. Before a tool runs, `beforeTool` hooks decide whether it may: the grant policy (`src/pi/codemode.ts`), then
   command approval for shell commands (`src/core/approvals.ts`). Pi then records the tool's intent and executes it.
5. Events reach the page over server-sent events (`GET /api/chats/:id/events`): a snapshot, then one batch per
   commit. Reconnecting gets a fresh snapshot, so another device can pick up a running chat.

After a crash or restart, Pi resumes from its journal. A Code Mode script replays without repeating calls that
already finished. A tool marked replay-safe may run again. One marked unsafe, such as a shell command or a file
write, is reported as interrupted and never re-run blindly. A command still waiting for approval asks again,
because nothing was recorded as started.

## Projects and workspaces

- `src/core/projects.ts`: a project is a **managed** folder under the data directory or an **existing** folder on
  the server. Pal refuses its own data, install and Nix store paths.
- `src/core/workspaces.ts`, `worktree-files.ts`: each chat gets a fixed workspace in Local, Worktree or Read-only
  mode. A worktree is materialized from committed `HEAD` without running hooks, filters or network access.
- `src/core/folders.ts`: read-only reference folders, bound to a run when it starts.
- `src/core/uploads.ts`: device uploads stored under the data directory, up to 25 MiB each.

## Instruction sources

`src/core/instructions.ts` loads `~/.agents/AGENTS.md` from the Pal host account and the actual chat workspace's
`AGENTS.md` before each model preparation. Global guidance precedes project guidance; deeper instructions apply
only within their subtree. Core policy and the current user always take precedence. Skills are separate: this
instruction loader does not discover or eagerly inject `SKILL.md` bodies.

Context shows current source paths, SHA-256 identities, limits and diagnostics. Project-specific source settings use
revision checks; the global file can be disabled or explicitly changed to an absolute host path, including
`~/AGENTS.md`. There is no implicit home alias or ancestor/sibling crawl. Disabled resolved paths do not fall back
to another file. Local, Read-only and Worktree use their actual workspace, not another source checkout.

`instructions_scope` selects up to eight relative directories. File reads/listings/writes/edits stop before execution
if applicable guidance differs from the last prepared request; the next preparation includes that scoped chain.
Shell commands cannot be reliably parsed for every affected path: declare nested scopes before using `cd` or
commands targeting a subtree. This is guidance coordination, not a shell sandbox or filesystem-race guarantee.

Files are UTF-8 regular files without symlinks or hardlinks, at most 8 KiB each. Source context is bounded to 32 KiB,
32 sources, depth 16, four concurrent inspections and 2,048 entries per source directory; omissions and read failures
are visible, not represented as applied instructions. Loading never executes code or changes grants. Pi journals the
prepared section and tool results, preserving the bytes used by an earlier request after source edits or restart.

## Agent tools

| Namespace | Tools                                                                                 | Source                    |
| --------- | ------------------------------------------------------------------------------------- | ------------------------- |
| files     | `files_folders`, `files_list`, `files_read`, `files_find`, `files_search`, `files_write`, `files_edit` | `src/core/files.ts` |
| shell     | `shell_run`                                                                           | `src/core/execution.ts`   |
| instructions | `instructions_scope` | `src/core/instructions.ts` |
| memory    | `memory_search`                                                                       | `src/core/memory.ts`      |
| browser   | `browser_observe`, `browser_act` (only while the owner has handed control over)       | `src/pi/browser-tools.ts` |
| MCP       | one tool per approved server tool, such as Exa search or Context7 docs                | `src/pi/mcp-tools.ts`     |

The tools share one path policy (`resolveProjectPath`, `isProtected`), which keeps them inside the chat's folders
and away from Pal's data. Writes check the file's current SHA-256 first. Overlapping workspaces are serialized by
`WorkspaceLocks`, and each mutation records a Git baseline first so the Changes panel can show it.

## Review, search and terminal

- `src/core/changes.ts`, `git.ts`: diffs against a recorded baseline, using raw Git object reads with hooks,
  filters, textconv and network disabled. Reviewed marks, line comments and discards are bound to the exact
  revision shown.
- `src/core/search.ts`: shared, lazily created fff indexes, at most three, released when idle.
- `src/core/terminals.ts`: human shells on node-pty, with one input controller, bounded scrollback and backpressure,
  over an authenticated WebSocket. Agent commands never use these shells.

## Browser

`src/core/browser.ts` starts one Chromium per project on demand, using the headless shell that matches
`playwright-core`.

- **Sandbox.** It runs inside bubblewrap with every namespace unshared. It sees only the read-only Nix store, a
  private `/tmp` and its own profile, and it has no network.
- **Egress.** Inside the sandbox, `socat` relays the proxy port to a Unix socket served by `src/core/browser-egress.ts`.
  That broker resolves every destination itself and connects only to public addresses on ports 80 and 443.
- **Resource caps.** The browser starts inside a transient `systemd-run --user` scope with memory, task and CPU
  limits. Without one it refuses to start.
- **Viewing.** Frames reach the owner as JPEG screencast frames over a WebSocket and are never stored.
- **Agent handoff.** The agent gets text-only, bounded views of the page and acts only on elements it has just
  inspected (`src/core/browser-page.ts`). It never sees the owner's frames.

## Providers

`src/pi/chatgpt.ts` implements Sign in with ChatGPT on Pi's OpenAI provider. It verifies the ID token's signature,
issuer, audience, expiry and nonce, and lists only the models the account can use. `src/pi/providers.ts` registers
the API-key providers with stored-key-only auth, so environment variables are never read. They are registered only
while you enable them, and a key echoed back in an error message is scrubbed out.

## Extensions and releases

Pal's extension-first philosophy keeps identity, storage, durability and permission enforcement in a small trusted
core. Capabilities belong in contributions around that core: agent tools, panels, integrations and interface-only
extras. The goal is for built-in and community extensions to follow the same model, bundled into reusable packages
people can create, customize and share.

The current catalog is compiled into Pal, not a public plug-in SDK or a downloadable package loader. Custom MCP
servers are today's way to add tools without rebuilding Pal. Extensions never bypass host policy, and in-process
code requires full application-code trust.

- `src/core/extensions.ts`: built-in contributions (files, shell, memory, browser, compact) can be switched for new
  chats. Each chat freezes its selection and the implementation versions it ran with. Compact output is opt-in: in
  a chat that selected it, `shell_run` asks `rtk rewrite` for an equivalent before recording its intent, runs that
  instead and returns it as `executed`, but only for calls no owner approved and whose output reaches the model.
- `pal check-release` (`src/core/release-check.ts`): builds and tests a candidate Git worktree with the running
  package's own protected recipes and tests. Only a fixed set of UI files may differ.
- `pal supervise` (`src/core/supervise.ts`): a small parent process that owns only release selection. It starts one
  child that owns the database, switches only to a checked digest you approved, probes health and rolls back.
  Linux and Nix only.

## Web UI

`web/src` is a Svelte 5 app built by Vite into `dist/public`.

- `lib/api.ts` is the typed API client, and `lib/chat.svelte.ts` holds a chat's live state from its event stream.
- `components/` holds the views: the chat, the side panels (Changes, Files, Context, Browser, Terminal), Settings
  and the dialogs.
- Panels load lazily, so a plain chat never downloads xterm or the browser view.
