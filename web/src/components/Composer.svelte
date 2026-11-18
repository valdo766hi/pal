<script lang="ts">
  import type { Snippet } from "svelte";
  import { api, ApiError } from "../lib/api.ts";
  import type { ChatDraft } from "../lib/drafts.svelte.ts";
  import Icon from "../lib/Icon.svelte";
  import { app } from "../lib/state.svelte.ts";
  import { MAX_INPUT_ATTACHMENTS, MAX_INPUT_CHARS } from "../../../src/protocol/limits.ts";
  import AddMenu from "./AddMenu.svelte";

  let {
    writing,
    projectId,
    phone,
    running,
    canSend,
    onSend,
    onSchedule,
    tools,
    typing = $bindable(false),
  }: {
    writing: ChatDraft;
    projectId: string;
    phone: boolean;
    running: boolean;
    canSend: boolean;
    onSend: () => void;
    onSchedule: () => void;
    /** The chat's controls between the add menu and Send. */
    tools: Snippet;
    typing?: boolean;
  } = $props();
  let box: HTMLTextAreaElement | undefined = $state();
  export function focus() {
    box?.focus();
  }

  async function upload(files: File[]) {
    for (const file of files) {
      if (!writing.active || writing.blocked) return;
      if (writing.attachments.length + writing.uploading >= MAX_INPUT_ATTACHMENTS) {
        writing.error = `A draft can attach at most ${MAX_INPUT_ATTACHMENTS} files.`;
        return;
      }
      writing.touch();
      writing.uploading++;
      try {
        const attachment = await api.upload(projectId, file, writing.signal);
        writing.attachments = [...writing.attachments, attachment];
      } catch (failure) {
        if (writing.active)
          writing.error = `${file.name}: ${failure instanceof ApiError ? failure.message : String(failure)}`;
      } finally {
        writing.uploading--;
      }
    }
  }

  /**
   * Files pasted into the composer, such as a screenshot or a copied image, attach like chosen ones. A clipboard that
   * also holds plain text, as rich documents do along with an image of themselves, pastes that text instead.
   */
  function paste(event: ClipboardEvent) {
    const data = event.clipboardData;
    if (data === null || data.files.length === 0 || data.types.includes("text/plain")) return;
    event.preventDefault();
    void upload([...data.files]);
  }

  function onKey(event: KeyboardEvent) {
    // Enter that confirms an input method's composition is not a send.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && app.sendWithEnter && !phone) {
      event.preventDefault();
      onSend();
    }
  }
</script>

<div class="cbx" class:oneline={phone}>
  {#if writing.attachments.length > 0 || writing.uploading > 0}
    <div class="chips">
      {#each writing.attachments as attachment (attachment.id)}
        <span class="chip">
          <Icon name="file" /><span class="ellipsis">{attachment.name}</span>
          <button
            class="chipx"
            aria-label={`Remove ${attachment.name}`}
            onclick={() => (writing.attachments = writing.attachments.filter((kept) => kept.id !== attachment.id))}
            ><Icon name="x" size={12} /></button
          >
        </span>
      {/each}
      {#if writing.uploading > 0}<span class="chip plain"
          ><span class="ring spin" aria-hidden="true"></span>Uploading…</span
        >{/if}
    </div>
  {/if}
  <label for="composer" class="sr">Message</label>
  <textarea
    id="composer"
    bind:this={box}
    class="cta"
    rows={phone ? 1 : 2}
    placeholder={running ? (phone ? "Steer or queue" : "Steer the run or queue a follow-up") : "Message Pal"}
    maxlength={MAX_INPUT_CHARS}
    disabled={writing.blocked || !writing.active}
    title="Drafts stay in this tab, across reloads, until you send them or sign out."
    bind:value={writing.text}
    onpaste={paste}
    onfocus={() => (typing = true)}
    onblur={() => (typing = false)}
    onkeydown={onKey}></textarea>
  <div class="tools">
    {#if writing.active && !writing.blocked}<AddMenu onFiles={upload} {onSchedule} />{/if}
    {@render tools()}
    <button
      class={["b p send", running && "busy"]}
      aria-label={running ? undefined : "Send"}
      title={running ? undefined : "Send"}
      onclick={onSend}
      disabled={!canSend}
    >
      <Icon
        name={running && writing.whenBusy === "steer" ? "steer" : "send"}
        size={running ? 16 : phone ? 18 : 15}
      />{#if running}{writing.whenBusy === "steer" ? "Steer" : "Queue"}{/if}
    </button>
  </div>
</div>

<style>
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cbx {
    position: relative;
  }
  .tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    flex-wrap: wrap;
  }
  .tools :global(.seg) {
    margin-left: 4px;
  }
  .send {
    margin-left: 4px;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 50%;
  }
  .send :global(svg) {
    stroke-width: 2.1;
  }
  .send.busy {
    width: auto;
    padding: 0 12px;
    border-radius: 16px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 2px 2px 0;
  }
  .plain {
    padding-right: 8px;
  }
  /* Phone: the composer is one pill with "+" and Send either side; model and approval live in the tools sheet. */
  .cbx.oneline {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 4px;
    padding: 5px;
    border-radius: 24px;
  }
  .oneline .tools {
    display: contents;
  }
  .oneline .chips {
    order: -1;
    flex-basis: 100%;
    padding: 4px 6px 0;
  }
  .oneline .cta {
    order: 1;
    flex: 1;
    min-width: 0;
    padding: 11px 2px;
    font-size: 15.5px;
  }
  .oneline .send {
    order: 2;
    width: 44px;
    height: 44px;
    margin: 0;
  }
  .oneline .send.busy {
    width: auto;
    padding: 0 14px;
    border-radius: 22px;
  }
  .oneline :global(.plus) {
    width: 44px;
    height: 44px;
    margin: 0;
    border-radius: 50%;
  }
</style>
