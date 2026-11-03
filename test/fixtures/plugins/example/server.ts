import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { CompiledCapability } from "../../../../src/capabilities/contract.ts";
import { HttpError } from "../../../../src/core/http.ts";
import { validate } from "../../../../src/core/requests.ts";
import manifest from "./manifest.ts";

const Settings = Type.Object({ prefix: Type.String({ maxLength: 32 }) }, { additionalProperties: false });

// A test plugin and the template in docs/development.md: one bounded tool, one setting, one panel and a renderer for
// the entry its tool records.
export default {
  manifest,
  open(host) {
    const settings = async () => validate(Settings, (await host.settings.get("echo")) ?? { prefix: "" });
    return {
      tools: [
        defineTool({
          name: "example_echo",
          description: "Echo at most 256 characters after the owner's prefix. This performs no external action.",
          parameters: Type.Object({ text: Type.String({ maxLength: 256 }) }, { additionalProperties: false }),
          callers: ["tools"],
          replay: "safe",
          execute: async ({ text }, api, context) => {
            const echoed = (await settings()).prefix + text;
            await api.commit(
              (tx) => tx.appendEntry(api.conversationId, { kind: "pal.example", data: { text: echoed } }),
              context,
            );
            return { output: [{ type: "text", text: echoed }] };
          },
        }),
      ],
      // GET and PUT settings, from the plugin's Settings tab.
      async api({ method, path, body }) {
        if (path.length === 1 && path[0] === "settings") {
          if (method === "GET") return settings();
          if (method === "PUT") {
            await host.settings.set("echo", validate(Settings, body));
            return { saved: true };
          }
        }
        throw new HttpError(404, "not_found", "no such example operation");
      },
    };
  },
} satisfies CompiledCapability;
