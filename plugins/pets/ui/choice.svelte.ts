import { readSetting, saveSetting } from "../../../web/src/lib/state.svelte.ts";

/** The composer pet is a per-browser choice: it changes nothing on the server or in any chat. */
export const pet = $state({ enabled: readSetting("pal.pet") !== "off", id: readSetting("pal.petId") ?? "abuy" });

export function choosePet(choice: { enabled: boolean; id: string }): void {
  pet.enabled = choice.enabled;
  pet.id = choice.id;
  saveSetting("pal.pet", choice.enabled ? "on" : "off");
  saveSetting("pal.petId", choice.id);
}
