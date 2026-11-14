import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../src/core/api.ts";
import { openPal } from "../../src/core/app.ts";
import { startServer } from "../../src/core/server.ts";
import { installFakeClaude, startFakeAnthropic } from "../fixtures/claude.ts";

const DIST = join(import.meta.dirname, "../../dist");

let browser: Browser;
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
});
afterAll(() => browser.close());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function shoot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const root = process.env.PAL_E2E_SCREENSHOTS;
  if (root === undefined) return;
  await mkdir(root, { recursive: true });
  await page.screenshot({ path: join(root, `${name}.png`), animations: "disabled", fullPage: true });
}

describe("Claude subscription plugin in the browser", () => {
  it("sets up the provider from Settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pal-claude-e2e-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "bin"));
    const claude = join(root, "bin", "claude");
    await installFakeClaude(claude);
    await writeFile(join(root, "bin", "fake-claude.json"), "{}");
    const pal = await openPal({ dataRoot: join(root, "data"), installRoot: "/nonexistent" }, context);
    cleanups.push(() => pal.close());
    const token = await pal.owner.setup(pal.owner.setupToken, "correct horse battery");
    await pal.settings.setModelSetupDeferred(true);
    await pal.projects.create("claude-e2e-project", { name: "Claude" });
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      version: "test",
      webRoot: join(import.meta.dirname, "../../dist/public"),
      api: createApi(pal),
      upgrade: (request, socket, head) => pal.upgrade(request, socket, head),
    });
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [width, theme] of [
      [1440, "dark"],
      [768, "light"],
      [390, "dark"],
    ] as const) {
      const view = await browser.newContext({ viewport: { width, height: 900 } });
      cleanups.push(() => view.close());
      await view.addCookies([{ name: "pal_session", value: token, url: base, httpOnly: true, sameSite: "Strict" }]);
      await view.addInitScript((chosen) => localStorage.setItem("pal.theme", chosen), theme);
      const page = await view.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${base}/#/settings/claude-code`);
      await page.getByText("legal and compliance terms").waitFor();
      if (width === 1440) {
        const command = page.getByLabel("Claude Code command or absolute path");
        await command.fill(claude);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByText("Saved. New requests use these settings.").waitFor();
        await page.getByRole("button", { name: "Check status" }).click();
        await page.getByText("Logged in with a Claude max subscription.").waitFor();
        await page.getByText("2.1.0 (Claude Code)", { exact: false }).waitFor();
      }
      await shoot(page, `claude-code-settings-${width}-${theme}`);
      await page.goto(`${base}/#/settings/models`);
      const card = page.getByRole("group", { name: "Claude subscription (Claude Code) · Experimental" });
      await card.getByText("Plugin", { exact: true }).waitFor();
      expect(await card.getByRole("textbox").count()).toBe(0);
      if (width === 1440) {
        await card.getByRole("switch").click();
        await card.getByText("Enabled", { exact: true }).waitFor();
        expect((await pal.providers.list()).find(({ id }) => id === "claude-code")?.models.length).toBeGreaterThan(0);
      }
      await card.scrollIntoViewIfNeeded();
      await shoot(page, `claude-code-models-${width}-${theme}`);
      expect(errors).toEqual([]);
    }
  });

  it("answers through the bundled plugin, its relay and the packaged tool inventory", async () => {
    // The built server, not the source: Claude Code starts the inventory by its path beside the bundled code.
    const chunk = readdirSync(DIST).find((name) => /^app-\w+\.js$/.test(name));
    if (chunk === undefined) throw new Error("build Pal first: no bundled app chunk");
    const bundled = (await import(join(DIST, chunk))) as typeof import("../../src/core/app.ts");
    const root = await mkdtemp(join(tmpdir(), "pal-claude-bundle-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "bin"));
    const claude = join(root, "bin", "claude");
    await installFakeClaude(claude);
    await writeFile(join(root, "bin", "fake-claude.json"), "{}");
    const anthropic = await startFakeAnthropic();
    cleanups.push(() => anthropic.close());
    const pal = await bundled.openPal(
      { dataRoot: join(root, "data"), installRoot: "/nonexistent", providerOrigin: anthropic.origin },
      context,
    );
    cleanups.push(() => pal.close());
    await pal.capabilities.request(
      "claude-code",
      {
        method: "PUT",
        path: ["settings"],
        query: new URLSearchParams(),
        body: { command: claude, configDir: null, allowUsageCredits: false },
      },
      context,
    );
    await pal.providers.setEnabled("claude-code", true);
    const [model] = (await pal.providers.list()).find(({ id }) => id === "claude-code")?.models ?? [];
    if (model === undefined) throw new Error("no Claude Code model listed");
    const project = await pal.projects.create("claude-bundle-project", { name: "Claude" });
    const chat = await pal.chats.createChat("claude-bundle-chat", { projectId: project.id }, context);
    const conversation = await pal.harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing conversation");
    await conversation.configure({ model: { provider: "claude-code", modelId: model.id } }, context);
    await pal.chats.submit(chat.id, "claude-bundle-input", { text: "call-tool" }, context);
    await conversation.waitForIdle(context);

    const logged = (await readFile(join(root, "bin", "fake-claude.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { mcp?: string; tools?: string[]; toolCall?: string; denied?: boolean });
    expect(logged.find(({ mcp }) => mcp !== undefined)).toMatchObject({
      mcp: join(DIST, "inert-mcp.mjs"),
      tools: expect.arrayContaining(["codemode"]),
    });
    expect(logged.find(({ toolCall }) => toolCall !== undefined)).toMatchObject({ denied: true });
    // The model's call, then Pal's result in the next request; the reply ends the run.
    expect(anthropic.requests).toHaveLength(2);
    expect(JSON.stringify(anthropic.requests.at(-1)?.body.messages.at(-1))).toContain("tool ran");
    expect((await conversation.context(context)).messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
  }, 60_000);
});
