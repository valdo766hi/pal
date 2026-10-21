import {
  api,
  type ChatGPTState,
  type ExtensionView,
  type ModelRef,
  type Project,
  type ProvidersState,
  type ProviderView,
} from "./api.ts";

export type SettingsTab = "general" | "models" | "mcp" | "extensions" | "pets";
export type Route = { view: "home" } | { view: "chat"; chatId: string } | { view: "settings"; tab: SettingsTab };

function parseRoute(hash: string): Route {
  const [, view, id] = hash.replace(/^#/, "").split("/");
  if (view === "chat" && id !== undefined && id !== "") return { view: "chat", chatId: id };
  if (view === "settings")
    return {
      view: "settings",
      tab: id === "models" || id === "mcp" || id === "extensions" || id === "pets" ? id : "general",
    };
  return { view: "home" };
}

export const app = $state({
  hash: location.hash,
  route: parseRoute(location.hash),
  projects: [] as Project[],
  chatgpt: undefined as ChatGPTState | undefined,
  providers: undefined as ProvidersState | undefined,
  extensions: undefined as ExtensionView | undefined,
  width: window.innerWidth,
  sendWithEnter: readSetting("pal.sendWithEnter") !== "false",
  pet: { enabled: readSetting("pal.pet") !== "off", id: readSetting("pal.petId") ?? "abuy" },
  theme: themeSetting(readSetting("pal.theme")),
  systemLight: matchMedia("(prefers-color-scheme: light)").matches,
});

/** Dark is Pal's default; System follows the device. Saved per browser. */
export type Theme = "dark" | "light" | "system";
function themeSetting(value: string | null): Theme {
  return value === "light" || value === "system" ? value : "dark";
}
matchMedia("(prefers-color-scheme: light)").addEventListener("change", (event) => (app.systemLight = event.matches));
export function shownTheme(): "dark" | "light" {
  if (app.theme !== "system") return app.theme;
  return app.systemLight ? "light" : "dark";
}
export function chooseTheme(theme: Theme): void {
  app.theme = theme;
  saveSetting("pal.theme", theme);
}

/** The composer pet is a per-browser choice: it changes nothing on the server or in any chat. */
export type PetChoice = { enabled: boolean; id: string };

export function choosePet(choice: PetChoice): void {
  app.pet = choice;
  saveSetting("pal.pet", choice.enabled ? "on" : "off");
  saveSetting("pal.petId", choice.id);
}

addEventListener("hashchange", () => {
  app.hash = location.hash;
  app.route = parseRoute(location.hash);
});
addEventListener("resize", () => (app.width = window.innerWidth));

export function navigate(route: Route): void {
  let hash = "#/";
  if (route.view === "chat") hash = `#/chat/${route.chatId}`;
  else if (route.view === "settings") hash = `#/settings/${route.tab}`;
  location.hash = hash;
}

/** The design's breakpoints: phone below 700px, tablet below 1100px. */
export function viewport(): "phone" | "tablet" | "desktop" {
  if (app.width < 700) return "phone";
  if (app.width < 1100) return "tablet";
  return "desktop";
}

export async function refreshProjects(): Promise<void> {
  app.projects = (await api.projects()).projects;
}

export async function refreshChatGPT(): Promise<void> {
  app.chatgpt = await api.chatgpt();
}

export async function refreshProviders(): Promise<void> {
  app.providers = await api.providers();
}

/** Whether an API-key provider has what it needs to be enabled: a saved key, or a described keyless endpoint. */
export function providerReady(provider: ProviderView): boolean {
  if (provider.id !== "compatible") return provider.hasKey;
  return provider.config != null && (provider.config.keyless || provider.hasKey);
}

/** The saved model for new chats. ChatGPT's state carries it too and is refreshed after every change, including
 * the model ChatGPT sign-in preselects. */
export function savedDefault(): ModelRef | null {
  return app.chatgpt?.default ?? app.providers?.default ?? null;
}

/**
 * Whether new chats can send now: the saved default model's provider is connected and enabled, and still offers that
 * model. Nothing else counts, so a missing or revoked choice needs the owner's repair instead of a substitute.
 */
export function defaultReady(): boolean {
  const chosen = savedDefault();
  if (chosen === null) return false;
  if (chosen.provider === "openai")
    return (
      app.chatgpt?.account != null &&
      app.chatgpt.models.some((model) => model.supported && model.slug === chosen.modelId)
    );
  const provider = app.providers?.providers.find((entry) => entry.id === chosen.provider);
  return provider?.enabled === true && provider.models.some((model) => model.id === chosen.modelId);
}

export async function refreshExtensions(): Promise<void> {
  app.extensions = await api.extensions();
}

export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse storage; the setting then lasts for this page only.
  }
}
