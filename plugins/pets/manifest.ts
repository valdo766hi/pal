import type { CapabilityManifest } from "../../src/capabilities/contract.ts";

export default {
  id: "pets",
  version: 1,
  native: "pal.pets",
  name: "Pets",
  description: "A small pixel pet on the composer. No tools, permissions, network or model requests.",
  core: { min: 2, max: 3 },
  order: 90,
  scope: "browser",
  ui: {
    settings: [{ id: "pets", label: "Pets", icon: "paw", component: "PetSettings", order: 10 }],
    slots: [{ slot: "composer", component: "Pet", order: 10 }],
  },
} satisfies CapabilityManifest;
