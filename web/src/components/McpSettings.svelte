<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, requestId, type McpServer, type McpServerInput, type McpState } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import ConfirmRemoval from "./ConfirmRemoval.svelte";

  let { onReviewed }: { onReviewed?: () => void } = $props();

  let review = $state(false);
  let servers: McpServer[] = $state([]);
  let loaded = $state(false);
  let open: Record<string, boolean> = $state({});
  let keys: Record<string, string> = $state({});
  let choices: Record<string, string[]> = $state({});
  let previous: Record<string, { server: McpServer; selection: string[] } | undefined> = $state({});
  let busy: Record<string, boolean> = $state({});
  let confirmRemove: string | undefined = $state();
  let error: string | undefined = $state();
  let adding = $state(false);
  let editing: string | undefined = $state();
  let programReview: McpServer | undefined = $state.raw();
  const emptyDraft = () => ({
    name: "",
    url: "",
    transport: "http" as "http" | "stdio",
    command: "",
    cwd: "",
    args: [] as { id: string; value: string }[],
    auth: "none" as "none" | "header" | "bearer" | "env",
    header: "x-api-key",
    variable: "SERVICE_API_KEY",
    key: "",
    private: false,
  });
  let draft = $state(emptyDraft());
  let saveLabel = $derived.by(() => {
    if (busy.save) return "Saving…";
    if (draft.transport === "stdio") return "Save local program";
    return editing === undefined ? "Add and test" : "Save and test";
  });
  function begin(server?: McpServer) {
    editing = server?.id;
    draft = emptyDraft();
    if (server !== undefined) {
      draft.name = server.name;
      draft.url = server.url;
      draft.private = server.private;
      draft.auth = server.auth.kind;
      if (server.auth.kind === "header") draft.header = server.auth.header;
      if (server.auth.kind === "env") draft.variable = server.auth.variable;
      if (server.stdio != null) {
        draft.transport = "stdio";
        draft.command = server.stdio.command;
        draft.cwd = server.stdio.cwd;
        draft.args = server.stdio.args.map((value) => ({ id: requestId(), value }));
      }
    }
    adding = true;
  }
  function transport(value: "http" | "stdio") {
    draft.transport = value;
    draft.auth = "none";
    draft.key = "";
  }

  const STATES: Record<McpState, { label: string; cls: string }> = {
    disabled: { label: "Disabled", cls: "" },
    idle: { label: "Enabled · idle", cls: "ok" },
    connecting: { label: "Connecting", cls: "ac" },
    ready: { label: "Ready", cls: "ok" },
    key_required: { label: "Key required", cls: "wa" },
    rate_limited: { label: "Rate-limited", cls: "wa" },
    unreachable: { label: "Unreachable", cls: "er" },
    blocked: { label: "Blocked by network policy", cls: "er" },
    changed: { label: "Tools changed", cls: "wa" },
    approval_required: { label: "Program approval needed", cls: "wa" },
    error: { label: "Error", cls: "er" },
  };

  onMount(() => {
    void api
      .mcp()
      .then(accept)
      .catch((failure: unknown) => (error = String(failure)))
      .finally(() => (loaded = true));
  });

  function accept(listing: { review: boolean; servers: McpServer[] }) {
    review = listing.review;
    servers = listing.servers;
  }

  function replace(server: McpServer) {
    const known = servers.find((candidate) => candidate.id === server.id);
    const selection = choices[server.id];
    if (known?.catalog != null && known.catalog !== server.catalog && selection !== undefined)
      previous[server.id] ??= { server: known, selection: [...selection] };
    servers = servers.map((known) => (known.id === server.id ? server : known));
    if (previous[server.id] === undefined)
      choices[server.id] = server.tools.filter((tool) => tool.approved && !tool.changed).map((tool) => tool.name);
  }

  async function approveTools(server: McpServer) {
    const catalog = server.catalog;
    if (catalog === null || previous[server.id] !== undefined || busy[server.id]) return;
    const selection =
      choices[server.id] ?? server.tools.filter((tool) => tool.approved && !tool.changed).map((tool) => tool.name);
    await act(server.id, async () => {
      try {
        return await api.mcpTools(server.id, selection, catalog);
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 409) {
          choices[server.id] = selection;
          previous[server.id] ??= { server, selection: [...selection] };
          accept(await api.mcp());
        }
        throw failure;
      }
    });
  }

  function reviewed(server: McpServer) {
    choices[server.id] = (choices[server.id] ?? []).filter((name) =>
      server.tools.some((tool) => tool.name === name && tool.available),
    );
    previous[server.id] = undefined;
  }

  async function act(id: string, work: () => Promise<{ server: McpServer }>) {
    busy[id] = true;
    error = undefined;
    try {
      replace((await work()).server);
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy[id] = false;
    }
  }

  async function finishReview(enable: boolean) {
    busy.review = true;
    try {
      accept(await api.mcpReview(enable));
      onReviewed?.();
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy.review = false;
    }
  }

  async function add() {
    if (busy.save) return;
    busy.save = true;
    error = undefined;
    try {
      let input: McpServerInput;
      if (draft.transport === "stdio") {
        if (draft.auth !== "none" && draft.auth !== "env")
          throw new Error("Local programs use a dedicated key variable or no key.");
        input = {
          transport: "stdio",
          name: draft.name.trim(),
          command: draft.command.trim(),
          args: draft.args.map((arg) => arg.value),
          cwd: draft.cwd.trim(),
          auth: draft.auth === "env" ? { kind: "env", variable: draft.variable } : { kind: "none" },
        };
      } else {
        if (draft.auth === "env") throw new Error("Environment keys are only for local programs.");
        const auth = draft.auth === "header" ? { kind: "header" as const, header: draft.header } : { kind: draft.auth };
        input = { name: draft.name.trim(), url: draft.url.trim(), auth, private: draft.private };
      }
      const { server } = editing === undefined ? await api.mcpAdd(input) : await api.mcpUpdate(editing, input);
      if (editing === undefined) servers = [...servers, server];
      else replace(server);
      if (draft.key !== "" && draft.auth !== "none") replace((await api.mcpKey(server.id, draft.key)).server);
      if (draft.transport === "http") replace((await api.mcpTest(server.id)).server);
      open[server.id] = true;
      adding = false;
      editing = undefined;
      draft = emptyDraft();
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy.save = false;
    }
  }

  async function approveProgram() {
    const server = programReview;
    if (server?.stdio == null) return;
    try {
      replace((await api.mcpProgram(server.id, server.stdio.digest, true)).server);
      programReview = undefined;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) accept(await api.mcp());
      throw failure;
    }
  }

  function programDetails(server: McpServer): string {
    return JSON.stringify(
      {
        command: server.stdio?.command,
        arguments: server.stdio?.args,
        cwd: server.stdio?.cwd,
        environment: [
          "PATH: executable directory",
          "HOME/TMPDIR: private temporary folder",
          "LANG: C.UTF-8",
          ...(server.auth.kind === "env"
            ? [`${server.auth.variable}: this server's encrypted key (value not shown)`]
            : []),
        ],
        lifetime: "90-second independent maximum; no inherited host environment",
        digest: server.stdio?.digest,
      },
      null,
      2,
    );
  }

  function connectionLabel(server: McpServer): string {
    if (server.preset !== null) return "Preset";
    if (server.stdio != null) return "Local program";
    return server.private ? "Private endpoint" : "HTTPS";
  }

  async function remove(id: string) {
    try {
      accept(await api.mcpRemove(id));
      confirmRemove = undefined;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    }
  }

  function toggleTool(id: string, name: string, on: boolean) {
    const current = choices[id] ?? [];
    choices[id] = on ? [...current, name] : current.filter((tool) => tool !== name);
  }

  function authLabel(server: McpServer): string {
    if (server.auth.kind === "none") return "No key";
    let kind = "Bearer key";
    if (server.auth.kind === "header") kind = `Key in ${server.auth.header}`;
    if (server.auth.kind === "env") kind = `Key in ${server.auth.variable}`;
    return `${kind} · ${server.keyConfigured ? "configured" : "not configured"}`;
  }
