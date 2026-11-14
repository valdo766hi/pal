import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../src/core/api.ts";
import { openPal } from "../../src/core/app.ts";
import { startServer } from "../../src/core/server.ts";
import type { ContextUsageInfo } from "../../web/src/lib/api.ts";
import { percentUsed, tokens } from "../../web/src/lib/context-usage.ts";
import { GOOD_KEY, startProviderFixture } from "../fixtures/provider-server.ts";

let browser: Browser;
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
});
afterAll(() => browser.close());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const provider = await startProviderFixture();
  cleanups.push(provider.close);
  const root = await mkdtemp(join(tmpdir(), "pal-context-ring-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pal = await openPal(
    {
      dataRoot: join(root, "data"),
      installRoot: "/nonexistent",
      providerOrigin: provider.origin,
      guidanceHome: join(root, "host-home"),
    },
    context,
  );
  cleanups.push(() => pal.close());
  const token = await pal.owner.setup(pal.owner.setupToken, "correct horse battery");
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
  const call = async (method: string, path: string, body?: object) => {
    const response = await fetch(`${base}/api/${path}`, {
      method,
      headers: { origin: base, cookie: `pal_session=${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  await call("PUT", "providers/openrouter/key", { key: GOOD_KEY });
  await call("PUT", "providers/openrouter/enabled", { enabled: true });
  await call("PUT", "default-model", { provider: "openrouter", model: "~deepseek/deepseek-flash-latest" });
  const project = await pal.projects.create("ring-project", { name: "Ring" });
  const chat = await pal.chats.createChat("ring-chat", { projectId: project.id, title: "Ring" }, context);
  expect(await pal.workspaces.info(chat.id)).toMatchObject({ state: "ready" });
  const open = async (width: number, theme: "dark" | "light" = "dark") => {
    const view = await browser.newContext({ viewport: { width, height: 900 } });
    cleanups.push(() => view.close());
    await view.addCookies([{ name: "pal_session", value: token, url: base, httpOnly: true, sameSite: "Strict" }]);
    await view.addInitScript((chosen) => localStorage.setItem("pal.theme", chosen), theme);
    const page = await view.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/#/chat/${chat.id}`);
    await page.getByLabel("Message", { exact: true }).waitFor();
    return { page, errors };
  };
  return { base, chat, provider, open, usage: () => call("GET", `chats/${chat.id}/context/usage`) };
}

const ringOf = (page: Page) => page.getByRole("button", { name: /^Context: / });
async function shoot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const root = process.env.PAL_E2E_SCREENSHOTS;
  if (root === undefined) return;
  await mkdir(root, { recursive: true });
  await page.screenshot({ path: join(root, `${name}.png`), animations: "disabled" });
}

describe("context ring", () => {
  it("fills after the first reply with the stored numbers, opens a breakdown and returns focus", async () => {
    const f = await setup();
    const { page, errors } = await f.open(1440);
    const ring = ringOf(page);
    await expect.poll(() => ring.getAttribute("aria-label")).toBe("Context: No context yet");
    await page.getByLabel("Message", { exact: true }).fill("How full is the context?");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Hello from the provider fixture").waitFor();
    await expect.poll(() => ring.getAttribute("aria-label")).not.toBe("Context: No context yet");
    const usage = (await f.usage()) as ContextUsageInfo;
    if (usage.usedTokens === null || usage.contextWindow === null) throw new Error("no prepared request");
    expect(await ring.getAttribute("aria-label")).toBe(
      `Context: ${percentUsed(usage)} used, ${tokens(usage.usedTokens)} of ${tokens(usage.contextWindow)} tokens`,
    );
    expect(await ring.textContent()).toContain(percentUsed(usage));

    await ring.focus();
    await page.keyboard.press("Enter");
    const breakdown = page.getByRole("dialog", { name: "Context usage" });
    await breakdown.waitFor();
    const rows = breakdown.getByRole("list", { name: "Where the context goes" });
    for (const label of ["System prompt", "Messages", "Tools · Code Mode", "Reserved for summarizing", "Free space"])
      await expect.poll(() => rows.getByText(label, { exact: true }).count()).toBeGreaterThan(0);
    await expect.poll(() => breakdown.getByText("Estimated from the last prepared request").count()).toBe(1);
    await shoot(page, "context-ring-1440-dark");
    await page.keyboard.press("Escape");
    await expect.poll(() => breakdown.count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toMatch(/^Context: /);

    await ring.click();
    await breakdown.getByRole("button", { name: "Inspect prompt in Context" }).click();
    await page.getByRole("region", { name: "Last prepared context" }).waitFor();
    await expect
      .poll(() => page.getByRole("region", { name: "Last prepared context" }).getByText("System prompt").count())
      .toBeGreaterThan(0);
    expect(f.provider.requests.filter((request) => request.path === "/api/v1/chat/completions")).toHaveLength(1);
    expect(errors).toEqual([]);

    for (const [width, theme] of [
      [768, "light"],
      [1440, "light"],
      [768, "dark"],
    ] as const) {
      const other = await f.open(width, theme);
      const shown = ringOf(other.page);
      await expect.poll(() => shown.getAttribute("aria-label")).toBe(await ring.getAttribute("aria-label"));
      await shown.click();
      const pop = other.page.getByRole("dialog", { name: "Context usage" });
      await pop.getByText("System prompt").waitFor();
      const box = await pop.boundingBox();
      expect(box !== null && box.x >= 0 && box.x + box.width <= width).toBe(true);
      await shoot(other.page, `context-ring-${width}-${theme}`);
    }
  });

  it("uses a sheet on a phone and disappears from every chat when switched off", async () => {
    const f = await setup();
    const { page, errors } = await f.open(390, "light");
    const ring = ringOf(page);
    await expect.poll(() => ring.getAttribute("aria-label")).toBe("Context: No context yet");
    await shoot(page, "context-ring-390-empty-light");
    await ring.click();
    const sheet = page.getByRole("dialog", { name: "Context usage" });
    await sheet.getByText("No context yet.", { exact: false }).waitFor();
    expect(await sheet.evaluate((node) => node.tagName)).toBe("DIALOG");
    await shoot(page, "context-ring-390-light");
    await page.keyboard.press("Escape");
    await expect.poll(() => sheet.count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      "Context: No context yet",
    );
    const dark = await f.open(390, "dark");
    await ringOf(dark.page).click();
    await dark.page.getByRole("dialog", { name: "Context usage" }).waitFor();
    await shoot(dark.page, "context-ring-390-dark");

    await page.goto(`${f.base}/#/settings/context-usage`);
    const shown = page.getByRole("switch", { name: /Context ring/ });
    expect(await shown.isChecked()).toBe(true);
    await shown.click();
    await page.goto(`${f.base}/#/chat/${f.chat.id}`);
    await page.getByLabel("Message", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Send" }).waitFor({ state: "attached" });
    expect(await ringOf(page).count()).toBe(0);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.getByLabel("Message", { exact: true }).fill("Still works");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Hello from the provider fixture").waitFor();
    expect(requests.filter((path) => path.endsWith("/context/usage"))).toEqual([]);
    expect(errors).toEqual([]);
    expect(dark.errors).toEqual([]);
  });
});
