<script lang="ts">
  import { api, type ChatSummary } from "../lib/api.ts";
  import { drafts } from "../lib/drafts.svelte.ts";
  import Icon from "../lib/Icon.svelte";
  import PalMark from "../lib/PalMark.svelte";
  import { app, navigate, refreshProjects } from "../lib/state.svelte.ts";
  import ConfirmRemoval from "./ConfirmRemoval.svelte";

  let {
    currentChatId,
    onNewChat,
    onCreateProject,
    onRenameChat,
    onClose,
    onCollapse,
  }: {
    currentChatId: string | undefined;
    onNewChat: (projectId: string) => void;
    onCreateProject: () => void;
    onRenameChat: (chat: ChatSummary) => void;
    /** Present when the sidebar is a drawer. */
    onClose?: () => void;
    /** Present when the sidebar can be hidden beside the chat. */
    onCollapse?: () => void;
  } = $props();

  /** The owner's own open/closed choice per project; otherwise only the current project is open. */
  let toggled: Record<string, boolean> = $state({});
  let showAll: Record<string, boolean> = $state({});
  let removing: { kind: "chat" | "project"; id: string; name: string } | undefined = $state();
  const SHOWN = 3;

  async function remove() {
    const item = removing;
    if (item === undefined) return;
    // Drafts go only once Pal confirms the deletion; a failed one keeps them.
    if (item.kind === "chat") {
      await api.deleteChat(item.id);
      drafts.forget(item.id);
    } else {
      const chats = app.projects.find((project) => project.id === item.id)?.chats ?? [];
      await api.removeProject(item.id);
      for (const chat of chats) drafts.forget(chat.id);
    }
    await refreshProjects();
    if (
      app.route.view === "chat" &&
      !app.projects.some((project) => project.chats.some((chat) => chat.id === currentChatId))
    )
      navigate({ view: "home" });
    removing = undefined;
  }
  const current = $derived(app.projects.find((project) => project.chats.some((chat) => chat.id === currentChatId)));
  const target = $derived(current ?? app.projects.find((project) => project.state === "ready"));
  const recents = $derived(
    app.projects
      .flatMap((project) => project.chats.map((chat) => ({ chat, project: project.name })))
      .sort((a, b) => b.chat.createdAt - a.chat.createdAt)
      .slice(0, 8),
  );
</script>

