<script lang="ts">
  import { onMount } from "svelte";
  import {
    api,
    ApiError,
    requestId,
    type ChatSummary,
    type ContextInfo,
    type PromptInfo,
    type MemoryInput,
    type MemoryItem,
    type Project,
    type GrantedFolder,
    type Workspace,
  } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import ConfirmRemoval from "./ConfirmRemoval.svelte";
  import InstructionSources from "./InstructionSources.svelte";
  import SkillSources from "./SkillSources.svelte";

  let { project, chat, workspace }: { project: Project; chat: ChatSummary; workspace?: Workspace | null } = $props();
  let info: ContextInfo | undefined = $state.raw();
  let extensions: Awaited<ReturnType<typeof api.chatExtensions>> | undefined = $state.raw();
  let pinDraft: { revision: number; text: string } | undefined = $state();
  let pinStale = $state(false);
  let prompt: PromptInfo | undefined = $state.raw();
  let pages: number[] = $state.raw([]);
  let inspecting = $state(false);
  const pinBytes = $derived(new TextEncoder().encode(pinDraft?.text ?? "").byteLength);
  let items: MemoryItem[] = $state.raw([]);
  let memoryAvailable = $state(false);
  let missingCapabilities: string[] = $state.raw([]);
  let folders: GrantedFolder[] = $state.raw([]);
  let error: string | undefined = $state();
  let busy = $state(false);
  let rebuilding = $state(false);
  let rebuilt = $state(false);
  let generation = 0;
  let editing: MemoryItem | undefined = $state.raw();
  let draft:
    | {
        title: string;
        body: string;
        kind: "owner" | "file" | "chat";
        entry: number;
        folder: string;
        path: string;
        sha256: string;
      }
    | undefined = $state();
  let pending: { intent: string; key: string } | undefined;
  let forgetting: MemoryItem | undefined = $state.raw();
  let preview: Awaited<ReturnType<typeof api.memorySource>> | undefined = $state.raw();
  let previewId: string | undefined = $state();
  let filePreview: string | undefined = $state();
  const savedEntry = $derived(editing?.source.kind === "chat" ? editing.source.entry : undefined);

  async function load() {
    const current = ++generation;
    const [context, pins, catalog] = await Promise.all([
      api.context(chat.id),
      api.chatExtensions(chat.id),
      api.extensions(),
    ]);
    const hasMemory = catalog.catalog.some((item) => item.id === "memory" && item.available !== false);
    const [memory, grants] = hasMemory
      ? await Promise.all([api.memory(project.id, workspace?.id), api.projectFolders(project.id, workspace?.id)])
      : [{ items: [] }, { folders: [] }];
    if (current !== generation) return;
    info = context;
    extensions = pins;
    memoryAvailable = hasMemory;
    missingCapabilities = pins.selected
      .filter(
        (choice) =>
          !catalog.catalog.some(
            (item) => item.available !== false && item.id === choice.id && item.version === choice.version,
          ),
      )
      .map((choice) => `${choice.id}@${choice.version}`);
    items = memory.items;
    folders = grants.folders;
  }
  onMount(() => {
    void load().catch((failure: unknown) => (error = String(failure)));
    return () => {
      generation++;
    };
  });
  async function refresh() {
    error = undefined;
    preview = undefined;
    previewId = undefined;
    prompt = undefined;
    pages = [];
    try {
      await load();
      if (pinDraft !== undefined && pinDraft.revision !== info?.pinned.revision) pinStale = true;
    } catch (failure) {
      error = String(failure);
    }
  }
  function editPin() {
    if (info === undefined) return;
    pinDraft = { revision: info.pinned.revision, text: info.pinned.text };
    pinStale = false;
    error = undefined;
  }
  function rebasePin() {
    if (pinDraft === undefined || info === undefined) return;
    pinDraft.revision = info.pinned.revision;
    pinStale = false;
    error = undefined;
  }
  async function savePin() {
    const selected = pinDraft;
    if (selected === undefined || busy || pinStale) return;
    busy = true;
    error = undefined;
    try {
      await api.pinInstructions(chat.id, selected.revision, selected.text);
      pinDraft = undefined;
      await load();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        await load();
        pinStale = true;
      }
      error = String(failure);
    } finally {
      busy = false;
    }
  }
  async function inspectPrompt(offset = 0, request?: string, previous: number[] = []) {
    if (inspecting) return;
    const current = generation;
    const id = chat.id;
    inspecting = true;
    error = undefined;
    try {
      const value = await api.contextPrompt(id, offset, request);
      if (current === generation && id === chat.id) {
        prompt = value;
        pages = previous;
      }
    } catch (failure) {
      error = String(failure);
    } finally {
      inspecting = false;
    }
  }
  function nextPrompt() {
    if (prompt?.next == null) return;
    void inspectPrompt(prompt.next, prompt.request.digest, [...pages, prompt.offset]);
  }
  function previousPrompt() {
    const offset = pages.at(-1);
    if (offset === undefined || prompt === undefined) return;
    void inspectPrompt(offset, prompt.request.digest, pages.slice(0, -1));
  }
  function begin(item?: MemoryItem) {
    editing = item;
    const source = item?.source;
    draft = {
      title: item?.title ?? "",
      body: item?.body ?? "",
      kind: source?.kind ?? "owner",
      entry: source?.kind === "chat" ? source.entry : 0,
      folder: source?.kind === "file" ? source.folder : "primary",
      path: source?.kind === "file" ? source.path : "",
      sha256: source?.kind === "file" && item?.state === "current" ? source.sha256 : "",
    };
    pending = undefined;
    preview = undefined;
    previewId = undefined;
    filePreview = undefined;
    error = undefined;
  }
  async function readSource() {
    if (draft === undefined) return;
    const selected = { folder: draft.folder, path: draft.path };
    busy = true;
    error = undefined;
    try {
      const file = await api.file(project.id, selected.path, selected.folder, workspace?.id);
      if (draft?.kind !== "file" || draft.folder !== selected.folder || draft.path !== selected.path) return;
      if (file.kind !== "text" || file.sha256 === null || file.truncated)
        throw new Error("Choose a bounded text source with a complete hash.");
      draft.sha256 = file.sha256;
      filePreview = Array.from(file.text).slice(0, 4000).join("");
    } catch (failure) {
      error = String(failure);
    } finally {
      busy = false;
    }
  }
  async function save() {
    if (draft === undefined || busy) return;
    busy = true;
    error = undefined;
    try {
      let source: MemoryInput["source"] = { kind: "owner" };
      if (draft.kind === "file") {
        if (draft.sha256 === "") throw new Error("Read and verify the source file before saving.");
        source = { kind: "file", folder: draft.folder, path: draft.path, sha256: draft.sha256 };
      } else if (draft.kind === "chat") {
        if (draft.entry < 1) throw new Error("Choose a source message.");
        const old = editing?.source;
        source = {
          kind: "chat",
          chat: old?.kind === "chat" && old.entry === draft.entry ? old.chat : chat.id,
          entry: draft.entry,
        };
      }
      const input: MemoryInput = { title: draft.title.trim(), body: draft.body.trim(), source };
      if (editing === undefined) {
        const intent = JSON.stringify(input);
        if (pending?.intent !== intent) pending = { intent, key: requestId() };
        await api.memorySave(project.id, pending.key, input, workspace?.id);
      } else await api.memoryCorrect(project.id, editing.id, editing.revision, input, workspace?.id);
      draft = undefined;
      editing = undefined;
      pending = undefined;
      await load();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) await refresh();
      error = String(failure);
    } finally {
      busy = false;
    }
  }
  async function viewSource(item: MemoryItem) {
    busy = true;
    error = undefined;
    try {
      preview = await api.memorySource(project.id, item.id, workspace?.id);
      previewId = item.id;
    } catch (failure) {
      error = String(failure);
    } finally {
      busy = false;
    }
  }
  async function forget() {
    const item = forgetting;
    if (item === undefined) return;
    try {
      await api.memoryForget(project.id, item.id, item.revision, workspace?.id);
      forgetting = undefined;
      preview = undefined;
      await load();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) await refresh();
      throw failure;
    }
  }
  async function rebuild() {
    rebuilding = true;
    rebuilt = false;
    error = undefined;
    try {
      await api.memoryRebuild(project.id);
      rebuilt = true;
    } catch (failure) {
      error = String(failure);
    } finally {
      rebuilding = false;
    }
  }
  function sourceLabel(item: MemoryItem) {
    if (item.source.kind === "file") return `${item.source.folder} / ${item.source.path}`;
    if (item.source.kind === "chat") return `Chat message #${item.source.entry}`;
    return "Owner note";
  }
