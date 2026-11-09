import type { CompiledCapability } from "../../src/capabilities/contract.ts";
import { type HelperLimits, helperTools } from "../../src/core/delegation.ts";
import manifest from "./manifest.ts";

// The kernel keeps helper conversations, their links and budget hooks; this plugin offers the model's tool.
export default {
  manifest,
  open(host) {
    const limits = host.options as HelperLimits | undefined;
    return {
      tools:
        helperTools({
          project: async (conversation) => (await host.project(conversation))?.id,
          ...(limits === undefined ? {} : { limits }),
          now: host.now,
        }).tools ?? [],
    };
  },
} satisfies CompiledCapability;
