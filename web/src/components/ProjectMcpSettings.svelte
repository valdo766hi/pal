<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Project, type ProjectMcp, type ProjectMcpServer } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import { navigate } from "../lib/state.svelte.ts";

  /** `row`: the trigger is a list row's value, as in a phone's tools sheet. */
  let { project, row = false }: { project: Project; row?: boolean } = $props();
  let settings: ProjectMcp | undefined = $state.raw();
  let modes: Record<string, "inherit" | "subset"> = $state({});
  let choices: Record<string, string[]> = $state({});
  let busy: string | undefined = $state();
  let error: string | undefined = $state();
  let open = $state(false);
  let dialog: HTMLDialogElement | undefined = $state();
  const names = $derived(
    settings?.servers
      .filter((server) => server.tools.some((tool) => tool.allowed))
      .map((server) => server.name)
      .join(", "),
  );

  function accept(server: ProjectMcpServer) {
    modes[server.id] = server.mode;
    choices[server.id] = server.tools.filter((tool) => tool.selected).map((tool) => tool.name);
  }
  async function refresh() {
    busy = "refresh";
    error = undefined;
    try {
      const listing = await api.projectMcp(project.id);
      settings = listing;
      for (const server of listing.servers) accept(server);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = undefined;
    }
  }
  async function save(server: ProjectMcpServer) {
    busy = server.id;
    error = undefined;
    try {
      const mode = modes[server.id] ?? server.mode;
      const updated = await api.setProjectMcp(
        project.id,
        server.id,
        server.revision,
        mode,
        mode === "inherit" ? [] : (choices[server.id] ?? []),
      );
      const next = updated.servers.find((candidate) => candidate.id === server.id);
      if (next !== undefined && settings !== undefined) {
        settings = { servers: settings.servers.map((current) => (current.id === server.id ? next : current)) };
        accept(next);
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = undefined;
    }
  }
  function show() {
    open = true;
    void refresh();
  }
  function select(server: string, name: string, checked: boolean) {
    const current = choices[server] ?? [];
    choices[server] = checked ? [...current, name] : current.filter((tool) => tool !== name);
  }
  onMount(() => {
    void refresh();
  });
  $effect(() => {
    if (open && dialog !== undefined && !dialog.open) dialog.showModal();
  });
</script>

{#if row}
  <button class="b t" aria-label="Project internet tools" disabled={busy !== undefined && !open} onclick={show}>
    {names || "None enabled"}<Icon name="chevR" size={14} />
  </button>
{:else}
  <button
    class="b i q tip end"
    aria-label="Project internet tools"
    data-tip={names ? `Internet tools · ${names}` : "Internet tools · none enabled"}
    disabled={busy !== undefined && !open}
    onclick={show}
  >
    <Icon name="plug" />
  </button>
{/if}

{#if open}
  <dialog
    bind:this={dialog}
    aria-labelledby="project-mcp-title"
    onclose={() => (open = false)}
    oncancel={(event) => {
      if (busy !== undefined) event.preventDefault();
    }}
  >
    <div class="head">
      <div>
        <p class="sub">Project settings · {project.name}</p>
        <h2 id="project-mcp-title">Internet tools</h2>
      </div>
      <button
        class="b i q tip end"
        aria-label="Close project internet tools"
        data-tip="Close"
        disabled={busy !== undefined}
        onclick={() => dialog?.close()}
      >
        <Icon name="x" />
      </button>
    </div>
    <p class="sub">
      Inherit owner defaults or select fewer approved tools. A project cannot enable a globally disabled connection or
      approve new capabilities.
    </p>
    <p class="sub">
      Changes revoke future calls and cancel active waits. Data already sent cannot be recalled; inspect interrupted
      actions before retrying.
    </p>
    <div class="buttons">
      <button class="b sm" disabled={busy !== undefined} onclick={refresh}>
        <Icon name="refresh" />Refresh permissions
      </button>
      <button
        class="b sm q"
        disabled={busy !== undefined}
        onclick={() => {
          dialog?.close();
          navigate({ view: "settings", tab: "mcp" });
        }}
      >
        Manage connections
      </button>
    </div>
    <p class="small">
      This is a snapshot. Refresh discards unsaved selections; the host checks permissions again for every call.
    </p>
    {#if error}<div class="callout er" role="alert">{error}</div>{/if}
    {#if settings === undefined}<p role="status">Loading project permissions…</p>{:else}
      {#each settings.servers as server (server.id)}
        {@const mode = modes[server.id] ?? server.mode}
        <section class="fold" aria-label={server.name + " project permissions"}>
          <div class="row">
            <h3>{server.name}</h3>
            <span class="pill">{server.enabled ? "Owner enabled" : "Owner disabled"}</span>
          </div>
          <p class="endpoint mono">{server.url}</p>
          <label class="fl">
            Permissions for {server.name}
            <select class="f" bind:value={modes[server.id]} disabled={busy !== undefined}>
              <option value="inherit">Inherit owner defaults</option>
              <option value="subset">Select tools for this project</option>
            </select>
          </label>
          {#if server.authorityStale || server.tools.some((tool) => tool.stale)}<p class="callout wa">
              The connection or selected definitions changed. Review the current tools and save again; old narrowed
              grants do not carry over.
            </p>{/if}
          {#if server.tools.length === 0}<p class="sub">
              No approved tools yet. Test and approve the connection in MCP settings first.
            </p>{/if}
          {#each server.tools as tool (tool.name)}
            {@const selected = (choices[server.id] ?? []).includes(tool.name)}
            <label class="tool">
              <input
                type="checkbox"
                checked={mode === "inherit" ? tool.approved && !tool.changed : selected}
                disabled={busy !== undefined || mode === "inherit" || ((!tool.approved || tool.changed) && !selected)}
                onchange={(event) => select(server.id, tool.name, event.currentTarget.checked)}
              />
              <span>
                <strong class="mono">{tool.name}</strong><span class="description">
                  {tool.description}
                </span>{#if !tool.approved || tool.changed}<span class="warning">
                    Needs owner approval
                  </span>{:else if tool.stale}<span class="warning">Project review required</span>{/if}
              </span>
            </label>
          {/each}
          {#if mode === "subset"}<p class="small">
              No selected tools means this server is blocked for the project.
            </p>{/if}
          <div class="buttons">
            <button
              class="b sm"
              aria-label={`Save ${server.name} project permissions`}
              disabled={busy !== undefined}
              onclick={() => save(server)}
            >
              {server.authorityStale || server.tools.some((tool) => tool.stale)
                ? "Review and save permissions"
                : "Save permissions"}
            </button>
          </div>
        </section>
      {/each}
    {/if}
  </dialog>
{/if}

<style>
  dialog {
    width: 640px;
    max-width: calc(100% - 32px);
    max-height: calc(100dvh - 32px);
    overflow: auto;
  }
  .head,
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  h2 {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
  }
  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .sub {
    margin: 0 0 10px;
    font-size: 13px;
    color: var(--tx2);
  }
  .fold {
    margin-top: 12px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg1);
  }
  .fl {
    flex: none;
  }
  .endpoint {
    overflow-wrap: anywhere;
    font-size: 11.5px;
    color: var(--tx3);
    margin: 6px 0 10px;
  }
  .tool {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 0;
    font-size: 12.5px;
  }
  .tool input {
    margin-top: 4px;
  }
  .tool > span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .description,
  .warning {
    display: block;
    font-size: 12px;
    color: var(--tx3);
  }
  .warning {
    color: var(--wa);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .small {
    color: var(--tx3);
    font-size: 11.5px;
    margin: 8px 0;
  }
</style>
