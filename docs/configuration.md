# Configuration

## Command line

```
pal [serve] [--host <address>] [--port <number>] [--data-dir <path>] [--public-origin <url>]
pal probe
pal doctor [--data-dir <path>] [--json]
pal supervise [serve options]
pal check-release --candidate <absolute worktree path> [--data-dir <path>]
pal backup --output <absolute path> [--data-dir <path>] [--include-credential-key] [--include-browser-profiles]
pal restore --from <absolute path> (--check | --data-dir <path>) [--credential-key <file>]
```

With pnpm, run the server as `pnpm start [options]` (build, then serve) or `pnpm serve [options]` (existing build).
The Nix package installs the same program as `pal`.

| Command         | What it does                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `serve`         | Runs Pal; this is the default command.                                                          |
| `probe`         | Checks SQLite FTS5, fff, Code Mode and the terminal on this host, then exits.                   |
| `doctor`        | Reports build identity, supported schema, core prerequisites and optional capability prerequisites. `--json` emits a support report. |
| `supervise`     | Runs Pal under the release supervisor (Linux, Nix package). See [Releases](#releases).          |
| `check-release` | Tests a candidate worktree with the running package's protected recipes. It never approves or activates anything. |
| `backup`, `restore` | Copy a stopped data directory, verify a backup, or restore it. See [Backup and restore](#backup-and-restore). |

| Option            | Meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `--host`          | Listen address, default `127.0.0.1`. Must be an IP address or `localhost`; any non-loopback address also requires `--public-origin`. |
| `--port`          | TCP port, default `7337`. `0` picks a free port.                                              |
| `--data-dir`      | Absolute path for Pal's data. The default is `$XDG_DATA_HOME/pal` or `~/.local/share/pal` on Linux and `~/Library/Application Support/pal` on macOS. |
| `--public-origin` | The exact origin browsers use, such as `https://pal.example` (no path, query or credentials). |

`pal doctor` exits 1 for a broken core and 0 when only optional prerequisites are missing. It checks native modules,
Git/GNU timeout/Bash versions, and data-directory permissions and writability without creating the directory. A
running store is reported as busy; its schema is not inspected. A stopped store is checked for a readable Pal schema,
not fully integrity-checked or migrated. Doctor neither reads credentials nor contacts model providers, starts a
browser, or activates a release. Browser program checks do not prove namespace, egress or user-scope protection;
those remain mandatory at browser start. Missing macOS browser/release adapters are reported as unavailable, not
parity. Review paths and other metadata before sharing the report.

## Data directory

Everything Pal keeps is in the data directory:

| Path                        | Contents                                                                     |
| --------------------------- | ---------------------------------------------------------------------------- |
| `pal.sqlite`                | Projects, chats, durable runs, settings and sealed credentials (WAL mode)     |
| `credentials.key`           | The 32-byte key that seals credentials (mode 0600). Keep it with the database. |
| `projects/<id>/workspace`   | Folders of managed projects                                                   |
| `uploads/`                  | Files uploaded from your devices                                              |
| `browser/<project>/`        | Browser profiles, including site cookies and logins                           |
| `release-checks/`, `release-control/` | Release candidates and the supervisor's selection (Nix only)        |

Pal creates the directory with mode 0700. If you create it yourself, keep it private (`chmod 700`), because it holds
credentials and site logins. Only one Pal process may own a data directory at a time.

### Backup and restore

Stop Pal (and its supervisor), then:

```sh
pal backup --output /backups/pal-2026-10-21 [--data-dir <path>] [--include-credential-key] [--include-browser-profiles]
pal restore --from /backups/pal-2026-10-21 --check [--credential-key /safe/pal.key]
pal restore --from /backups/pal-2026-10-21 --data-dir <path> [--credential-key /safe/pal.key]
```

`backup` refuses while Pal or a supervisor owns the directory and holds the database's exclusive lock for the
whole copy, so Pal cannot start meanwhile. SQLite makes the consistent database copy. `manifest.json` records
regular-file sizes and SHA-256 checksums, folders, symbolic-link targets (never followed), schema, Pal version,
installation ID and counts of unfinished work. The new folder appears only when complete; folders are 0700 and
files 0600. Other file types refuse the backup.

- **Credential key:** excluded by default, so the backup holds only sealed credentials. Keep `credentials.key`
  somewhere safe and pass it to `restore --credential-key`; Pal checks it against the backup's fingerprint. With
  `--include-credential-key` the backup itself can unseal every saved credential: protect it accordingly. The
  backup folder is not encrypted.
- **Browser profiles** (site cookies and logins) are excluded unless `--include-browser-profiles` is given.
- **Existing-folder projects and reference folders** are never copied; the manifest lists them as external.
- **Release-control state** is copied, but Nix packages it names must still exist on the restoring host.
- **Build identity:** format 2 archives bind the last-opened Pal implementation's digest to the copied database;
  a version such as `0.0.0` alone does not identify a build. Older archives or stores without this metadata use
  format 1 and report `build: null`: their build identity is unknown, not verified. Keep the exact retained
  implementation for unfinished work; a checksum pass does not make a different build compatible with it.

`restore --check` verifies the manifest, every checksum, the absence of unlisted paths, the database's integrity,
schema, installation and recorded build identity, and the key, without writing anything or contacting providers. A backup from a newer
schema than this Pal supports is refused. `restore` performs the same checks, then recreates the backup only at its
original data directory, which must not exist: move a damaged installation aside first; nothing is ever replaced.
Restored folders are new filesystem objects, so the folder identities Pal pinned inside the data directory are
remapped to them; pins on external folders are untouched. Moving an installation to a different path is not
supported yet.

Restoring turns scheduled messages off and pauses active schedules. A claimed firing is retained in its history,
not automatically retried: inspect the chat's receipts and external outcomes before enabling scheduling and
reviewing/resuming individual schedules. Work already admitted to a chat retains its normal durable recovery
rules; a data restore cannot undo external effects.

## First run

On first start, Pal prints a one-time setup link (`http://127.0.0.1:7337/#setup=…`). Open it and choose an owner
passphrase of at least 12 characters. The link works only until the owner exists. Sessions last 30 days.

Onboarding then walks you through four steps:

1. **Provider**: choose and connect any supported provider (see [Models](#models)). Only ChatGPT needs a ChatGPT
   account. ChatGPT sign-in opens OpenAI's sign-in page. Its callback goes to `127.0.0.1:1455` on the machine
   running Pal. If your browser is on another device, the final page will not load; copy its full address and
   paste it into the field Pal shows. For an API key or endpoint, **Continue** turns that provider on.
2. **Model**: choose the model new chats start with.
3. **Internet tools** offers the Exa and Context7 presets, which you can enable now or later.
4. **Create a project**, either a Pal-managed folder or an existing folder on the server.

**Set up later** skips provider/model setup without choosing a default or enabling a provider. This choice survives
reloads and restarts. Create a project now and return through **Connect** or Settings → Models; Send stays disabled
until you explicitly choose a usable model.

Setup makes no model request. If the chosen provider or model later becomes unavailable, Pal stops sending instead
of switching to another one.

## Remote access

Pal accepts requests only for its own host name, and state-changing requests only from its exact origin. To use it
from other devices, choose one of these:

- **Behind an HTTPS reverse proxy.** Keep Pal on loopback and give the proxy's origin:
  `pal serve --public-origin https://pal.example`. The proxy must forward the original `Host` header and pass
  WebSocket upgrades (`/api/terminals/…`, `/api/projects/…/browser/socket`). With an HTTPS origin, session
  cookies are marked `Secure`.
- **On a private network you trust,** such as a VPN address:
  `pal serve --host 100.64.0.10 --public-origin http://100.64.0.10:7337`.

Never expose plain HTTP to the internet: the passphrase and session cookie would travel unencrypted.

## Models

Settings → **Models**:

- **ChatGPT** uses your subscription through Sign in with ChatGPT. Usage counts against that account's limits, and
  Pal never falls back to an API key.
- **API keys and endpoints**: OpenRouter, OpenCode Zen, OpenCode Go, the OpenAI API, the Anthropic API, the DeepSeek
  API and an OpenAI-compatible endpoint. Each one needs a saved key (except a keyless compatible endpoint) and then
  an explicit **Use … in chats** switch.
  - Keys are stored encrypted and never shown again. **Check key** asks the provider without a model request,
    where it documents a way to (OpenRouter, OpenAI, Anthropic, DeepSeek, compatible endpoints). OpenRouter and
    DeepSeek also report your usage or balance.
  - An OpenAI-compatible endpoint takes a name, base URL, model IDs, context window and output limit. The URL may
    point at a private network address, because you chose it.

The model picker in each chat lists ChatGPT once you sign in and every enabled provider, with search. Choosing a
model from another provider sends that chat's history to it with your next message. Model and reasoning changes
wait until active and queued work finishes. If another tab changes the saved settings, Send refuses until you reload
and review them; your draft stays. **Use for new chats** makes the selection the default.
Pal never reads model keys from environment variables such as `OPENAI_API_KEY`.

## Internet tools (MCP)

Settings → **MCP servers**:

- **Exa** (web search and page fetch) and **Context7** (library documentation) are presets. Both work without a
  key at rate-limited levels; a key raises the limits.
- **Custom servers** speak Streamable HTTP over HTTPS. A private-network endpoint needs an explicit opt-in.
- **Tool review.** **Test** connects and lists tools without calling them. You approve exact tool definitions, and
  a changed definition is blocked until you approve it again.
- **Local programs** start a Nix-store executable with exact arguments, folder and an optional key variable, after
  explicit consent. They run unsandboxed as the Pal user.
- **Per-project grants.** The **Internet tools** button in a chat narrows which servers and tools the project may
  use.

## Agent permissions

- **Command approval** is set per chat with the composer's **Ask** / **Full access** pill. Ask is the default for
  every chat.
- **Workspace mode** is chosen when you start a chat:
  - **Local** works in the project folder.
  - **Worktree** works in a separate Git worktree from `HEAD`.
  - **Read-only** has no agent writes and no agent shell.
- **Extensions** (Settings → Extensions) switch built-in tools and panels for new chats. Existing chats keep what
  they started with.

## Research helpers

Off unless selected in Settings → Extensions for new chats. A helper answers one self-contained research question
using the parent chat's model/reasoning and admitted folder scope, with current project internet-tool grants.
It cannot write files, run commands, use the browser or start helpers. The file tools are read-only; granted internet
tools can still have external effects. Each helper uses additional provider requests and quota, not a free model.

One parent run can start four helpers; a project can have two active at once. Each helper has 12 model requests,
40 tool calls, a 200,000-token threshold and 10 minutes; all helpers in one parent run share a 500,000-token
threshold. Counters, deadlines, ownership and project slots survive restarts. Helpers decline history compaction
(which uses additional model requests); if their context fills, they stop without an answer rather than exceed the
request limit. Ordinary chats keep native compaction. Token thresholds are checked before the next request/tool
call, not billing caps: a completed response can cross a threshold.

The transcript links each helper's purpose and result to its parent call. Stop cancels owned helper work; a crash
resumes the same submission and ingests its result once. Interrupted internet calls can have unknown outcomes:
check their external effects before repeating them. Retrying a failed status lookup only reads status, not tools.

## Scheduled messages

Off until you turn on **Scheduled messages** in Settings → General. With it off, nothing runs on a schedule and Pal
needs no queue service or extra process. Once it's on, a chat's **+** menu → **Schedule a message** sends that chat a
message once, every day or on chosen weekdays, at a time in a time zone you pick.

- **Cost and effects.** Before you schedule, Pal shows the chat's model and how it's billed, how often it can run,
  and what a run may do under the chat's command mode, workspace and internet-tool grants. Scheduling approves that
  for every run. A run is an ordinary message in the chat, with the same grants and approvals as one you type: in
  Ask mode, a command waits for you and is declined if nobody answers within 2 minutes.
- **Changed settings.** If the chat's model, reasoning or command mode changes, or its provider is turned off, the
  next run doesn't happen and the schedule pauses until you review the new settings and resume it.
- **Time zones.** Times are wall-clock times in the chosen zone, across daylight-saving changes. A time skipped when
  clocks go forward runs that much later (02:30 runs at 03:30). A time repeated when clocks go back runs once, at
  its first occurrence.
- **Missed runs.** A run Pal notices more than 5 minutes late, because Pal was stopped or asleep, is skipped by
  default. Choose **Send it once when Pal is back** to send only the most recent missed run instead.
- **Overlaps.** A run due while the schedule's previous run is still working is skipped.
- **Pause, resume and cancel.** Paused, cancelled and finished schedules start nothing. Resuming or turning
  scheduling back on starts from the next time; runs due meanwhile are skipped. A schedule can stop after a set
  number of runs, and ends without running if its chat is deleted. Each schedule keeps its recent history.
- **Restarts.** Each run is claimed under a fixed request ID before it's sent, so a crash or restart finishes that run
  once instead of sending it again. The attempt count includes claims whose admission was blocked or interrupted;
  history distinguishes actual admissions. Backup restoration pauses automation as described above.

## Browser

The Browser panel needs the browser runtime: Chromium, bubblewrap, socat and coreutils, plus `systemd-run --user`
for resource limits. The Linux Nix package provides it. Without it the panel says the runtime is unavailable.
Browsing is limited to public addresses on ports 80 and 443. **Clear browser data…** deletes the project's profile,
and removing a project deletes it too.

## Releases

On Linux, the Nix package can run as `pal supervise`. Settings → **Releases** then shows candidates that
`pal check-release` has tested. Activation needs two explicit confirmations:

1. You approve the exact checked digest.
2. You confirm the activation or compatible rollback.

The supervisor drains running work, starts the new child, checks its health and keeps the previous release to fall
back to.

## Environment variables

The Nix package sets these, and most users never need them.

| Variable           | Purpose                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `PAL_TIMEOUT`      | GNU `timeout` used to bound shell and Git commands. Defaults to `timeout`, then `gtimeout`, on `PATH`. |
| `PAL_BASH`         | Bash for agent commands and terminals (default `bash`)                                    |
| `PAL_CHROMIUM`, `PAL_BWRAP`, `PAL_SOCAT`, `PAL_COREUTILS`, `PAL_FONTCONFIG` | Browser runtime programs. The browser is available only when the first four are set. |
| `PAL_SYSTEMD_RUN`  | `systemd-run` for the browser's resource scope (default `systemd-run`)                    |
| `PAL_NIX`, `PAL_FLOCK`, `PAL_RELEASE_*` | Programs and pinned sources for release checks and the supervisor            |

Agent commands start with a clean environment containing `PATH`, a private `HOME` and `TMPDIR`, `LANG` and
`TERM`. Pal's own environment and secrets are not passed on.
