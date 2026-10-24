<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type SkillInfo, type SkillSettings } from "../lib/api.ts";

  let { chatId }: { chatId: string } = $props();
  let info: SkillInfo | undefined = $state.raw();
  let settings: SkillSettings | undefined = $state();
  let disabled = $state("");
  let selection: { revision: number; skills: { id: string; revision: string }[] } | undefined = $state();
  let saving = $state(false);
  let loading = $state(false);
  let error: string | undefined = $state();
  let generation = 0;

  async function load(id: string, signal?: AbortSignal) {
    const current = ++generation;
    loading = true;
    try {
      const value = await api.skills(id, signal);
      if (id === chatId && current === generation) {
        info = value;
        error = undefined;
      }
    } catch (failure) {
      if (current === generation && !signal?.aborted) error = String(failure);
    } finally {
      if (id === chatId && current === generation) loading = false;
    }
  }
  onMount(() => {
    const controller = new AbortController();
    void load(chatId, controller.signal);
    return () => {
      generation++;
      controller.abort();
    };
  });
  function editSettings() {
    if (info === undefined) return;
    settings = {
      ...info.settings,
      global: info.settings.global.map((root) => ({ ...root })),
      project: info.settings.project.map((root) => ({ ...root })),
      disabled: [...info.settings.disabled],
    };
    disabled = settings.disabled.join("\n");
  }
  function editSelection() {
    if (info === undefined) return;
    selection = {
      revision: info.selection.revision,
      skills: info.selection.items.map(({ id, revision }) => ({ id, revision })),
    };
  }
  function choose(id: string, revision: string, checked: boolean) {
    if (selection === undefined) return;
    selection.skills = selection.skills.filter((item) => item.id !== id);
    if (checked) selection.skills.push({ id, revision });
  }
  async function save(kind: "settings" | "selection") {
    if (saving || loading || info === undefined) return;
    const id = chatId,
      current = generation;
    const draft =
      kind === "settings" && settings !== undefined
        ? {
            ...settings,
            global: settings.global.map((root) => ({ ...root })),
            project: settings.project.map((root) => ({ ...root })),
            disabled: disabled
              .split("\n")
              .map((name) => name.trim())
              .filter(Boolean),
          }
        : undefined;
    const choices =
      kind === "selection" && selection !== undefined
        ? { revision: selection.revision, skills: selection.skills.map((item) => ({ ...item })) }
        : undefined;
    if (draft === undefined && choices === undefined) return;
    saving = true;
    error = undefined;
    try {
      let value: SkillInfo;
      if (draft !== undefined) value = await api.configureSkills(id, draft);
      else if (choices !== undefined) value = await api.selectSkills(id, choices.revision, choices.skills);
      else return;
      if (id === chatId && current === generation) {
        info = value;
        if (kind === "settings") settings = undefined;
        else selection = undefined;
      }
    } catch (failure) {
      if (id === chatId && current === generation)
        error =
          failure instanceof ApiError && failure.status === 409
            ? "Your skill draft is retained. Refresh skills, inspect the changed sources, then explicitly reload the current settings or selection before saving."
            : String(failure);
    } finally {
      if (id === chatId && current === generation) saving = false;
    }
  }
</script>

