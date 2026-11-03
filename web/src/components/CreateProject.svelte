<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type FolderListing, type Project, requestId } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import { viewport } from "../lib/state.svelte.ts";

  let { onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void } = $props();

  let name = $state("");
  let mode: "managed" | "existing" = $state("managed");
  let folder: string | undefined = $state();
  let picking = $state(false);
  let listing: FolderListing | undefined = $state();
  let pathInput = $state("");
  let busy = $state(false);
  let error: string | undefined = $state();
  // One key per dialog: a retried Create after a lost response returns the same project.
  const key = requestId();
  const phone = $derived(viewport() === "phone");
  let dialog: HTMLDialogElement;
  let nameInput: HTMLInputElement | undefined = $state();

  // A native modal keeps focus inside and the page behind it inert; closing returns focus to what opened it.
  onMount(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.showModal();
    nameInput?.focus();
    return () => opener?.focus();
  });

  const crumbs = $derived(
    listing === undefined
      ? []
      : listing.path
          .split("/")
          .filter(Boolean)
          .map((part, index, parts) => ({ label: part, path: `/${parts.slice(0, index + 1).join("/")}` })),
  );

  const folderErrors: Record<string, string> = {
    folder_missing: "That folder doesn't exist on this server.",
    folder_not_directory: "That path is a file, not a folder.",
    folder_unreadable: "Pal can't read that folder. Check its permissions on the server.",
    folder_forbidden: "That folder is inside Pal's own files. Choose another.",
  };

  async function open(path?: string) {
    error = undefined;
    try {
      listing = await api.folders(path);
      pathInput = listing.path;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  async function startPicking() {
    picking = true;
    await open(folder);
  }

  async function create() {
    busy = true;
    error = undefined;
    try {
      const { project } = await api.createProject(key, name.trim(), mode === "existing" ? folder : undefined);
      if (project.state === "failed") error = `Pal couldn't create the workspace: ${project.error ?? "unknown error"}`;
      else onCreated(project);
    } catch (failure) {
      error = failure instanceof ApiError ? (folderErrors[failure.code] ?? failure.message) : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class:phone
  aria-labelledby="create-title"
  oncancel={(event) => {
    event.preventDefault();
    if (picking) picking = false;
    else onClose();
  }}
>
  <div class="top">
    <div class="heading">
      <h2 id="create-title">{picking ? "Choose a folder" : "Create project"}</h2>
      <div class="step">{picking ? "A folder on this server" : "Name and where its files live"}</div>
    </div>
    <button class="b i q tip end" aria-label="Close" data-tip="Close" onclick={onClose}><Icon name="x" /></button>
  </div>

  {#if picking}
    <div class="picker">
      <div class="pathbar">
        <div class="pathrow">
          <button
            class="b i tip start"
            aria-label="Parent folder"
            data-tip="Parent folder"
            onclick={() => open(listing?.parent)}
            disabled={listing?.parent === undefined}
          >
            <Icon name="chevL" />
          </button>
          <label for="picker-path" class="sr">Folder path</label>
          <input
            id="picker-path"
            class="f mono"
            bind:value={pathInput}
            onkeydown={(event) => event.key === "Enter" && open(pathInput)}
            autocomplete="off"
            spellcheck="false"
          />
          <button class="b" onclick={() => open(pathInput)}>Go</button>
        </div>
        <nav aria-label="Path" class="crumbs">
          <button class="b sm q mono" onclick={() => open("/")}>/</button>
          {#each crumbs as crumb, index (crumb.path)}
            {#if index > 0}<span aria-hidden="true" class="sep">/</span>{/if}
            <button class="b sm q mono" aria-current={crumb.path === listing?.path} onclick={() => open(crumb.path)}
              >{crumb.label}</button
            >
          {/each}
        </nav>
      </div>
      <div class="entries">
        {#if listing?.problem === "denied"}
          <div role="alert" class="callout er">
            <strong>Permission denied.</strong> Pal can't read <span class="mono">{listing.path}</span>. Pick another
            folder or change its permissions on the server.
          </div>
        {:else if listing?.problem === "missing"}
          <div role="alert" class="callout wa">
            <strong>No such folder.</strong> <span class="mono">{listing.path}</span> doesn't exist.
          </div>
        {:else if listing?.problem === "not_directory"}
          <div role="alert" class="callout wa">
            <strong>Not a folder.</strong> <span class="mono">{listing.path}</span> is a file.
          </div>
        {:else if listing !== undefined && listing.entries.length === 0}
          <p class="empty">No subfolders.</p>
        {/if}
        <ul role="list">
          {#each listing?.entries ?? [] as entry (entry.path)}
            <li>
              <button class="frow" onclick={() => open(entry.path)}>
                <Icon name="folder" />
                <span class="mono grow">{entry.name}</span>
                {#if entry.git}<span class="pill">Git</span>{/if}
                <Icon name="chevR" />
              </button>
            </li>
          {/each}
        </ul>
        {#if listing?.truncated}<p class="empty">Showing the first 500 folders. Type a path to go further.</p>{/if}
      </div>
      <div class="foot">
        <span class="note mono">{listing?.problem === undefined ? listing?.path : ""}</span>
        <button class="b" onclick={() => (picking = false)}>Cancel</button>
        <button
          class="b p"
          disabled={listing === undefined || listing.problem !== undefined}
          onclick={() => {
            folder = listing?.path;
            picking = false;
          }}>Select folder</button
        >
      </div>
    </div>
  {:else}
    <div class="body">
      <label class="fl"
        >Project name<input
          class="f"
          bind:this={nameInput}
          bind:value={name}
          placeholder="e.g. Platform"
          maxlength="120"
        /></label
      >
      <fieldset>
        <legend>Where the project's files live</legend>
        <label class="choice">
          <input type="radio" name="mode" value="managed" bind:group={mode} />
          <span>
            <span class="cname">Create managed workspace</span>
            <span class="optd">Pal creates a new folder for this project in its data directory on this server.</span>
          </span>
        </label>
        <label class="choice">
          <input type="radio" name="mode" value="existing" bind:group={mode} />
          <span>
            <span class="cname">Use existing folder on this server</span>
            <span class="optd"
              >The project points at a folder that already exists here. Pal doesn't copy or move it.</span
            >
          </span>
        </label>
      </fieldset>
      {#if mode === "existing"}
        {#if folder === undefined}
          <div><button class="b" onclick={startPicking}><Icon name="folder" />Choose folder…</button></div>
        {:else}
          <div class="fold chosen">
            <Icon name="folder" /><span class="mono grow">{folder}</span>
            <button class="b sm" onclick={startPicking}>Change…</button>
          </div>
        {/if}
      {/if}
      <p class="note">
        High-trust host workspace: Pal can write files and run commands as its server user. Commands are not sandboxed;
        the working folder does not confine their access.
      </p>
      {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
    </div>
    <div class="foot">
      <span class="note">Folders stay where they are on the server.</span>
      <button
        class="b p"
        onclick={create}
        disabled={busy || name.trim() === "" || (mode === "existing" && folder === undefined)}>Create project</button
      >
    </div>
  {/if}
</dialog>

<style>
  dialog {
    width: 660px;
    max-width: calc(100% - 48px);
    height: min(640px, 92%);
    max-height: calc(100% - 48px);
    padding: 0;
    flex-direction: column;
    transform-origin: center;
  }
  dialog[open] {
    display: flex;
  }
  dialog.phone {
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    margin: 0;
    border-radius: 0;
  }
  .top {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 12px 12px 18px;
    border-bottom: 1px solid var(--line);
  }
  .heading {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .step {
    font-size: 12px;
    color: var(--tx3);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .body .fl {
    flex: 0 0 auto;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  legend {
    font-size: 13px;
    color: var(--tx2);
    padding: 0;
    margin-bottom: 6px;
  }
  .choice {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 7px;
    cursor: pointer;
  }
  .choice input {
    margin-top: 3px;
  }
  .choice > span {
    display: flex;
    flex-direction: column;
  }
  .cname {
    font-weight: 500;
    font-size: 13px;
  }
  .chosen {
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
    font-size: 13px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .foot {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--line);
    flex-wrap: wrap;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
  }
  .note {
    flex: 1 1 200px;
    font-size: 12.5px;
    color: var(--tx3);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .picker {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .pathbar {
    flex: 0 0 auto;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-bottom: 1px solid var(--line);
  }
  .pathrow {
    display: flex;
    gap: 6px;
  }
  .crumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    font-size: 12.5px;
  }
  .sep {
    color: var(--tx3);
  }
  .entries {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 6px 8px;
  }
  .entries .callout {
    margin: 8px;
  }
  .empty {
    margin: 10px;
    font-size: 13px;
    color: var(--tx3);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .frow {
    border-radius: 6px;
  }
  .frow :global(svg) {
    color: var(--tx3);
  }
</style>
