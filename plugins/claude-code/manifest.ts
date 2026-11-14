import type { CapabilityManifest } from "../../src/capabilities/contract.ts";

export default {
  id: "claude-code",
  version: 1,
  native: "pal.claude-code",
  name: "Claude subscription",
  description:
    "Experimental: use your own Claude Pro or Max subscription for chats through the official Claude Code CLI, installed and logged in on this server. Off until you enable it in Settings → Models; Pal never offers a Claude login or reads Claude Code's credentials.",
  core: { min: 3, max: 3 },
  order: 88,
  scope: "installation",
  providers: [{ id: "claude-code", name: "Claude subscription (Claude Code) · Experimental" }],
  ui: {
    settings: [{ id: "claude-code", label: "Claude Code", icon: "term", component: "ClaudeCodeSettings", order: 40 }],
  },
} satisfies CapabilityManifest;