<section aria-label="Skill sources">
  <div class="row">
    <h3 class="h3 grow">Skill sources</h3>
    <button class="b sm q" disabled={saving || loading} onclick={() => load(chatId)}>Refresh skills</button>
  </div>
  <p class="sub">
    Reusable procedures from the host account and this chat's actual workspace. Only names and descriptions load by
    default; select a skill here or ask Pal to use one. Skills and package-relative references are untrusted guidance,
    not permission to run scripts or access other files.
  </p>
  {#if error}<p class="callout er" role="alert">{error}</p>{/if}
  {#if loading && info}<p class="sub" role="status">Refreshing skills…</p>{/if}
  {#if info === undefined}<p class="sub" role="status">Loading skills…</p>
  {:else}
    <p class="sub">
      Current sources, not earlier request bytes. Limits: {info.limits.catalog} packages,
      {info.limits.metadataBytes.toLocaleString()} metadata bytes and {info.limits.fileBytes.toLocaleString()} bytes per file.
      Prepared prompts and native tool history retain the bytes actually used.
    </p>
    {#each info.current.roots as root, index (`${root.scope}:${index}`)}
      <p class="sub mono">{root.scope} · {root.state} · {root.path}</p>
      {#if root.diagnostic}<p class="callout wa">{root.diagnostic}</p>{/if}
    {/each}
    {#each info.current.diagnostics as diagnostic (diagnostic)}<p class="callout wa">{diagnostic}</p>{/each}
    {#each info.current.catalog as item (item.id)}
      <details>
        <summary>{item.name ?? "Invalid skill package"} · {item.scope} · {item.state}</summary>
        {#if item.description}<p class="sub">{item.description}</p>{/if}
        <p class="mono sub">{item.path}</p>
        {#if item.revision}<p class="mono sub">Revision: {item.revision}</p>{/if}
        {#if item.metadataSha256}<p class="mono sub">Metadata sha256: {item.metadataSha256}</p>{/if}
        {#if item.shadowedBy}<p class="mono sub">Overridden by: {item.shadowedBy}</p>{/if}
        {#if item.diagnostic}<p class="callout wa">{item.diagnostic}</p>{/if}
      </details>
    {:else}<p class="sub">No skill packages found. Add SKILL.md packages to an enabled root, then refresh.</p>{/each}
    {#if info.current.selected.length}
      <section class="selected" aria-label="Selected skill content">
        <h4 class="h3">Selected for this chat</h4>
        {#each info.current.selected as item (item.id)}
          <p class="sub">{item.state}</p>
          <p class="mono sub">{item.path}</p>
          <p class="mono sub">sha256: {item.sha256}</p>
          {#if item.diagnostic}<p class="callout wa">{item.diagnostic}</p>{/if}
          {#if item.text !== null}<details>
              <summary>View current selected bytes</summary>
              <pre class="mono">{item.text}</pre>
            </details>{/if}
        {/each}
      </section>
    {/if}
    {#if info.selection.used.length}<details>
        <summary>Recent historical skill tool reads</summary>
        {#each info.selection.used as item (item.id)}<p class="mono sub">
            {item.scope} · {item.path}<br />sha256: {item.sha256}
          </p>{/each}
      </details>{/if}
    {#if selection === undefined}
      <button class="b sm q" disabled={saving || loading} onclick={editSelection}>Choose skills for this chat</button>
    {:else}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void save("selection");
        }}
      >
        <fieldset disabled={saving || loading}>
          <legend>Up to {info.limits.selected} selected skills</legend>
          <p class="sub">Changed sources are withheld. Uncheck and reselect a skill to use its current revision.</p>
          {#each info.current.catalog as item (item.id)}
            {#if item.name && item.revision}
              {@const checked = selection.skills.some((choice) => choice.id === item.id)}
              <label class="sub"
                ><input
                  type="checkbox"
                  aria-label={`Select ${item.name} from ${item.scope}`}
                  {checked}
                  disabled={!checked && (item.state !== "ready" || selection.skills.length >= info.limits.selected)}
                  onchange={(event) => {
                    if (item.revision) choose(item.id, item.revision, event.currentTarget.checked);
                  }}
                />
                {item.name} · {item.scope} · {item.state}</label
              >
            {/if}
          {/each}
          {#each selection.skills.filter((choice) => !info?.current.catalog.some((item) => item.id === choice.id && item.name && item.revision)) as item (item.id)}
            <label class="sub"
              ><input type="checkbox" checked onchange={() => choose(item.id, item.revision, false)} /> Remove
              unavailable selection {item.id}</label
            >
          {/each}
          <div class="row end">
            <button class="b sm q" type="button" onclick={() => (selection = undefined)}>Cancel skill selection</button>
            <button class="b sm q" type="button" onclick={editSelection}>Reload current skill selection</button>
            <button class="b sm p" type="submit">Save skill selection</button>
          </div>
        </fieldset>
      </form>
    {/if}
    {#if settings === undefined}
      <button class="b sm q" disabled={saving || loading} onclick={editSettings}>Configure skill sources</button>
    {:else}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void save("settings");
        }}
      >
        <fieldset disabled={saving || loading}>
          <p class="sub">
            These settings apply to this project. Names use Unicode NFKC and lowercase. A project skill overrides its
            global namesake; ambiguous project duplicates block global fallback. Disabling a name disables all its
            sources. Disabling or removing a project root can reveal an enabled global definition.
          </p>
          {#each ["global", "project"] as kind (kind)}
            {@const scope = kind as "global" | "project"}
            {#each settings[scope] as root, index (root)}
              <label class="fl"
                >{scope === "global" ? "Global skill root on the host" : "Project skill root relative to workspace"}
                {index + 1}
                <input class="f mono" required maxlength="1024" bind:value={root.path} />
              </label>
              <div class="row">
                <label class="sub"
                  ><input type="checkbox" bind:checked={root.enabled} /> Enable {scope} root {index + 1}</label
                >
                <button
                  class="b sm q"
                  type="button"
                  onclick={() => {
                    if (settings) settings[scope] = settings[scope].filter((item) => item !== root);
                  }}>Remove {scope} root {index + 1}</button
                >
              </div>
            {/each}
            <button
              class="b sm q"
              type="button"
              disabled={settings[scope].length >= info.limits.roots}
              onclick={() => settings?.[scope].push({ path: "", enabled: true })}>Add {scope} skill root</button
            >
          {/each}
          <label class="fl"
            >Disabled skill names for this project
            <textarea class="f" rows="3" maxlength="10240" bind:value={disabled}></textarea>
          </label>
          <p class="sub">One name per line. A disabled global skill stays available to other projects.</p>
          <div class="row end">
            <button class="b sm q" type="button" onclick={() => (settings = undefined)}>Cancel skill source edit</button
            >
            <button class="b sm q" type="button" onclick={editSettings}>Reload current skill settings</button>
            <button class="b sm p" type="submit">Save skill sources</button>
          </div>
        </fieldset>
      </form>
    {/if}
  {/if}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px 0;
    border-top: 1px solid var(--line);
    min-width: 0;
  }
  .selected {
    padding: 12px 0;
  }
  details,
  .mono {
    overflow-wrap: anywhere;
  }
  summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--tx2);
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 220px;
    overflow: auto;
    font-size: 12px;
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
    font-size: 12px;
    margin-bottom: 8px;
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
  @media (max-width: 699px) {
    summary {
      min-height: 44px;
    }
  }
</style>
