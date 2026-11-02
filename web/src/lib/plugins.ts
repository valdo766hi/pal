// Plugin interface pieces from plugins/*: manifests are read at build time, components load only when shown.
import type { Component } from "svelte";
import type { CapabilityManifest } from "../../../src/capabilities/contract.ts";
import type { ChatSummary, ContextInfo, GrantedFolder, Project, Workspace } from "./api.ts";

export type ContextSectionProps = {
  project: Project;
  chat: ChatSummary;
  workspace?: Workspace | null;
  info: ContextInfo;
  folders: GrantedFolder[];
  /** Changes each time the owner refreshes the Context panel. */
  refreshed: number;
};
type Loader = () => Promise<{ default: Component<ContextSectionProps> }>;
export type Section = { key: string; name: string; load: Loader };

const manifests = Object.values(
  import.meta.glob<{ default: CapabilityManifest }>("../../../plugins/*/manifest.ts", { eager: true }),
).map((module) => module.default);
const components = import.meta.glob<{ default: Component<ContextSectionProps> }>("../../../plugins/*/ui/*.svelte");

/** The sections for `slot` from plugins this chat selected, at the version it pinned, in order. */
export function sections(slot: "context", selected: readonly { id: string; version: number }[]): Section[] {
  return manifests
    .filter((manifest) => selected.some((choice) => choice.id === manifest.id && choice.version === manifest.version))
    .flatMap((manifest) =>
      (manifest.ui?.slots ?? []).filter((item) => item.slot === slot).map((item) => ({ manifest, item })),
    )
    .sort((a, b) => a.item.order - b.item.order)
    .map(({ manifest, item }) => ({
      key: `${manifest.id}/${item.component}`,
      name: manifest.name,
      load:
        components[`../../../plugins/${manifest.id}/ui/${item.component}.svelte`] ??
        (() => Promise.reject(new Error(`${manifest.id} has no ${item.component} component`))),
    }));
}
