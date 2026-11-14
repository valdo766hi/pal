import type { CapabilityManifest } from "../../src/capabilities/contract.ts";

export default {
  id: "context-usage",
  version: 1,
  native: "pal.context-usage",
  name: "Context usage",
  description:
    "A ring beside the message box showing how full the model's context is, with a breakdown of what fills it. Reads Pal's estimates of the last prepared request; no tools, network or model requests.",
  core: { min: 3, max: 3 },
  order: 80,
  scope: "browser",
  ui: {
    settings: [{ id: "context-usage", label: "Context ring", icon: "layers", component: "RingSettings", order: 20 }],
    slots: [{ slot: "composer-tools", component: "ContextRing", order: 10 }],
  },
} satisfies CapabilityManifest;
