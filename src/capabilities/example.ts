import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { CompiledCapability } from "./contract.ts";

/** Copy this trusted, compiled contribution; do not load implementations from owner-supplied paths. */
export const exampleCapability = {
  manifest: {
    id: "example",
    version: 1,
    native: "pal.example",
    name: "Example echo",
    description: "Echo a bounded string through native Code Mode. No shell, network or credential access is requested.",
    core: { min: 1, max: 1 },
    panels: ["Context"],
    settings: "new-chat-selection",
    namespace: { name: "example", prefix: "example_", description: "A bounded capability template." },
    optIn: true,
    tools: [{ name: "example_echo", replay: "safe", permissions: ["project.read"], maxOutputBytes: 4096 }],
  },
  open() {
    return {
      tools: [
        defineTool({
          name: "example_echo",
          description: "Echo at most 256 characters. This performs no external action.",
          parameters: Type.Object({ text: Type.String({ maxLength: 256 }) }, { additionalProperties: false }),
          callers: ["tools"],
          replay: "safe",
          execute: async ({ text }) => ({ output: [{ type: "text", text }] }),
        }),
      ],
    };
  },
} satisfies CompiledCapability;
