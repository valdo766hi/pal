import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { CompiledCapability } from "../../../../src/capabilities/contract.ts";
import manifest from "./manifest.ts";

// A test plugin: one bounded tool, one panel and a renderer for the entry its tool records.
export default {
  manifest,
  open() {
    return {
      tools: [
        defineTool({
          name: "example_echo",
          description: "Echo at most 256 characters. This performs no external action.",
          parameters: Type.Object({ text: Type.String({ maxLength: 256 }) }, { additionalProperties: false }),
          callers: ["tools"],
          replay: "safe",
          execute: async ({ text }, api, context) => {
            await api.commit(
              (tx) => tx.appendEntry(api.conversationId, { kind: "pal.example", data: { text } }),
              context,
            );
            return { output: [{ type: "text", text }] };
          },
        }),
      ],
    };
  },
} satisfies CompiledCapability;
