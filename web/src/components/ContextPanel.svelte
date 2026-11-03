<script lang="ts">
  import { onMount } from "svelte";
  import {
    api,
    ApiError,
    type ChatSummary,
    type ContextInfo,
    type PromptInfo,
    type Project,
    type GrantedFolder,
    type Workspace,
  } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import { slots } from "../lib/plugins.ts";
  import InstructionSources from "./InstructionSources.svelte";
  import SkillSources from "./SkillSources.svelte";
  import WorkingGoal from "./WorkingGoal.svelte";

  let { project, chat, workspace }: { project: Project; chat: ChatSummary; workspace?: Workspace | null } = $props();
  let info: ContextInfo | undefined = $state.raw();
  let extensions: Awaited<ReturnType<typeof api.chatExtensions>> | undefined = $state.raw();
  let pinDraft: { revision: number; text: string } | undefined = $state();
  let pinStale = $state(false);
  let prompt: PromptInfo | undefined = $state.raw();
  let pages: number[] = $state.raw([]);
  let inspecting = $state(false);
  const pinBytes = $derived(new TextEncoder().encode(pinDraft?.text ?? "").byteLength);
  let missingCapabilities: string[] = $state.raw([]);
  let folders: GrantedFolder[] = $state.raw([]);
  let error: string | undefined = $state();
  let busy = $state(false);
  let generation = 0;
  let refreshed = $state(0);

  async function load() {
    const current = ++generation;
    const [context, pins, catalog] = await Promise.all([
      api.context(chat.id),
      api.chatExtensions(chat.id),
      api.extensions(),
    ]);
    const grants = await api.projectFolders(project.id, workspace?.id);
    if (current !== generation) return;
    info = context;
    extensions = pins;
    missingCapabilities = pins.selected
      .filter(
        (choice) =>
          !catalog.catalog.some(
            (item) => item.available !== false && item.id === choice.id && item.version === choice.version,
          ),
      )
      .map((choice) => `${choice.id}@${choice.version}`);
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
    refreshed++;
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
    {#key chat.id}<WorkingGoal chatId={chat.id} /><InstructionSources chatId={chat.id} /><SkillSources
        chatId={chat.id}
      />{/key}
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
    {#each slots("context", extensions?.selected ?? []) as section (section.key)}
      {#await section.load()}<p class="sub" role="status">Loading {section.name}…</p>
      {:then { default: Section }}<Section {project} {chat} {workspace} {info} {folders} {refreshed} />
      {:catch failure}<p role="alert">Couldn't load {section.name}: {String(failure)}</p>{/await}
    {/each}
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
  .sub {
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
  h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
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
