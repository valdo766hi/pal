// Plugin interface pieces from plugins/*: manifests are read at build time, components load only when shown.
import type { Component } from "svelte";
import type { CapabilityManifest } from "../../../src/capabilities/contract.ts";
import type { ChatSummary, ContextInfo, GrantedFolder, Project, Workspace } from "./api.ts";
import { ICONS, type IconName } from "./icons.ts";

/** What each slot's components receive. */
export type SlotProps = {
  context: {
    project: Project;
    chat: ChatSummary;
    workspace?: Workspace | null;
    info: ContextInfo;
    folders: GrantedFolder[];
    /** Changes each time the owner refreshes the Context panel. */
    refreshed: number;
  };
  /** `onSpace` reports the room the piece needs above the transcript's end, in pixels. */
  composer: { running: boolean; active: boolean; onSpace: (pixels: number) => void };
};
export type PanelProps = { project: Project; chat: ChatSummary; workspace?: Workspace | null };
/** A transcript entry a plugin wrote, as its renderer receives it. */
export type RendererProps = { entry: { id: number; kind: string; data?: unknown } };
type Loader<P extends Record<string, unknown>> = () => Promise<{ default: Component<P> }>;
export type Piece<P extends Record<string, unknown>> = { key: string; name: string; load: Loader<P> };
export type SettingsSection = Piece<Record<string, never>> & { id: string; label: string; icon: IconName };
export type PluginPanel = Piece<PanelProps> & { id: string; icon: IconName };
type Choice = { id: string; version: number };

const manifests = Object.values(
  import.meta.glob<{ default: CapabilityManifest }>("../../../plugins/*/manifest.ts", { eager: true }),
).map((module) => module.default);
const components = import.meta.glob("../../../plugins/*/ui/*.svelte");

/** Plugin components that failed to load in this tab, newest last, for the owner's copied diagnostics. */
export const loadFailures: { plugin: string; component: string; at: string }[] = [];

function loader<P extends Record<string, unknown>>(manifest: CapabilityManifest, component: string): Loader<P> {
  const load =
    (components[`../../../plugins/${manifest.id}/ui/${component}.svelte`] as Loader<P> | undefined) ??
    (() => Promise.reject(new Error(`${manifest.id} has no ${component} component`)));
  return () =>
    load().catch((failure: unknown) => {
      loadFailures.push({ plugin: manifest.id, component, at: new Date().toISOString() });
      if (loadFailures.length > 20) loadFailures.shift();
      throw failure;
    });
}

const icon = (name: string, fallback: IconName): IconName =>
  Object.hasOwn(ICONS, name) ? (name as IconName) : fallback;
/** Browser plugins always; others only where this chat selected them, at the version it pinned. */
const shown = (selected: readonly Choice[]) =>
  manifests.filter(
    (manifest) =>
      manifest.scope === "browser" ||
      selected.some((choice) => choice.id === manifest.id && choice.version === manifest.version),
  );

/** The pieces for `slot` this chat shows. */
export function slots<S extends keyof SlotProps>(slot: S, selected: readonly Choice[]): Piece<SlotProps[S]>[] {
  return shown(selected)
    .flatMap((manifest) =>
      (manifest.ui?.slots ?? []).filter((item) => item.slot === slot).map((item) => ({ manifest, item })),
    )
    .sort((a, b) => a.item.order - b.item.order)
    .map(({ manifest, item }) => ({
      key: `${manifest.id}/${item.component}`,
      name: manifest.name,
      load: loader<SlotProps[S]>(manifest, item.component),
    }));
}

/** Settings tabs from every plugin in this build, in order. */
export const settingsSections: readonly SettingsSection[] = manifests
  .flatMap((manifest) => (manifest.ui?.settings ?? []).map((item) => ({ manifest, item })))
  .sort((a, b) => a.item.order - b.item.order)
  .map(({ manifest, item }) => ({
    key: `${manifest.id}/${item.component}`,
    name: manifest.name,
    id: item.id,
    label: item.label,
    icon: icon(item.icon, "gear"),
    load: loader<Record<string, never>>(manifest, item.component),
  }));

/** Plugin panels this chat shows, after the kernel's, in order. */
export function panels(selected: readonly Choice[]): PluginPanel[] {
  return shown(selected)
    .flatMap((manifest) => (manifest.ui?.panels ?? []).map((item) => ({ manifest, item })))
    .sort((a, b) => a.item.order - b.item.order)
    .map(({ manifest, item }) => ({
      key: `${manifest.id}/${item.component}`,
      name: manifest.name,
      id: item.id,
      icon: icon(item.icon, "layers"),
      load: loader<PanelProps>(manifest, item.component),
    }));
}

/**
 * How this chat shows a transcript entry a plugin wrote: its renderer; `missing` when the entry belongs to a plugin the
 * chat selected but this build's catalog (`available`, once known) lacks; undefined otherwise.
 */
export function renderer(
  kind: string,
  selected: readonly Choice[],
  available: ReadonlySet<string> | undefined,
): Piece<RendererProps> | "missing" | undefined {
  for (const manifest of shown(selected)) {
    const item = manifest.ui?.renderers?.find((candidate) => candidate.entry === kind);
    if (item !== undefined)
      return { key: `${manifest.id}/${item.component}`, name: manifest.name, load: loader(manifest, item.component) };
  }
  const owner = selected.find((choice) => kind === `pal.${choice.id}` || kind.startsWith(`pal.${choice.id}.`));
  return owner !== undefined && available !== undefined && !available.has(owner.id) ? "missing" : undefined;
}
