<script lang="ts">
  import { onMount, tick } from "svelte";
  import { api, type GrantedFolder, type Project, type ProjectFolder, type Workspace } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import ReferenceFolders from "./ReferenceFolders.svelte";

  type Preview = Awaited<ReturnType<typeof api.file>>;
  type Found = Awaited<ReturnType<typeof api.search>>;

  let {
    project,
    workspace,
    onAttach,
    onViewDiff,
  }: {
    project: Project;
    workspace?: Workspace | null | undefined;
    /** Put a reference the owner chose into the composer; it is sent only when they send the message. */
    onAttach: (text: string) => void;
    onViewDiff: (path: string) => void;
  } = $props();
  /** Loaded folders by relative path ("" is the project root); only expanded ones are fetched. */
  let folders: Record<string, ProjectFolder> = $state({});
  let expanded: Record<string, boolean> = $state({});
  let preview: Preview | undefined = $state.raw();
  let opener: string | undefined;
  let busy = $state(false);
  let error: string | undefined = $state();
  let back: HTMLButtonElement | undefined = $state();
  const lines = $derived(preview?.kind === "text" ? preview.text.split("\n") : []);
  /** Selected line range, 1-based and inclusive; pick a line, then another to extend. */
  let selection: { from: number; to: number } | undefined = $state();
  let query = $state("");
  let mode: "text" | "regex" | "files" = $state("text");
  let found: Found | undefined = $state.raw();
  let grants: GrantedFolder[] = $state.raw([]);
  let selected = $state("primary");
  const active = $derived(grants.find((folder) => folder.id === selected));
  const root = $derived(workspace?.root ?? project.root);
  const primarySource = $derived(
    workspace?.mode === "worktree" ? `Worktree file (workspace ${workspace.id}, ${root})` : "Project file",
  );
  const source = $derived(
    selected === "primary" ? primarySource : `Reference file (folder ${selected}, ${active?.root ?? ""})`,
  );

  function selectFolder(id: string) {
    selected = id;
    folders = {};
    expanded = {};
    preview = undefined;
    found = undefined;
    selection = undefined;
    void load("");
  }

  function acceptGrants(current: GrantedFolder[]) {
    grants = current;
    if (!current.some((folder) => folder.id === selected)) selectFolder("primary");
  }

  const find = (event: SubmitEvent) => {
    event.preventDefault();
    void run(async () => {
      found = query.trim() === "" ? undefined : await api.search(project.id, query, mode, selected, workspace?.id);
    });
  };

  /** Open a search hit with its line selected and in view. */
  const reveal = (path: string, line: number | undefined) =>
    run(async () => {
      await display(path);
      if (line !== undefined) {
        selection = { from: line, to: line };
        await tick();
        document.querySelector(`[aria-label="Select line ${line}"]`)?.scrollIntoView({ block: "center" });
      }
    });
  const MAX_SNIPPET_CHARS = 20_000;

  function pick(line: number) {
    selection =
      selection === undefined || selection.from !== selection.to
        ? { from: line, to: line }
        : { from: Math.min(selection.from, line), to: Math.max(selection.from, line) };
  }

  function attachLines() {
    if (preview === undefined || selection === undefined) return;
    let snippet = lines.slice(selection.from - 1, selection.to).join("\n");
    if (snippet.length > MAX_SNIPPET_CHARS)
      snippet = `${snippet.slice(0, MAX_SNIPPET_CHARS)}\n[selection cut to ${MAX_SNIPPET_CHARS} characters]`;
    // A fence longer than any backtick run inside keeps the snippet intact.
    const fence = "`".repeat(Math.max(3, ...[...snippet.matchAll(/`+/g)].map((run) => run[0].length + 1)));
    const range =
      selection.from === selection.to ? `line ${selection.from}` : `lines ${selection.from}–${selection.to}`;
    onAttach(`${source} \`${preview.path}\`, ${range}:\n\n${fence}\n${snippet}\n${fence}`);
    selection = undefined;
  }

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

  const load = (path: string) =>
    run(async () => {
      folders[path] = await api.files(project.id, path, selected, workspace?.id);
    });

  function toggle(path: string) {
    expanded[path] = !expanded[path];
    if (expanded[path] && folders[path] === undefined) void load(path);
  }

  /** A link may name a folder or a file; the server's path policy decides whether it is readable at all. */
  async function openLink(path: string) {
    await run(async () => {
      try {
        folders[path] = await api.files(project.id, path, selected, workspace?.id);
        expanded[path] = true;
      } catch {
        await display(path);
      }
    });
  }

  async function display(path: string) {
    opener = path;
    selection = undefined;
    preview = await api.file(project.id, path, selected, workspace?.id);
    await tick();
    back?.focus();
  }

  const show = (path: string) => run(() => display(path));

  async function close() {
    preview = undefined;
    await tick();
    document.querySelector<HTMLButtonElement>(`[data-file-row="${CSS.escape(opener ?? "")}"]`)?.focus();
  }

  function refresh() {
    void run(async () => {
      const current = (await api.projectFolders(project.id, workspace?.id)).folders;
      grants = current;
      if (!current.some((folder) => folder.id === selected)) {
        selected = "primary";
        folders = {};
        expanded = {};
        preview = undefined;
        found = undefined;
        selection = undefined;
      }
      const open = ["", ...Object.keys(expanded).filter((path) => expanded[path])];
      const reloaded = await Promise.all(
        open.map(async (path) => [path, await api.files(project.id, path, selected, workspace?.id)] as const),
      );
      folders = Object.fromEntries(reloaded);
      const opened = preview;
      if (opened !== undefined) {
        const refreshed = await api.file(project.id, opened.path, selected, workspace?.id);
        if (preview === opened) preview = refreshed;
      }
    });
  }

  function size(bytes: number | undefined): string {
    if (bytes === undefined) return "";
    if (bytes < 1024) return `${bytes} B`;
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }

  onMount(() => {
    void run(async () => {
      grants = (await api.projectFolders(project.id, workspace?.id)).folders;
      folders[""] = await api.files(project.id, "", "primary", workspace?.id);
    });
  });
</script>

{#snippet tree(path: string, depth: number)}
  {@const folder = folders[path]}
  {#if folder !== undefined}
    <ul role="list" class="rows">
      {#each folder.entries as entry (entry.path)}
        <li>
          <button
            class="frow"
            style:padding-left={`${12 + depth * 16}px`}
            data-file-row={entry.path}
            disabled={busy}
            aria-expanded={entry.kind === "folder" ? expanded[entry.path] === true : undefined}
            onclick={() =>
              entry.kind === "folder"
                ? toggle(entry.path)
                : entry.kind === "link"
                  ? openLink(entry.path)
                  : show(entry.path)}
          >
            <Icon name={entry.kind === "folder" ? (expanded[entry.path] ? "chevD" : "chevR") : "file"} />
            <span class="mono name">{entry.name}{entry.kind === "link" ? " →" : ""}</span>
            <span class="dim">{size(entry.size)}</span>
          </button>
          {#if entry.kind !== "file" && expanded[entry.path]}{@render tree(entry.path, depth + 1)}{/if}
        </li>
      {/each}
      {#if folder.entries.length === 0}<li class="dim note" style:padding-left={`${28 + depth * 16}px`}>
          Empty folder
        </li>{/if}
      {#if folder.omitted > 0}
        <li class="dim note" style:padding-left={`${28 + depth * 16}px`}>{folder.omitted} more entries not shown</li>
      {/if}
    </ul>
  {:else if expanded[path] || path === ""}
    <p class="dim note" role="status" style:padding-left={`${28 + depth * 16}px`}>Loading…</p>
  {/if}
{/snippet}

<div class="files" aria-busy={busy}>
  <div class="info">
    <span class="pill">{selected === "primary" ? "Primary" : "Read-only"}</span>
    <span class="mono folder" title={active?.root ?? root}>{active?.root ?? root}</span>
    <button class="b sm q" onclick={refresh} disabled={busy}><Icon name="refresh" />Refresh</button>
  </div>
  <div class="folder-tools">
    <label class="sr" for="file-folder">File folder</label>
    <select
      id="file-folder"
      class="f"
      value={selected}
      disabled={busy}
      onchange={(event) => selectFolder(event.currentTarget.value)}
    >
      {#each grants as folder (folder.id)}<option value={folder.id}
          >{folder.id === "primary" ? "Primary workspace" : folder.root}</option
        >{/each}
    </select>
    <ReferenceFolders {project} {workspace} disabled={busy} onChanged={acceptGrants} />
  </div>
  {#if active !== undefined && !active.indexed}<p class="hint">
      Indexing is off for this reference. Browse or read individual files; manage Folders to change the grant.
    </p>{/if}
  {#if error}<div class="callout er" role="alert">{error}</div>{/if}
  {#if preview === undefined}
    <form class="search" role="search" onsubmit={find}>
      <input class="f" type="search" aria-label="Search files" placeholder="Search the project" bind:value={query} />
      <div class="seg" role="radiogroup" aria-label="Search mode">
        {#each [["text", "Text"], ["regex", "Regex"], ["files", "Names"]] as const as [value, label] (value)}
          <button type="button" class="segb" role="radio" aria-checked={mode === value} onclick={() => (mode = value)}
            >{label}</button
          >
        {/each}
      </div>
      <button class="b sm" type="submit" disabled={busy || active?.indexed === false || query.trim() === ""}
        >Search</button
      >
    </form>
    {#if found !== undefined}
      <div class="results-head">
        <span
          >{found.hits.length === 0
            ? "No matches"
            : `${found.hits.length} ${found.hits.length === 1 ? "match" : "matches"}`}</span
        >
        {#if found.truncated}<span class="warning">More matches exist; narrow the search.</span>{/if}
        {#if found.indexing}<span class="warning">Index still building; results may be incomplete.</span>{/if}
        <button class="b sm q" onclick={() => (found = undefined)}>Back to folders</button>
      </div>
      <ul role="list" class="rows scroll" aria-label="Search results">
        {#each found.hits as hit, index (`${hit.path}:${hit.line ?? 0}:${index}`)}
          <li>
            <button class="frow hit" data-file-row={hit.path} onclick={() => reveal(hit.path, hit.line)}>
              <span class="mono hitpath">{hit.path}{hit.line === undefined ? "" : `:${hit.line}`}</span>
              {#if hit.text !== undefined}
                {@const ranges = hit.ranges ?? []}
                <span class="mono hittext"
                  >{#each ranges as [start, end], at (at)}{hit.text.slice(
                      at === 0 ? 0 : (ranges[at - 1]?.[1] ?? 0),
                      start,
                    )}<mark>{hit.text.slice(start, end)}</mark>{/each}{hit.text.slice(ranges.at(-1)?.[1] ?? 0)}</span
                >
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="hint">Read-only view of the project folder. Viewing a file doesn't send it to the model.</p>
      <div class="scroll">{@render tree("", 0)}</div>
    {/if}
  {:else}
    {@const slash = preview.path.lastIndexOf("/")}
    <div class="filehead">
      <button
        class="b i q tip start"
        aria-label="Back to files"
        data-tip="Back to files"
        bind:this={back}
        onclick={close}><Icon name="chevL" /></button
      >
      <span class="mono path" title={preview.path}
        ><span class="dim">{preview.path.slice(0, slash + 1)}</span>{preview.path.slice(slash + 1)}</span
      >
      <span class="pill"><Icon name="lock" />Read-only</span>
    </div>
    <div class="actions">
      <button class="b sm" onclick={() => preview && onAttach(`${source}: \`${preview.path}\``)}
        ><Icon name="clip" />Attach file</button
      >
      {#if preview.kind === "text"}
        <button class="b sm" onclick={attachLines} disabled={selection === undefined}
          >{selection === undefined
            ? "Attach lines"
            : selection.from === selection.to
              ? `Attach line ${selection.from}`
              : `Attach lines ${selection.from}–${selection.to}`}</button
        >
        {#if selection !== undefined}<button class="b sm q" onclick={() => (selection = undefined)}
            >Clear selection</button
          >{/if}
      {/if}
      {#if selected === "primary"}<button class="b sm q" onclick={() => preview && onViewDiff(preview.path)}
          >View diff</button
        >{/if}
    </div>
    {#if preview.kind === "text"}
      <p class="hint">Select lines: choose a line number, then another to extend the range.</p>
    {/if}
    <div class="scroll code">
      {#if preview.kind === "binary"}
        <p class="note">Binary file, {size(preview.size)}. Its contents aren't shown.</p>
      {:else}
        {#if preview.truncated}
          <p class="note warning">Large file ({size(preview.size)}): only the first 256 KB are shown.</p>
        {/if}
        <div class="lines">
          {#each lines as line, index (index)}
            {@const number = index + 1}
            {@const chosen = selection !== undefined && number >= selection.from && number <= selection.to}
            <div class="line" class:chosen>
              <button
                class="number"
                aria-pressed={chosen}
                aria-label={`Select line ${number}`}
                onclick={() => pick(number)}>{number}</button
              ><span class="text">{line}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .files {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .info,
  .filehead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }
  .filehead {
    gap: 6px;
    padding: 8px 10px;
  }
  .folder-tools {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--line);
  }
  .folder-tools .f {
    min-width: 0;
    flex: 1;
    font-size: 12px;
  }
  .folder,
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .folder {
    color: var(--tx2);
  }
  .path {
    font-size: 12.5px;
  }
  .hint {
    margin: 0;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--tx3);
    border-bottom: 1px solid var(--line);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px 0 16px;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .frow {
    min-height: 30px;
    gap: 6px;
  }
  .frow :global(svg) {
    color: var(--tx3);
  }
  .name {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dim {
    color: var(--tx3);
    font-size: 12px;
  }
  .note {
    margin: 6px 12px;
    font-size: 12px;
    color: var(--tx3);
    list-style: none;
  }
  .warning {
    color: var(--wa);
  }
  .code {
    font-family: var(--mono);
    font-size: 12.5px;
    padding-top: 6px;
  }
  .lines {
    display: inline-block;
    min-width: 100%;
  }
  .line {
    display: flex;
    white-space: pre;
    line-height: 20px;
  }
  .number {
    flex: 0 0 46px;
    text-align: right;
    padding: 0 10px 0 0;
    border: 0;
    background: transparent;
    font: inherit;
    line-height: 20px;
    color: var(--tx3);
    cursor: pointer;
    user-select: none;
  }
  .number:hover,
  .number:focus-visible,
  .number[aria-pressed="true"] {
    color: var(--ac);
    background: var(--acbg);
  }
  .chosen {
    background: var(--acbg);
  }
  .search {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
  }
  .search .f {
    flex: 1 1 160px;
    min-width: 0;
    padding: 4px 9px;
  }
  .results-head {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--tx3);
    border-bottom: 1px solid var(--line);
  }
  .results-head .b {
    margin-left: auto;
  }
  .hit {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding-top: 6px;
    padding-bottom: 6px;
  }
  .hitpath {
    font-size: 12px;
    color: var(--tx2);
    overflow-wrap: anywhere;
  }
  .hittext {
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  mark {
    background: var(--acbg);
    color: var(--ac);
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
  }
  .text {
    padding-right: 24px;
  }
</style>
