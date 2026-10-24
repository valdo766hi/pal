<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type ChatSummary, requestId, type WorkspaceMode } from "../lib/api.ts";
  import type { ReviewFeedback } from "../../../src/core/feedback.ts";
  import Icon from "../lib/Icon.svelte";
  import {
    app,
    navigate,
    refreshChatGPT,
    refreshProjects,
    refreshProviders,
    readSetting,
    refreshExtensions,
    type Route,
    saveSetting,
    viewport,
  } from "../lib/state.svelte.ts";
  import ChatView from "./ChatView.svelte";
  import CreateProject from "./CreateProject.svelte";
  import Onboarding from "./Onboarding.svelte";
  import ProjectMcpSettings from "./ProjectMcpSettings.svelte";
  import RenameChat from "./RenameChat.svelte";
  import Settings from "./Settings.svelte";
  import Sidebar from "./Sidebar.svelte";

  let { onSignOut }: { onSignOut: () => void } = $props();

  /** The route the drawer was opened on: navigating anywhere closes it. */
  let drawerRoute: Route | undefined = $state();
  const drawer = $derived(drawerRoute !== undefined && drawerRoute === app.route);
  /** On desktop the sidebar sits beside the chat unless the owner hid it; saved in this browser. */
  let sidebarShown = $state(readSetting("pal.sidebar") !== "hidden");
  function showSidebar(shown: boolean) {
    sidebarShown = shown;
    saveSetting("pal.sidebar", shown ? "shown" : "hidden");
  }
  let creating = $state(false);
  let renaming: ChatSummary | undefined = $state.raw();
  let error: string | undefined = $state();
  let loaded = $state(false);
  let panelRoute: Route | undefined = $state();
  const panel = $derived(panelRoute === app.route);
  const changesPanel = () => import("./ChangesPanel.svelte");
  const filesPanel = () => import("./FilesPanel.svelte");
  const terminalPanel = () => import("./TerminalPanel.svelte");
  const contextPanel = () => import("./ContextPanel.svelte");
  const browserPanel = () => import("./BrowserPanel.svelte");
  type PanelView = "Changes" | "Files" | "Terminal" | "Context" | "Browser";
  let panelView = $state<PanelView>("Changes");
  const panelButtons = [
    { id: "Changes", icon: "changes" },
    { id: "Files", icon: "file" },
    { id: "Terminal", icon: "term" },
    { id: "Browser", icon: "globe" },
    { id: "Context", icon: "layers" },
  ] as const;
  type Dock = "bottom" | "side";
  /** Where Terminal sits beside the chat on desktop, and the share of the work area it takes, per position. */
  let dock: Dock = $state(readSetting("pal.terminalDock") === "side" ? "side" : "bottom");
  const SHARE = { min: 20, max: 80, step: 5 };
  function storedShare(where: Dock): number {
    const value = Number(readSetting(`pal.terminalShare.${where}`));
    return Number.isFinite(value) && value >= SHARE.min && value <= SHARE.max ? value : where === "bottom" ? 45 : 50;
  }
  let shares = $state({ bottom: storedShare("bottom"), side: storedShare("side") });
  let workarea: HTMLDivElement | undefined = $state();
  function setDock(next: Dock) {
    dock = next;
    saveSetting("pal.terminalDock", next);
  }
  function setShare(value: number, save = true) {
    shares[dock] = Math.round(Math.min(SHARE.max, Math.max(SHARE.min, value)));
    if (save) saveSetting(`pal.terminalShare.${dock}`, String(shares[dock]));
  }
  function drag(event: PointerEvent) {
    if (workarea === undefined || event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const box = workarea.getBoundingClientRect();
    const move = (next: PointerEvent) =>
      setShare(
        dock === "bottom"
          ? ((box.bottom - next.clientY) / box.height) * 100
          : ((box.right - next.clientX) / box.width) * 100,
        false,
      );
    const end = () => {
      handle.removeEventListener("pointermove", move);
      setShare(shares[dock]);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", end, { once: true });
  }
  /** The divider is a slider over its own position: from the bottom when docked below, from the left beside. */
  const position = $derived(dock === "bottom" ? shares.bottom : 100 - shares.side);
  function nudge(event: KeyboardEvent) {
    const steps: Record<string, number> = {
      ArrowUp: position + SHARE.step,
      ArrowRight: position + SHARE.step,
      ArrowDown: position - SHARE.step,
      ArrowLeft: position - SHARE.step,
      Home: SHARE.min,
      End: SHARE.max,
    };
    const next = steps[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setShare(dock === "bottom" ? next : 100 - next);
  }
  /** A file Files asked Changes to open. */
  let diffPath: string | undefined = $state();
  let chatView:
    | {
        insertText(text: string): boolean;
        insertFeedback(text: string, feedback: ReviewFeedback): boolean;
        hasFeedback(id: string): boolean;
        openTools(): void;
      }
    | undefined = $state();
  let changesView: { refresh(): Promise<void> } | undefined = $state();
  let changeStatus: { busy: boolean; files: number | undefined; add: number; del: number } | undefined = $state();
  function openPanel(view: PanelView) {
    diffPath = undefined;
    panelRoute = app.route;
    panelView = view;
  }
  function togglePanel(view: PanelView) {
    diffPath = undefined;
    panelRoute = panel && panelView === view ? undefined : app.route;
    panelView = view;
  }
  const size = $derived(viewport());
  const beside = $derived(size === "desktop" && sidebarShown);
  /** Where the sidebar is not beside the chat, a header button brings it back: as a drawer, or beside again. */
  function openSidebar() {
    if (size === "desktop") showSidebar(true);
    else drawerRoute = app.route;
  }
  const docked = $derived(panel && panelView === "Terminal" && size === "desktop");
  const chatId = $derived(app.route.view === "chat" ? app.route.chatId : undefined);
  const located = $derived.by(() => {
    for (const project of app.projects) {
      const chat = project.chats.find((candidate) => candidate.id === chatId);
      if (chat !== undefined) return { project, chat };
    }
    return undefined;
  });

  const enabledPanels = $derived(
    new Set([
      "Context",
      ...(app.extensions?.catalog ?? [])
        .filter((item) =>
          located?.chat.extensions.some((choice) => choice.id === item.id && choice.version === item.version),
        )
        .flatMap((item) => [...item.panels]),
    ]),
  );

  onMount(() => {
    void Promise.all([refreshProjects(), refreshChatGPT(), refreshProviders(), refreshExtensions()])
      .catch((failure: unknown) => (error = failure instanceof Error ? failure.message : String(failure)))
      .finally(() => (loaded = true));
  });

  let creatingChat = false;
  let pendingChat: { key: string; project: string; mode: WorkspaceMode } | undefined;
  async function newChat(projectId: string, mode: WorkspaceMode = "local") {
    if (creatingChat) return;
    creatingChat = true;
    if (pendingChat?.project !== projectId || pendingChat.mode !== mode)
      pendingChat = { key: requestId(), project: projectId, mode };
    error = undefined;
    try {
      const { chat } = await api.createChat(pendingChat.key, projectId, mode);
      await refreshProjects();
      navigate({ view: "chat", chatId: chat.id });
      pendingChat = undefined;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      creatingChat = false;
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    // Terminal and Browser pass Escape to the shell or page.
    if (
      event.key === "Escape" &&
      panelView !== "Terminal" &&
      panelView !== "Browser" &&
      document.querySelector("dialog[open]") === null
    )
      panelRoute = undefined;
  }}
/>

{#if !loaded}
  <div class="center" role="status">Loading Pal…</div>
{:else if error !== undefined && app.projects.length === 0}
  <div class="center">
    <div class="callout er" role="alert">Couldn't load Pal: {error}</div>
    <button class="b" onclick={() => location.reload()}>Try again</button>
  </div>
{:else if app.projects.length === 0}
  <Onboarding onCreateProject={() => (creating = true)} />
{:else}
  <div class="shell">
    <!-- A phone shows one panel at a time, full screen with its own header. -->
    {#if size === "phone" && app.route.view !== "settings" && !(located && panel && enabledPanels.has(panelView))}
      <header class="phonehdr">
        <button
          class="b i q tip start"
          aria-label="Projects and chats"
          data-tip="Projects and chats"
          onclick={() => (drawerRoute = app.route)}><Icon name="menu" /></button
        >
        <div class="phonetitle">
          <div class="t">{located?.chat.title ?? (located ? "New chat" : "Pal")}</div>
          {#if located}<div class="s" title={located.chat.workspace?.root ?? located.project.root}>
              {located.project.name} · {located.chat.workspace?.mode ?? "local"}
            </div>{/if}
        </div>
        {#if located}
          <button
            class="b i q tip end toolsbtn"
            aria-label="Workspace tools"
            data-tip="Workspace tools"
            onclick={() => chatView?.openTools()}
            ><Icon name="grid" />{#if (changeStatus?.files ?? 0) > 0}<span class="dot" aria-hidden="true"
              ></span>{/if}</button
          >
        {:else}<span class="toolsbtn" aria-hidden="true"></span>{/if}
      </header>
    {/if}
    <div class="body">
      {#if beside || (size !== "desktop" && drawer)}
        <div
          class="side"
          class:drawer={size !== "desktop"}
          style:width={size === "desktop" ? "260px" : size === "phone" ? "86%" : "300px"}
        >
          <Sidebar
            currentChatId={chatId}
            onNewChat={newChat}
            onCreateProject={() => (creating = true)}
            onRenameChat={(chat) => (renaming = { ...chat })}
            {...size === "desktop"
              ? { onCollapse: () => showSidebar(false) }
              : { onClose: () => (drawerRoute = undefined) }}
          />
        </div>
      {/if}
      {#if size !== "desktop" && drawer}
        <button class="scrim" aria-label="Close projects" onclick={() => (drawerRoute = undefined)}></button>
      {/if}

      <main>
        {#if error !== undefined}<div class="callout er banner" role="alert">{error}</div>{/if}
        {#if app.route.view === "settings"}
          <Settings tab={app.route.tab} {onSignOut} />
        {:else if located !== undefined}
          {@const root = located.chat.workspace?.root ?? located.project.root}
          {#if size !== "phone"}<header class="chathead">
              {#if size === "tablet"}<button
                  class="b i q tip start"
                  aria-label="Projects and chats"
                  data-tip="Projects and chats"
                  onclick={() => (drawerRoute = app.route)}><Icon name="menu" /></button
                >{:else if size === "desktop" && !sidebarShown}<button
                  class="b i q tip"
                  aria-label="Show sidebar"
                  data-tip="Show sidebar"
                  onclick={openSidebar}><Icon name="sidebar" /></button
                >{/if}
              <h1 class="title">
                <button aria-haspopup="dialog" onclick={() => (renaming = { ...located.chat })}
                  ><span>{located.chat.title ?? "New chat"}</span><Icon name="chevD" size={14} /></button
                >
              </h1>
              <span class="where" title={root}>{located.project.name} · {located.chat.workspace?.mode ?? "local"}</span>
              <div class="tools">
                {#each panelButtons as item (item.id)}
                  {#if enabledPanels.has(item.id)}
                    {@const changed = item.id === "Changes" ? (changeStatus?.files ?? 0) : 0}
                    <button
                      class="b i q tip"
                      aria-label={item.id}
                      data-tip={changed > 0 ? `Changes · ${changed} ${changed === 1 ? "file" : "files"}` : item.id}
                      aria-expanded={panel && panelView === item.id}
                      onclick={() => togglePanel(item.id)}
                      ><Icon name={item.icon} />{#if changed > 0}<span class="dot" aria-hidden="true"
                        ></span>{/if}</button
                    >
                  {/if}
                {/each}
                <span class="sep" aria-hidden="true"></span>
                {#key located.project.id}<ProjectMcpSettings project={located.project} />{/key}
              </div>
            </header>{/if}
          <div
            class="workarea"
            class:dock-bottom={docked && dock === "bottom"}
            class:dock-side={docked && dock === "side"}
            bind:this={workarea}
            style:--terminal-share={`${shares[dock]}%`}
          >
            <div class="chat-area">
              {#key located.chat.id}<ChatView
                  bind:this={chatView}
                  onAdmitted={() => {
                    void changesView?.refresh();
                  }}
                  chat={located.chat}
                  project={located.project}
                  onNewChat={(mode) => newChat(located.project.id, mode)}
                  panels={panelButtons.filter((item) => enabledPanels.has(item.id))}
                  onPanel={(id) => openPanel(id as PanelView)}
                  changeCount={changeStatus?.files}
                />{/key}
            </div>
            {#if panel && enabledPanels.has(panelView)}
              {#if docked}<div
                  class="divider"
                  role="slider"
                  tabindex="0"
                  aria-label="Resize terminal"
                  aria-orientation={dock === "bottom" ? "vertical" : "horizontal"}
                  aria-valuemin={SHARE.min}
                  aria-valuemax={SHARE.max}
                  aria-valuenow={position}
                  aria-valuetext={`Terminal ${shares[dock]}% of the work area`}
                  onpointerdown={drag}
                  onkeydown={nudge}
                ></div>{/if}
              {#if size === "tablet"}<button
                  class="panel-scrim"
                  aria-label="Close workspace panel"
                  onclick={() => (panelRoute = undefined)}
                ></button>{/if}
              <aside
                class="workspace-panel"
                class:terminal-panel={panelView === "Terminal"}
                aria-label="Workspace panel"
              >
                {#if panelView !== "Terminal"}<div class="panelhead">
                    <h2>{panelView}</h2>
                    {#if panelView === "Changes" && changeStatus?.files !== undefined}
                      <span class="count"
                        >{changeStatus.files}
                        {changeStatus.files === 1 ? "file" : "files"}{changeStatus.files > 0
                          ? " · "
                          : ""}{#if changeStatus.files > 0}<span class="add">+{changeStatus.add}</span>
                          <span class="del">−{changeStatus.del}</span>{/if}</span
                      >
                    {/if}
                    <span class="grow"></span>
                    {#if panelView === "Changes"}
                      <button
                        class="b i q tip"
                        aria-label="Refresh"
                        data-tip="Refresh"
                        disabled={changeStatus?.busy !== false}
                        onclick={() => changesView?.refresh()}><Icon name="refresh" /></button
                      >
                    {/if}
                    <button
                      class="b i q tip end"
                      aria-label="Close panel"
                      data-tip="Close"
                      onclick={() => (panelRoute = undefined)}><Icon name="x" /></button
                    >
                  </div>{/if}
                {#key located.chat.workspace?.id ?? located.project.id}
                  {#if panelView === "Terminal"}
                    {#await terminalPanel()}<p role="status">Loading terminal…</p>
                    {:then { default: TerminalPanel }}
                      <TerminalPanel
                        project={located.project}
                        workspace={located.chat.workspace}
                        dock={docked ? dock : undefined}
                        onDock={setDock}
                        onClose={() => (panelRoute = undefined)}
                        onSelection={(text) => {
                          chatView?.insertText(`Terminal selection (human shell):\n\n${text}`);
                          panelRoute = undefined;
                        }}
                      />
                    {:catch failure}<p role="alert">Couldn’t load terminal: {String(failure)}</p>{/await}
                  {:else if panelView === "Browser"}
                    {#await browserPanel()}<p role="status">Loading browser…</p>
                    {:then { default: BrowserPanel }}
                      {#key located.chat.id}<BrowserPanel project={located.project} chatId={located.chat.id} />{/key}
                    {:catch failure}<p role="alert">Couldn't load the browser: {String(failure)}</p>{/await}
                  {:else if panelView === "Context"}
                    {#await contextPanel()}<p role="status">Loading context…</p>
                    {:then { default: ContextPanel }}
                      <ContextPanel project={located.project} chat={located.chat} workspace={located.chat.workspace} />
                    {:catch failure}<p role="alert">Couldn't load context: {String(failure)}</p>{/await}
                  {:else if panelView === "Files"}
                    {#await filesPanel()}<p role="status">Loading files…</p>
                    {:then { default: FilesPanel }}
                      <FilesPanel
                        project={located.project}
                        workspace={located.chat.workspace}
                        onAttach={(text) => {
                          chatView?.insertText(text);
                          // Overlay panels give the composer back; the desktop side panel stays open.
                          if (size !== "desktop") panelRoute = undefined;
                        }}
                        onViewDiff={(path) => {
                          diffPath = path;
                          panelView = "Changes";
                        }}
                      />
                    {:catch failure}<p role="alert">Couldn't load files: {String(failure)}</p>{/await}
                  {:else}
                    {#await changesPanel()}
                      <p role="status">Loading changes…</p>
                    {:then { default: ChangesPanel }}
                      <ChangesPanel
                        bind:this={changesView}
                        onStatus={(next) => (changeStatus = next)}
                        project={located.project}
                        workspace={located.chat.workspace}
                        initialPath={diffPath}
                        composed={(id) => chatView?.hasFeedback(id) ?? false}
                        onFeedback={(text, feedback) => {
                          const added = chatView?.insertFeedback(text, feedback) ?? false;
                          if (added && size !== "desktop") panelRoute = undefined;
                          return added;
                        }}
                      />
                    {:catch failure}<p role="alert">Couldn't load changes: {String(failure)}</p>{/await}
                  {/if}
                {/key}
              </aside>
            {/if}
          </div>
        {:else if loaded}
          {@const ready = app.projects.find((project) => project.state === "ready")}
          <div class="center">
            <div class="intro">
              {#if size === "tablet" || (size === "desktop" && !sidebarShown)}
                <button class="b q" onclick={openSidebar}><Icon name="menu" />Projects</button>
              {/if}
              <h1>{chatId === undefined ? "Pick a chat" : "Chat not found"}</h1>
              <p>Choose a chat in a project, or start a new one.</p>
              {#if ready}<button class="b p" onclick={() => newChat(ready.id)}
                  ><Icon name="plus" />New chat in {ready.name}</button
                >{/if}
            </div>
          </div>
        {/if}
      </main>
    </div>
  </div>
{/if}

{#if creating}
  <CreateProject
    onClose={() => (creating = false)}
    onCreated={async (project) => {
      creating = false;
      await refreshProjects();
      await newChat(project.id);
    }}
  />
{/if}

{#if renaming}
  <RenameChat chat={renaming} onClose={() => (renaming = undefined)} />
{/if}

<style>
  .shell {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--bg1);
    overflow: hidden;
  }
  .phonehdr {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px;
    padding-top: max(6px, env(safe-area-inset-top));
    background: var(--bg1);
  }
  .phonehdr .b.i {
    width: 44px;
    height: 44px;
    border-radius: var(--radius-md);
    color: color-mix(in srgb, var(--tx) 85%, transparent);
  }
  .toolsbtn {
    position: relative;
    width: 44px;
    flex: none;
  }
  .tools .dot,
  .toolsbtn .dot {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ac);
  }
  .toolsbtn .dot {
    top: 10px;
    right: 10px;
  }
  .phonetitle {
    flex: 1;
    min-width: 0;
    text-align: center;
    line-height: 1.25;
  }
  .phonetitle .t {
    font-size: 15px;
    font-weight: 550;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .phonetitle .s {
    font-size: 12px;
    color: var(--tx3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
  }
  .side {
    flex: 0 0 auto;
    border-right: 1px solid var(--line);
    min-height: 0;
  }
  .drawer {
    position: absolute;
    z-index: 30;
    top: 0;
    bottom: 0;
    left: 0;
    box-shadow: var(--shadow);
    animation: slide-left var(--mid) var(--ease);
  }
  main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .banner {
    margin: 8px 12px 0;
  }
  .chathead {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
    height: 56px;
    padding: 0 12px 0 24px;
    border-bottom: 1px solid var(--line);
  }
  .title {
    flex: 0 1 auto;
    min-width: 0;
    margin: 0;
    font: inherit;
  }
  .title button {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    font-size: 14.5px;
    font-weight: 550;
    color: var(--tx);
  }
  .title span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title :global(svg) {
    color: var(--tx3);
  }
  .where {
    flex: 0 1 auto;
    min-width: 0;
    font-size: 12.5px;
    color: var(--tx3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    margin-left: auto;
  }
  .sep {
    width: 1px;
    height: 18px;
    margin: 0 6px;
    background: var(--line2);
  }
  .workarea {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
  }
  .workarea.dock-bottom {
    flex-direction: column;
  }
  .dock-bottom .workspace-panel.terminal-panel {
    width: 100%;
    height: var(--terminal-share);
    border-left: 0;
  }
  .dock-side .workspace-panel.terminal-panel {
    width: var(--terminal-share);
  }
  /* A 9px hit area along the seam with a small grip; the grip brightens while hovered, focused or dragged. */
  .divider {
    position: relative;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    z-index: 27;
    background: var(--bg1);
    touch-action: none;
  }
  .dock-bottom .divider {
    height: 9px;
    border-top: 1px solid var(--line);
    cursor: row-resize;
  }
  .dock-side .divider {
    width: 9px;
    border-left: 1px solid var(--line);
    cursor: col-resize;
  }
  .divider::after {
    content: "";
    border-radius: 2px;
    background: var(--line3);
    transition: background-color var(--fast) var(--ease);
  }
  .dock-bottom .divider::after {
    width: 36px;
    height: 3px;
  }
  .dock-side .divider::after {
    width: 3px;
    height: 36px;
  }
  .divider:hover::after,
  .divider:focus-visible::after,
  .divider:active::after {
    background: var(--focus);
  }
  .divider:focus-visible {
    outline: none;
  }
  .chat-area {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .workspace-panel {
    display: flex;
    flex-direction: column;
    width: clamp(380px, 32vw, 460px);
    flex: none;
    min-width: 0;
    border-left: 1px solid var(--line);
    background: var(--side);
    z-index: 26;
    animation: fade var(--mid) var(--ease);
  }
  .panelhead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 0 18px;
    border-bottom: 1px solid var(--line);
    min-height: 56px;
  }
  .panelhead h2 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
  }
  .panelhead .grow {
    flex: 1;
  }
  .count {
    font: 12px var(--mono);
    color: var(--tx3);
    white-space: nowrap;
  }
  .count .add {
    color: var(--ok);
  }
  .count .del {
    color: var(--er);
  }
  .panel-scrim {
    position: absolute;
    inset: 0;
    z-index: 25;
    border: 0;
    background: var(--scrim);
    animation: fade var(--mid) var(--ease);
  }
  @media (max-width: 1099px) {
    .workspace-panel.terminal-panel {
      height: 100%;
    }
    .workspace-panel {
      position: absolute;
      inset: 0 0 0 auto;
      width: 70%;
      box-shadow: var(--shadow);
      animation: slide-right var(--mid) var(--ease);
    }
  }
  @media (max-width: 699px) {
    .workspace-panel {
      width: 100%;
      border-left: 0;
      box-shadow: none;
    }
    .panelhead {
      padding-top: env(safe-area-inset-top);
    }
  }
  .center {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .intro {
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  .intro h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.015em;
  }
  .intro p {
    margin: 0;
    color: var(--tx2);
  }
</style>