</script>

<div class="context">
  <div class="toolbar">
    <span class="mono grow">{workspace?.root ?? project.root}</span>
    <button class="b sm q" onclick={refresh} disabled={busy || inspecting}
      ><Icon name="refresh" />Refresh context</button
    >
  </div>
  {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
  {#if info === undefined}<p class="sub" role="status">Loading context…</p>
  {:else}
    <section aria-label="Project instructions">
      <h3 class="h3">Project instructions</h3>
      <p class="sub">
        Core instructions and owner-pinned guidance for this chat. Global, project and scoped AGENTS.md sources are
        inspected separately below; none of them grants tool permissions.
      </p>
      <details>
        <summary>View stored instructions</summary>
        <pre class="mono">{info.instructions || "No stored instructions."}</pre>
      </details>
      <div class="row">
        <strong class="sub grow">Pinned for this chat · revision {info.pinned.revision}</strong>
        <span class="sub"
          >{info.pinned.estimatedTokens.toLocaleString()} estimated tokens · {info.pinned.bytes} bytes</span
        >
      </div>
      {#if info.pinned.text !== ""}<pre class="mono" aria-label="Saved pinned instructions">{info.pinned
            .text}</pre>{/if}
      <p class="sub">
        Limits: {info.budgets.pinnedTokens.toLocaleString()} estimated tokens and 6 KiB UTF-8. Pi estimates are not provider
        measurements. Core policy and tool declarations are separate. Changes apply at the next preparation, not to an already-sent
        request, and never grant tool permissions.
      </p>
      {#if pinDraft === undefined}<div>
          <button class="b sm q" onclick={editPin} disabled={busy || inspecting}>Edit pinned instructions</button>
        </div>
      {:else}<form
          class="editor"
          onsubmit={(event) => {
            event.preventDefault();
            void savePin();
          }}
        >
          <fieldset disabled={busy}>
            <label class="fl"
              >Instructions pinned for this chat<textarea class="f" rows="5" maxlength="6144" bind:value={pinDraft.text}
              ></textarea></label
            >
            <span class="sub"
              >Draft: {pinBytes.toLocaleString()} / {info.budgets.pinnedBytes.toLocaleString()} UTF-8 bytes</span
            >
            {#if pinStale}<p class="callout wa">
                Your draft is retained. Review the current saved instructions above before choosing to replace them.
              </p>
              <button class="b sm" type="button" onclick={rebasePin}>Use current revision for my draft</button>{/if}
            <div class="row end">
              <button
                class="b sm q"
                type="button"
                onclick={() => {
                  pinDraft = undefined;
                  pinStale = false;
                }}>Cancel instruction edit</button
              ><button class="b sm p" type="submit" disabled={pinStale || pinBytes > info.budgets.pinnedBytes}
                >Save pinned instructions</button
              >
            </div>
          </fieldset>
        </form>{/if}
      <p class="sub">
        Model: {info.model?.modelId ?? "Not selected"}. {info.head === null
          ? "No context head marker."
          : `Context head entry #${info.head}. Original history remains retained.`}
      </p>
    </section>
    {#key chat.id}<InstructionSources chatId={chat.id} /><SkillSources chatId={chat.id} />{/key}
    {#if extensions}
      <section aria-label="Extension pins">
        <h3 class="h3">Extension pins</h3>
        <p class="sub">
          This chat keeps its selected built-ins. Defaults in Settings affect new chats only. Core authorization and
          approval hooks always remain active.
        </p>
        <div class="row">
          {#each extensions.selected as item (item.id)}<span class="pill mono">{item.id}@{item.version}</span>{/each}
        </div>
        {#if missingCapabilities.length > 0}<p class="callout wa" role="status">
            This chat requires its retained Pal release: {missingCapabilities.join(", ")} is unavailable in this build. New
            input and tool execution are blocked.
          </p>{/if}
        <details>
          <summary>Recent native request pins</summary>
          <p class="sub">
            Up to 100 recent transcript entries are inspected. Each request pins its immutable implementation; older
            history remains in Pi.
          </p>
          {#each extensions.requests as pin (pin.task)}<pre
              class="mono">{`Task ${pin.task} · ${pin.release}\n${pin.selected.map((item) => `${item.id}@${item.version}`).join(", ")}${pin.implementations === undefined ? "" : `\n${pin.implementations.map((item) => `${item.id}@${item.version} · ${item.digest}`).join("\n")}`}`}</pre>{:else}<p
              class="sub"
            >
              No request pins yet.
            </p>{/each}
        </details>
      </section>
    {/if}
    {#if memoryAvailable}
      <section aria-label="Curated memory">
        <div class="row">
          <h3 class="h3 grow">Curated memory</h3>
          <button class="b sm" onclick={() => begin()} disabled={busy || draft !== undefined}
            ><Icon name="plus" />Add memory</button
          >
        </div>
        <p class="sub">
          Source-linked facts for this project. Searchable on demand through Code Mode, not automatically added to
          prompts. File-backed notes are withheld when their content or grants change. Unavailable sources are hidden.
        </p>
        {#if draft !== undefined}
          <form
            class="editor"
            onsubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy}>
              <legend>{editing === undefined ? "New memory" : `Correct revision ${editing.revision}`}</legend>
              <label class="fl">Memory title<input class="f" maxlength="120" required bind:value={draft.title} /></label
              >
              <label class="fl"
                >Memory fact<textarea class="f" rows="4" maxlength="2000" required bind:value={draft.body}
                ></textarea></label
              >
              <label class="fl"
                >Source type<select class="f" bind:value={draft.kind}
                  ><option value="owner">Owner note (this form)</option><option value="chat">Chat message</option
                  ><option value="file">File revision</option></select
                ></label
              >
              {#if draft.kind === "chat"}
                <label class="fl"
                  >Source message<select class="f" bind:value={draft.entry}>
                    <option value={0}>Choose a retained message</option>
                    {#if savedEntry !== undefined && !info.sources.some((source) => source.entry === savedEntry)}<option
                        value={savedEntry}>Saved source #{savedEntry}</option
                      >{/if}
                    {#each info.sources as source (source.entry)}<option value={source.entry}
                        >#{source.entry} · {source.text.slice(0, 75)}</option
                      >{/each}
                  </select></label
                >
                <p class="sub">
                  Up to 20 recent transcript entries are inspected. Existing saved sources remain linked after
                  compaction.
                </p>
              {:else if draft.kind === "file"}
                <label class="fl"
                  >Source folder<select
                    class="f"
                    bind:value={draft.folder}
                    onchange={() => {
                      if (draft) draft.sha256 = "";
                      filePreview = undefined;
                    }}
                    >{#each folders as folder (folder.id)}<option value={folder.id}
                        >{folder.id === "primary" ? "Working folder" : "Read-only reference"} · {folder.root}</option
                      >{/each}</select
                  ></label
                >
                <label class="fl"
                  >Source file<input
                    class="f mono"
                    maxlength="1024"
                    bind:value={draft.path}
                    oninput={() => {
                      if (draft) draft.sha256 = "";
                      filePreview = undefined;
                    }}
                    placeholder="docs/decision.md"
                  /></label
                >
                {#if filePreview !== undefined}<pre
                    class="mono"
                    aria-label="Verified source preview">{filePreview}</pre>
                  <p class="sub">Preview: up to 4,000 characters. The saved hash covers the complete file.</p>{/if}
                <div class="row">
                  <button class="b sm" type="button" onclick={readSource} disabled={draft.path === ""}
                    >Verify source file</button
                  ><span class="sub">{draft.sha256 === "" ? "Not verified" : "Full-file hash verified"}</span>
                </div>
              {:else}<p class="sub">This is your statement, not a citation to an external document.</p>{/if}
              <div class="row end">
                <button
                  type="button"
                  class="b sm q"
                  onclick={() => {
                    draft = undefined;
                    editing = undefined;
                  }}>Cancel memory edit</button
                ><button class="b sm p" type="submit" disabled={draft.title.trim() === "" || draft.body.trim() === ""}
                  >{busy ? "Saving…" : "Save memory"}</button
                >
              </div>
            </fieldset>
          </form>
        {/if}
        {#if items.length === 0}<p class="sub">
            No available memories yet. Save a fact or decision with its source.
          </p>{/if}
        <ul>
          {#each items as item (item.id)}
            <li class="memory">
              <h4>{item.title}</h4>
              <p class="fact">{item.body}</p>
              <div class="row sub">
                <span class="pill">Revision {item.revision}</span><span class="grow">{sourceLabel(item)}</span
                >{#if item.state === "changed"}<span class="pill wa">Source changed · retrieval off</span>{/if}
              </div>
              <div class="row">
                <button
                  class="b sm q"
                  aria-label={`View source for ${item.title}`}
                  onclick={() => viewSource(item)}
                  disabled={busy}>View source</button
                ><span class="grow"></span><button
                  class="b sm q"
                  aria-label={`Correct ${item.title}`}
                  onclick={() => begin(item)}
                  disabled={busy || draft !== undefined}>Correct</button
                ><button
                  class="b sm q d"
                  aria-label={`Forget ${item.title}`}
                  onclick={() => (forgetting = item)}
                  disabled={busy}>Forget…</button
                >
              </div>
              {#if previewId === item.id && preview !== undefined}<div
                  class="source"
                  role="region"
                  aria-label="Memory source"
                >
                  <strong>{preview.label}</strong>{#if !preview.current}<p class="callout wa">
                      The source differs from the saved hash. This is the current file, not the original revision.
                    </p>{/if}
                  <pre class="mono">{preview.text}</pre>
                  {#if preview.truncated}<p class="sub">Preview is bounded; additional content is omitted.</p>{/if}
                </div>{/if}
            </li>
          {/each}
        </ul>
        <div class="row">
          <button class="b sm q" onclick={rebuild} disabled={rebuilding}
            >{rebuilding ? "Rebuilding…" : "Rebuild memory search"}</button
          >{#if rebuilt}<span class="sub" role="status">Memory search rebuilt.</span>{/if}
        </div>
        <p class="sub">
          Forgetting stops future lookups. Earlier transcripts, retained revisions and backups are not erased. Limits:
          200 retained notes per project, 32 revisions per note, 8 MiB per installation. Model lookups retain at most
          3,000 UTF-8 bytes.
        </p>
      </section>
    {:else}<p class="sub">Memory is not included in this build; saved notes remain retained.</p>{/if}
    <section aria-label="Last prepared context">
      <div class="row">
        <h3 class="h3 grow">Last prepared context</h3>
        <button class="b sm q" onclick={() => inspectPrompt()} disabled={busy || inspecting || info.prepared === null}
          >{inspecting ? "Inspecting…" : "Inspect prepared prompt"}</button
        >
      </div>
      <p class="sub">
        Native Pi context at its recorded preparation boundary, before provider serialization. Preparation is not proof
        of transmission. This does not predict the next request. Image and reasoning bodies/signatures are omitted; text
        previews are bounded. Inspection makes no model call.
      </p>
      {#if info.prepared === null}<p class="sub">No model request has been prepared yet.</p>{/if}
      {#if prompt !== undefined}
        <div class="lookup">
          <strong>{prompt.request.model.modelId} · {prompt.request.thinkingLevel}</strong><time
            datetime={new Date(prompt.request.at).toISOString()}>{new Date(prompt.request.at).toLocaleString()}</time
          ><span class="sub"
            >{prompt.request.estimatedTokens.toLocaleString()} estimated context tokens · {prompt.request.messages} messages
            · cutoff #{prompt.request.cutoff}</span
          ><span class="sub"
            >Model context window: {prompt.request.contextWindow?.toLocaleString() ?? "Unknown"} tokens. Pi default compaction
            reserve: {prompt.request.reserveTokens.toLocaleString()} tokens for output/tool space. Estimates may differ from
            actual usage.</span
          >
        </div>
        <h4>Effective named sections</h4>
        {#each prompt.sections as section (section.name)}<details>
            <summary class="mono">{section.name}{section.truncated ? " · preview limited" : ""}</summary>
            <pre class="mono">{section.text}</pre>
          </details>{/each}
        {#if prompt.sectionsLimited}<p class="sub">Additional sections omitted by the preview budget.</p>{/if}
        <h4>Message previews</h4>
        {#each prompt.previews as message (message.index)}<details>
            <summary>#{message.index + 1} · {message.role}{message.truncated ? " · preview limited" : ""}</summary>
            <pre class="mono">{message.text}</pre>
          </details>{/each}
        <p class="sub">
          Up to 20 messages per page, 4 KiB per preview and 64 KiB preview text per response. The original context is
          not altered.
        </p>
        <div class="row">
          <button class="b sm" onclick={previousPrompt} disabled={inspecting || pages.length === 0}
            >Previous messages</button
          ><button class="b sm" onclick={nextPrompt} disabled={inspecting || prompt.next === null}>Next messages</button
          >
        </div>
      {/if}
    </section>
    <section aria-label="Attached files and selections">
      <h3 class="h3">Attached files and selections</h3>
      <p class="sub">
        Uploaded attachments from the latest 20 transcript entries, up to 50 distinct files. Files/Terminal selections
        are ordinary message text in the prepared context. Unsent composer files are not included.
      </p>
      {#if info.attachments.length === 0}<p class="sub">No uploaded attachment in these recent entries.</p>{/if}
      {#each info.attachments as item (item.id)}<div class="folder">
          <strong>{item.name}</strong><span class="mono sub">{item.mediaType} · {item.size.toLocaleString()} bytes</span
          >
        </div>{/each}
      <p class="sub">
        Retention: original history, uploads and instruction revisions are retained; compaction changes model context,
        not stored history. Removing a chat/project or forgetting a note does not physically erase these records or
        backups. There is no automatic retention purge or physical-erasure action.
      </p>
    </section>
    <section aria-label="Recent memory lookups">
      <h3 class="h3">Recent memory lookups</h3>
      <p class="sub">
        Durable lookup activity, not proof the model used an item. Later revocation or correction can withhold
        candidates before delivery.
      </p>
      {#if info.lookups.length === 0}<p class="sub">No memory lookup in the latest 20 entries.</p>{/if}
      {#each info.lookups as lookup (lookup.entry)}<div class="lookup">
          <strong>{lookup.query}</strong><time datetime={new Date(lookup.at).toISOString()}
            >{new Date(lookup.at).toLocaleString()}</time
          >
          <p class="sub">{lookup.candidates.length} candidates{lookup.truncated ? " · limited" : ""}</p>
          {#each lookup.candidates as item (item.id)}<div class="mono sub">
              {item.id} · revision {item.revision}
            </div>{/each}
        </div>{/each}
    </section>
    <section aria-label="Available for search">
      <h3 class="h3">Available for search</h3>
      <p class="sub">
        Not in the prompt. Adding a folder does not trust its instructions or confine the host shell. Current file
        search and retained-memory search are separate.
      </p>
      {#each folders as folder (folder.id)}<div class="folder">
          <span class="mono">{folder.root}</span><span class="sub"
            >{folder.access === "write" ? "Writable" : "Read-only"} · {folder.indexed
              ? "File search on demand"
              : "File indexing off"}</span
          >
        </div>{/each}
      {#if info.moreHistory}<p class="sub">Older chat history exists beyond this bounded inspection.</p>{/if}
    </section>
  {/if}
</div>
{#if forgetting !== undefined}<ConfirmRemoval
    title="Forget this memory?"
    description="Stop future memory lookups for this exact revision. Existing transcript copies, retained revisions and backups are not erased. A stale confirmation never forgets a corrected note."
    detail={`${forgetting.title}\n${forgetting.id} · revision ${forgetting.revision}`}
    confirmLabel="Forget memory"
    busyLabel="Forgetting…"
    onCancel={() => (forgetting = undefined)}
    onConfirm={forget}
  />{/if}

<style>
  .context {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 14px 14px 24px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .toolbar,
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .end {
    justify-content: flex-end;
  }
  .toolbar > span {
    overflow-wrap: anywhere;
    font-size: 12px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .h3,
  .sub,
  .fact {
    margin: 0;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--bg0);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 10px;
    margin: 8px 0 0;
    font-size: 12px;
  }
  summary {
    cursor: pointer;
    color: var(--tx2);
    font-size: 13px;
    min-height: 30px;
    align-content: center;
    overflow-wrap: anywhere;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .memory {
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .fact {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 13px;
  }
  .source {
    padding: 8px;
    background: var(--bg2);
    border-radius: 5px;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .editor {
    padding: 10px;
    border: 1px solid var(--acln);
    border-radius: 6px;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  legend {
    font-size: 13px;
    margin-bottom: 10px;
  }
  .fl {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--tx2);
  }
  .f {
    width: 100%;
    min-width: 0;
  }
  .folder,
  .lookup {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 9px 0;
    border-bottom: 1px solid var(--line);
    overflow-wrap: anywhere;
    font-size: 12px;
  }
  time {
    color: var(--tx3);
  }
  @media (max-width: 699px) {
    summary {
      min-height: 44px;
    }
  }
</style>
