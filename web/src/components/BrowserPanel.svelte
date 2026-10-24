<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api, ApiError, type Project } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import { viewport as layout } from "../lib/state.svelte.ts";
  import ConfirmRemoval from "./ConfirmRemoval.svelte";

  let { project, chatId }: { project: Project; chatId: string } = $props();
  type Tab = { id: string; url: string; active: boolean };
  type View = {
    epoch: number;
    control: boolean;
    mode: "paused" | "human" | "private-login" | "agent";
    busy: boolean;
    agent: { chat: string; expires: number; remaining: number } | null;
    viewport: { width: number; height: number };
    tabs: Tab[];
    dialog: { type: string; message: string; defaultValue: string } | null;
  };
  const sizes = [
    { label: "Desktop", width: 1280, height: 800 },
    { label: "Tablet", width: 768, height: 1024 },
    { label: "Phone", width: 390, height: 844 },
  ];
  const KEYS = new Set([
    "Enter",
    "Backspace",
    "Tab",
    "Escape",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
  ]);

  let view: View | undefined = $state();
  let titles: Record<string, string> = $state({});
  let frame: string | undefined = $state();
  let status: "checking" | "connecting" | "open" | "closed" | "unavailable" = $state("checking");
  let error: string | undefined = $state();
  let address = $state("");
  let typing = $state("");
  let answer = $state("");
  let clearing = $state(false);
  let handoff: { epoch: number; url: string; chat: string } | undefined = $state();
  let busy = $state(false);
  let addressFocused = false;
  let addressDirty = false;
  let socket: WebSocket | undefined;
  let image: HTMLImageElement | undefined = $state();
  let keyboard: HTMLInputElement | undefined = $state();
  let typingFocus = $state(false);
  let lastMove = 0;
  let disposed = false;
  const phone = $derived(layout() === "phone");
  const active = $derived(view?.tabs.find((tab) => tab.active));

  onMount(() => void check());
  onDestroy(() => {
    disposed = true;
    socket?.close();
    resetView();
  });

  function resetView() {
    if (frame !== undefined) URL.revokeObjectURL(frame);
    frame = undefined;
    view = undefined;
    titles = {};
    handoff = undefined;
    address = "";
    addressFocused = false;
    addressDirty = false;
  }

  async function check() {
    try {
      const available = (await api.browser(project.id)).available;
      if (!disposed) status = available ? "closed" : "unavailable";
    } catch (failure) {
      if (disposed) return;
      error = failure instanceof ApiError ? failure.message : String(failure);
      status = "closed";
    }
  }

  function start() {
    if (disposed || status === "connecting" || status === "open") return;
    error = undefined;
    resetView();
    status = "connecting";
    const opened = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/projects/${project.id}/browser/socket`,
    );
    opened.binaryType = "blob";
    socket = opened;
    opened.onopen = () => {
      if (socket === opened) status = "open";
    };
    opened.onerror = () => {
      if (socket === opened)
        error = "Couldn't open the browser. Check the host's sandbox and resource scope, then try again.";
    };
    opened.onclose = () => {
      if (socket !== opened) return;
      resetView();
      status = "closed";
    };
    opened.onmessage = (event: MessageEvent<Blob | string>) => {
      if (socket !== opened || disposed) return;
      if (event.data instanceof Blob) {
        const previous = frame;
        frame = URL.createObjectURL(event.data);
        if (previous !== undefined) URL.revokeObjectURL(previous);
        return;
      }
      const message = JSON.parse(event.data) as
        | ({ type: "state" } & View)
        | { type: "titles"; titles: { id: string; title: string }[] }
        | { type: "error"; message: string };
      if (message.type === "state") {
        const tab = message.tabs.find((tab) => tab.active);
        const changed = tab?.id !== active?.id;
        if (
          changed ||
          message.viewport.width !== view?.viewport.width ||
          message.viewport.height !== view?.viewport.height
        ) {
          if (frame !== undefined) URL.revokeObjectURL(frame);
          frame = undefined;
        }
        view = message;
        error = undefined;
        if (changed || !message.control || (!addressFocused && !addressDirty)) {
          address = tab?.url ?? "";
          addressDirty = false;
        }
      } else if (message.type === "titles") {
        titles = Object.fromEntries(message.titles.map((entry) => [entry.id, entry.title]));
      } else {
        error = message.message;
      }
    };
  }

  function send(message: Record<string, unknown>) {
    if (socket?.readyState !== WebSocket.OPEN || view === undefined) return false;
    socket.send(JSON.stringify(message.type === "take" ? message : { ...message, epoch: view.epoch }));
    return true;
  }

  /** Page coordinates for a point on the shown frame, which may be scaled to fit the panel. */
  function point(event: MouseEvent): { x: number; y: number } | undefined {
    if (image === undefined || view === undefined) return undefined;
    const rect = image.getBoundingClientRect();
    if (
      rect.width === 0 ||
      rect.height === 0 ||
      event.clientX < rect.left ||
      event.clientX >= rect.right ||
      event.clientY < rect.top ||
      event.clientY >= rect.bottom
    )
      return undefined;
    const x = ((event.clientX - rect.left) / rect.width) * view.viewport.width;
    const y = ((event.clientY - rect.top) / rect.height) * view.viewport.height;
    return {
      x: Math.max(0, Math.min(view.viewport.width - 1, Math.round(x))),
      y: Math.max(0, Math.min(view.viewport.height - 1, Math.round(y))),
    };
  }
  function pointer(event: PointerEvent, action: "down" | "up" | "move") {
    if (!view?.control) return;
    const at = point(event);
    if (at === undefined) return;
    if (action === "move") {
      // Hover needs moves, but a pointer floods; one every 50 ms is enough.
      if (Date.now() - lastMove < 50) return;
      lastMove = Date.now();
    } else {
      event.preventDefault();
      keyboard?.focus({ preventScroll: true });
    }
    send({
      type: "mouse",
      action,
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
      ...at,
    });
  }
  /**
   * Pointer input on the shown page, attached directly as a remote view's canvas would be. Keyboard users have the
   * address bar, toolbar and the keyboard field above, which a pointer press also focuses.
   */
  function pointerInput(node: HTMLElement) {
    const down = (event: PointerEvent) => pointer(event, "down");
    const up = (event: PointerEvent) => pointer(event, "up");
    const move = (event: PointerEvent) => pointer(event, "move");
    const menu = (event: Event) => event.preventDefault();
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointermove", move);
    node.addEventListener("wheel", wheel, { passive: false });
    node.addEventListener("contextmenu", menu);
    return () => {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("wheel", wheel);
      node.removeEventListener("contextmenu", menu);
    };
  }
  function wheel(event: WheelEvent) {
    if (!view?.control) return;
    event.preventDefault();
    const at = point(event);
    if (at !== undefined) send({ type: "wheel", dx: event.deltaX, dy: event.deltaY, ...at });
  }
  /** Named keys and shortcuts go as key presses; typed characters arrive through `typed`, which also covers IMEs. */
  function key(event: KeyboardEvent) {
    if (!view?.control) return;
    const modifiers = [event.ctrlKey && "Control", event.altKey && "Alt", event.metaKey && "Meta"].filter(Boolean);
    if (KEYS.has(event.key) || (event.key.length === 1 && modifiers.length > 0)) {
      event.preventDefault();
      send({
        type: "key",
        key: [...modifiers, event.shiftKey && event.key.length > 1 ? "Shift" : false, event.key]
          .filter(Boolean)
          .join("+"),
      });
    }
  }
  function typed(event: Event & { currentTarget: HTMLInputElement }) {
    const text = event.currentTarget.value;
    event.currentTarget.value = "";
    if (view?.control && text !== "") send({ type: "text", text });
  }
  function go() {
    const url = address.trim();
    if (url !== "" && send({ type: "navigate", url })) addressDirty = false;
  }
  async function stop(clear: boolean) {
    busy = true;
    try {
      socket?.close();
      socket = undefined;
      await (clear ? api.clearBrowser(project.id) : api.closeBrowser(project.id));
      resetView();
      status = "closed";
      clearing = false;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<div class="browser">
  {#if status === "unavailable"}
    <p class="note">
      This Pal build has no browser runtime. The project browser is not supported on macOS yet; use a Linux Pal host.
    </p>
  {:else if status === "closed" || status === "checking"}
    <div class="note">
      <p>
        A Chromium browser for this project, with its own profile. Site logins stay for next time until you clear them.
      </p>
      <button class="b p" disabled={status === "checking" || busy} onclick={start}
        ><Icon name="globe" />Open browser</button
      >
      {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
    </div>
  {:else}
    <div class="bar">
      <button
        class="b i q tip"
        aria-label="Back"
        data-tip="Back"
        disabled={!view?.control}
        onclick={() => send({ type: "back" })}><Icon name="chevL" /></button
      >
      <button
        class="b i q tip"
        aria-label="Forward"
        data-tip="Forward"
        disabled={!view?.control}
        onclick={() => send({ type: "forward" })}><Icon name="chevR" /></button
      >
      <button
        class="b i q tip"
        aria-label="Reload"
        data-tip="Reload"
        disabled={!view?.control}
        onclick={() => send({ type: "reload" })}><Icon name="refresh" /></button
      >
      <label for="browser-address" class="sr">Address</label>
      <input
        id="browser-address"
        class="f mono address"
        bind:value={address}
        disabled={!view?.control}
        autocomplete="off"
        spellcheck="false"
        oninput={() => (addressDirty = true)}
        onfocus={() => (addressFocused = true)}
        onblur={() => (addressFocused = false)}
        onkeydown={(event) => event.key === "Enter" && go()}
      />
      <button class="b" disabled={!view?.control} onclick={go}>Go</button>
    </div>
    <div class="tabs" role="tablist" aria-label="Browser tabs">
      {#each view?.tabs ?? [] as tab (tab.id)}
        <span class="tab" class:on={tab.active}>
          <button
            role="tab"
            aria-selected={tab.active}
            disabled={!view?.control}
            onclick={() => send({ type: "selectTab", id: tab.id })}>{titles[tab.id] || tab.url || "New tab"}</button
          >
          <button
            class="x"
            aria-label={`Close tab ${titles[tab.id] || tab.url || "New tab"}`}
            disabled={!view?.control}
            onclick={() => send({ type: "closeTab", id: tab.id })}><Icon name="x" size={12} /></button
          >
        </span>
      {/each}
      <button
        class="b i q tip"
        aria-label="New tab"
        data-tip="New tab"
        disabled={!view?.control}
        onclick={() => send({ type: "newTab" })}><Icon name="plus" /></button
      >
    </div>
    <div class="status">
      {#if view?.mode === "private-login"}<span class="pill wa">Private login · only you</span>{/if}
      {#if view?.control}<span class="pill ok">You control this browser</span>
      {:else}<span class="pill"
          >{view?.mode === "agent"
            ? "Pal controls this browser"
            : view?.mode === "paused"
              ? "Paused"
              : "View only"}</span
        ><button class="b sm" onclick={() => send({ type: "take" })}>Take control</button>{/if}
      <label class="size"
        ><span class="sr">Page size</span>
        <select
          class="f"
          disabled={!view?.control}
          value={sizes.find((size) => size.width === view?.viewport.width)?.label ?? "Desktop"}
          onchange={(event) => {
            const size = sizes.find((entry) => entry.label === event.currentTarget.value);
            if (size !== undefined) send({ type: "viewport", width: size.width, height: size.height });
          }}
        >
          {#each sizes as size (size.label)}<option value={size.label}>{size.label} {size.width}×{size.height}</option
            >{/each}
        </select></label
      >
    </div>
    <div class="row">
      <button class="b sm q" disabled={view === undefined} onclick={() => send({ type: "mode", mode: "paused" })}
        >Pause</button
      >
      <button class="b sm q" disabled={view === undefined} onclick={() => send({ type: "mode", mode: "private-login" })}
        >Private login</button
      >
      <button
        class="b sm"
        disabled={!view?.control || active === undefined || !active.url.startsWith("http")}
        onclick={() => {
          if (view !== undefined && active !== undefined)
            handoff = { epoch: view.epoch, url: active.url, chat: chatId };
        }}>Hand to Pal…</button
      >
    </div>
    {#if view?.busy}<p class="fine" role="status">
        Finishing a browser action. Inspect the page before continuing.
      </p>{/if}
    {#if view?.agent}<p class="fine" role="status">
        This chat grant: {view.agent.remaining} calls left, expires {new Date(view.agent.expires).toLocaleTimeString()}.
        Each action still needs approval.
      </p>{/if}
    <p class="fine">
      Separate project profile; public sites only. Frames stay here, never saved or sent to the model. Sign in
      privately, then explicitly hand back control to share visible page text with this chat. Passwords and form values
      are not shared.
    </p>
    {#if view?.dialog}
      <div class="callout wa" role="alertdialog" aria-label="Page dialog">
        <span><strong>The page asks:</strong> {view.dialog.message}</span>
        {#if view.dialog.type === "prompt"}<input class="f" aria-label="Answer" bind:value={answer} />{/if}
        <div class="row">
          <button
            class="b sm p"
            disabled={!view.control}
            onclick={() => send({ type: "dialog", accept: true, text: answer })}>OK</button
          >
          <button class="b sm" disabled={!view.control} onclick={() => send({ type: "dialog", accept: false })}
            >Cancel</button
          >
        </div>
      </div>
    {/if}
    {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
    <!-- Typing goes to the page through this field, which a click on the page focuses (and phones then show a keyboard). -->
    <input
      bind:this={keyboard}
      class="sr"
      aria-label="Keyboard input to the page"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      disabled={!view?.control}
      onkeydown={key}
      oninput={typed}
      onfocus={() => (typingFocus = true)}
      onblur={() => (typingFocus = false)}
    />
    <div class="view" class:typing={typingFocus} {@attach pointerInput}>
      {#if frame !== undefined}
        <img
          bind:this={image}
          src={frame}
          alt={`Page: ${titles[active?.id ?? ""] || active?.url || "loading"}`}
          draggable="false"
        />
      {:else}
        <p class="dim">{status === "connecting" ? "Starting the browser…" : "Waiting for the page…"}</p>
      {/if}
    </div>
    {#if phone && view?.control}
      <div class="mobile">
        <input
          class="f"
          aria-label="Type into the page"
          bind:value={typing}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <button
          class="b sm"
          disabled={typing === ""}
          onclick={() => {
            send({ type: "text", text: typing });
            typing = "";
          }}>Type</button
        >
        {#each ["Enter", "Backspace", "Tab"] as name (name)}<button
            class="b sm q"
            onclick={() => send({ type: "key", key: name })}>{name}</button
          >{/each}
      </div>
    {/if}
    <div class="row">
      <button class="b sm" disabled={busy} onclick={() => stop(false)}>Close browser</button>
      <button class="b sm q" disabled={busy} onclick={() => (clearing = true)}>Clear browser data…</button>
    </div>
  {/if}
</div>

{#if handoff !== undefined}
  <ConfirmRemoval
    title="Hand browser to Pal?"
    description="Allow this chat’s selected model to read visible page text and request browser actions using this project’s site logins. The grant lasts five minutes or 40 calls. Every browser action still asks for approval, even in Full access. Finish signing in privately first. Pause or Take control revokes future calls; an action already sent may have completed."
    detail={`Chat: ${handoff.chat}\nPage: ${handoff.url}`}
    confirmLabel="Hand to Pal"
    onConfirm={async () => {
      if (handoff !== undefined && socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "handoff", ...handoff }));
      handoff = undefined;
    }}
    onCancel={() => (handoff = undefined)}
  />
{/if}

{#if clearing}
  <ConfirmRemoval
    title="Clear browser data?"
    description="The browser closes and this project's profile is deleted: cookies, site logins and other site data. Pages you open later start signed out."
    detail={`Project: ${project.name}`}
    confirmLabel="Clear browser data"
    busyLabel="Clearing…"
    onConfirm={() => stop(true)}
    onCancel={() => (clearing = false)}
  />
{/if}

<style>
  .browser {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px 12px;
    min-height: 0;
    flex: 1;
    overflow: auto;
  }
  .note {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    color: var(--tx2);
    font-size: 13px;
  }
  .note p {
    margin: 0;
  }
  .bar,
  .row,
  .status,
  .mobile {
    display: flex;
    align-items: center;
    gap: 4px 6px;
    flex-wrap: wrap;
  }
  .address {
    flex: 1 1 160px;
    min-width: 0;
  }
  .tabs {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    align-items: center;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    max-width: 180px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg1);
  }
  .tab.on {
    border-color: var(--line2);
    background: var(--bg3);
  }
  .tab button {
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    font-size: 12px;
    padding: 4px 6px;
    cursor: pointer;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab .x {
    padding: 4px;
    flex: 0 0 auto;
  }
  .size {
    margin-left: auto;
  }
  .fine {
    margin: 0;
    font-size: 12px;
    color: var(--tx3);
  }
  .view {
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--bg0);
    min-height: 200px;
    flex: 1;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    overflow: hidden;
    touch-action: none;
  }
  .view.typing {
    outline: 2px solid var(--ac);
    outline-offset: 2px;
  }
  .view img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    height: auto;
    user-select: none;
  }
  .dim {
    color: var(--tx3);
    font-size: 13px;
    padding: 20px;
    margin: 0;
  }
  .callout {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
</style>