<aside aria-label="Projects and chats">
  <div class="brand">
    <PalMark size={22} cutout="var(--side)" />
    <span class="wordmark">pal</span>
    {#if onClose !== undefined}
      <button class="b i q tip end" aria-label="Close projects" data-tip="Close" onclick={onClose}>
        <Icon name="x" />
      </button>
    {:else if onCollapse !== undefined}
      <button class="b i q tip" aria-label="Collapse sidebar" data-tip="Collapse sidebar" onclick={onCollapse}>
        <Icon name="sidebar" />
      </button>
    {/if}
  </div>
  <button class="item" onclick={() => target && onNewChat(target.id)} disabled={target === undefined}>
    <Icon name="edit" /><span class="label">New chat</span>
  </button>
  <div class="lists">
    <nav aria-label="Projects">
      <div class="navhead">
        <span class="lbl">Projects</span>
        <button class="b i q sm tip" aria-label="New project" data-tip="New project" onclick={onCreateProject}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {#if app.projects.length === 0}<p class="none">No projects yet.</p>{/if}
      {#each app.projects as project (project.id)}
        {@const open = toggled[project.id] ?? project.id === target?.id}
        {@const shown = showAll[project.id]
          ? project.chats
          : project.chats.filter((chat, index) => index < SHOWN || chat.id === currentChatId)}
        <div class="head">
          <button class="item" aria-expanded={open} onclick={() => (toggled[project.id] = !open)}>
            <Icon name="folder" />
            <span class="label">{project.name}</span>
            {#if project.state !== "ready"}
              <span class="state">{project.state === "failed" ? "Failed" : "Preparing"}</span>
            {/if}
          </button>
          <span class="acts">
            <button
              class="b i q sm tip"
              aria-label={`New chat in ${project.name}`}
              data-tip="New chat"
              onclick={() => onNewChat(project.id)}
              disabled={project.state !== "ready"}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              class="b i q sm tip end"
              aria-label={`Remove project ${project.name}`}
              data-tip="Remove project"
              onclick={() => (removing = { kind: "project", id: project.id, name: project.name })}
            >
              <Icon name="trash" size={14} />
            </button>
          </span>
        </div>
        {#if open}
          <ul role="list">
            {#each shown as chat (chat.id)}
              <li>
                <button
                  class="item chat"
                  aria-current={chat.id === currentChatId}
                  onclick={() => navigate({ view: "chat", chatId: chat.id })}
                >
                  <span class="label">{chat.title ?? "New chat"}</span>
                </button>
                <span class="acts">
                  <button
                    class="b i q sm tip"
                    aria-label={`Rename chat ${chat.title ?? "New chat"}`}
                    data-tip="Rename"
                    onclick={() => onRenameChat(chat)}
                  >
                    <Icon name="edit" size={14} />
                  </button>
                  <button
                    class="b i q sm tip end"
                    aria-label={`Delete chat ${chat.title ?? "New chat"}`}
                    data-tip="Delete"
                    onclick={() => (removing = { kind: "chat", id: chat.id, name: chat.title ?? "New chat" })}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              </li>
            {/each}
            {#if shown.length < project.chats.length}
              <li>
                <button class="item chat more" onclick={() => (showAll[project.id] = true)}>
                  Show {project.chats.length - shown.length} more
                </button>
              </li>
            {/if}
          </ul>
        {/if}
      {/each}
    </nav>
    {#if recents.length > 0}
      <nav aria-label="Recent chats">
        <div class="navhead"><span class="lbl">Recents</span></div>
        {#each recents as { chat, project } (chat.id)}
          <button class="item recent" onclick={() => navigate({ view: "chat", chatId: chat.id })}>
            <span class="label">{chat.title ?? "New chat"}</span><span class="where">{project}</span>
          </button>
        {/each}
      </nav>
    {/if}
  </div>
  <div class="foot">
    <span class="avatar" aria-hidden="true">O</span>
    <span class="owner">Owner</span>
    <button
      class="b i q tip up"
      aria-label="Settings"
      data-tip="Settings"
      aria-current={app.route.view === "settings"}
      onclick={() => navigate({ view: "settings", tab: "general" })}
    >
      <Icon name="settings" />
    </button>
  </div>
</aside>

{#if removing}
  <ConfirmRemoval
    title={`${removing.kind === "chat" ? "Delete chat" : "Remove project"} “${removing.name}”?`}
    description={removing.kind === "chat"
      ? "Stops running work and hides this chat. Its history is retained on the server."
      : "Stops running work and removes the project and its chats from Pal. All files stay on the server, including managed workspaces. This does not delete any folder."}
    confirmLabel={removing.kind === "chat" ? "Delete chat" : "Remove project"}
    onCancel={() => (removing = undefined)}
    onConfirm={remove}
  />
{/if}

<style>
  aside {
    display: flex;
    flex-direction: column;
    gap: 20px;
    height: 100%;
    padding: 16px 12px 12px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    background: var(--side);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 34px;
    padding: 0 0 0 6px;
  }
  .wordmark {
    flex: 1;
    font-family: var(--display);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.04em;
    line-height: 1;
  }
  .lists {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .navhead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 26px;
    padding: 0 0 4px 8px;
  }
  .lbl {
    font-size: 12px;
    font-weight: 500;
    color: var(--tx3);
  }
  .none {
    margin: 4px 8px;
    font-size: 13px;
    color: var(--tx3);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: color-mix(in srgb, var(--tx) 90%, transparent);
    text-align: left;
    transition:
      background-color var(--fast) var(--ease),
      color var(--fast) var(--ease);
  }
  .item:hover:not(:disabled) {
    background: var(--bg3);
    color: var(--tx);
  }
  .item:disabled {
    opacity: 0.5;
  }
  .brand + .item {
    min-height: 34px;
  }
  .item :global(svg) {
    color: var(--tx2);
  }
  .chat {
    padding-left: 34px;
    color: var(--tx2);
  }
  .chat[aria-current="true"],
  .chat[aria-current="true"]:hover {
    background: var(--bg4);
    color: var(--tx);
  }
  .more {
    font-size: 13px;
    color: var(--tx3);
  }
  .recent {
    gap: 8px;
    color: color-mix(in srgb, var(--tx) 85%, transparent);
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .where,
  .state {
    flex: none;
    font-size: 12px;
    color: var(--tx3);
  }
  .state {
    color: var(--wa);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .head,
  li {
    position: relative;
    display: flex;
    align-items: center;
  }
  .acts {
    display: flex;
    flex: none;
  }
  /* Row actions stay reachable by keyboard and touch, but only appear where the owner is pointing. */
  @media (hover: hover) and (pointer: fine) {
    .acts {
      position: absolute;
      right: 4px;
      padding-left: 4px;
      border-radius: var(--radius-sm);
      background: var(--bg3);
      opacity: 0;
      transition: opacity var(--fast) var(--ease);
    }
    li:has(.chat[aria-current="true"]) .acts {
      background: var(--bg4);
    }
    .head:hover .acts,
    .head:focus-within .acts,
    li:hover .acts,
    li:focus-within .acts {
      opacity: 1;
    }
    .head:hover .item,
    li:hover .item {
      background: var(--bg3);
      color: var(--tx);
    }
    li:hover .chat[aria-current="true"] {
      background: var(--bg4);
    }
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0 0 6px;
    border-top: 1px solid var(--line);
  }
  .avatar {
    width: 28px;
    height: 28px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--bg4);
    color: color-mix(in srgb, var(--tx) 90%, transparent);
    font-size: 12px;
    font-weight: 600;
  }
  .owner {
    flex: 1;
    font-size: 13px;
    color: color-mix(in srgb, var(--tx) 90%, transparent);
  }
</style>
