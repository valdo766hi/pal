import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openPal, type Pal } from "../../src/core/app.ts";
import type { ChatGPTEndpoints } from "../../src/pi/chatgpt.ts";
import { openStore } from "../../src/storage/store.ts";
import { startMcpFixture } from "./mcp-server.ts";

/** A seeded preset pointed only at an explicit loopback fixture, never the public service. */
export async function startCachedMcp(dataRoot: string, endpoints?: ChatGPTEndpoints, preset = "exa") {
  const fixture = await startMcpFixture();
  let pal: Pal | undefined;
  const options = {
    dataRoot,
    installRoot: "/nonexistent-install",
    guidanceHome: join(dataRoot, "home"),
    ...(endpoints === undefined ? {} : { endpoints }),
  };
  try {
    fixture.state.tools = fixture.state.tools.map((tool) => ({
      ...tool,
      name: tool.name === "search" ? (preset === "exa" ? "web_search_exa" : "query-docs") : tool.name,
    }));
    fixture.state.result = {
      content: [{ type: "text", text: "Fixture durable source" }],
      structuredContent: {
        results: [{ url: "https://fixture.invalid/cached", title: "Fixture durable source", score: 1 }],
      },
    };
    pal = await openPal(options, context);
    await pal.close();
    pal = undefined;
    const store = await openStore(dataRoot);
    try {
      await store.database.run("UPDATE pal_mcp_servers SET url = ?, private = 1 WHERE id = ?", fixture.url, preset);
    } finally {
      await store.close();
    }
    pal = await openPal(options, context);
    await pal.mcp.setEnabled(preset, true);
    return {
      fixture,
      get pal() {
        if (pal === undefined) throw new Error("fixture is closed");
        return pal;
      },
      reopen: async () => {
        await pal?.close();
        pal = await openPal(options, context);
      },
      close: async () => {
        try {
          await pal?.close();
          pal = undefined;
        } finally {
          await fixture.close();
        }
      },
    };
  } catch (error) {
    try {
      await pal?.close();
    } finally {
      await fixture.close();
    }
    throw error;
  }
}
