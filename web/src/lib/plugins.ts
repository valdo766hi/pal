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
type Loader<P extends Record<string, unknown>> = () => Promise<{ default: Component<P> }>;
export type Piece<P extends Record<string, unknown>> = { key: string; name: string; load: Loader<P> };
export type SettingsSection = Piece<Record<string, never>> & { id: string; label: string; icon: IconName };

const manifests = Object.values(
  import.meta.glob<{ default: CapabilityManifest }>("../../../plugins/*/manifest.ts", { eager: true }),
).map((module) => module.default);
const components = import.meta.glob("../../../plugins/*/ui/*.svelte");

function loader<P extends Record<string, unknown>>(manifest: CapabilityManifest, component: string): Loader<P> {
  return (
    (components[`../../../plugins/${manifest.id}/ui/${component}.svelte`] as Loader<P> | undefined) ??
    (() => Promise.reject(new Error(`${manifest.id} has no ${component} component`)))
  );
}

/** The pieces for `slot`: browser plugins always, others only where this chat selected them at that version. */
export function slots<S extends keyof SlotProps>(
  slot: S,
  selected: readonly { id: string; version: number }[],
): Piece<SlotProps[S]>[] {
  return manifests
    .filter(
      (manifest) =>
        manifest.scope === "browser" ||
        selected.some((choice) => choice.id === manifest.id && choice.version === manifest.version),
    )
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
    icon: Object.hasOwn(ICONS, item.icon) ? (item.icon as IconName) : "gear",
    load: loader<Record<string, never>>(manifest, item.component),
  }));
