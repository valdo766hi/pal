import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { openPal } from "../src/core/app.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pal-settings-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pal = await openPal({ dataRoot: root, installRoot: "/nonexistent" }, context);
  cleanups.push(() => pal.close());
  return pal;
}

const before = { provider: "openrouter", modelId: "first-model" };
const after = { provider: "anthropic", modelId: "second-model" };

describe("default provider/model selection", () => {
  it("reads one complete selection while a concurrent writer changes providers", async () => {
    const { settings } = await setup();
    for (let n = 0; n < 20; n++) {
      await settings.setDefaultModel(before);
      const [read] = await Promise.all([settings.defaultModel(), settings.setDefaultModel(after)]);
      expect(read).toEqual(before);
      expect(await settings.defaultModel()).toEqual(after);
    }
  });

  it("rolls back both fields if saving the provider fails, preserving legacy ChatGPT defaults", async () => {
    const { settings, store } = await setup();
    expect(await settings.defaultModel()).toBeUndefined();
    await settings.setDefaultModel({ provider: "openai", modelId: "chatgpt-model" });
    expect(await settings.model()).toBe("chatgpt-model");
    await settings.setDefaultModel(before);
    await store.database.exec(`
      CREATE TEMP TRIGGER reject_default BEFORE UPDATE OF value ON pal_settings
      WHEN NEW.key = 'default_provider' AND NEW.value = 'anthropic'
      BEGIN SELECT RAISE(ABORT, 'fixture default failure'); END;
    `);
    await expect(settings.setDefaultModel(after)).rejects.toThrow("fixture default failure");
    expect(await settings.defaultModel()).toEqual(before);
    expect(await settings.model()).toBe("chatgpt-model");
  });
});
