import type { CapabilityManifest } from "../../src/capabilities/contract.ts";

export default {
  id: "jev",
  version: 1,
  native: "pal.jev",
  name: "Jev",
  description:
    "Auto command mode's decision model: Jev judges whether each agent shell command is routine enough to run without asking. Each decision is one billed request through TypeSafe or OpenRouter, with the key you enter.",
  core: { min: 3, max: 3 },
  order: 85,
  scope: "installation",
  advisor: { label: "Jev" },
  ui: { settings: [{ id: "jev", label: "Jev", icon: "shield", component: "JevSettings", order: 30 }] },
} satisfies CapabilityManifest;
