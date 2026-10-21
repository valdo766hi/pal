# Security

Pal is a single-owner application with high trust: an AI agent works on the same machine as your files. This page
lists what Pal enforces and, as importantly, what it does not. Pal is beta software; review it before relying on it
for sensitive work.

## Owner access

- **Setup.** The first owner is created only through a one-time setup token printed on the server's terminal.
  The passphrase must have at least 12 characters and is stored as an scrypt hash. Sign-in admits at most ten
  combined pending attempts and wrong passphrases completed in the last ten minutes. Pending attempts cannot age
  out; successes and internal errors release their slot. This process-local limiter resets on restart.
- **Sessions.** Sessions are random opaque tokens in an `HttpOnly`, `SameSite=Strict` cookie, `Secure` behind
  HTTPS. They are stored only as SHA-256 hashes and expire after 30 days. Signing out also closes that session's
  terminal and browser connections.
- **Requests.** Every request must name Pal's own host (loopback names or the `--public-origin` host), which
  blocks DNS rebinding. Every state-changing request and WebSocket upgrade must come from Pal's exact origin. The UI
  is served with a restrictive Content Security Policy.

## Credentials

- **At rest.** ChatGPT tokens and provider, MCP and program keys are sealed with AES-256-GCM. They are bound to the
  installation and provider, and the key lives in `credentials.key` (mode 0600) outside the database.
- **In the API.** Keys are write-only: no response, page, script, transcript or log contains them. A key echoed
  back in a provider's error message is replaced with `[redacted key]` before it is stored.
- **ChatGPT sign-in** verifies the ID token's signature, issuer, audience, expiry and nonce, and refuses a
  different account than the one connected.
- **No ambient keys.** Pal never reads model keys from its environment. Credentials are never passed to agent
  commands, terminals or local programs, except a local program's own consented key.

## What the agent can do

The model has a single tool, `codemode`. Its scripts run in a QuickJS sandbox with memory, time, output and
call-count limits, and can reach the host only through granted tools. Each tool call is checked against the current
grants, workspace and command-approval mode immediately before it runs.

Each script has one 100-call host budget shared by `tools.*`, `searchTools()`, `describeTool()` and
`describeNamespace()`, including rejected calls. Local output, `store()`/`load()` and `ALL_TOOLS` do not consume it.
Pi journals budget rejections in the same order as other results. Changing the call limit or its adapter version
refuses an unfinished replay rather than silently resetting its budget.

- **File tools** resolve real paths, refuse symlink escapes and never touch Pal's data directory or credentials.
  Writes are refused when the file changed since the agent read it.
- **Shell commands are not sandboxed.** They run on the host as the user running Pal, starting in the chat's
  working folder. The environment is clean (no Pal secrets or shell profiles). Commands have at most 120 seconds
  and a bounded output, and Stop kills their process group. GNU `timeout` keeps the deadline even if Pal itself
  dies. A command can still do anything that user can: read other files, use the network or change the system.
- **Ask mode** (the default for every chat) shows each command, its folder and timeout, and runs it only after you
  approve that exact request. Denying, stopping or not answering in time means nothing runs. Switching to **Full
  access** never approves a request that is already waiting.
- **Read-only mode and worktrees are tool policies, not sandboxes.** They change which tools the agent has and
  which folder it works in. They do not confine shell commands, local programs or other processes.
- **After a crash,** a command or write that may have started is reported as interrupted, never re-run on its own.
- **Compact command output** (opt-in, per chat) runs a command's [rtk](https://github.com/rtk-ai/rtk) equivalent,
  such as `rtk git status` for `git status`, so the model reads condensed output. It applies only to commands that
  ran without an approval (Full access): a command you approved in Ask mode always runs exactly as shown. It also
  never applies when output goes to a file or another program (a pipe, redirect, here-document, command
  substitution or background job), so generated files and calculations stay exact. The receipt shows the command
  that ran. The rewrite is rtk's own and is trusted like any program on PATH; it runs with an empty home, so your
  rtk and agent configuration do not apply, and it is killed at a 5-second deadline, on Stop and on shutdown.
  Without rtk, or without an equivalent, the command runs unchanged.

Treat workspace files, web pages and tool results as untrusted input. They can contain instructions meant for the
model (prompt injection), and Pal never grants them tool permissions or policy authority. Loaded AGENTS.md guidance
is subordinate to core policy and the current user. Its source settings grant bounded document reads, not execution
or access to the rest of the home directory. Keep Ask mode on for chats that read content you do not control.

## Internet tools

- **Network policy.** Remote MCP servers must use HTTPS. Connections to loopback, private, link-local and other
  non-public addresses are refused at connect time, after DNS resolution, unless you opt a server into a private
  endpoint. Redirects are refused, and responses and results are size-limited.
- **Tool approval.** You approve exact tool definitions against the displayed catalog digest and connection
  authority. Stale submissions conflict without changing approvals; the UI keeps the old selection for comparison
  and requires review of the current definitions. A changed definition is blocked until approved again, and
  disabling a server or revoking a grant stops calls that are already queued or running.
- **Local MCP programs** are trusted code that runs unsandboxed on the host, like shell commands. Only
  Nix-store executables with exact arguments are accepted, after explicit consent.

## Browser

- **Sandbox.** Each project browser runs Chromium with its own sandbox inside bubblewrap, with every namespace
  unshared. It sees only the read-only Nix store, a private `/tmp` and its profile, and has no network at all.
- **Egress.** Its only way out is a broker on the host that resolves each destination itself and connects only to
  public addresses on ports 80 and 443. This applies to every connection, including redirects and subresources.
- **Resources.** A `systemd-run --user` scope limits memory, tasks and CPU. Without one, the browser does not
  start.
- **Privacy.** Frames go only to your browser and are never stored. Nothing records screenshots, traces, HAR files
  or your input.
- **Agent handoff.**
  - The agent uses the browser only after you hand control over, and you can take it back at any time.
  - It sees bounded page text, not your frames, and acts only on elements it has just inspected.
  - It cannot type into username, password or one-time-code fields; sign-ins are yours.

## Not covered

- Other processes running as the same user can read Pal's data directory.
- Pal keeps history: forgetting a memory or removing a chat hides it from future use but does not erase existing
  records or backups.
- Exposing Pal over plain HTTP outside a trusted private network leaks the passphrase and session.
- Real-site multi-factor sign-in, passkeys and native dialogs in the browser are not promised to work.
