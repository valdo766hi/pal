import type { CapabilityManifest } from "../../src/capabilities/contract.ts";

export default {
  id: "helpers",
  version: 1,
  native: "pal.helpers",
  name: "Research helpers",
  description:
    "The agent may hand self-contained research questions to helpers that use this chat's model, granted folders (read-only) and internet tools. Helpers can't write files, run commands, use the browser or start helpers; at most 4 per run, each with its own request, token and time limits.",
  core: { min: 2, max: 3 },
  order: 50,
  // Off until chosen: each helper spends model requests on the chat's provider.
  optIn: true,
  tools: [{ name: "agents_delegate", replay: "safe", callers: ["model"], permissions: [], maxOutputBytes: 16 * 1024 }],
} satisfies CapabilityManifest;
