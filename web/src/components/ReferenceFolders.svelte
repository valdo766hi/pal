<script lang="ts">
  import { api, requestId, type FolderListing, type GrantedFolder, type Project, type Workspace } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";

  let {
    project,
    workspace,
    onChanged,
    disabled = false,
  }: {
    project: Project;
    workspace?: Workspace | null | undefined;
    onChanged: (folders: GrantedFolder[]) => void;
    disabled?: boolean;
  } = $props();
  let open = $state(false);
  let dialog: HTMLDialogElement | undefined = $state();
  let folders: GrantedFolder[] = $state.raw([]);
  let path = $state("");
  let indexed = $state(false);
  let listing: FolderListing | undefined = $state.raw();
  let busy = $state(false);
  let error: string | undefined = $state();
  let key = requestId();

  async function run(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = undefined;
    try {
      await work();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }

  async function refresh() {
    folders = (await api.projectFolders(project.id, workspace?.id)).folders;
    onChanged(folders);
  }

  function browse(target = path) {
    return run(async () => {
      listing = await api.folders(target || undefined);
      path = listing.path;
      key = requestId();
    });
  }

  function add() {
    return run(async () => {
      await api.addFolder(project.id, key, path, indexed);
      path = "";
      indexed = false;
      listing = undefined;
      key = requestId();
      await refresh();
    });
  }

  $effect(() => {
    if (open && dialog !== undefined && !dialog.open) dialog.showModal();
  });
</script>

<button
  class="b sm q"
  aria-label="Manage project folders"
  {disabled}
  onclick={() => {
    open = true;
    void run(refresh);
  }}
>
  <Icon name="folder" />Folders
</button>

{#if open}
  <dialog
    bind:this={dialog}
    aria-labelledby="reference-title"
    onclose={() => (open = false)}
    oncancel={(event) => busy && event.preventDefault()}
  >
    <div class="head">
      <div>
        <p class="sub">Project settings · {project.name}</p>
        <h2 id="reference-title">Folders</h2>
      </div>
      <button
        class="b i q tip end"
        aria-label="Close project folders"
        data-tip="Close"
        disabled={busy}
        onclick={() => dialog?.close()}
      >
        <Icon name="x" />
      </button>
    </div>
    <p class="sub">
      References grant read-only file access. Search indexing is separate and off by default. Nothing is copied or
      automatically added to a prompt.
    </p>
    <p class="sub">
      New grants apply to the next run; removal revokes future reads immediately. Removing access never deletes files.
      Folder contents are not trusted instructions.
    </p>
    <p class="callout wa">These file-tool grants do not sandbox host commands or the human Terminal.</p>
    {#if error}<div class="callout er" role="alert">{error}</div>{/if}
    {#each folders as folder (folder.id)}
      <section class="fold" aria-label={folder.id === "primary" ? "Primary workspace" : `Reference ${folder.root}`}>
        <div class="row">
          <span class="mono path">{folder.root}</span><span class="pill">
            {folder.id === "primary" ? "Primary" : "Read-only"}
          </span>
        </div>
        <div class="row">
          <span class="sub">{folder.indexed ? "Search on demand" : "Indexing off"} · Instructions untrusted</span>
          {#if folder.id !== "primary"}<button
              class="b sm q"
              disabled={busy}
              onclick={() =>
                run(async () => {
                  await api.removeFolder(project.id, folder.id);
                  await refresh();
                })}
            >
              Remove access
            </button>{/if}
        </div>
      </section>
    {/each}
    <h3>Add reference folder</h3>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void browse();
      }}
    >
      <label class="fl">
        Folder on this server<input
          class="f mono"
          bind:value={path}
          oninput={() => {
            key = requestId();
            listing = undefined;
          }}
          maxlength="4096"
          autocomplete="off"
          spellcheck="false"
          disabled={busy}
        />
      </label>
      <div class="row">
        <button class="b sm" disabled={busy} type="submit">Browse server folders</button>
        {#if listing?.parent}<button
            class="b sm q"
            disabled={busy}
            type="button"
            onclick={() => browse(listing?.parent)}
          >
            Parent folder
          </button>{/if}
      </div>
    </form>
    {#if listing}
      <div class="picker" aria-label="Server subfolders">
        {#if listing.problem}<p role="alert" class="callout er">
            Cannot select this folder: {listing.problem.replaceAll("_", " ")}.
          </p>
        {:else if listing.entries.length === 0}<p class="sub">
            No subfolders. You can grant access to this folder below.
          </p>{/if}
        {#each listing.entries as entry (entry.path)}<button
            class="frow"
            disabled={busy}
            onclick={() => browse(entry.path)}
          >
            <Icon name="folder" /><span class="mono path">{entry.name}</span><Icon name="chevR" />
          </button>{/each}
        {#if listing.truncated}<p class="sub">Showing the first 500 folders. Type a path to go further.</p>{/if}
      </div>
    {/if}
    <label class="check">
      <input type="checkbox" bind:checked={indexed} onchange={() => (key = requestId())} disabled={busy} />Allow search
      indexing for this reference
    </label>
    <p class="sub">
      With indexing off, individual files can still be browsed and read. To change indexing later, remove and re-add the
      grant; existing runs never gain extra access.
    </p>
    <div class="buttons">
      <button class="b" disabled={busy} onclick={() => dialog?.close()}>Close</button>
      <button
        class="b p"
        disabled={busy ||
          listing === undefined ||
          listing.problem !== undefined ||
          listing.path !== path ||
          folders.length >= 9}
        onclick={add}
      >
        Grant read-only access
      </button>
    </div>
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
  .row,
  .buttons {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .head {
    justify-content: space-between;
    flex-wrap: nowrap;
  }
  .row {
    justify-content: space-between;
  }
  .buttons {
    justify-content: flex-end;
    margin-top: 14px;
  }
  h2,
  h3 {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
  }
  h3 {
    margin-top: 18px;
    font-size: 14px;
  }
  .sub {
    margin: 0 0 10px;
    font-size: 12.5px;
    color: var(--tx2);
  }
  .fold {
    margin: 10px 0;
    padding: 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg1);
  }
  .fold .sub {
    margin: 0;
  }
  .path {
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 12px;
  }
  .fl {
    margin-bottom: 8px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    margin: 12px 0 8px;
  }
  .picker {
    max-height: 200px;
    overflow: auto;
    margin-top: 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px;
  }
  .frow {
    gap: 6px;
    min-height: 32px;
  }
</style>