</script>

<div class="head">
  <h2 class="h2 grow">MCP servers</h2>
  <button class="b p" onclick={() => begin()} disabled={adding}><Icon name="plus" />Add server</button>
</div>
<p class="sub">
  MCP servers give Pal's scripts more tools. Pal calls a tool only while its server is enabled and only after you
  approve it; a server receives whatever a script sends to its tools. Keys are stored encrypted and never shown again.
</p>

{#if review}
  <div class="fold accent">
    <strong>Enable internet tools?</strong>
    <p class="sub">
      Exa searches and reads public web pages; Context7 answers questions from library documentation. Both work without
      a key at limited rates, and a key raises the limits. Queries go to those services, separately from your model
      provider. Pal asks before sending private code or documents to them.
    </p>
    <div class="row-buttons">
      <button class="b p" onclick={() => finishReview(true)} disabled={busy.review}>Enable Exa and Context7</button>
      <button class="b" onclick={() => finishReview(false)} disabled={busy.review}>Not now</button>
    </div>
  </div>
{/if}

{#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}

{#if adding}
  <div class="fold accent">
    <div class="line">
      <strong class="grow">{editing === undefined ? "Add MCP server" : "Edit MCP server"}</strong>
      <button
        class="b i q tip end"
        aria-label="Cancel adding server"
        data-tip="Cancel"
        disabled={busy.save}
        onclick={() => {
          adding = false;
          draft = emptyDraft();
        }}><Icon name="x" /></button
      >
    </div>
    <div class="fields">
      <label class="fl">Name<input class="f" bind:value={draft.name} maxlength="80" autocomplete="off" /></label>
      <div class="fl">
        <span>Transport</span>
        <div class="seg" role="radiogroup" aria-label="Transport">
          <button
            class="segb"
            role="radio"
            aria-checked={draft.transport === "http"}
            disabled={editing !== undefined || busy.save}
            onclick={() => transport("http")}>Streamable HTTP</button
          >
          <button
            class="segb"
            role="radio"
            aria-checked={draft.transport === "stdio"}
            disabled={editing !== undefined || busy.save}
            onclick={() => transport("stdio")}>Local stdio</button
          >
        </div>
      </div>
    </div>
    {#if draft.transport === "stdio"}
      <p class="callout wa">
        Local programs run as the Pal host user, not in a sandbox. They can access files and network beyond their
        working folder. Save first, inspect and approve the exact program, then test and select its tools.
      </p>
      <label class="fl"
        >Command<input
          class="f mono"
          bind:value={draft.command}
          maxlength="4096"
          placeholder="/nix/store/…-server/bin/server"
          autocomplete="off"
          spellcheck="false"
        /></label
      >
      <p class="sub">
        Use an executable already provided by Nix. Pal never installs a package, evaluates a flake, loads .envrc or
        imports repository MCP configuration automatically.
      </p>
      <label class="fl"
        >Working folder on this server<input
          class="f mono"
          bind:value={draft.cwd}
          maxlength="4096"
          autocomplete="off"
          spellcheck="false"
        /></label
      >
      <p class="sub">
        Choose an existing folder outside Pal's private data and installation. This is separate from device uploads or a
        chat's working folder.
      </p>
      {#each draft.args as arg, index (arg.id)}
        <div class="fields">
          <label class="fl wide"
            >Argument {index + 1}<textarea
              class="f mono"
              rows="2"
              maxlength="4096"
              bind:value={arg.value}
              spellcheck="false"></textarea></label
          >
          <button
            class="b sm q"
            aria-label={`Remove argument ${index + 1}`}
            onclick={() => (draft.args = draft.args.filter((item) => item.id !== arg.id))}
            ><Icon name="x" />Remove</button
          >
        </div>
      {/each}
      <div>
        <button
          class="b sm q"
          disabled={draft.args.length >= 32}
          onclick={() => (draft.args = [...draft.args, { id: requestId(), value: "" }])}
          ><Icon name="plus" />Add argument</button
        >
      </div>
      <p class="sub">
        Each row is one exact argument; no shell splitting or expansion. Arguments may name mutable data or code you
        also trust. Do not put keys in arguments.
      </p>
    {:else}
      <label class="fl wide"
        >URL<input
          class="f mono"
          bind:value={draft.url}
          placeholder="https://tools.example.com/mcp"
          maxlength="2048"
          autocomplete="off"
          spellcheck="false"
        /></label
      >
    {/if}
    <div class="fields">
      <label class="fl">
        {draft.transport === "stdio" ? "Authentication" : "Key"}
        <select class="f" bind:value={draft.auth}>
          <option value="none">None</option>
          {#if draft.transport === "stdio"}<option value="env">Encrypted key in environment</option>
          {:else}<option value="header">API key header</option><option value="bearer">Bearer token</option>{/if}
        </select>
      </label>
      {#if draft.auth === "header"}<label class="fl"
          >Header name<input class="f mono" bind:value={draft.header} autocomplete="off" spellcheck="false" /></label
        >{/if}
      {#if draft.auth === "env"}<label class="fl"
          >Key variable<input
            class="f mono"
            bind:value={draft.variable}
            maxlength="64"
            autocomplete="off"
            spellcheck="false"
          /></label
        >{/if}
      {#if draft.auth !== "none"}<label class="fl wide"
          >Key<input class="f mono" type="password" bind:value={draft.key} maxlength="4096" autocomplete="off" /></label
        >{/if}
    </div>
    {#if draft.transport === "http"}
      <label class="flr"
        ><input type="checkbox" bind:checked={draft.private} />Private endpoint: allow a local or private-network
        address (and plain HTTP). Only for servers you run.</label
      >
    {:else}
      <p class="sub">
        Only the dedicated key variable is injected; the host's environment, model provider credentials and other
        servers' keys are never inherited. Use a variable ending in KEY, TOKEN, SECRET or PASSWORD, such as
        SERVICE_API_KEY. Startup or configuration variables are not accepted.
      </p>
    {/if}
    {#if editing !== undefined}<p class="sub">
        Changing the endpoint, program, folder or authentication identity disables the connection, clears approvals and
        deletes its old key. Re-enter a key if needed.
      </p>{/if}
    <div class="row-buttons end">
      <button
        class="b p"
        onclick={add}
        disabled={busy.save ||
          draft.name.trim() === "" ||
          (draft.transport === "http"
            ? draft.url.trim() === ""
            : draft.command.trim() === "" || draft.cwd.trim() === "")}
      >
        {saveLabel}
      </button>
    </div>
  </div>
{/if}

{#if loaded && servers.length === 0}<p class="sub">No MCP servers yet.</p>{/if}
<div class="list">
  {#each servers as server (server.id)}
    {@const status = STATES[server.state]}
    {@const expanded = open[server.id] === true}
    <div class="fold card">
      <div class="line">
        <button class="b q name" aria-expanded={expanded} onclick={() => (open[server.id] = !expanded)}>
          <Icon name={expanded ? "chevD" : "chevR"} />
          <span>{server.name}</span>
          <span class="cmeta">{connectionLabel(server)} · {authLabel(server)}</span>
        </button>
        <span class="pill {status.cls}">{status.label}</span>
        <label class="switch">
          <input
            class="swi"
            type="checkbox"
            role="switch"
            checked={server.enabled}
            disabled={busy[server.id] ||
              (server.stdio != null &&
                (!server.stdio.approved || (server.auth.kind === "env" && !server.keyConfigured)))}
            aria-label={`Enable ${server.name}`}
            onchange={(event) => act(server.id, () => api.mcpEnabled(server.id, event.currentTarget.checked))}
          />
          {server.enabled ? "On" : "Off"}
        </label>
      </div>
      <div class="mono url">{server.stdio?.command ?? server.url}</div>
      {#if busy[server.id]}
        <div class="status" role="status">
          <span class="ring spin" aria-hidden="true"></span>Talking to {server.name}…
        </div>
      {:else if server.state === "approval_required"}
        <div class="callout wa" role="status">
          Inspect and approve this exact local program before it can start. Saving or enabling a configuration never
          grants execution consent.
        </div>
      {:else if server.state === "key_required" || server.state === "rate_limited" || server.state === "changed"}
        <div class="callout wa" role="status">
          <strong>{status.label}.</strong>
          {server.state === "changed"
            ? "Review the tools below; changed ones stay off until approved again."
            : (server.detail ?? "Configure this local program’s dedicated key before testing.")}
        </div>
      {:else if server.state === "unreachable" || server.state === "blocked" || server.state === "error"}
        <div class="callout er" role="alert">
          <span><strong>{status.label}.</strong> {server.detail}</span>
          <div>
            <button
              class="b sm"
              disabled={busy[server.id] || (server.stdio != null && !server.stdio.approved)}
              onclick={() => act(server.id, () => api.mcpTest(server.id))}>Retry</button
            >
          </div>
        </div>
      {/if}
      {#if expanded}
        <div class="details">
          <div class="h3">Connection</div>
          {#if server.stdio != null}
            <p class="callout wa">
              Trusted host execution, not a sandbox. Pal starts this program for discovery or one tool call, then stops
              it; no local server is kept running between requests. Program startup itself can have external effects.
            </p>
            <pre class="program mono">{programDetails(server)}</pre>
            <div class="row-buttons">
              {#if server.stdio.approved}<button
                  class="b sm"
                  disabled={busy[server.id]}
                  onclick={() => act(server.id, () => api.mcpProgram(server.id, server.stdio?.digest ?? "", false))}
                  >Revoke program approval</button
                >
              {:else}<button class="b sm" disabled={busy[server.id]} onclick={() => (programReview = server)}
                  >Review local program…</button
                >{/if}
            </div>
          {/if}
          {#if server.preset === null}<div>
              <button class="b sm q" disabled={busy[server.id] || adding} onclick={() => begin(server)}
                >Edit connection</button
              >
            </div>{/if}
          {#if server.auth.kind !== "none"}
            <div class="fields">
              <label class="fl wide">
                {server.keyConfigured ? "Replace key" : "Key"}
                <input
                  class="f mono"
                  type="password"
                  bind:value={keys[server.id]}
                  placeholder={server.keyConfigured ? "Saved; type to replace" : "Enter this server’s key"}
                  autocomplete="off"
                />
              </label>
            </div>
            <div class="row-buttons">
              <button
                class="b sm"
                disabled={(keys[server.id] ?? "") === ""}
                onclick={() =>
                  act(server.id, async () => {
                    const saved = await api.mcpKey(server.id, keys[server.id] ?? "");
                    keys[server.id] = "";
                    return saved;
                  })}>Save key</button
              >
              {#if server.keyConfigured}
                <button class="b sm q" onclick={() => act(server.id, () => api.mcpKey(server.id, null))}
                  >Remove key</button
                >
              {/if}
            </div>
          {/if}
          <div>
            <button
              class="b sm"
              disabled={busy[server.id] ||
                (server.stdio != null &&
                  (!server.stdio.approved || (server.auth.kind === "env" && !server.keyConfigured)))}
              onclick={() => act(server.id, () => api.mcpTest(server.id))}>Test connection</button
            >
          </div>
          <p class="sub">
            Testing connects and lists tools. It never calls one. Local tests start the approved program; startup
            effects are not undone.
          </p>
          {#if server.stdio == null && !server.private}
            <label class="flr">
              <input
                type="checkbox"
                checked={server.fakeIp}
                disabled={busy[server.id]}
                aria-label={`Allow fake-IP routing for ${server.name}`}
                onchange={(event) => act(server.id, () => api.mcpFakeIp(server.id, event.currentTarget.checked))}
              />
              Allow a trusted local proxy’s fake-IP DNS for this endpoint (198.18.0.0/15).
            </label>
            <p class="sub">
              Only for a proxy you already trust. HTTPS and certificate verification stay on; other private addresses
              stay blocked. Changing this disables the server and clears tool approvals. Test, then enable it again.
            </p>
          {/if}
          <div class="h3">Tools</div>
          {#if previous[server.id] !== undefined}
            <div class="callout wa" role="status">
              The catalog or connection changed. Your previous selection is kept below for comparison; review the
              current definitions before approving. Removed tools cannot be selected again.
            </div>
            <details>
              <summary>Previously reviewed catalog and selection</summary>
              <pre class="program mono">{JSON.stringify(previous[server.id], null, 2)}</pre>
            </details>
            <button class="b sm" disabled={busy[server.id] || server.catalog === null} onclick={() => reviewed(server)}
              >I reviewed the current catalog</button
            >
          {/if}
          {#if server.catalog === null}
            <p class="sub">Test the connection before approving tools for its current configuration.</p>
          {/if}
          {#if server.tools.length === 0}
            <p class="sub">Test the connection to list this server's tools.</p>
          {:else}
            {#each server.tools as tool (tool.name)}
              <div>
                <label class="srcrow tool">
                  <input
                    type="checkbox"
                    disabled={busy[server.id] || !tool.available}
                    checked={(
                      choices[server.id] ?? server.tools.filter((t) => t.approved && !t.changed).map((t) => t.name)
                    ).includes(tool.name)}
                    onchange={(event) => {
                      choices[server.id] ??= server.tools.filter((t) => t.approved && !t.changed).map((t) => t.name);
                      toggleTool(server.id, tool.name, event.currentTarget.checked);
                    }}
                  />
                  <span class="grow">
                    <span class="mono">{tool.name}</span>
                    {#if !tool.available}<span class="pill wa">Not in current catalog</span>
                    {:else if tool.changed}<span class="pill wa">Changed since approval</span>
                    {:else if tool.approved}<span class="pill ok">Approved</span>{/if}
                    <span class="setd">{tool.description}</span>
                  </span>
                </label>
                <details>
                  <summary>Definition: {tool.name}</summary>
                  <pre class="program mono">{JSON.stringify(tool.definition, null, 2)}</pre>
                </details>
              </div>
            {/each}
            <div class="row-buttons">
              <button
                class="b sm p"
                disabled={busy[server.id] || server.catalog === null || previous[server.id] !== undefined}
                onclick={() => approveTools(server)}>Approve selected tools</button
              >
            </div>
          {/if}
          {#if server.preset === null}
            <div class="row-buttons divider">
              {#if confirmRemove === server.id}
                <span class="grow small"
                  >Remove {server.name}? Its tools stop at once and its stored key is deleted.</span
                >
                <button class="b sm" onclick={() => (confirmRemove = undefined)}>Cancel</button>
                <button class="b sm dz" onclick={() => remove(server.id)}>Remove</button>
              {:else}
                <button class="b sm q d" onclick={() => (confirmRemove = server.id)}>Remove server…</button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</div>

{#if programReview?.stdio}
  <ConfirmRemoval
    title="Approve this local MCP program?"
    description="This program runs unsandboxed as the Pal host user, with filesystem and network authority beyond its working folder. Only its Nix executable is pinned; arguments may refer to mutable code or data. Approval persists for this exact command, arguments, folder identity and key variable. Saving approval does not start it: test and select tools separately. Do not approve code you do not trust."
    detail={programDetails(programReview)}
    confirmLabel="Approve program"
    busyLabel="Approving…"
    onCancel={() => (programReview = undefined)}
    onConfirm={approveProgram}
  />
{/if}

<style>
  .program {
    margin: 0;
    padding: 10px;
    background: var(--bg0);
    border: 1px solid var(--line);
    border-radius: 6px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 240px;
    overflow: auto;
    font-size: 12px;
  }
  .head,
  .line {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .accent {
    border-color: var(--acln);
    gap: 12px;
  }
  .row-buttons {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .end {
    justify-content: flex-end;
  }
  .fields {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    align-items: flex-end;
  }
  .wide {
    flex: 3 1 260px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card {
    gap: 10px;
  }
  .name {
    padding-left: 4px;
    flex: 1 1 220px;
    justify-content: flex-start;
    min-width: 0;
    color: var(--tx);
  }
  .name .cmeta {
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .switch {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--tx2);
  }
  .url {
    font-size: 12px;
    color: var(--tx3);
    overflow-wrap: anywhere;
    padding-left: 30px;
  }
  .status {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    color: var(--tx2);
    padding-left: 30px;
  }
  .details {
    display: flex;
    flex-direction: column;
    gap: 12px;
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .tool {
    align-items: flex-start;
    justify-content: flex-start;
    cursor: pointer;
  }
  .tool input {
    margin-top: 3px;
  }
  .tool .grow {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: center;
  }
  .tool .setd {
    flex-basis: 100%;
  }
  .divider {
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }
  .small {
    font-size: 12.5px;
    color: var(--tx2);
  }
</style>
