import { readSetting, saveSetting } from "../../../web/src/lib/state.svelte.ts";

/** Per-browser choices: they change nothing on the server or in any chat. */
export const ring = $state({
  shown: readSetting("pal.contextRing") !== "off",
  percent: readSetting("pal.contextRingPercent") !== "off",
});

export function chooseRing(choice: { shown: boolean; percent: boolean }): void {
  ring.shown = choice.shown;
  ring.percent = choice.percent;
  saveSetting("pal.contextRing", choice.shown ? "on" : "off");
  saveSetting("pal.contextRingPercent", choice.percent ? "on" : "off");
}
