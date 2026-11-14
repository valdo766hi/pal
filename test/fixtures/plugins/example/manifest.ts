import type { CapabilityManifest } from "../../../../src/capabilities/contract.ts";

export default {
  id: "example",
  version: 1,
  native: "pal.example",
  name: "Example echo",
  description: "Echo a bounded string through native Code Mode. No shell, network or credential access is requested.",
  core: { min: 2, max: 3 },
  order: 70,
  namespace: { name: "example", prefix: "example_", description: "A bounded capability template." },
  optIn: true,
  tools: [
    { name: "example_echo", replay: "safe", callers: ["tools"], permissions: ["project.read"], maxOutputBytes: 4096 },
  ],
  ui: {
    settings: [{ id: "example", label: "Example echo", icon: "layers", component: "ExampleSettings", order: 70 }],
    panels: [{ id: "Example", icon: "layers", component: "ExamplePanel", order: 10 }],
    renderers: [{ entry: "pal.example", component: "ExampleResult", order: 10 }],
  },
} satisfies CapabilityManifest;
