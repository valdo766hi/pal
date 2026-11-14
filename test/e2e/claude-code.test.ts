import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../src/core/api.ts";
import { openPal } from "../../src/core/app.ts";
import { startServer } from "../../src/core/server.ts";

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
  it("ships the inert tool inventory beside the bundle and sets up the provider from Settings", async () => {
    // Claude Code starts the vendored inventory by path relative to the bundled code.
    expect(existsSync(join(import.meta.dirname, "../../dist/inert-mcp.mjs"))).toBe(true);
    const root = await mkdtemp(join(tmpdir(), "pal-claude-e2e-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "bin"));
    const claude = join(root, "bin", "claude");
    await copyFile(join(import.meta.dirname, "../fixtures/fake-claude.mjs"), claude);
    await chmod(claude, 0o755);
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
});
