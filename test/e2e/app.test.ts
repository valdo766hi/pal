// The built UI in Chromium against the real server, with ChatGPT replaced by the loopback OpenAI fixture.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../src/core/api.ts";
import { openPal, type Pal } from "../../src/core/app.ts";
import { browserRuntime } from "../../src/core/browser.ts";
import { startServer } from "../../src/core/server.ts";
import { startMcpFixture } from "../fixtures/mcp-server.ts";
import { startCachedMcp } from "../fixtures/cached-mcp.ts";
import { STDIO_FIXTURE } from "../fixtures/stdio-server.ts";
import { browse, startOpenAIFixture } from "../fixtures/openai-server.ts";
import { startProviderFixture } from "../fixtures/provider-server.ts";
import { fakeReleaseControl } from "../fixtures/releases.ts";

const webRoot = join(import.meta.dirname, "..", "..", "dist", "public");
const exec = promisify(execFile);
/** Where to save screenshots for design review; unset, none are kept. */
const shots = process.env.PAL_E2E_SCREENSHOTS;

let fixture: Awaited<ReturnType<typeof startOpenAIFixture>>;
let mcp: Awaited<ReturnType<typeof startMcpFixture>>;
let provider: Awaited<ReturnType<typeof startProviderFixture>>;
/** A loopback site for the owner browser, and the paths it served. */
let site: number;
const visited: string[] = [];
let pal: Pal;
let dataRoot: string;
let base: string;
let browser: Browser;
let page: Page;
let chatUrl: string;
const cleanups: (() => Promise<unknown>)[] = [];
const releases = fakeReleaseControl();

beforeAll(async () => {
  fixture = await startOpenAIFixture();
  cleanups.push(fixture.close);
  mcp = await startMcpFixture();
  cleanups.push(mcp.close);
  provider = await startProviderFixture();
  cleanups.push(provider.close);
  const pages = createServer((request, response) => {
    visited.push(request.url ?? "/");
    response.setHeader("content-type", "text/html");
    response.end(
      `<title>Fixture ${request.url}</title><style>body{margin:0}</style>` +
        `<button style="position:absolute;left:0;top:0;width:200px;height:100px" onclick="location='/clicked'">go</button>` +
        `<form action="/submit" style="position:absolute;top:150px"><input name="q"></form>`,
    );
  });
  pages.listen(0, "127.0.0.1");
  await once(pages, "listening");
  site = (pages.address() as AddressInfo).port;
  cleanups.push(() => new Promise((resolve) => pages.close(resolve)));
  const packagedBrowser = browserRuntime();
  dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-e2e-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  pal = await openPal(
    {
      dataRoot,
      installRoot: "/nonexistent-install",
      endpoints: fixture.endpoints,
      providerOrigin: provider.origin,
      // No user service manager in the build sandbox: the browser runs without its scope here, and only this site.
      browser: {
        runtime: packagedBrowser === undefined ? undefined : { ...packagedBrowser, scope: null },
        egress: { allowPrivate: true, ports: new Set([site]) },
      },
    },
    context,
  );
  cleanups.push(() => pal.close());
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    version: "e2e",
    webRoot,
    api: createApi(pal, undefined, releases.access),
    upgrade: (request, socket, head) => pal.upgrade(request, socket, head),
  });
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  cleanups.push(() => browser.close());
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // A private-network HTTP page lacks randomUUID, but must still be able to create projects and send messages.
  await page.addInitScript(() => Object.defineProperty(crypto, "randomUUID", { value: undefined }));
  if (shots !== undefined) await mkdir(shots, { recursive: true });
});

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function shoot(name: string): Promise<void> {
  if (shots !== undefined) await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" });
}

/** Onboarding's provider step with ChatGPT: sign in through the fixture, then explicitly choose the default model. */
async function onboardWithChatGPT(view: Page): Promise<void> {
  await view
    .getByRole("radiogroup", { name: "Model provider" })
    .getByRole("radio", { name: /^ChatGPT/ })
    .check();
  await view.getByRole("button", { name: "Continue" }).click();
  await view.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  const authUrl = await view.getByRole("link", { name: "Open ChatGPT sign-in" }).getAttribute("href");
  if (authUrl === null) throw new Error("no sign-in link");
  if (view === page) await shoot("chatgpt-waiting-1440");
  // The owner's own browser completes sign-in on ChatGPT and lands on the server's callback.
  await browse(authUrl);
  await view.getByText("Signed in as").waitFor();
  await view.getByRole("button", { name: "Continue" }).click();
  await view.getByRole("heading", { name: "Choose a model" }).waitFor();
  // Signing in lists models but saves no default until the owner picks one.
  expect(await view.getByRole("radio", { name: /gpt-5\.5/ }).isChecked()).toBe(false);
  expect(await view.getByRole("button", { name: "Continue" }).isDisabled()).toBe(true);
  await view.getByRole("radio", { name: /gpt-5\.5/ }).check();
  await expect.poll(() => view.getByRole("button", { name: "Continue" }).isEnabled()).toBe(true);
  await view.getByRole("button", { name: "Continue" }).click();
}

/** Opens a workspace panel from the chat header, or from the tools sheet at phone width. */
async function openPanel(name: string, view: Page = page): Promise<void> {
  if ((view.viewportSize()?.width ?? 1440) < 700) await view.getByRole("button", { name: "Workspace tools" }).click();
  await view.getByRole("button", { name, exact: true }).click();
}

/** The composer's model control opens on reasoning; its model header opens the model list. */
async function openModelList(): Promise<void> {
  await page.getByRole("button", { name: /^Model and reasoning/ }).click();
  await page
    .getByRole("dialog", { name: "Model and reasoning" })
    .getByRole("button", { name: /^Choose model/ })
    .click();
}

describe("Pal in a browser", () => {
  it("refuses to start without the terminal's setup link, then sets up the owner from it", async () => {
    await page.goto(base);
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
    await expect.poll(() => page.getByRole("heading", { name: "Pal isn't set up yet" }).count()).toBe(1);
    await page.goto(`${base}/#setup=${pal.owner.setupToken}`);
    await page.getByLabel("Passphrase", { exact: true }).fill("correct horse battery");
    await page.getByLabel("Confirm passphrase").fill("correct horse battery");
    await shoot("setup-1440");
    await page.getByRole("button", { name: "Create owner" }).click();
    await page.getByRole("heading", { name: "Welcome to Pal" }).waitFor();
    // The token leaves the address bar once used; projects cannot precede sign-in.
    expect(page.url()).not.toContain("setup=");
    expect(await page.getByRole("button", { name: "Create project" }).count()).toBe(0);
    await page.reload();
    await page.getByRole("heading", { name: "Connect a model provider" }).waitFor();
    await shoot("onboarding-1440");
  });

  it("connects ChatGPT and keeps its model before offering internet tools or projects", async () => {
    await onboardWithChatGPT(page);
    await page.getByText("Enable internet tools?").waitFor();
    expect(await page.getByRole("button", { name: "Create project" }).count()).toBe(0);
    await shoot("onboarding-internet-1440");
  });

  it("reviews internet tools, then creates the first project and chats", async () => {
    await page.getByRole("button", { name: "Not now" }).click();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    expect((await pal.mcp.list()).every((server) => !server.enabled)).toBe(true);
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByLabel("Project name").fill("Notes");
    await shoot("create-project-1440");
    await page.getByRole("dialog", { name: "Create project" }).getByRole("button", { name: "Create project" }).click();
    await page.getByRole("heading", { name: "Start the conversation" }).waitFor();
    chatUrl = page.url();
    await page.getByLabel("Message").fill("hi");
    await page.getByRole("button", { name: "Send" }).click({ timeout: 3000 });
    await page.getByText("Hello").waitFor();
    await page.getByRole("heading", { name: "hi" }).waitFor();
    await shoot("chat-1440");
  });

  it("serves the mark as small favicons and an inline in-app mark under the page's own CSP", async () => {
    const icons = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]')].map(
        (link) => link.href,
      ),
    );
    expect(icons.map((href) => new URL(href).pathname).sort()).toEqual([
      "/apple-touch-icon.png",
      "/favicon-16.png",
      "/favicon-32.png",
    ]);
    for (const href of icons) {
      const response = await fetch(href);
      expect(response.headers.get("content-type")).toBe("image/png");
      // Deliberate small derivatives, not the full-size source artwork.
      expect((await response.arrayBuffer()).byteLength).toBeLessThan(16 * 1024);
    }
    const mark = page.getByRole("complementary", { name: "Projects and chats" }).locator("svg.mark").first();
    expect((await mark.boundingBox())?.width).toBe(22);
    expect(await mark.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps reasoning effort for this chat across reload and sends it to the model", async () => {
    const trigger = page.getByRole("button", { name: /^Model and reasoning/ });
    await trigger.click();
    const card = page.getByRole("dialog", { name: "Model and reasoning" });
    const slider = card.getByRole("slider", { name: "Reasoning effort" });
    // The knob is taller than the track and the fill ends under its center, so no fill edge shows around it.
    const covered = () =>
      card.locator(".track").evaluate((track) => {
        const box = (selector: string) => {
          const node = track.querySelector(selector);
          if (node === null) throw new Error(`missing ${selector}`);
          return node.getBoundingClientRect();
        };
        const [rail, fill, knob] = [track.getBoundingClientRect(), box(".fill"), box(".knob")];
        return (
          Math.abs(fill.right - (knob.left + knob.width / 2)) < 1 && knob.top < rail.top && knob.bottom > rail.bottom
        );
      });
    // Opening focuses the stepped control; keys move only between levels this model supports.
    await expect.poll(() => slider.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await slider.getAttribute("aria-valuetext")).toBe("Off");
    expect(await card.locator(".dot").count()).toBe(5);
    await expect.poll(covered).toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => trigger.getAttribute("aria-label")).toContain("reasoning low");
    // The model's own top level is reachable, not just Pal's former four.
    await page.keyboard.press("End");
    await expect.poll(() => slider.getAttribute("aria-valuetext")).toBe("Extra high");
    await expect.poll(() => trigger.getAttribute("aria-label")).toContain("reasoning extra high");
    await expect.poll(covered).toBe(true);
    // A press lands on the step drawn under the pointer.
    const medium = await card.locator(".dot").nth(2).boundingBox();
    if (medium === null) throw new Error("the Medium step is not rendered");
    await page.mouse.click(medium.x + medium.width / 2, medium.y + medium.height / 2);
    await expect.poll(() => slider.getAttribute("aria-valuetext")).toBe("Medium");
    await expect.poll(() => trigger.getAttribute("aria-label")).toContain("reasoning medium");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => slider.getAttribute("aria-valuetext")).toBe("High");
    await expect.poll(() => trigger.getAttribute("aria-label")).toContain("reasoning high");
    await page.reload();
    await trigger.click();
    await expect.poll(() => slider.getAttribute("aria-valuetext")).toBe("High");
    // The header names the model and the level, as the slider moves.
    expect(await card.getByRole("button", { name: /^Choose model/ }).textContent()).toContain("High");
    await expect.poll(covered).toBe(true);
    await shoot("reasoning-1440");
    // The model header above the slider opens the real model list, with this chat's model chosen.
    await card.getByRole("button", { name: /^Choose model/ }).click();
    const list = page.getByRole("dialog", { name: "Choose model" });
    expect(await list.getByRole("radio", { checked: true }).count()).toBe(1);
    await shoot("model-list-1440");
    await page.keyboard.press("Escape");
    await list.waitFor({ state: "detached" });
    expect(await trigger.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.getByLabel("Message").fill("reason carefully");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Hello", { exact: true }).nth(1).waitFor();
    expect(await page.getByText("Hello", { exact: true }).count()).toBe(2);
    expect(fixture.apiRequests.filter((call) => call.path === "/v1/responses").at(-1)?.body.reasoning).toMatchObject({
      effort: "high",
    });
  });

  it("ignores invalid event JSON and handles the next snapshot", async () => {
    const errors: string[] = [];
    const recordError = (error: Error) => errors.push(error.message);
    const events = "**/api/chats/*/events";
    const text = "Stream recovered after invalid frames";
    const snapshot = {
      entries: [{ id: 1, kind: "pi.user", model: [{ role: "user", content: text }] }],
      inbox: [],
    };
    page.on("pageerror", recordError);
    await page.route(events, (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body:
          "event: snapshot\ndata: {\n\nevent: event\ndata: invalid\n\nevent: approvals\ndata: invalid\n\n" +
          `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` +
          'event: approvals\ndata: {"mode":"ask","approvals":[]}\n\n',
      }),
    );
    try {
      await page.reload();
      await page.getByText(text, { exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      page.off("pageerror", recordError);
      await page.unroute(events);
      await page.reload();
    }
  });

  it("colors code blocks and copies them from the header", async () => {
    const code = 'package main\n\nfunc main() {\n\tfmt.Println("hi") // greet\n}';
    fixture.behavior.reply = `Save this as \`main.go\`:\n\n\`\`\`go\n${code}\n\`\`\``;
    try {
      await page.getByLabel("Message").fill("write a small go program");
      await page.getByRole("button", { name: "Send" }).click();
      const block = page.locator(".md .code").last();
      await block.waitFor();
      expect((await block.locator(".codehead").textContent())?.trim()).toBe("goCopy");
      expect(await block.locator(".hl-k").allTextContents()).toEqual(["package", "func"]);
      expect(await block.locator(".hl-f").allTextContents()).toEqual(["main", "Println"]);
      expect(await block.locator(".hl-s").allTextContents()).toEqual(['"hi"']);
      expect(await block.locator(".hl-c").allTextContents()).toEqual(["// greet"]);
      // Keywords take the theme's blue; everything else keeps its own color, and tabs are four columns.
      expect(
        await block
          .locator(".hl-k")
          .first()
          .evaluate((node) => getComputedStyle(node).color),
      ).toBe("rgb(157, 177, 230)");
      expect(await block.locator("code").evaluate((node) => getComputedStyle(node).tabSize)).toBe("4");
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
      const copy = block.locator("button[data-copy]");
      await copy.click();
      await expect.poll(() => copy.textContent()).toBe("Copied");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
      await shoot("code-1440");
    } finally {
      fixture.behavior.reply = "Hello";
    }
  });

  it("collapses popover motion when the owner prefers reduced motion", async () => {
    const trigger = page.getByRole("button", { name: /^Model and reasoning/ });
    const seconds = () =>
      page
        .getByRole("dialog", { name: "Model and reasoning" })
        .evaluate((node) => Number.parseFloat(getComputedStyle(node).animationDuration));
    await trigger.click();
    expect(await seconds()).toBeGreaterThan(0.1);
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      await trigger.click();
      expect(await seconds()).toBeLessThan(0.001);
      await page.keyboard.press("Escape");
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
  });

  it("shows a small optional pet that never takes input and keeps the owner's choice in this browser", async () => {
    const pet = page.locator(".pet");
    await pet.waitFor();
    expect(await pet.getAttribute("data-pet")).toBe("abuy");
    expect(await pet.getAttribute("data-pose")).toBe("sit");
    expect(await pet.getAttribute("aria-hidden")).toBe("true");
    const box = await pet.boundingBox();
    if (box === null) throw new Error("the pet is not rendered");
    expect(box.width).toBeLessThanOrEqual(48);
    // Whatever is under the pet still gets the pointer.
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".pet") ?? null, center)).toBe(
      null,
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      const blink = () =>
        pet.locator(".open").evaluate((node) => Number.parseFloat(getComputedStyle(node).animationDuration));
      expect(await blink()).toBeLessThan(0.001);
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
    await page.goto(`${base}/#/settings/pets`);
    const settings = page.getByRole("region", { name: "Composer pet" });
    const choices = settings.getByRole("radiogroup", { name: "Pet" }).getByRole("radio");
    await expect
      .poll(() => choices.evaluateAll((radios) => radios.map((radio) => (radio as HTMLInputElement).value)))
      .toEqual(["abuy", "oyen", "kuro", "kalong", "jelok"]);
    const poses = settings.getByRole("list", { name: "Abuy's poses" });
    expect(await poses.getByRole("listitem").allInnerTexts()).toEqual([
      expect.stringContaining("Sitting"),
      expect.stringContaining("On the laptop"),
      expect.stringContaining("Coffee break"),
      expect.stringContaining("Napping"),
    ]);
    await settings.getByRole("radio", { name: /^Kuro/ }).check();
    await settings.getByRole("list", { name: "Kuro's poses" }).getByText("Casting a spell").waitFor();
    // Arrow keys move through the pets like any radio group.
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => settings.getByRole("radio", { name: /^Kalong/ }).isChecked()).toBe(true);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await settings.scrollIntoViewIfNeeded();
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await shoot(`pet-settings-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(chatUrl);
    await page.reload();
    await expect.poll(() => pet.getAttribute("data-pet")).toBe("kalong");
    await shoot("pet-1440");

    // Its own clock: the pet takes a break, then naps, while nobody runs or types; typing wakes it.
    const timed = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: await page.context().storageState(),
    });
    try {
      await timed.clock.install();
      const view = await timed.newPage();
      await view.goto(chatUrl);
      const idle = view.locator(".pet");
      await expect.poll(() => idle.getAttribute("data-pose")).toBe("sit");
      await view.clock.fastForward(10_000);
      await expect.poll(() => idle.getAttribute("data-pose")).toBe("rest");
      await view.clock.fastForward(20_000);
      await expect.poll(() => idle.getAttribute("data-pose")).toBe("nap");
      await view.getByLabel("Message").fill("hello");
      await expect.poll(() => idle.getAttribute("data-pose")).toBe("sit");
    } finally {
      await timed.close();
    }

    await page.goto(`${base}/#/settings/pets`);
    await settings.getByRole("switch", { name: "Show the pet on the composer" }).uncheck();
    await page.goto(chatUrl);
    await page.reload();
    await page.getByLabel("Message").waitFor();
    expect(await pet.count()).toBe(0);
    // Off means its code is never fetched, not merely hidden.
    expect(
      await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .some((entry) => /\/assets\/(Pet|PetSprite|pets)-[^/]+\.js$/.test(entry.name)),
      ),
    ).toBe(false);
    await page.evaluate(() => ["pal.pet", "pal.petId"].forEach((key) => localStorage.removeItem(key)));
    await page.reload();
    await pet.waitFor();
    expect(await pet.getAttribute("data-pet")).toBe("abuy");
  });

  it("switches dark, light and system themes and keeps the choice in this browser", async () => {
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // Dark stays the default even though this browser reports a light system preference.
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches)).toBe(true);
    expect(await theme()).toBe("dark");
    expect(await background()).toBe("rgb(20, 21, 23)");
    await page.goto(`${base}/#/settings/general`);
    const group = page.getByRole("radiogroup", { name: "Theme" });
    await group.getByRole("radio", { name: "Light" }).click();
    await expect.poll(theme).toBe("light");
    expect(await background()).toBe("rgb(250, 250, 250)");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => group.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
    await page.emulateMedia({ colorScheme: "dark" });
    try {
      await expect.poll(theme).toBe("dark");
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(theme).toBe("light");
      await page.goto(chatUrl);
      await page.reload();
      await page.getByLabel("Message").waitFor();
      expect(await theme()).toBe("light");
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
        await shoot(`theme-light-${width}`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${base}/#/settings/general`);
      await group.getByRole("radio", { name: "Dark" }).click();
      await expect.poll(theme).toBe("dark");
    } finally {
      await page.emulateMedia({ colorScheme: null });
    }
    await page.goto(chatUrl);
    await page.getByLabel("Message").waitFor();
  });

  it("explains the usage limit instead of retrying", async () => {
    fixture.behavior.responses = "usage_limit";
    await page.getByLabel("Message").fill("again");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("ChatGPT usage limit reached.").waitFor();
    fixture.behavior.responses = "ok";
  });

  it("adds a private MCP server, approves its tools, and a chat script calls them", async () => {
    await page.goto(`${base}/#/settings/mcp`);
    await page.getByRole("button", { name: "Add server" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Fixture");
    await page.getByLabel("URL").fill(mcp.url);
    await page.getByLabel(/Private endpoint/).check();
    await page.getByRole("button", { name: "Add and test" }).click();
    await page.getByRole("checkbox", { name: /^search/ }).check();
    await page.getByRole("checkbox", { name: /^fetch/ }).check();
    await page.getByRole("button", { name: "Approve selected tools" }).click();
    await page.getByRole("switch", { name: "Enable Fixture" }).check();
    await page.getByText("Ready", { exact: true }).waitFor();
    // Testing and approving never called a tool.
    expect(mcp.calls).toEqual([]);
    await shoot("settings-mcp-1440");
    await page.getByRole("button", { name: /^Context7/ }).click();
    const routing = page.getByRole("checkbox", { name: "Allow fake-IP routing for Context7" });
    await routing.check();
    await expect.poll(async () => (await pal.mcp.get("context7")).fakeIp).toBe(true);
    expect((await pal.mcp.get("context7")).enabled).toBe(false);
    await routing.uncheck();
    await expect.poll(async () => (await pal.mcp.get("context7")).fakeIp).toBe(false);

    const server = (await pal.mcp.list()).find((candidate) => candidate.name === "Fixture");
    fixture.behavior.responses = "script";
    fixture.behavior.script = `return (await tools.mcp__${server?.id}__search({ query: "durable" })).results[0].title;`;
    await page.goto(chatUrl);
    await page.getByLabel("Message").fill("research durable agents");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: /Ran a script/ }).click();
    await page.getByText(`${server?.id} · search`).waitFor();
    // The model answers once the script's result is back; the run ends instead of looping.
    await page.getByText("Hello").last().waitFor();
    await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
    expect(mcp.calls.map((call) => call.name)).toEqual(["search"]);
    await shoot("chat-mcp-1440");
    fixture.behavior.responses = "ok";
  });

  it("saves local MCP without executing, reviews exact intent, and invalidates changed or stale approvals", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pal-browser-program-")));
    const marker = join(cwd, "starts");
    const code = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "start\\n");\n${STDIO_FIXTURE}`;
    const key = "fixture-browser-local-key";
    let id: string | undefined;
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    try {
      await page.goto(`${base}/#/settings/mcp`);
      await page.getByRole("button", { name: "Add server" }).click();
      await page.getByRole("radio", { name: "Local stdio", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Local browser fixture");
      await page.getByLabel("Command", { exact: true }).fill(process.execPath);
      await page.getByLabel("Working folder on this server").fill(cwd);
      await page.getByRole("button", { name: "Add argument", exact: true }).click();
      await page.getByLabel("Argument 1", { exact: true }).fill("-e");
      await page.getByRole("button", { name: "Add argument", exact: true }).click();
      await page.getByLabel("Argument 2", { exact: true }).fill(code);
      await page.getByRole("combobox", { name: /^Authentication/ }).selectOption("env");
      await page.getByLabel("Key variable", { exact: true }).fill("BROWSER_LOCAL_TOKEN");
      await page.getByLabel("Key", { exact: true }).fill(key);
      const saved = page.waitForResponse(
        (r) => r.url() === `${base}/api/mcp/servers` && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Save local program", exact: true }).click();
      const body = (await (await saved).json()) as { server: { id: string } };
      id = body.server.id;
      const card = page.locator(".card").filter({ has: page.getByRole("button", { name: /^Local browser fixture/ }) });
      await card.getByRole("button", { name: "Review local program…" }).waitFor();
      expect(await card.getByRole("switch").isDisabled()).toBe(true);
      expect(await card.getByRole("button", { name: "Test connection", exact: true }).isDisabled()).toBe(true);
      await expect(readFile(marker)).rejects.toThrow();
      const dialog = page.getByRole("alertdialog", { name: "Approve this local MCP program?" });
      await card.getByRole("button", { name: "Review local program…" }).click();
      expect(
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .evaluate((el) => el === document.activeElement),
      ).toBe(true);
      expect(await dialog.innerText()).toContain("unsandboxed");
      expect(await dialog.innerText()).toContain("BROWSER_LOCAL_TOKEN");
      expect(await dialog.innerText()).not.toContain(key);
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await dialog.evaluate((el) => {
          el.scrollTop = 0;
        });
        expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
        expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await shoot(`mcp-program-review-${width}`);
      }
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      await expect(readFile(marker)).rejects.toThrow();
      await card.getByRole("button", { name: "Review local program…" }).click();
      await dialog.getByRole("button", { name: "Approve program", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await expect(readFile(marker)).rejects.toThrow();
      await card.getByRole("button", { name: "Test connection", exact: true }).click();
      await card.getByRole("checkbox", { name: /^inspect/ }).check();
      await card.getByRole("button", { name: "Approve selected tools" }).click();
      await expect.poll(async () => (await pal.mcp.get(id ?? "")).tools[0]?.approved).toBe(true);
      await card.getByRole("switch").check();
      await expect.poll(async () => (await pal.mcp.get(id ?? "")).enabled).toBe(true);
      expect(await readFile(marker, "utf8")).toBe("start\n");
      await page.reload();
      await page.getByRole("button", { name: /^Local browser fixture/ }).click();
      expect(await card.getByLabel("Replace key", { exact: true }).inputValue()).toBe("");
      expect(await page.locator("body").innerText()).not.toContain(key);
      await shoot("mcp-program-connected-390");
      await card.getByRole("button", { name: "Edit connection" }).click();
      expect(await page.getByRole("radio", { name: "Streamable HTTP", exact: true }).isDisabled()).toBe(true);
      await page.getByRole("button", { name: "Add argument", exact: true }).click();
      await page.getByLabel("Argument 3", { exact: true }).fill("changed");
      await page.getByRole("button", { name: "Save local program", exact: true }).click();
      await card.getByRole("button", { name: "Review local program…" }).waitFor();
      expect(await pal.mcp.get(id)).toMatchObject({
        enabled: false,
        keyConfigured: false,
        stdio: { approved: false },
        tools: [],
      });
      expect(await readFile(marker, "utf8")).toBe("start\n");
      await card.getByRole("button", { name: "Review local program…" }).click();
      const current = await pal.mcp.get(id);
      if (current.stdio === null) throw new Error("missing local configuration");
      await pal.mcp.update(id, {
        transport: "stdio",
        name: current.name,
        command: current.stdio.command,
        args: [...current.stdio.args, "external-edit"],
        cwd,
        auth: { kind: "env", variable: "BROWSER_LOCAL_TOKEN" },
      });
      await dialog.getByRole("button", { name: "Approve program", exact: true }).click();
      await dialog
        .getByRole("alert")
        .filter({ hasText: /changed/ })
        .waitFor();
      expect((await pal.mcp.get(id)).stdio?.approved).toBe(false);
      expect(await dialog.innerText()).not.toContain("external-edit");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await card.getByRole("button", { name: "Review local program…" }).click();
      expect(await dialog.innerText()).toContain("external-edit");
      await dialog.getByRole("button", { name: "Approve program", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      expect(await card.getByRole("button", { name: "Test connection", exact: true }).isDisabled()).toBe(true);
      await card.getByRole("button", { name: "Revoke program approval" }).click();
      await card.getByRole("button", { name: "Review local program…" }).waitFor();
      expect(await readFile(marker, "utf8")).toBe("start\n");
      expect(errors).toEqual([]);
    } finally {
      page.off("pageerror", onError);
      if (id !== undefined) await pal.mcp.remove(id);
      await rm(cwd, { recursive: true, force: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(chatUrl);
    }
  });

  it("curates linked memory in Context, refuses stale correction/forgetting, and retrieves only on demand", async () => {
    const project = await pal.projects.create("context-browser-project", { name: "Context fixture" });
    const chat = await pal.chats.createChat("context-browser-chat", { projectId: project.id }, context);
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.stack ?? error.message);
    page.on("pageerror", onError);
    try {
      await writeFile(join(project.root, "decision.txt"), "Original cobalt source");
      await page.goto(`${base}/#/chat/${chat.id}`);
      await page.reload();
      await page.getByLabel("Message").fill("A source decision for Context");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByText("Hello", { exact: true }).waitFor();
      await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
      const before = fixture.apiRequests.filter((call) => call.path === "/v1/responses").length;
      await page.getByRole("button", { name: "Context", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Workspace panel" });
      await panel.getByRole("button", { name: "Add memory", exact: true }).waitFor();
      await panel.getByRole("button", { name: "Add memory", exact: true }).click();
      await panel.getByLabel("Memory title", { exact: true }).fill("Owner decision");
      await panel.getByLabel("Memory fact", { exact: true }).fill("cobalt owner decision");
      await panel.getByRole("button", { name: "Save memory", exact: true }).click();
      await panel.getByRole("heading", { name: "Owner decision", exact: true }).waitFor();
      const owner = (await pal.memory.list(project.id, context)).find((item) => item.title === "Owner decision");
      if (owner === undefined) throw new Error("missing owner memory");
      await panel.getByRole("button", { name: "Correct Owner decision", exact: true }).click();
      await panel.getByLabel("Memory fact", { exact: true }).fill("my retained draft");
      await pal.memory.correct(
        project.id,
        owner.id,
        1,
        { title: owner.title, body: "external correction", source: { kind: "owner" } },
        context,
      );
      await panel.getByRole("button", { name: "Save memory", exact: true }).click();
      await panel
        .getByRole("alert")
        .filter({ hasText: /changed/ })
        .waitFor();
      expect(await panel.getByLabel("Memory fact", { exact: true }).inputValue()).toBe("my retained draft");
      await panel.getByRole("button", { name: "Cancel memory edit" }).click();
      await panel.getByRole("button", { name: "Forget Owner decision", exact: true }).click();
      const dialog = page.getByRole("alertdialog", { name: "Forget this memory?" });
      expect(
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .evaluate((el) => el === document.activeElement),
      ).toBe(true);
      await pal.memory.correct(
        project.id,
        owner.id,
        2,
        { title: owner.title, body: "latest owner correction", source: { kind: "owner" } },
        context,
      );
      await dialog.getByRole("button", { name: "Forget memory", exact: true }).click();
      await dialog
        .getByRole("alert")
        .filter({ hasText: /changed/ })
        .waitFor();
      expect((await pal.memory.list(project.id, context)).find((item) => item.id === owner.id)?.revision).toBe(3);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      expect(await panel.isVisible()).toBe(true);
      await panel.getByRole("button", { name: "Forget Owner decision", exact: true }).click();
      await dialog.getByRole("button", { name: "Forget memory", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await expect.poll(() => panel.getByRole("heading", { name: "Owner decision", exact: true }).count()).toBe(0);

      await panel.getByRole("button", { name: "Add memory", exact: true }).click();
      await panel.getByLabel("Memory title", { exact: true }).fill("File decision");
      await panel.getByLabel("Memory fact", { exact: true }).fill("cobalt SQLite from a verified file");
      await panel.getByRole("combobox", { name: /^Source type/ }).selectOption("file");
      await panel.getByLabel("Source file", { exact: true }).fill("decision.txt");
      await panel.getByRole("button", { name: "Verify source file", exact: true }).click();
      await panel.getByLabel("Verified source preview").filter({ hasText: "Original cobalt source" }).waitFor();
      await panel.getByRole("button", { name: "Save memory", exact: true }).click();
      await panel.getByRole("heading", { name: "File decision", exact: true }).waitFor();
      await panel.getByRole("button", { name: "View source for File decision", exact: true }).click();
      await panel
        .getByRole("region", { name: "Memory source", exact: true })
        .getByText("Original cobalt source", { exact: true })
        .waitFor();
      await writeFile(join(project.root, "decision.txt"), "New cobalt source");
      await panel.getByRole("button", { name: "Refresh context", exact: true }).click();
      await panel.getByText("Source changed · retrieval off", { exact: true }).waitFor();
      expect(await panel.getByRole("region", { name: "Memory source", exact: true }).count()).toBe(0);
      await panel.getByRole("button", { name: "Correct File decision", exact: true }).click();
      await panel.getByLabel("Memory fact", { exact: true }).fill("cobalt revised file fact");
      await panel.getByRole("button", { name: "Verify source file", exact: true }).click();
      await panel.getByLabel("Verified source preview").filter({ hasText: "New cobalt source" }).waitFor();
      await panel.getByRole("button", { name: "Save memory", exact: true }).click();
      await expect.poll(() => panel.getByText("Source changed · retrieval off", { exact: true }).count()).toBe(0);
      await panel.getByRole("button", { name: "Add memory", exact: true }).click();
      await panel.getByLabel("Memory title", { exact: true }).fill("Chat decision");
      await panel.getByLabel("Memory fact", { exact: true }).fill("cobalt comes from a retained chat message");
      await panel.getByRole("combobox", { name: /^Source type/ }).selectOption("chat");
      const conversation = await pal.harness.conversation(chat.conversationId, context);
      const entry = (await conversation?.context(context))?.entries.find((entry) =>
        entry.model?.some((message) => message.role === "user"),
      );
      if (entry === undefined) throw new Error("missing source entry");
      await panel.getByRole("combobox", { name: /^Source message/ }).selectOption(String(entry.id));
      await panel.getByRole("button", { name: "Save memory", exact: true }).click();
      await panel.getByRole("heading", { name: "Chat decision", exact: true }).waitFor();
      await panel.getByRole("button", { name: "View source for Chat decision", exact: true }).click();
      await panel
        .getByRole("region", { name: "Memory source", exact: true })
        .getByText("A source decision for Context", { exact: true })
        .waitFor();
      await panel.getByRole("button", { name: "Rebuild memory search", exact: true }).click();
      await panel.getByText("Memory search rebuilt.", { exact: true }).waitFor();
      expect(fixture.apiRequests.filter((call) => call.path === "/v1/responses")).toHaveLength(before);
      await panel.getByRole("button", { name: "Close panel", exact: true }).click();
      fixture.behavior.responses = "script";
      fixture.behavior.script = 'return await tools.memory_search({query:"cobalt"});';
      await page.getByLabel("Message").fill("retrieve the cobalt decisions");
      const sent = page.waitForResponse(
        (response) =>
          response.url() === `${base}/api/chats/${chat.id}/inputs` && response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Send", exact: true }).click();
      expect((await sent).status()).toBe(200);
      await page.getByText("Hello", { exact: true }).nth(1).waitFor();
      expect(await page.getByText("Hello", { exact: true }).count()).toBe(2);
      await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Context", exact: true }).click();
      await panel
        .getByRole("region", { name: "Recent memory lookups", exact: true })
        .getByText("cobalt", { exact: true })
        .waitFor();
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await panel.getByRole("heading", { name: "Curated memory", exact: true }).scrollIntoViewIfNeeded();
        expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
        await shoot(`context-memory-${width}`);
      }
      await page.reload();
      await openPanel("Context");
      await panel.getByRole("heading", { name: "Chat decision", exact: true }).waitFor();
      await panel
        .getByRole("region", { name: "Recent memory lookups", exact: true })
        .getByText("cobalt", { exact: true })
        .waitFor();
      expect(errors).toEqual([]);
    } finally {
      page.off("pageerror", onError);
      fixture.behavior.responses = "ok";
      await pal.projects.remove(project.id);
      await pal.chats.abortDeleted(context);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(chatUrl);
    }
  });

  it("persists source receipts, keeps links inert until clicked and labels failed retrieval", async () => {
    const card = page.getByRole("region", { name: "Fixture search sources" });
    await card.waitFor();
    const received = await card.locator("time").getAttribute("datetime");
    const requests: string[] = [];
    await page.context().route("https://fixture.invalid/**", async (route) => {
      requests.push(route.request().url());
      await route.fulfill({ contentType: "text/html", body: "<h1>Source fixture</h1>" });
    });
    try {
      await page.reload();
      await card.waitFor();
      expect(await card.locator("time").getAttribute("datetime")).toBe(received);
      await card.locator("summary").click();
      await card.getByRole("link", { name: /^Durable agents/ }).waitFor();
      expect(await card.innerText()).toContain("Not cached at lookup");
      expect(await card.getByText("Server-reported link", { exact: true }).count()).toBe(3);
      expect(mcp.calls.map((call) => call.name)).toEqual(["search"]);
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await card.scrollIntoViewIfNeeded();
        expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
        await shoot(`internet-sources-${width}`);
      }
      expect(requests).toEqual([]);
      const popupPromise = page.waitForEvent("popup");
      await card.getByRole("link", { name: /^Durable agents/ }).click();
      const popup = await popupPromise;
      try {
        await popup.getByRole("heading", { name: "Source fixture" }).waitFor();
        expect(await popup.evaluate(() => window.opener === null && document.referrer === "")).toBe(true);
        expect(requests).toEqual(["https://fixture.invalid/durable"]);
      } finally {
        await popup.close();
      }
    } finally {
      await page.context().unroute("https://fixture.invalid/**");
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    const server = (await pal.mcp.list()).find((candidate) => candidate.name === "Fixture");
    if (server === undefined) throw new Error("missing server");
    fixture.behavior.responses = "script";
    fixture.behavior.script = `return await tools.mcp__${server.id}__fetch({ url: "https://fixture.invalid/missing" });`;
    await page.getByLabel("Message").fill("fetch the missing page");
    await page.getByRole("button", { name: "Send" }).click();
    const failed = page.getByRole("region", { name: "Fixture fetch sources" });
    await failed.getByText("Server error", { exact: true }).waitFor();
    expect(await failed.getByRole("link").count()).toBe(0);
    await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
    fixture.behavior.responses = "ok";
  });

  it("shows persistent cache age and requested live bypass without claiming an origin recrawl", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-cache-browser-")));
    const f = await startCachedMcp(root, fixture.endpoints);
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      version: "cache-e2e",
      webRoot,
      api: createApi(f.pal),
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const view = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    view.on("pageerror", (error) => errors.push(error.message));
    try {
      const token = await f.pal.owner.setup(f.pal.owner.setupToken, "cache browser fixture");
      await view.context().addCookies([{ name: "pal_session", value: token, url: origin }]);
      await f.pal.mcp.finishReview(false);
      await view.goto(origin);
      await onboardWithChatGPT(view);
      await view.getByRole("heading", { name: "Create your first project" }).waitFor();
      await view.getByRole("button", { name: "Create project" }).click();
      await view.getByLabel("Project name").fill("Cache browser fixture");
      await view
        .getByRole("dialog", { name: "Create project" })
        .getByRole("button", { name: "Create project" })
        .click();
      await view.getByRole("heading", { name: "Start the conversation" }).waitFor();
      fixture.behavior.responses = "script";
      fixture.behavior.script = 'return await tools.mcp__exa__web_search_exa({query:"durable"});';
      const submit = async (text: string, answer: number) => {
        await view.getByLabel("Message").fill(text);
        const accepted = view.waitForResponse((r) => r.url().endsWith("/inputs") && r.request().method() === "POST");
        await view.getByRole("button", { name: "Send" }).click();
        expect((await accepted).status()).toBe(200);
        await view.getByText("Hello", { exact: true }).nth(answer).waitFor();
        await view.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
      };
      const cards = view.getByRole("region", { name: "Exa web_search_exa sources" });
      await submit("lookup a fixture source", 0);
      const stored = await f.pal.store.database.get<{ fetched_at: number }>("SELECT fetched_at FROM pal_mcp_cache");
      if (stored === undefined) throw new Error("missing browser cache entry");
      const fetchedAt = new Date(stored.fetched_at).toISOString();
      expect(await cards.nth(0).innerText()).toContain("Not cached at lookup");
      await submit("repeat that lookup", 1);
      const cached = cards.nth(1);
      await cached.getByText("Cached at lookup", { exact: false }).waitFor();
      expect(f.fixture.calls).toHaveLength(1);
      expect(JSON.stringify(fixture.apiRequests.at(-1)?.body)).toContain("mcp__exa__web_search_exa: Pal cache hit");
      const times = await cached
        .locator("time")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime")));
      expect(times[1]).toBe(fetchedAt);
      const cachedText = await cached.innerText();
      expect(cachedText).toContain("Age at lookup:");
      expect(cachedText).toContain("This was not a live lookup.");
      await view.reload();
      await cached.waitFor();
      expect(await cached.innerText()).toBe(cachedText);
      expect(
        await cached.locator("time").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime"))),
      ).toEqual(times);
      for (const width of [1440, 768, 390]) {
        await view.setViewportSize({ width, height: 900 });
        await cached.scrollIntoViewIfNeeded();
        expect(await view.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
        expect(await cached.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        if (shots !== undefined) await view.screenshot({ path: join(shots, `internet-cache-${width}.png`) });
      }
      await view.setViewportSize({ width: 1440, height: 900 });
      fixture.behavior.script = 'return await tools.mcp__exa__web_search_exa({query:"durable",_pal_freshness:"live"});';
      await submit("get a live response instead", 2);
      const bypass = cards.nth(2);
      await bypass.getByText("Pal's cache was bypassed as requested.", { exact: false }).waitFor();
      expect(await bypass.innerText()).toContain("does not prove an origin recrawl");
      expect(await bypass.innerText()).toContain("Not cached at lookup");
      expect(f.fixture.calls).toHaveLength(2);
      expect(f.fixture.calls.at(-1)?.arguments).toEqual({ query: "durable", objective: "durable" });
      expect(errors).toEqual([]);
    } finally {
      fixture.behavior.responses = "ok";
      await view.context().close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins bounded owner instructions, preserves stale drafts and inspects a prepared prompt without another model call", async () => {
    const project = await pal.projects.create("prompt-browser-project", { name: "Prompt fixture" });
    const chat = await pal.chats.createChat("prompt-browser-chat", { projectId: project.id }, context);
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    const panel = page.getByRole("complementary", { name: "Workspace panel" });
    const count = () => fixture.apiRequests.filter((call) => call.path === "/v1/responses").length;
    try {
      await page.goto(`${base}/#/chat/${chat.id}`);
      await page.reload();
      const before = count();
      await page.getByRole("button", { name: "Context", exact: true }).click();
      await panel.getByRole("button", { name: "Edit pinned instructions" }).click();
      const field = panel.getByLabel("Instructions pinned for this chat");
      await field.fill("x".repeat(5251));
      await panel.getByRole("button", { name: "Save pinned instructions" }).click();
      await panel
        .getByRole("alert")
        .filter({ hasText: /1,500 estimated tokens/ })
        .waitFor();
      expect(await field.inputValue()).toBe("x".repeat(5251));
      await field.fill("Prefer jade fixture tests.");
      await panel.getByRole("button", { name: "Save pinned instructions" }).click();
      await panel.getByLabel("Saved pinned instructions").filter({ hasText: "Prefer jade fixture tests." }).waitFor();
      expect(await panel.getByRole("button", { name: "Inspect prepared prompt" }).isDisabled()).toBe(true);
      await page.reload();
      await page.getByRole("button", { name: "Context", exact: true }).click();
      await panel.getByLabel("Saved pinned instructions").waitFor();
      await panel.getByRole("button", { name: "Edit pinned instructions" }).click();
      await field.fill("My retained owner preference.");
      await pal.context.pin(chat, { revision: 1, text: "Other owner's correction." }, context);
      await panel.getByRole("button", { name: "Save pinned instructions" }).click();
      await panel
        .getByRole("alert")
        .filter({ hasText: /changed elsewhere/ })
        .waitFor();
      expect(await field.inputValue()).toBe("My retained owner preference.");
      expect(await panel.getByLabel("Saved pinned instructions").innerText()).toBe("Other owner's correction.");
      expect(await panel.getByRole("button", { name: "Save pinned instructions" }).isDisabled()).toBe(true);
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await field.scrollIntoViewIfNeeded();
        expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
        expect(await field.inputValue()).toBe("My retained owner preference.");
        await shoot(`context-pinned-stale-${width}`);
      }
      await panel.getByRole("button", { name: "Use current revision for my draft" }).click();
      await panel.getByRole("button", { name: "Save pinned instructions" }).click();
      await panel
        .getByLabel("Saved pinned instructions")
        .filter({ hasText: "My retained owner preference." })
        .waitFor();
      expect(count()).toBe(before);
      await panel.getByRole("button", { name: "Close panel", exact: true }).click();
      await page.locator('input[type="file"]').setInputFiles({
        name: "prompt.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Attached jade fixture source."),
      });
      await page.getByRole("button", { name: "Remove prompt.txt" }).waitFor();
      await page.getByLabel("Message").fill("prepare a context with my instructions");
      const sent = page.waitForResponse(
        (response) => response.url().endsWith(`/chats/${chat.id}/inputs`) && response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Send", exact: true }).click();
      expect((await sent).status()).toBe(200);
      await page.getByText("Hello", { exact: true }).waitFor();
      await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
      expect(JSON.stringify(fixture.apiRequests.at(-1)?.body)).toContain("My retained owner preference.");
      expect(JSON.stringify(fixture.apiRequests.at(-1)?.body)).toContain("Attached jade fixture source.");
      const after = count();
      await openPanel("Context");
      await panel.getByRole("button", { name: "Inspect prepared prompt" }).click();
      const prepared = panel.getByRole("region", { name: "Last prepared context" });
      await prepared.getByText("pinned", { exact: true }).click();
      await prepared.locator("pre").filter({ hasText: "My retained owner preference." }).waitFor();
      await panel
        .getByRole("region", { name: "Attached files and selections" })
        .getByText("prompt.txt", { exact: true })
        .waitFor();
      const at = await prepared.locator("time").getAttribute("datetime");
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await prepared.scrollIntoViewIfNeeded();
        expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
        expect(await prepared.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await shoot(`context-prepared-${width}`);
      }
      await page.reload();
      await openPanel("Context");
      await panel.getByRole("button", { name: "Inspect prepared prompt" }).click();
      await prepared.locator("time").waitFor();
      expect(await prepared.locator("time").getAttribute("datetime")).toBe(at);
      expect(count()).toBe(after);
      expect(errors).toEqual([]);
    } finally {
      page.off("pageerror", onError);
      await pal.projects.remove(project.id);
      await pal.chats.abortDeleted(context);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(chatUrl);
    }
  });

  it("narrows project internet tools, rejects stale settings and fits every viewport", async () => {
    const project = (await pal.projects.list())[0];
    const server = (await pal.mcp.list()).find((candidate) => candidate.name === "Fixture");
    if (project === undefined || server === undefined) throw new Error("missing project or server");
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    const button = page.getByRole("button", { name: "Project internet tools" });
    const dialog = page.getByRole("dialog", { name: "Internet tools", exact: true });
    const card = dialog.getByRole("region", { name: "Fixture project permissions" });
    await button.click();
    await card.getByLabel("Permissions for Fixture").selectOption("subset");
    await card.getByRole("checkbox", { name: /^fetch/ }).uncheck();
    await card.getByRole("button", { name: "Save Fixture project permissions" }).click();
    await expect.poll(async () => (await pal.mcp.grants.decision(project.id, server.id, "fetch")).allowed).toBe(false);
    await dialog.getByRole("button", { name: "Close project internet tools" }).click();
    await page.reload();
    await button.click();
    await expect.poll(() => card.getByLabel("Permissions for Fixture").inputValue()).toBe("subset");
    expect(await card.getByRole("checkbox", { name: /^search/ }).isChecked()).toBe(true);
    expect(await card.getByRole("checkbox", { name: /^fetch/ }).isChecked()).toBe(false);
    expect(await dialog.getByRole("region", { name: "Context7 project permissions" }).innerText()).toContain(
      "Owner disabled",
    );

    // A second owner tab changes the saved selection while this dialog keeps its reviewed snapshot.
    const current = (await pal.mcp.grants.view(project.id)).servers.find((candidate) => candidate.id === server.id);
    if (current === undefined) throw new Error("missing grant");
    await pal.mcp.grants.set(project.id, server.id, { revision: current.revision, mode: "subset", tools: [] });
    await card.getByRole("button", { name: "Save Fixture project permissions" }).click();
    await dialog.getByRole("alert").filter({ hasText: "Refresh before saving" }).waitFor();
    await dialog.getByRole("button", { name: "Refresh permissions" }).click();
    await expect.poll(() => card.getByRole("checkbox", { name: /^search/ }).isChecked()).toBe(false);
    await card.getByRole("checkbox", { name: /^search/ }).check();
    await card.getByRole("button", { name: "Save Fixture project permissions" }).click();
    await expect.poll(async () => (await pal.mcp.grants.decision(project.id, server.id, "search")).allowed).toBe(true);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      // A phone has no chat header; the same settings open from its tools sheet.
      if (width === 390) {
        await page.getByRole("button", { name: "Workspace tools" }).click();
        await button.click();
      }
      await card.scrollIntoViewIfNeeded();
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await card.locator("label.fl").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(
        100,
      );
      await shoot(`project-mcp-${width}`);
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await button.evaluate((element) => element.matches(":focus"))).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await button.click();
    await card.getByLabel("Permissions for Fixture").selectOption("inherit");
    await card.getByRole("button", { name: "Save Fixture project permissions" }).click();
    await expect.poll(async () => (await pal.mcp.grants.decision(project.id, server.id, "fetch")).allowed).toBe(true);
    await expect
      .poll(() => dialog.getByRole("button", { name: "Close project internet tools" }).isEnabled())
      .toBe(true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("complementary", { name: "Workspace panel" }).waitFor();
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    expect(errors).toEqual([]);
    page.off("pageerror", onError);
  });

  it("adds device files from the composer's + menu and lets a script read the project folder", async () => {
    const add = page.getByRole("button", { name: "Add", exact: true });
    await add.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Add" });
    // Only device files for now: no folders, plugins or other pictured actions.
    expect(await menu.getByRole("menuitem").count()).toBe(1);
    const item = menu.getByRole("menuitem", { name: /^Add file from this device/ });
    await expect.poll(() => item.evaluate((node) => node === document.activeElement)).toBe(true);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      const box = await menu.boundingBox();
      expect(box !== null && box.x >= 0 && box.x + box.width <= width).toBe(true);
      await shoot(`add-menu-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    expect(await add.evaluate((node) => node === document.activeElement)).toBe(true);
    // Listening first lets Playwright's file chooser interception settle before the key that opens it.
    const chooser = page.waitForEvent("filechooser");
    // Arrow keys open the menu on its only item, the way a keyboard user would reach it.
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => item.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    const picked = await chooser;
    expect(picked.isMultiple()).toBe(true);
    await picked.setFiles([
      { name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("The launch is on Tuesday.") },
      { name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Not for this message.") },
    ]);
    await page.getByRole("button", { name: "Remove draft.txt" }).click();
    await page.getByRole("button", { name: "Remove draft.txt" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Remove plan.txt" }).waitFor();
    fixture.behavior.responses = "script";
    fixture.behavior.script = "return await tools.files_list({});";
    await page.getByLabel("Message").fill("what is in the project?");
    await page.getByRole("button", { name: "Send" }).click();
    // The sent message shows its attachment; the upload reached the model with it.
    await page.locator(".user .chip").filter({ hasText: "plan.txt" }).waitFor();
    await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
    const sent = fixture.apiRequests.filter((call) => call.path === "/v1/responses");
    expect(JSON.stringify(sent.map((call) => call.body.input))).toContain("The launch is on Tuesday.");
    expect(JSON.stringify(sent.map((call) => call.body.input))).not.toContain("Not for this message.");
    await page
      .getByRole("button", { name: /Ran a script/ })
      .last()
      .click();
    await page.getByText("files_list", { exact: true }).waitFor();
    await shoot("chat-upload-1440");
    fixture.behavior.responses = "ok";
  });

  it("writes a project file and shows a real host command receipt through Code Mode", async () => {
    const projectBefore = (await pal.projects.list())[0];
    if (projectBefore === undefined) throw new Error("missing project");
    await exec("git", ["init", "-q"], { cwd: projectBefore.root });
    await writeFile(join(projectBefore.root, "base.txt"), "original\n");
    await exec("git", ["add", "base.txt"], { cwd: projectBefore.root });
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "base",
      ],
      { cwd: projectBefore.root },
    );
    fixture.behavior.responses = "script";
    fixture.behavior.script =
      'await tools.files_write({ path: "host.txt", content: "before\\n", expectedHash: null }); return await tools.shell_run({ command: "printf after >> host.txt; printf host-output", timeout: 2 });';
    await page.getByLabel("Message").fill("write and test the file");
    await page.getByRole("button", { name: "Send" }).click();
    // New chats ask first: the exact command waits for the owner, and nothing runs before approval.
    const request = page.getByRole("group", { name: "Approval request" });
    await request.getByText("printf after >> host.txt; printf host-output", { exact: true }).waitFor();
    await request.getByText("timeout 2 s", { exact: false }).waitFor();
    await page.getByRole("status").filter({ hasText: "Waiting for your approval" }).waitFor();
    expect(await readFile(join(projectBefore.root, "host.txt"), "utf8")).toBe("before\n");
    // The pet works alongside an active run and sits back down when it ends.
    const pet = page.locator(".pet");
    await expect.poll(() => pet.getAttribute("data-pose")).toBe("work");
    await shoot("approval-pending-1440");
    await request.getByRole("button", { name: "Approve once" }).click();
    await page.getByText("Exit 0", { exact: true }).waitFor();
    await request.getByText(/Approved once by you at/).waitFor();
    await page.locator("summary").filter({ hasText: "Host command" }).click();
    await page.getByText("host-output", { exact: true }).waitFor();
    await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
    await expect.poll(() => pet.getAttribute("data-pose")).toBe("sit");
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    expect(await readFile(join(project.root, "host.txt"), "utf8")).toBe("before\nafter");
    const chat = (await pal.chats.list(project.id))[0];
    if (chat === undefined) throw new Error("missing chat");
    const agent = await (await pal.harness.conversation(chat.conversationId, context))?.agent(context);
    expect(agent?.tools.map((tool) => tool.name)).toEqual(["codemode"]);
    for (const name of ["files_write", "files_edit", "shell_run"])
      expect(agent?.callable.find((tool) => tool.name === name)).toMatchObject({
        replay: "unsafe",
        callers: ["tools"],
      });
    await shoot("host-command-1440");
    fixture.behavior.responses = "ok";
  });

  it("chooses Ask or Full access from the composer, denies and resumes requests across reload", async () => {
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    const pill = page.getByRole("button", { name: /^Command approval:/ });
    await expect.poll(() => pill.textContent()).toContain("Ask");
    await pill.click();
    const popover = page.getByRole("dialog", { name: "Command approval" });
    await popover.getByText("How should Pal actions be approved?").waitFor();
    const rows = popover.getByRole("radio");
    expect(await rows.count()).toBe(2);
    const ask = popover.getByRole("radio", { name: /Ask for approval/ });
    const full = popover.getByRole("radio", { name: /Full access \(YOLO\)/ });
    expect(await ask.getAttribute("aria-checked")).toBe("true");
    expect(await full.getAttribute("aria-checked")).toBe("false");
    expect(await ask.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press("ArrowDown");
    expect(await full.evaluate((node) => node === document.activeElement)).toBe(true);
    await shoot("command-mode-1440");
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "detached" });
    expect(await pill.evaluate((node) => node === document.activeElement)).toBe(true);

    fixture.behavior.responses = "script";
    fixture.behavior.script = 'return await tools.shell_run({ command: "printf denied >> denied.txt", timeout: 2 });';
    await page.getByLabel("Message").fill("try a command I will deny");
    await page.getByRole("button", { name: "Send" }).click();
    const denied = page.getByRole("group", { name: "Approval request" }).filter({ hasText: "denied.txt" });
    await denied.getByRole("button", { name: "Deny" }).click();
    await denied.getByText(/Denied by you at .*Nothing was run/).waitFor();
    await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
    await expect(readFile(join(project.root, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    // A browser reload neither answers nor loses a waiting request.
    fixture.behavior.script = 'return await tools.shell_run({ command: "printf reload >> reload.txt", timeout: 2 });';
    await page.getByLabel("Message").fill("run after a reload");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("group", { name: "Approval request" }).filter({ hasText: "reload.txt" }).waitFor();
    // While a run waits, the composer offers exactly Steer or Queue for the next message.
    const busy = page.getByRole("radiogroup", { name: "While the agent is running" });
    expect(await busy.getByRole("radio").count()).toBe(2);
    await page.getByRole("button", { name: "Queue", exact: true }).waitFor();
    await busy.getByRole("radio", { name: "Steer" }).click();
    await page.getByRole("button", { name: "Steer", exact: true }).waitFor();
    await page.reload();
    const reloaded = page.getByRole("group", { name: "Approval request" }).filter({ hasText: "reload.txt" });
    await reloaded.getByRole("button", { name: "Approve once" }).click();
    await reloaded.getByText(/Approved once by you at/).waitFor();
    await expect.poll(() => readFile(join(project.root, "reload.txt"), "utf8").catch(() => "")).toBe("reload");
    await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });

    await pill.click();
    await full.click();
    await popover.waitFor({ state: "detached" });
    await expect.poll(() => pill.textContent()).toContain("Full access");
    await page.reload();
    await expect.poll(() => pill.textContent()).toContain("Full access");
    const before = await page.getByRole("group", { name: "Approval request" }).count();
    fixture.behavior.script = 'return await tools.shell_run({ command: "printf full >> full.txt", timeout: 2 });';
    await page.getByLabel("Message").fill("run without asking");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => readFile(join(project.root, "full.txt"), "utf8").catch(() => "")).toBe("full");
    await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
    expect(await page.getByRole("group", { name: "Approval request" }).count()).toBe(before);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      // A phone keeps the composer's approval, model and workspace choices in its tools sheet.
      if (width === 390) await page.getByRole("button", { name: "Workspace tools" }).click();
      await pill.click();
      await popover.waitFor();
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await shoot(`command-mode-full-${width}`);
      await page.keyboard.press("Escape");
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await pill.click();
    await ask.click();
    await expect.poll(() => pill.textContent()).toContain("Ask");
    fixture.behavior.responses = "ok";
  });

  it("reviews actual Git diffs, rejects stale marks and fits desktop, tablet and phone", async () => {
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace panel" });
    await panel.getByRole("button", { name: /host.txt/ }).click();
    await panel.getByLabel("File diff").filter({ hasText: "+before" }).waitFor();
    await panel.getByRole("button", { name: "Mark reviewed" }).click();
    await expect
      .poll(() => panel.getByRole("button", { name: "Reviewed", exact: true }).getAttribute("aria-pressed"))
      .toBe("true");
    await page.reload();
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await panel.getByRole("button", { name: /host.txt/ }).click();
    await panel.getByRole("button", { name: "Reviewed", exact: true }).waitFor();
    await writeFile(join(project.root, "host.txt"), "manual edit\n");
    await panel.getByRole("button", { name: "Reviewed", exact: true }).click();
    await panel
      .getByRole("alert")
      .filter({ hasText: /file changed/ })
      .waitFor();
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await panel.getByLabel("File diff").filter({ hasText: "+manual edit" }).waitFor();
    await panel.getByRole("button", { name: "Mark reviewed" }).waitFor();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await shoot(`changes-${width}`);
    }
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    await page.getByLabel("Message").waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it("browses the project folder read-only by keyboard without sending files to the model", async () => {
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    await mkdir(join(project.root, "docs"), { recursive: true });
    await writeFile(join(project.root, "docs", "guide.md"), "# Guide\nfirst version\n");
    await symlink("/etc/hosts", join(project.root, "outside-link")).catch(() => {});
    const modelRequests = fixture.apiRequests.length;
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace panel" });
    await panel.getByRole("button", { name: /^docs/ }).click();
    await panel.getByRole("button", { name: /^guide\.md/ }).click();
    await panel.getByText("first version").waitFor();
    await panel.getByText("Read-only").waitFor();
    // Back returns focus to the row that opened the file, by keyboard.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")))
      .toBe("Back to files");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-file-row")))
      .toBe("docs/guide.md");
    await page.keyboard.press("Enter");
    await writeFile(join(project.root, "docs", "guide.md"), "# Guide\nsecond version\n");
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await panel.getByText("second version").waitFor();
    await panel.getByRole("button", { name: "Back to files" }).click();
    await panel.getByRole("button", { name: /^outside-link/ }).click();
    await panel
      .getByRole("alert")
      .filter({ hasText: /outside the project folder/ })
      .waitFor();
    // Attaching is an explicit choice that fills the composer; nothing is sent until the owner sends it.
    await panel.getByRole("button", { name: /^docs/ }).waitFor();
    await panel.getByRole("button", { name: /^guide\.md/ }).click();
    await panel.getByRole("button", { name: "Select line 1" }).click();
    await panel.getByRole("button", { name: "Select line 2" }).click();
    await panel.getByRole("button", { name: "Attach lines 1–2" }).click();
    await expect
      .poll(() => page.getByLabel("Message").inputValue())
      .toBe("Project file `docs/guide.md`, lines 1–2:\n\n```\n# Guide\nsecond version\n```");
    await panel.getByRole("button", { name: "Attach file" }).click();
    await expect.poll(() => page.getByLabel("Message").inputValue()).toMatch(/\n\nProject file: `docs\/guide\.md`$/);
    await page.getByLabel("Message").fill("");
    await panel.getByRole("button", { name: "Back to files" }).click();
    await panel.getByRole("button", { name: /^host\.txt/ }).click();
    await panel.getByRole("button", { name: "View diff" }).click();
    await panel.getByRole("heading", { name: "Changes" }).waitFor();
    await panel.getByLabel("File diff").filter({ hasText: "+manual edit" }).waitFor();
    expect(fixture.apiRequests.length).toBe(modelRequests);
    // Search finds exact text and opens the hit with its line selected.
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await panel.getByLabel("Search files").fill("second version");
    await panel.getByRole("button", { name: "Search", exact: true }).click();
    await panel
      .getByRole("list", { name: "Search results" })
      .getByRole("button", { name: /docs\/guide\.md:2/ })
      .click();
    await expect
      .poll(() => panel.getByRole("button", { name: "Select line 2" }).getAttribute("aria-pressed"))
      .toBe("true");
    await shoot("files-search-1440");
    await panel.getByRole("button", { name: "Back to files" }).click();
    await panel.getByRole("button", { name: "Back to folders" }).click();
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    // Switching back opens Files afresh, folders collapsed.
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await panel.getByRole("button", { name: /^docs/ }).click();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await shoot(`files-${width}`);
    }
    await panel.getByRole("button", { name: /^guide\.md/ }).click();
    await panel.getByText("second version").waitFor();
    await shoot("files-preview-390");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it("manages read-only reference folders with separate indexing and a responsive host picker", async () => {
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    const external = await realpath(await mkdtemp(join(tmpdir(), "pal-reference-e2e-")));
    cleanups.push(() => rm(external, { recursive: true, force: true }));
    const reference = join(external, "docs");
    await mkdir(reference);
    await writeFile(join(reference, "reference-guide.txt"), "reference needle\n");
    const modelRequests = fixture.apiRequests.length;
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace panel" });
    const manage = panel.getByRole("button", { name: "Manage project folders" });
    await manage.click();
    const dialog = page.getByRole("dialog", { name: "Folders", exact: true });
    const indexing = dialog.getByRole("checkbox", { name: "Allow search indexing for this reference" });
    expect(await indexing.isChecked()).toBe(false);
    await dialog.getByLabel("Folder on this server").fill(external);
    await dialog.getByRole("button", { name: "Browse server folders" }).click();
    await dialog.getByRole("button", { name: "docs", exact: true }).click();
    await expect.poll(() => dialog.getByLabel("Folder on this server").inputValue()).toBe(reference);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      expect(await dialog.getByLabel("Folder on this server").inputValue()).toBe(reference);
      await shoot(`reference-grant-${width}`);
    }
    await dialog.getByRole("button", { name: "Grant read-only access" }).click();
    await dialog.getByRole("region", { name: `Reference ${reference}`, exact: true }).waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")))
      .toBe("Manage project folders");
    const granted = (await pal.folders.list(project.id)).find((folder) => folder.root === reference);
    if (granted === undefined) throw new Error("missing reference grant");
    await panel.getByLabel("File folder").selectOption(granted.id);
    await panel.getByRole("button", { name: /^reference-guide/ }).click();
    await panel.getByText("reference needle", { exact: true }).waitFor();
    expect(await panel.getByRole("button", { name: "View diff" }).count()).toBe(0);
    await panel.getByRole("button", { name: "Select line 1", exact: true }).click();
    await panel.getByRole("button", { name: "Attach line 1", exact: true }).click();
    await expect
      .poll(() => page.getByLabel("Message").inputValue())
      .toContain(`Reference file (folder ${granted.id}, ${reference})`);
    await page.getByLabel("Message").fill("");
    await panel.getByRole("button", { name: "Back to files" }).click();
    await panel.getByLabel("Search files").fill("needle");
    expect(await panel.getByRole("button", { name: "Search", exact: true }).isDisabled()).toBe(true);
    await shoot("reference-files-1440");
    await page.reload();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await panel.getByLabel("File folder").selectOption(granted.id);
    await manage.click();
    await dialog.getByRole("button", { name: "Remove access", exact: true }).click();
    await expect
      .poll(() => dialog.getByRole("region", { name: `Reference ${reference}`, exact: true }).count())
      .toBe(0);
    await dialog.getByLabel("Folder on this server").fill(reference);
    await dialog.getByRole("button", { name: "Browse server folders" }).click();
    await indexing.check();
    await dialog.getByRole("button", { name: "Grant read-only access" }).click();
    await dialog.getByRole("region", { name: `Reference ${reference}`, exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    expect(await panel.getByLabel("File folder").inputValue()).toBe("primary");
    const indexed = (await pal.folders.list(project.id)).find((folder) => folder.root === reference);
    if (indexed === undefined) throw new Error("missing indexed grant");
    expect(indexed.id).not.toBe(granted.id);
    await panel.getByLabel("File folder").selectOption(indexed.id);
    await panel.getByLabel("Search files").fill("needle");
    await panel.getByRole("button", { name: "Search", exact: true }).click();
    await panel
      .getByRole("list", { name: "Search results" })
      .getByRole("button", { name: /reference-guide.txt:1/ })
      .waitFor();
    expect(fixture.apiRequests.length).toBe(modelRequests);
    expect(await readFile(join(reference, "reference-guide.txt"), "utf8")).toBe("reference needle\n");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
  });

  it("starts explicit per-chat workspace modes and keeps Files, Changes and Terminal in the chosen folder", async () => {
    const project = await pal.projects.create("worktree-ui-project", { name: "Workspace modes" });
    try {
      const git = (...args: string[]) =>
        exec(
          "git",
          ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
          { cwd: project.root },
        );
      await git("init", "-q");
      await writeFile(join(project.root, "workspace.txt"), "committed workspace fixture\n");
      await git("add", "workspace.txt");
      await git("commit", "-qm", "base");
      await writeFile(join(project.root, "workspace.txt"), "source-only manual change\n");
      const local = await pal.chats.createChat("worktree-ui-local", { projectId: project.id }, context);
      await page.goto(`${base}/#/chat/${local.id}`);
      await page.reload();
      const mode = page.getByRole("button", { name: "Workspace mode", exact: true });
      await mode.waitFor();
      await expect.poll(() => mode.textContent()).toContain("Local");
      const picker = page.getByRole("dialog", { name: "Workspace mode", exact: true });
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        if (width === 390) await page.getByRole("button", { name: "Workspace tools" }).click();
        await mode.click();
        expect(await picker.getByRole("button").count()).toBe(3);
        await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toContain("New local chat");
        expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
        const box = await picker.boundingBox();
        expect(box !== null && box.x >= 0 && box.x + box.width <= width).toBe(true);
        await shoot(`workspace-picker-${width}`);
        await page.keyboard.press("Escape");
        await picker.waitFor({ state: "detached" });
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")))
          .toBe("Workspace mode");
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      const requests = fixture.apiRequests.length;
      await mode.click();
      const admitted = page.waitForResponse(
        (response) => response.url() === `${base}/api/chats` && response.request().method() === "POST",
      );
      await picker.getByRole("button", { name: "New worktree chat", exact: false }).click();
      const response = await admitted;
      expect(response.status()).toBe(200);
      const created = await response.json();
      expect(created.chat.workspace).toMatchObject({ mode: "worktree", state: "ready" });
      await page.waitForURL(`${base}/#/chat/${created.chat.id}`);
      await expect.poll(() => mode.textContent()).toContain("Worktree");
      const worktreeChat = (await pal.chats.list(project.id)).find((chat) => chat.id !== local.id);
      if (worktreeChat === undefined) throw new Error("worktree chat missing");
      const workspace = await pal.workspaces.info(worktreeChat.id);
      if (workspace?.state !== "ready") throw new Error("worktree not ready");
      const url = page.url();
      expect(workspace.root).not.toBe(project.root);
      await page.reload();
      await expect.poll(() => mode.textContent()).toContain("Worktree");
      await page.getByRole("button", { name: "Files", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Workspace panel" });
      await panel.getByTitle(workspace.root, { exact: true }).waitFor();
      await panel.getByRole("button", { name: /^workspace.txt/ }).click();
      await panel.getByText("committed workspace fixture", { exact: true }).waitFor();
      await writeFile(join(workspace.root, "workspace.txt"), "worktree-only revision\n");
      await panel.getByRole("button", { name: "Refresh", exact: true }).click();
      await panel.getByText("worktree-only revision", { exact: true }).waitFor();
      await panel.getByRole("button", { name: "Select line 1", exact: true }).click();
      await panel.getByRole("button", { name: "Attach line 1", exact: true }).click();
      await expect
        .poll(() => page.getByLabel("Message").inputValue())
        .toContain(`Worktree file (workspace ${workspace.id}, ${workspace.root})`);
      await page.getByLabel("Message").fill("");
      await panel.getByRole("button", { name: "View diff", exact: true }).click();
      await panel.getByRole("region", { name: "File diff" }).filter({ hasText: "+worktree-only revision" }).waitFor();
      await panel.getByTitle(workspace.root, { exact: true }).waitFor();
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
        await shoot(`worktree-changes-${width}`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await panel.getByRole("button", { name: "Discard…", exact: true }).click();
      const discard = page.getByRole("alertdialog", { name: "Discard changes to this file?" });
      await discard.getByText(`${workspace.root}/workspace.txt`, { exact: false }).waitFor();
      await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
      await panel.getByRole("heading", { name: "No changes found" }).waitFor();
      expect(await readFile(join(project.root, "workspace.txt"), "utf8")).toBe("source-only manual change\n");
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await panel.getByRole("checkbox", { name: /I understand this shell/ }).check();
      await panel.getByRole("button", { name: "New host terminal", exact: true }).click();
      await panel.getByText(workspace.root, { exact: true }).first().waitFor();
      await expect.poll(async () => (await pal.terminals.list(project.id))[0]?.cwd).toBe(workspace.root);
      await shoot("worktree-terminal-1440");
      await panel.getByRole("button", { name: "Close terminal 1", exact: true }).click();
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
      await mode.click();
      await picker.getByRole("button", { name: "New read-only chat", exact: false }).click();
      await expect.poll(() => mode.textContent()).toContain("Read-only");
      await page.getByText("Agent file writes and shell are disabled.", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Files", exact: true }).click();
      await panel.getByRole("button", { name: /^workspace.txt/ }).click();
      await panel.getByText("source-only manual change", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
      await page.goto(url);
      await page.reload();
      await expect.poll(() => mode.textContent()).toContain("Worktree");
      expect(fixture.apiRequests.length).toBe(requests);
    } finally {
      expect(
        (await page.request.delete(`${base}/api/projects/${project.id}`, { headers: { origin: base } })).status(),
      ).toBe(200);
      await page.goto(chatUrl);
      await page.reload();
      await page.getByLabel("Message").waitFor();
    }
  });

  it("shows failed worktree preparation without a local fallback and keeps the error across reload", async () => {
    const project = await pal.projects.create("non-git-ui-project", { name: "No Git" });
    try {
      const local = await pal.chats.createChat("non-git-ui-local", { projectId: project.id }, context);
      await page.goto(`${base}/#/chat/${local.id}`);
      await page.reload();
      await page.getByRole("button", { name: "Workspace mode", exact: true }).click();
      await page.getByRole("button", { name: "New worktree chat", exact: false }).click();
      const status = page.getByRole("status").filter({ hasText: "Worktree unavailable" });
      await status.waitFor();
      await page.getByLabel("Message").fill("must not dispatch");
      expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
      const created = (await pal.chats.list(project.id)).find((chat) => chat.id !== local.id);
      if (created === undefined) throw new Error("failed chat missing");
      expect(await pal.workspaces.info(created.id)).toMatchObject({ mode: "worktree", state: "failed" });
      await page.reload();
      await status.waitFor();
      await shoot("worktree-unavailable-1440");
      expect(pal.chats.stopped).toBe(false);
    } finally {
      expect(
        (await page.request.delete(`${base}/api/projects/${project.id}`, { headers: { origin: base } })).status(),
      ).toBe(200);
      await page.goto(chatUrl);
      await page.reload();
      await page.getByLabel("Message").waitFor();
    }
  });

  it("requires local opt-in for ignored review, drops late private responses and resets permission on reload", async () => {
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    await writeFile(join(project.root, ".gitignore"), "*.secret\n");
    await writeFile(join(project.root, "local.secret"), "private review fixture\n");
    const modelRequests = fixture.apiRequests.length;
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace panel" });
    const include = panel.getByRole("checkbox", { name: "Include ignored files for review" });
    // The opt-in and its warning sit under the baseline's Details line.
    const details = panel.locator("summary").filter({ hasText: "Baseline" });
    await details.click();
    await include.waitFor();
    expect(await include.isChecked()).toBe(false);
    expect(await panel.getByRole("button", { name: /local.secret/ }).count()).toBe(0);
    await include.check();
    await panel.getByRole("button", { name: /local.secret/ }).click();
    await panel.getByRole("region", { name: "File diff" }).filter({ hasText: "+private review fixture" }).waitFor();
    await panel.getByRole("button", { name: "Mark reviewed", exact: true }).click();
    await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
    await panel.getByRole("textbox", { name: "Comment on line 1" }).fill("Review ignored fixture");
    await panel.getByRole("button", { name: "Add comment", exact: true }).click();
    await panel.getByText("Review ignored fixture", { exact: true }).waitFor();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await shoot(`ignored-review-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await include.uncheck();
    await expect.poll(() => panel.getByText("Review ignored fixture", { exact: true }).count()).toBe(0);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const completed = Promise.withResolvers<undefined>();
    const routePattern = `**/api/projects/${project.id}/changes?scope=include-ignored*`;
    await page.route(routePattern, async (route) => {
      const response = await route.fetch();
      entered.resolve(undefined);
      await release.promise;
      await route.fulfill({ response });
      completed.resolve(undefined);
    });
    try {
      await include.check();
      await entered.promise;
      await include.uncheck();
      await expect.poll(() => panel.getByRole("button", { name: "Refresh", exact: true }).isEnabled()).toBe(true);
      const delivered = page.waitForResponse((response) => response.url().includes("/changes?scope=include-ignored"));
      release.resolve(undefined);
      await (await delivered).finished();
      await completed.promise;
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await panel.getByRole("button", { name: /local.secret/ }).count()).toBe(0);
      expect(await panel.getByText("Review ignored fixture", { exact: true }).count()).toBe(0);
    } finally {
      release.resolve(undefined);
      await page.unrouteAll({ behavior: "wait" });
    }
    await include.check();
    await panel.getByRole("button", { name: /local.secret/ }).click();
    await panel.getByRole("button", { name: "Send feedback to chat (1)" }).click();
    await expect.poll(() => page.getByLabel("Message").inputValue()).toContain("private review fixture");
    await page.getByLabel("Message").fill("");
    expect(fixture.apiRequests.length).toBe(modelRequests);
    await page.reload();
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await details.click();
    expect(await include.isChecked()).toBe(false);
    expect(await panel.getByRole("button", { name: /local.secret/ }).count()).toBe(0);
    expect(await panel.getByText("Review ignored fixture", { exact: true }).count()).toBe(0);
    await include.check();
    await panel.getByRole("button", { name: /local.secret/ }).click();
    await panel.getByRole("button", { name: "Discard…", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "Discard changes to this file?" });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await readFile(join(project.root, "local.secret"), "utf8")).toBe("private review fixture\n");
    await panel.getByRole("button", { name: "Discard…", exact: true }).click();
    await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "Restored local.secret to the baseline." }).waitFor();
    await expect(stat(join(project.root, "local.secret"))).rejects.toThrow();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
  });

  it("discards a file only at the revision shown, never over newer work", async () => {
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    await writeFile(join(project.root, "base.txt"), "agent edit\n");
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace panel" });
    await panel.getByRole("button", { name: /base\.txt/ }).click();
    await panel.getByLabel("File diff").filter({ hasText: "+agent edit" }).waitFor();
    await panel.getByRole("button", { name: "Discard…" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Discard changes to this file?" });
    await dialog.getByText(/Rewrites the file on disk to baseline/).waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await shoot(`discard-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await writeFile(join(project.root, "base.txt"), "newer edit\n");
    await dialog.getByRole("button", { name: "Discard changes" }).click();
    await panel
      .getByRole("alert")
      .filter({ hasText: /Nothing was discarded/ })
      .waitFor();
    await dialog.waitFor({ state: "detached" });
    expect(await readFile(join(project.root, "base.txt"), "utf8")).toBe("newer edit\n");
    await panel.getByLabel("File diff").filter({ hasText: "+newer edit" }).waitFor();
    await panel.getByRole("button", { name: "Discard…" }).click();
    await dialog.getByRole("button", { name: "Discard changes" }).click();
    await panel.getByRole("status").filter({ hasText: "Restored base.txt to the baseline." }).waitFor();
    expect(await readFile(join(project.root, "base.txt"), "utf8")).toBe("original\n");
    await expect.poll(() => panel.getByRole("button", { name: /base\.txt/ }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
  });

  it("comments on diff lines, keeps outdated comments visible and sends feedback only to the composer", async () => {
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    const modelRequests = fixture.apiRequests.length;
    await writeFile(join(project.root, "base.txt"), "one\ntwo\nthree\n");
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace panel" });
    await panel.getByRole("button", { name: /base\.txt/ }).click();
    await panel.getByRole("button", { name: "Comment on line 2" }).click();
    await panel.getByRole("textbox", { name: "Comment on line 2" }).fill("Rename two.");
    await panel.getByRole("button", { name: "Add comment" }).click();
    await panel.getByText("Rename two.").waitFor();
    await panel.getByRole("button", { name: "Comment on line 3" }).click();
    await panel.getByRole("textbox", { name: "Comment on line 3" }).fill("Unsubmitted draft");
    await panel.getByRole("button", { name: /host\.txt/ }).click();
    expect(await panel.getByRole("textbox", { name: "Comment on line 3" }).inputValue()).toBe("Unsubmitted draft");
    expect(await panel.getByText(/^Original target: base\.txt/).count()).toBe(1);
    await panel.getByRole("button", { name: /base\.txt/ }).click();
    expect(await panel.getByRole("textbox", { name: "Comment on line 3" }).inputValue()).toBe("Unsubmitted draft");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await panel.getByRole("textbox", { name: /Comment on line/ }).count()).toBe(0);
    // Comments live on the server, so they survive a reload.
    await page.reload();
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await panel.getByRole("button", { name: /base\.txt/ }).click();
    await panel.getByText("Rename two.").waitFor();
    await writeFile(join(project.root, "base.txt"), "one\nTWO\nthree\n");
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await panel.getByText("1 outdated comment").waitFor();
    await panel.getByRole("button", { name: "Comment on line 3" }).click();
    await panel.getByRole("textbox", { name: "Comment on line 3" }).fill("Keep three.");
    await panel.getByRole("button", { name: "Add comment" }).click();
    await panel.getByText("Keep three.").waitFor();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      // A phone shows the panel full screen, so its own controls stand in for the chat header's.
      for (const name of width === 390
        ? ["Refresh", "Close panel"]
        : ["Project internet tools", "Changes", "Files", "Terminal"]) {
        // Overlay panels slide in when the layout changes; measure where they settle.
        await expect
          .poll(async () => {
            const box = await page.getByRole("button", { name, exact: true }).boundingBox();
            return box !== null && box.x >= 0 && box.x + box.width <= width;
          })
          .toBe(true);
      }
      await shoot(`comments-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByLabel("Message").fill("");
    await panel.getByRole("button", { name: "Send feedback to chat (2)" }).click();
    await expect
      .poll(() => page.getByLabel("Message").inputValue())
      .toMatch(
        /^Review feedback:\n\nWorkspace: [^\n]+\n\nbase\.txt \(revision [0-9a-f]{12}\), line 2 \(outdated\): two\nRename two\.\n\nbase\.txt \(revision [0-9a-f]{12}\), line 3: three\nKeep three\.$/,
      );
    await expect.poll(() => panel.getByText("In composer · not admitted", { exact: true }).count()).toBe(2);
    expect((await pal.changes.list(project.id)).comments.map((comment) => comment.sent)).toEqual([false, false]);
    const composed = await page.getByLabel("Message").inputValue();
    await panel.getByRole("button", { name: "Copy feedback again (2)", exact: true }).click();
    expect(await page.getByLabel("Message").inputValue()).toBe(composed);
    expect(fixture.apiRequests.length).toBe(modelRequests);
    await panel.getByRole("button", { name: "Delete comment on line 3" }).click();
    await expect.poll(() => panel.getByText("Keep three.").count()).toBe(0);
    await page.getByLabel("Message").fill("");
    await panel.getByRole("button", { name: "Discard…" }).click();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect.poll(() => panel.getByText("Rename two.").count()).toBe(0);
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
  });

  it("keeps review comments accessible outside diff hunks and after the last change disappears", async () => {
    const project = await pal.projects.create("comment-visibility-project", { name: "Review fixture" });
    try {
      await exec("git", ["init", "-q"], { cwd: project.root });
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      const original = lines.join("\n") + "\n";
      await writeFile(join(project.root, "review.txt"), original);
      await exec("git", ["add", "review.txt"], { cwd: project.root });
      await exec(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-qm",
          "base",
        ],
        { cwd: project.root },
      );
      await pal.changes.list(project.id);
      lines[0] = "changed first line";
      await writeFile(join(project.root, "review.txt"), lines.join("\n") + "\n");
      const revision = (await pal.changes.list(project.id)).files[0]?.revision ?? "";
      await pal.changes.comment(project.id, "review.txt", revision, 2, "Keep this context line.\n" + "X".repeat(1000));
      const chat = await pal.chats.createChat("comment-visibility-chat", { projectId: project.id }, context);
      await page.goto(`${base}/#/chat/${chat.id}`);
      await page.reload();
      await page.getByRole("button", { name: "Changes", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Workspace panel" });
      await panel.getByText("Keep this context line.").waitFor();
      lines[0] = "line 1";
      lines[19] = "changed last line";
      await writeFile(join(project.root, "review.txt"), lines.join("\n") + "\n");
      await panel.getByRole("button", { name: "Refresh", exact: true }).click();
      await panel.getByLabel("File diff").filter({ hasText: "+changed last line" }).waitFor();
      await panel.getByText("Keep this context line.").waitFor();
      expect(await panel.getByText("Outdated", { exact: true }).count()).toBe(0);
      await writeFile(join(project.root, "review.txt"), original);
      await panel.getByRole("button", { name: "Refresh", exact: true }).click();
      await panel.getByRole("heading", { name: "No changes found" }).waitFor();
      await panel.getByText("Keep this context line.").waitFor();
      await page.setViewportSize({ width: 390, height: 900 });
      await expect
        .poll(() =>
          panel
            .getByRole("region", { name: "Other review comments" })
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        )
        .toBe(true);
      await panel.getByRole("button", { name: "Send feedback to chat (1)" }).click();
      await panel.waitFor({ state: "detached" });
      await expect.poll(() => page.getByLabel("Message").inputValue()).toContain("Keep this context line.");
      expect((await pal.changes.list(project.id)).comments[0]?.sent).toBe(false);
      expect(
        await pal.store.database.get("SELECT count(*) AS n FROM pal_admissions WHERE chat_id = ?", chat.id),
      ).toEqual({ n: 0 });
      await openPanel("Changes");
      await panel.getByText("In composer · not admitted", { exact: true }).waitFor();
      await panel.getByRole("button", { name: "Copy feedback again (1)", exact: true }).waitFor();
      await panel.getByRole("button", { name: "Delete comment on line 2" }).click();
      await expect.poll(() => panel.getByText("Keep this context line.").count()).toBe(0);
    } finally {
      await pal.projects.remove(project.id);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(chatUrl);
      await page.reload();
    }
  });

  it("keeps committed changes listed until the owner chooses to review from the latest commit", async () => {
    const project = await pal.projects.create("baseline-move-project", { name: "Commit fixture" });
    const git = (...args: string[]) =>
      exec(
        "git",
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
        { cwd: project.root },
      );
    try {
      await git("init", "-q");
      await writeFile(join(project.root, "app.txt"), "first\n");
      await git("add", "app.txt");
      await git("commit", "-qm", "base");
      const first = (await git("rev-parse", "HEAD")).stdout.trim();
      await pal.changes.list(project.id);
      // As an agent would: edit and commit; the recorded baseline stays put.
      await writeFile(join(project.root, "app.txt"), "second\n");
      await git("commit", "-qam", "agent commit");
      const latest = (await git("rev-parse", "HEAD")).stdout.trim();
      const chat = await pal.chats.createChat("baseline-move-chat", { projectId: project.id }, context);
      await page.goto(`${base}/#/chat/${chat.id}`);
      await page.reload();
      await page.getByRole("button", { name: "Changes", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Workspace panel" });
      await panel.getByText(`Baseline ${first.slice(0, 12)}`).waitFor();
      await panel
        .getByRole("list", { name: "Changed files" })
        .getByRole("button", { name: /app\.txt/ })
        .waitFor();
      const notice = panel.getByRole("status").filter({ hasText: `now at commit ${latest.slice(0, 12)}` });
      await notice.waitFor();
      await shoot("changes-commit-moved-1440");
      await page.setViewportSize({ width: 390, height: 900 });
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await shoot("changes-commit-moved-390");
      await page.setViewportSize({ width: 1440, height: 900 });
      await notice.getByRole("button", { name: "Review from latest commit" }).click();
      await panel.getByRole("heading", { name: "No changes found" }).waitFor();
      await panel.getByText(`Now reviewing changes since commit ${latest.slice(0, 12)}.`).waitFor();
      await panel.getByText(`Baseline ${latest.slice(0, 12)}`).waitFor();
      expect(await panel.getByRole("button", { name: "Review from latest commit" }).count()).toBe(0);
      await page.reload();
      await page.getByRole("button", { name: "Changes", exact: true }).click();
      await panel.getByText(`Baseline ${latest.slice(0, 12)}`).waitFor();
      await panel.getByRole("heading", { name: "No changes found" }).waitFor();
    } finally {
      await pal.projects.remove(project.id);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(chatUrl);
      await page.reload();
    }
  });

  it("reattaches a real human shell on a phone, transfers control and shares only selected output", async () => {
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    const modelRequests = fixture.apiRequests.length;
    expect(await pal.terminals.list(project.id)).toEqual([]);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace panel" });
    await panel.getByText(/No terminal sessions/).waitFor();
    expect(await pal.terminals.list(project.id)).toEqual([]);
    await panel.getByRole("checkbox", { name: /I understand/ }).check();
    await panel.getByRole("button", { name: "New host terminal" }).click();
    await panel.getByRole("status").filter({ hasText: "You control this shell" }).waitFor();
    await panel.getByLabel("Terminal input").focus();
    await page.keyboard.insertText("printf '\\033[2J\\033[Hterminal-live\\r\\n'; printf once >> terminal-count.txt");
    await page.keyboard.press("Enter");
    await expect.poll(() => panel.locator(".xterm-rows").innerText()).toContain("terminal-live");
    await expect.poll(() => readFile(join(project.root, "terminal-count.txt"), "utf8")).toBe("once");
    const id = (await pal.terminals.list(project.id))[0]?.id;
    await panel.getByRole("checkbox", { name: "Screen reader mode" }).check();
    await panel.getByLabel("Terminal input").pressSequentially("printf reader-ok", { delay: 15 });
    await page.keyboard.press("Enter");
    await expect.poll(() => panel.locator(".xterm-accessibility-tree").innerText()).toContain("reader-ok");
    await panel.getByRole("checkbox", { name: "Screen reader mode" }).uncheck();
    // Program colors reach the screen in Pal's palette; the echoed command itself stays uncolored.
    await panel.getByLabel("Terminal input").focus();
    await page.keyboard.insertText("printf '\\033[31m%s\\033[0m\\n' \"ansi-$((40 + 2))\"");
    await page.keyboard.press("Enter");
    const colored = panel.locator(".xterm-rows span").filter({ hasText: /^ansi-42$/ });
    await expect.poll(() => colored.count()).toBeGreaterThan(0);
    expect(await colored.first().evaluate((node) => getComputedStyle(node).color)).toBe("rgb(201, 145, 153)");
    await shoot("terminal-1440");
    // Bottom is the default dock; Side refits the same shell, with no new session and no replayed input.
    const position = panel.getByRole("radiogroup", { name: "Terminal position" });
    expect(await position.getByRole("radio", { name: "Bottom" }).getAttribute("aria-checked")).toBe("true");
    expect((await panel.boundingBox())?.width).toBeGreaterThan(1000);
    const bottomCols = (await pal.terminals.list(project.id))[0]?.cols ?? 0;
    await position.getByRole("radio", { name: "Side" }).click();
    await expect.poll(async () => (await panel.boundingBox())?.x ?? 0).toBeGreaterThan(700);
    await expect.poll(async () => (await pal.terminals.list(project.id))[0]?.cols ?? 0).toBeLessThan(bottomCols);
    expect((await pal.terminals.list(project.id)).map((terminal) => terminal.id)).toEqual([id]);
    const divider = page.getByRole("slider", { name: "Resize terminal" });
    expect(await divider.getAttribute("aria-valuetext")).toBe("Terminal 50% of the work area");
    await divider.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => divider.getAttribute("aria-valuetext")).toBe("Terminal 55% of the work area");
    await shoot("terminal-side-1440");
    expect(await readFile(join(project.root, "terminal-count.txt"), "utf8")).toBe("once");
    await panel.getByRole("button", { name: "Close panel", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "You control this shell" }).waitFor();
    await expect.poll(() => panel.locator(".xterm-rows").innerText()).toContain("terminal-live");
    expect((await pal.terminals.list(project.id))[0]?.id).toBe(id);
    expect(await page.getByLabel("Message").inputValue()).toBe("");
    // This browser remembers the position and size.
    expect(await position.getByRole("radio", { name: "Side" }).getAttribute("aria-checked")).toBe("true");
    expect(await divider.getAttribute("aria-valuetext")).toBe("Terminal 55% of the work area");
    await position.getByRole("radio", { name: "Bottom" }).click();
    await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(1000);

    const phoneContext = await browser.newContext({ storageState: await page.context().storageState() });
    const phone = await phoneContext.newPage();
    try {
      phone.on("pageerror", onError);
      await phone.setViewportSize({ width: 390, height: 844 });
      await phone.goto(chatUrl);
      await openPanel("Terminal", phone);
      const mobile = phone.getByRole("complementary", { name: "Workspace panel" });
      await mobile.getByRole("button", { name: "Take control" }).click();
      await mobile.getByRole("status").filter({ hasText: "You control this shell" }).waitFor();
      await panel.getByRole("button", { name: "Take control" }).waitFor();
      await expect.poll(async () => (await pal.terminals.list(project.id))[0]?.cols).toBeLessThan(60);
      await mobile
        .getByRole("toolbar", { name: "Terminal keys" })
        .getByRole("button", { name: "Esc", exact: true })
        .click();
      await mobile
        .getByRole("toolbar", { name: "Terminal keys" })
        .getByRole("button", { name: "Ctrl+C", exact: true })
        .click();
      await mobile.getByLabel("Terminal input").focus();
      await phone.keyboard.insertText("printf phone > phone.txt");
      await phone.keyboard.press("Enter");
      await expect.poll(() => readFile(join(project.root, "phone.txt"), "utf8")).toBe("phone");
      expect(await phone.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      if (shots !== undefined) await phone.screenshot({ path: join(shots, "terminal-390.png") });
      await mobile.getByRole("button", { name: "Select output", exact: true }).click();
      await mobile.getByRole("button", { name: "Send selection to composer" }).click();
      await expect.poll(() => phone.getByLabel("Message").inputValue()).toContain("terminal-live");
      expect(fixture.apiRequests.length).toBe(modelRequests);
      expect(await readFile(join(project.root, "terminal-count.txt"), "utf8")).toBe("once");
    } finally {
      await phoneContext.close();
    }
    await panel.getByRole("button", { name: "Take control" }).click();
    await page.setViewportSize({ width: 768, height: 1024 });
    await shoot("terminal-768");
    await panel.getByRole("button", { name: "Close terminal 1" }).click();
    await panel.getByText(/No terminal sessions/).waitFor();
    expect(await pal.terminals.list(project.id)).toEqual([]);
    expect(errors).toEqual([]);
    page.off("pageerror", onError);
    await panel.getByRole("button", { name: "Close panel", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it("renames a chat with cancel, mobile resizing, persistence and stale-edit protection", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "New chat in Notes", exact: true }).click();
    await page.getByRole("heading", { name: "Start the conversation" }).waitFor();
    const id = page.url().split("/").at(-1);
    if (id === undefined) throw new Error("missing chat");
    const dialog = page.getByRole("dialog", { name: "Rename chat", exact: true });
    const input = dialog.getByLabel("Chat name");
    try {
      const trigger = page.getByRole("button", { name: "Rename chat New chat", exact: true });
      await trigger.click();
      expect(await input.evaluate((element) => element.matches(":focus"))).toBe(true);
      await input.fill("Canceled name");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      expect(await trigger.evaluate((element) => element.matches(":focus"))).toBe(true);
      await trigger.click();
      await input.fill("Release notes");
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await input.inputValue()).toBe("Release notes");
        expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
        await shoot(`rename-chat-${width}`);
      }
      await input.press("Enter");
      await dialog.waitFor({ state: "detached" });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
      await page.getByRole("heading", { name: "Release notes", exact: true }).waitFor();
      fixture.behavior.responses = "ok";
      await page.getByLabel("Message").fill("Do not replace the chosen title");
      await page.getByRole("button", { name: "Send" }).click();
      await page.getByText("Hello", { exact: true }).waitFor();
      await page.getByRole("heading", { name: "Release notes", exact: true }).waitFor();
      await page.getByRole("button", { name: "Rename chat Release notes", exact: true }).click();
      await input.fill("Stale saved name");
      await pal.chats.rename(id, { title: "Updated elsewhere", expectedTitle: "Release notes" });
      await dialog.getByRole("button", { name: "Save name" }).click();
      await dialog.getByRole("alert").filter({ hasText: "chat name changed" }).waitFor();
      expect(await input.inputValue()).toBe("Stale saved name");
      expect((await pal.chats.get(id))?.title).toBe("Updated elsewhere");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Rename chat Updated elsewhere", exact: true }).click();
      expect(await input.inputValue()).toBe("Updated elsewhere");
      await input.fill("Final name");
      await dialog.getByRole("button", { name: "Save name" }).click();
      await dialog.waitFor({ state: "detached" });
      await page.getByRole("heading", { name: "Final name", exact: true }).waitFor();
    } finally {
      await pal.chats.remove(id, context);
      await page.goto(chatUrl);
      await page.reload();
    }
  });

  it("deletes retained workspaces only after a separate confirmation and refuses a replaced folder", async () => {
    const project = await pal.projects.create("cleanup-browser-project", { name: "Cleanup fixture" });
    await writeFile(join(project.root, "notes.txt"), "retained until confirmed");
    await pal.projects.remove(project.id);
    await page.goto(`${base}/#/settings/general`);
    await page.reload();
    const cleanup = page.getByRole("region", { name: "Removed managed workspaces" });
    const trigger = cleanup.getByRole("button", { name: "Delete workspace Cleanup fixture", exact: true });
    const dialog = page.getByRole("alertdialog", { name: "Delete workspace “Cleanup fixture”?", exact: true });
    await trigger.click();
    expect(await dialog.getByRole("button", { name: "Cancel" }).evaluate((button) => button.matches(":focus"))).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await readFile(join(project.root, "notes.txt"), "utf8")).toBe("retained until confirmed");
    await trigger.click();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await dialog.getByText(project.root, { exact: true }).waitFor();
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await shoot(`delete-workspace-${width}`);
    }
    const saved = join(dataRoot, "saved-workspace");
    await rename(project.root, saved);
    try {
      await mkdir(project.root);
      await writeFile(join(project.root, "new.txt"), "not confirmed");
      await dialog.getByRole("button", { name: "Delete workspace", exact: true }).click();
      await dialog.getByRole("alert").filter({ hasText: "folder changed" }).waitFor();
      expect(await readFile(join(project.root, "new.txt"), "utf8")).toBe("not confirmed");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await rm(project.root, { recursive: true });
    } finally {
      await rename(saved, project.root);
    }
    await cleanup.getByRole("button", { name: "Refresh workspaces" }).click();
    await expect.poll(() => trigger.isEnabled()).toBe(true);
    await trigger.click();
    await dialog.getByRole("button", { name: "Delete workspace", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await cleanup.getByRole("status").filter({ hasText: "Workspace deleted" }).waitFor();
    expect(await stat(project.root).catch(() => undefined)).toBeUndefined();
    await trigger.waitFor({ state: "detached" });
    const refreshed = page.waitForResponse(
      (response) => response.url() === `${base}/api/removed-workspaces` && response.request().method() === "GET",
    );
    await page.reload();
    const response = await refreshed;
    expect(response.status()).toBe(200);
    expect(
      ((await response.json()) as { workspaces: { id: string }[] }).workspaces.some((item) => item.id === project.id),
    ).toBe(false);
    expect(await trigger.count()).toBe(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(chatUrl);
    await page.getByLabel("Message").waitFor();
  });

  it("clicks Send in a legacy chat created before ChatGPT sign-in", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-e2e-legacy-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const legacy = await openPal(
      { dataRoot: root, installRoot: "/nonexistent-install", endpoints: fixture.endpoints },
      context,
    );
    cleanups.push(() => legacy.close());
    const project = await legacy.projects.create("legacy-project", { name: "Legacy" });
    const chat = await legacy.chats.createChat("legacy-chat", { projectId: project.id }, context);
    const server = await startServer({ host: "127.0.0.1", port: 0, version: "e2e", webRoot, api: createApi(legacy) });
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const legacyPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    cleanups.push(() => legacyPage.close());
    await legacyPage
      .context()
      .addCookies([
        { name: "pal_session", value: await legacy.owner.setup(legacy.owner.setupToken, "correct horse battery"), url },
      ]);
    await legacyPage.goto(`${url}/#/chat/${chat.id}`);
    await legacyPage.getByLabel("Message").fill("hi");
    expect(await legacyPage.getByRole("button", { name: "Send" }).isDisabled()).toBe(true);
    await legacyPage.getByRole("button", { name: "Connect", exact: true }).click();
    await legacyPage.getByRole("button", { name: "Sign in with ChatGPT" }).click();
    const auth = await legacyPage.getByRole("link", { name: "Open ChatGPT sign-in" }).getAttribute("href");
    if (auth === null) throw new Error("no sign-in link");
    await browse(auth);
    await legacyPage.getByText("Signed in as").waitFor();
    await legacyPage.goto(`${url}/#/chat/${chat.id}`);
    await legacyPage.getByLabel("Message").fill("hi");
    // Signing in chose no model, so this chat still waits for an explicit one.
    expect(await legacyPage.getByRole("button", { name: "Send" }).isDisabled()).toBe(true);
    await legacyPage.getByRole("button", { name: /^Model and reasoning/ }).click();
    await legacyPage
      .getByRole("dialog", { name: "Model and reasoning" })
      .getByRole("button", { name: /^Choose model/ })
      .click();
    await legacyPage.getByRole("radio", { name: /gpt-5\.5/ }).click();
    await legacyPage.keyboard.press("Escape");
    await legacyPage.getByRole("button", { name: "Send" }).click({ timeout: 3000 });
    await legacyPage.getByText("Hello").waitFor();
    expect(
      (await (await legacy.harness.conversation(chat.conversationId, context))?.agent(context))?.model?.modelId,
    ).toBe("gpt-5.5");
  });

  it("enables OpenRouter with a hidden key, chats on its model and never falls back", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#/settings/models`);
    const card = page.getByRole("group", { name: "OpenRouter" });
    await card.getByText("Not set up").waitFor();
    await card.getByLabel("API key").fill("sk-fixture-good");
    await card.getByRole("button", { name: "Save key" }).click();
    await card.getByText("Ready · off").waitFor();
    expect(await card.getByLabel("Replace API key").inputValue()).toBe("");
    expect(await page.content()).not.toContain("sk-fixture-good");
    await card.getByRole("switch", { name: /Use OpenRouter in chats/ }).check();
    await card.getByText("Enabled", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Check key" }).click();
    await card.getByRole("status").filter({ hasText: "OpenRouter accepted this key." }).waitFor();
    await shoot("providers-1440");
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    await shoot("providers-390");
    await page.setViewportSize({ width: 1440, height: 900 });

    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    const chat = await pal.chats.createChat("e2e-provider-chat", { projectId: project.id }, context);
    await page.goto(`${base}/#/chat/${chat.id}`);
    await page.reload();
    await openModelList();
    const picker = page.getByRole("dialog", { name: "Choose model" });
    await picker.getByText("Pay per token from your OpenRouter credits.").waitFor();
    await picker.getByLabel("Search models").fill("deepseek-flash-latest");
    await shoot("provider-picker-1440");
    await picker
      .getByRole("radiogroup", { name: "OpenRouter models" })
      .getByRole("radio", { name: /deepseek-flash-latest/ })
      .click();
    await picker.waitFor({ state: "detached" });
    const chatgptRequests = () => fixture.apiRequests.filter((request) => request.path === "/v1/responses").length;
    const before = chatgptRequests();
    await page.getByLabel("Message").fill("hello from openrouter");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Hello from the provider fixture").waitFor();
    expect(provider.requests.at(-1)).toMatchObject({ path: "/api/v1/chat/completions" });
    expect(provider.requests.at(-1)?.headers.authorization).toBe("Bearer sk-fixture-good");
    expect(chatgptRequests()).toBe(before);
    await shoot("provider-chat-1440");

    await pal.providers.setEnabled("openrouter", false);
    await page.reload();
    await page.getByText("OpenRouter isn't enabled.").waitFor();
    await page.getByLabel("Message").fill("never sent elsewhere");
    expect(await page.getByRole("button", { name: "Send" }).isDisabled()).toBe(true);
    expect(chatgptRequests()).toBe(before);
    await pal.chats.remove(chat.id, context);
  });

  it("describes a keyless OpenAI-compatible endpoint and chats on one of its models", async () => {
    await page.goto(`${base}/#/settings/models`);
    const card = page.getByRole("group", { name: "OpenAI-compatible endpoint" });
    await card.getByText("Not set up").waitFor();
    await card.getByLabel("Name", { exact: true }).fill("Local models");
    await card.getByLabel("Base URL").fill(`${provider.origin}/compat/v1`);
    await card.getByLabel("Model IDs, one per line").fill("local-a\nlocal-b");
    await card.getByLabel("This endpoint needs no key").check();
    await card.getByRole("button", { name: "Save endpoint" }).click();
    await card.getByText("Ready · off").waitFor();
    expect(await card.getByLabel("API key").count()).toBe(0);
    await card.getByRole("switch").check();
    await card.getByText("Enabled", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Check endpoint" }).click();
    await card.getByRole("status").filter({ hasText: "Local models answered." }).waitFor();
    await shoot("compatible-endpoint-1440");

    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    const chat = await pal.chats.createChat("e2e-compatible-chat", { projectId: project.id }, context);
    await page.goto(`${base}/#/chat/${chat.id}`);
    await page.reload();
    await openModelList();
    await page
      .getByRole("radiogroup", { name: "Local models models" })
      .getByRole("radio", { name: /local-b/ })
      .click();
    await page.getByLabel("Message").fill("hello from the local endpoint");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Hello from the provider fixture").waitFor();
    expect(provider.requests.at(-1)?.path).toBe("/compat/v1/chat/completions");
    expect(provider.requests.at(-1)?.body.model).toBe("local-b");
    await pal.providers.setEnabled("compatible", false);
    await pal.chats.remove(chat.id, context);
  });

  it("sets up a fresh Pal on OpenRouter and other providers without ChatGPT, and never falls back", async () => {
    const chatgpt = await startOpenAIFixture();
    cleanups.push(chatgpt.close);
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-e2e-providers-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const open = () =>
      openPal(
        {
          dataRoot: root,
          installRoot: "/nonexistent-install",
          endpoints: chatgpt.endpoints,
          providerOrigin: provider.origin,
        },
        context,
      );
    const serve = async (instance: Pal) => {
      const server = await startServer({
        host: "127.0.0.1",
        port: 0,
        version: "e2e",
        webRoot,
        api: createApi(instance),
      });
      const stop = () => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      };
      cleanups.push(stop);
      return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stop };
    };
    let fresh = await open();
    cleanups.push(() => fresh.close());
    let served = await serve(fresh);
    const view = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    cleanups.push(() => view.close());
    const errors: string[] = [];
    view.on("pageerror", (error) => errors.push(error.message));
    const snap = async (name: string) => {
      if (shots !== undefined) await view.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" });
    };
    const key = "sk-fixture-good";
    const before = provider.requests.length;
    const heading = (name: string) => view.getByRole("heading", { name, exact: true });
    const choices = view.getByRole("radiogroup", { name: "Model provider" });
    const choice = (name: RegExp) => choices.getByRole("radio", { name });
    const status = (name: RegExp) => choice(name).evaluate((radio) => radio.closest("label")?.textContent ?? "");
    const next = view.getByRole("button", { name: "Continue" });
    const back = view.getByRole("button", { name: "Back" });
    const focused = (target: typeof next) => target.evaluate((element) => element === document.activeElement);

    await view.goto(`${served.origin}/#setup=${fresh.owner.setupToken}`);
    await view.getByLabel("Passphrase", { exact: true }).fill("correct horse battery");
    await view.getByLabel("Confirm passphrase").fill("correct horse battery");
    await view.getByRole("button", { name: "Create owner" }).click();
    await heading("Connect a model provider").waitFor();
    await view.getByText("Choose the provider you want to use with Pal.").waitFor();
    expect(await view.getByText(/Not a ChatGPT user/).count()).toBe(0);
    expect(await next.isDisabled()).toBe(true);
    const methods: [string, string, string][] = [
      ["ChatGPT", "Subscription sign-in", "Counts against your ChatGPT plan's usage limits."],
      ["OpenRouter", "API key", "Pay per token from your OpenRouter credits."],
      ["OpenCode Zen", "API key", "Pay as you go from your OpenCode balance."],
      ["OpenCode Go", "API key", "Counts against your OpenCode Go subscription limits"],
      ["OpenAI API", "API key", "Pay per token on your OpenAI API account, separate from your ChatGPT subscription."],
      ["Anthropic API", "API key", "Pay per token on your Anthropic API account, not a Claude subscription."],
      [
        "DeepSeek API",
        "API key",
        "Pay per token from your DeepSeek API platform balance, separate from the DeepSeek chat app.",
      ],
      ["OpenAI-compatible endpoint", "Custom endpoint", "Billed, if at all, by whoever runs this endpoint"],
    ];
    const radios = choices.getByRole("radio");
    expect(await radios.count()).toBe(methods.length);
    const squash = (value: string) => value.replaceAll(/\s+/g, "");
    for (const [index, [name, method, billing]] of methods.entries()) {
      const text = await radios.nth(index).evaluate((radio) => radio.closest("label")?.textContent ?? "");
      expect(squash(text)).toContain(squash(`${name}${method}${billing}`));
    }
    await snap("onboarding-providers-1440");

    // Each other key provider shows its own method, billing and key check; none needs a ChatGPT account.
    const alternatives: [RegExp, string, string | undefined][] = [
      [/^OpenAI API/, "OpenAI API", "OpenAI API accepted this key."],
      [/^Anthropic API/, "Anthropic API", "Anthropic API accepted this key."],
      [/^DeepSeek API/, "DeepSeek API", "DeepSeek API accepted this key. Balance: 4.20 USD."],
      [/^OpenCode Zen/, "OpenCode Zen", undefined],
      [/^OpenCode Go/, "OpenCode Go", undefined],
    ];
    for (const [radio, name, accepted] of alternatives) {
      await choice(radio).check();
      await next.click();
      await heading(`Connect ${name}`).waitFor();
      await view.getByText(`Paste an API key from ${name}.`).waitFor();
      const card = view.getByRole("group", { name });
      expect(await card.getByRole("link", { name: "Get a key" }).getAttribute("href")).toMatch(/^https:\/\//);
      expect(await card.getByRole("switch").count()).toBe(0);
      expect(await next.isDisabled()).toBe(true);
      await card.getByLabel("API key").fill(key);
      await card.getByRole("button", { name: "Save key" }).click();
      await card.getByText("Key saved, not checked.").waitFor();
      if (accepted === undefined) {
        await card.getByText(`${name} has no free key check, so your first message tests it.`).waitFor();
        expect(await card.getByRole("button", { name: "Check key" }).count()).toBe(0);
      } else {
        await card.getByRole("button", { name: "Check key" }).click();
        await card.getByRole("status").filter({ hasText: accepted }).waitFor();
      }
      expect(await next.isEnabled()).toBe(true);
      await back.click();
      await heading("Connect a model provider").waitFor();
      expect(await status(radio)).toContain("Ready · off");
    }

    // OpenRouter by keyboard; missing, malformed and rejected keys never pass.
    await radios.first().focus();
    await view.keyboard.press("ArrowDown");
    expect(await choice(/^OpenRouter/).isChecked()).toBe(true);
    await view.keyboard.press("Tab");
    expect(await focused(next)).toBe(true);
    await view.keyboard.press("Enter");
    await heading("Connect OpenRouter").waitFor();
    expect(await focused(heading("Connect OpenRouter"))).toBe(true);
    const card = view.getByRole("group", { name: "OpenRouter" });
    expect(await next.isDisabled()).toBe(true);
    expect(await card.getByRole("button", { name: "Save key" }).isDisabled()).toBe(true);
    await card.getByLabel("API key").fill("short");
    await card.getByRole("button", { name: "Save key" }).click();
    await card.getByRole("alert").filter({ hasText: "8–4096" }).waitFor();
    expect(await next.isDisabled()).toBe(true);
    await card.getByLabel("API key").fill("sk-or-fixture-revoked");
    await card.getByRole("button", { name: "Save key" }).click();
    await card.getByText("Key saved, not checked.").waitFor();
    await card.getByRole("button", { name: "Check key" }).click();
    await card.getByRole("status").filter({ hasText: "OpenRouter rejected this key." }).waitFor();
    await card.getByLabel("Replace API key").fill(key);
    await card.getByRole("button", { name: "Save key" }).click();
    await card.getByText("Key saved, not checked.").waitFor();
    await card.getByRole("button", { name: "Check key" }).click();
    await card.getByRole("status").filter({ hasText: "OpenRouter accepted this key." }).waitFor();
    await view.getByText("Continue turns on OpenRouter for chats.").waitFor();
    expect(await fresh.providers.usable("openrouter")).toBe(false);
    expect(await view.content()).not.toContain(key);
    expect(await view.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("sk-");
    expect(await (await view.request.get(`${served.origin}/api/providers`)).text()).not.toContain(key);
    await view.setViewportSize({ width: 390, height: 844 });
    expect(await view.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    await snap("onboarding-connect-390");
    await view.setViewportSize({ width: 1440, height: 900 });

    // An enabled key is not a model choice, and a reload resumes at the provider without guessing one.
    await next.click();
    await heading("Choose a model").waitFor();
    expect(await fresh.providers.usable("openrouter")).toBe(true);
    expect(await next.isDisabled()).toBe(true);
    await view.reload();
    await heading("Connect a model provider").waitFor();
    expect(await status(/^OpenRouter/)).toContain("Enabled");
    await choice(/^OpenRouter/).check();
    await next.click();
    await heading("Connect OpenRouter").waitFor();
    await next.click();
    await heading("Choose a model").waitFor();
    await view.getByLabel("Search models").fill("deepseek-flash-latest");
    const models = view.getByRole("radiogroup", { name: "Default model" });
    await models.getByRole("radio", { name: /deepseek-flash-latest/ }).check();
    await expect.poll(() => next.isEnabled()).toBe(true);
    expect(await fresh.settings.defaultModel()).toEqual({
      provider: "openrouter",
      modelId: "~deepseek/deepseek-flash-latest",
    });
    await back.click();
    await heading("Connect OpenRouter").waitFor();
    await next.click();
    await heading("Choose a model").waitFor();
    await view.getByLabel("Search models").fill("deepseek-flash-latest");
    expect(await models.getByRole("radio", { name: /deepseek-flash-latest/ }).isChecked()).toBe(true);
    await view.setViewportSize({ width: 390, height: 844 });
    expect(await view.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    await snap("onboarding-model-390");
    await view.setViewportSize({ width: 1440, height: 900 });
    await next.click();
    await view.getByText("Enable internet tools?").waitFor();
    await view.getByRole("button", { name: "Not now" }).click();
    await heading("Create your first project").waitFor();
    // Setup only made key checks: no model request.
    expect(new Set(provider.requests.slice(before).map((request) => request.path))).toEqual(
      new Set(["/v1/models", "/user/balance", "/api/v1/key"]),
    );

    // The choice survives a restart, and the first message goes to OpenRouter.
    await served.stop();
    await fresh.close();
    fresh = await open();
    served = await serve(fresh);
    await view.goto(served.origin);
    await heading("Create your first project").waitFor();
    await view.getByRole("button", { name: "Create project" }).click();
    await view.getByLabel("Project name").fill("Provider first");
    await view.getByRole("dialog", { name: "Create project" }).getByRole("button", { name: "Create project" }).click();
    await view.getByRole("heading", { name: "Start the conversation" }).waitFor();
    await view.getByLabel("Message").fill("hello from setup");
    await view.getByRole("button", { name: "Send" }).click();
    await view.getByText("Hello from the provider fixture").waitFor();
    expect(provider.requests.at(-1)).toMatchObject({ path: "/api/v1/chat/completions" });
    expect(provider.requests.at(-1)?.headers.authorization).toBe(`Bearer ${key}`);

    // Disabling the chosen provider stops sending instead of substituting another, and setup asks for a repair.
    await fresh.providers.setEnabled("openrouter", false);
    await view.reload();
    await view.getByText("OpenRouter isn't enabled.").waitFor();
    await view.getByLabel("Message").fill("never sent elsewhere");
    expect(await view.getByRole("button", { name: "Send" }).isDisabled()).toBe(true);
    for (const project of await fresh.projects.list()) await fresh.projects.remove(project.id);
    await view.goto(`${served.origin}/#/`);
    await view.reload();
    await heading("Connect a model provider").waitFor();
    expect(await choice(/^OpenRouter/).isChecked()).toBe(true);
    expect(await status(/^OpenRouter/)).toContain("Ready · off");

    // A keyless compatible endpoint is a first-class alternative too.
    await choice(/^OpenAI-compatible endpoint/).check();
    await next.click();
    await heading("Connect OpenAI-compatible endpoint").waitFor();
    const endpoint = view.getByRole("group", { name: "OpenAI-compatible endpoint" });
    await endpoint.getByLabel("Name", { exact: true }).fill("Local models");
    await endpoint.getByLabel("Base URL").fill(`${provider.origin}/compat/v1`);
    await endpoint.getByLabel("Model IDs, one per line").fill("local-a\nlocal-b");
    await endpoint.getByLabel("This endpoint needs no key").check();
    expect(await next.isDisabled()).toBe(true);
    await endpoint.getByRole("button", { name: "Save endpoint" }).click();
    await endpoint.getByText("Endpoint saved, not checked.").waitFor();
    await endpoint.getByRole("button", { name: "Check endpoint" }).click();
    await endpoint.getByRole("status").filter({ hasText: "Local models answered." }).waitFor();
    await next.click();
    await heading("Choose a model").waitFor();
    await view.getByText("New chats start with the model you choose from Local models.").waitFor();
    await models.getByRole("radio", { name: /local-b/ }).check();
    await expect.poll(() => next.isEnabled()).toBe(true);
    await next.click();
    await heading("Create your first project").waitFor();

    // A model the endpoint stops offering is not ready either; choosing another repairs it.
    const config = (await fresh.providers.list()).find((entry) => entry.id === "compatible")?.config;
    if (config == null) throw new Error("missing endpoint");
    await fresh.providers.setCompatible({ ...config, models: ["local-a"] });
    await view.reload();
    await heading("Connect a model provider").waitFor();
    expect(await choice(/^OpenAI-compatible endpoint/).isChecked()).toBe(true);
    await next.click();
    await heading("Connect OpenAI-compatible endpoint").waitFor();
    await next.click();
    await heading("Choose a model").waitFor();
    await view.getByText("isn't available from Local models anymore.").waitFor();
    expect(await next.isDisabled()).toBe(true);
    await models.getByRole("radio", { name: /local-a/ }).check();
    await expect.poll(() => next.isEnabled()).toBe(true);
    await next.click();
    await heading("Create your first project").waitFor();
    expect(await fresh.settings.defaultModel()).toEqual({ provider: "compatible", modelId: "local-a" });

    expect([chatgpt.authorizations, chatgpt.tokenRequests, chatgpt.apiRequests]).toEqual([[], [], []]);
    expect(errors).toEqual([]);
  });

  it("selects versioned built-ins for new chats without changing active chat contributions", async () => {
    const before = await pal.extensions.view();
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    let chatId: string | undefined;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${base}/#/settings/extensions`);
      await page.getByRole("heading", { name: "Extensions", exact: true }).waitFor();
      const shell = page.getByRole("switch", { name: "Enable Host commands and Terminal for new chats" });
      const remoteBrowser = page.getByRole("switch", { name: "Enable Project browser for new chats" });
      await shell.focus();
      await page.keyboard.press("Space");
      await expect.poll(() => shell.isChecked(), { timeout: 5000 }).toBe(false);
      await remoteBrowser.uncheck();
      await expect.poll(() => remoteBrowser.isChecked(), { timeout: 5000 }).toBe(false);
      await page.reload();
      await shell.waitFor();
      expect(await shell.isChecked()).toBe(false);
      expect(await remoteBrowser.isChecked()).toBe(false);
      await shoot("extensions-1440");
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await shoot("extensions-390");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(chatUrl);
      await page.getByRole("button", { name: "Browser", exact: true }).waitFor();
      await page.getByRole("button", { name: "Terminal", exact: true }).waitFor();
      const chat = await pal.chats.createChat("e2e-extension-chat", { projectId: project.id }, context);
      chatId = chat.id;
      await page.goto(`${base}/#/chat/${chat.id}`);
      await page.reload();
      await page.getByRole("button", { name: "Context", exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Terminal", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Browser", exact: true }).count()).toBe(0);
      const agent = await (await pal.harness.conversation(chat.conversationId, context))?.agent(context);
      expect(agent?.callable.map((tool) => tool.name)).not.toContain("shell_run");
      await page.getByLabel("Message").fill("pin this fixture request");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByText("Hello", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Context", exact: true }).click();
      const pins = page.getByRole("region", { name: "Extension pins", exact: true });
      await pins.getByText("files@1", { exact: true }).waitFor();
      expect(await pins.getByText("shell@1", { exact: true }).count()).toBe(0);
      await pins.getByText("Recent native request pins", { exact: true }).click();
      await pins.getByText(new RegExp(`Task \\d+ · ${before.release}`)).waitFor();
      await shoot("extension-pins-1440");
    } finally {
      const current = await pal.extensions.view();
      await pal.extensions.select({ selected: before.selected, digest: current.digest });
      if (chatId !== undefined) await pal.chats.remove(chatId, context);
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  it("reviews inert exact source, requires code-trust consent and confirms activation across desktop and phone", async () => {
    releases.enable();
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${base}/#/settings/extensions`);
      await page.reload();
      const control = page.getByRole("region", { name: "Controlled releases", exact: true });
      await control.getByRole("button", { name: `Review candidate ${releases.digest.slice(0, 12)}` }).click();
      await control.getByRole("heading", { name: "Exact tested source" }).waitFor();
      const approve = control.getByRole("button", { name: "Approve exact digest", exact: true });
      expect(await approve.isDisabled()).toBe(true);
      await control.locator("summary").filter({ hasText: "web/src/app.css" }).click();
      await control.locator("pre").filter({ hasText: '<img src=x onerror="window.releaseInjected=true">' }).waitFor();
      expect(await page.evaluate("window.releaseInjected === undefined")).toBe(true);
      expect(releases.calls.filter((call) => call.op === "approve")).toHaveLength(0);
      const trust = control.getByRole("checkbox", { name: /I reviewed all changes/ });
      await trust.focus();
      await page.keyboard.press("Space");
      await approve.click();
      await control.getByText(/Approval recorded for this digest/).waitFor();
      expect(releases.calls.find((call) => call.op === "approve")?.args).toEqual({
        digest: releases.digest,
        acceptCodeTrust: true,
      });
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await control.getByRole("heading", { name: "Exact tested source" }).scrollIntoViewIfNeeded();
        expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
        await shoot(`release-source-${width}`);
      }
      await control.getByRole("button", { name: "Activate approved release…", exact: true }).click();
      const dialog = page.getByRole("alertdialog", { name: "Activate this approved release?" });
      expect(
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      expect(releases.calls.filter((call) => call.op === "activate")).toHaveLength(0);
      await control.getByRole("button", { name: "Activate approved release…", exact: true }).click();
      await dialog.getByRole("button", { name: "Activate release", exact: true }).click();
      await control.getByText(/Pal is restarting/).waitFor();
      expect(releases.calls.filter((call) => call.op === "activate")).toEqual([
        { op: "activate", args: { digest: releases.digest } },
      ]);
    } finally {
      releases.disable();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
    }
  });

  it("shows invalidated approval without activating and confirms only the retained previous digest for rollback", async () => {
    releases.enable();
    try {
      await page.goto(`${base}/#/settings/extensions`);
      await page.reload();
      const control = page.getByRole("region", { name: "Controlled releases", exact: true });
      await control.getByRole("button", { name: `Review candidate ${releases.digest.slice(0, 12)}` }).click();
      await control.getByRole("checkbox", { name: /I reviewed all changes/ }).check();
      await control.getByRole("button", { name: "Approve exact digest", exact: true }).click();
      await control.getByText(/Approval recorded for this digest/).waitFor();
      releases.rejectActivation();
      await control.getByRole("button", { name: "Activate approved release…", exact: true }).click();
      const activate = page.getByRole("alertdialog", { name: "Activate this approved release?" });
      await activate.getByRole("button", { name: "Activate release", exact: true }).click();
      await activate.getByRole("alert").getByText("Candidate changed; its approval is invalid.").waitFor();
      await shoot("release-stale-1440");
      await activate.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await control.getByRole("button", { name: "Activate approved release…", exact: true }).isDisabled()).toBe(
        true,
      );
      await control.getByRole("button", { name: "Roll back previous release…", exact: true }).click();
      const rollback = page.getByRole("alertdialog", { name: "Roll back to the retained release?" });
      await rollback.getByText(releases.previous, { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await rollback.waitFor({ state: "detached" });
      expect(releases.calls.filter((call) => call.op === "rollback")).toHaveLength(0);
      await control.getByRole("button", { name: "Roll back previous release…", exact: true }).click();
      await rollback.getByRole("button", { name: "Roll back release", exact: true }).click();
      await control.getByText(/Pal is restarting/).waitFor();
      expect(releases.calls.filter((call) => call.op === "rollback")).toEqual([
        { op: "rollback", args: { digest: releases.previous } },
      ]);
    } finally {
      releases.disable();
      await page.reload();
    }
  });

  it("opens the project's own browser, drives a page by pointer and fits a phone", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    const chat = await pal.chats.createChat("e2e-browser-chat", { projectId: project.id }, context);
    await page.goto(`${base}/#/chat/${chat.id}`);
    await page.reload();
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace panel" });
    await panel.getByRole("button", { name: "Open browser" }).click();
    await panel.getByText("You control this browser").waitFor();
    await panel.getByLabel("Address").fill(`http://127.0.0.1:${site}/`);
    await panel.getByRole("button", { name: "Go", exact: true }).click();
    await expect.poll(() => visited.includes("/")).toBe(true);
    const view = panel.getByRole("img", { name: /^Page:/ });
    await view.waitFor();
    await expect
      .poll(() => view.evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth > 0))
      .toBe(true);
    const box = await view.boundingBox();
    if (box === null) throw new Error("no page view");
    // The frame is the 1280×800 page scaled to the panel; the page's button covers its top-left 200×100.
    await page.mouse.click(box.x + (box.width * 50) / 1280, box.y + (box.height * 40) / 800);
    await expect.poll(() => visited.includes("/clicked")).toBe(true);
    await panel.getByRole("tab", { name: "Fixture /clicked" }).waitFor();
    await expect
      .poll(() => view.evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth > 0))
      .toBe(true);
    await panel.getByRole("button", { name: "Private login", exact: true }).click();
    await panel.getByText("Private login · only you").waitFor();
    expect(pal.browsers.allows(chat.conversationId)).toBe(false);
    await panel.getByRole("button", { name: "Hand to Pal…", exact: true }).click();
    const handoff = page.getByRole("alertdialog", { name: "Hand browser to Pal?" });
    await handoff.getByText(/Every browser action still asks/).waitFor();
    await page.keyboard.press("Escape");
    await handoff.waitFor({ state: "detached" });
    expect(pal.browsers.allows(chat.conversationId)).toBe(false);
    await panel.getByRole("button", { name: "Hand to Pal…", exact: true }).click();
    await handoff.getByRole("button", { name: "Hand to Pal", exact: true }).click();
    await panel.getByText("Pal controls this browser").waitFor();
    expect(pal.browsers.allows(chat.conversationId)).toBe(true);
    await shoot("browser-agent-1440");
    const beforeAction = visited.filter((path) => path === "/clicked").length;
    fixture.behavior.responses = "script";
    fixture.behavior.script =
      'const page = await tools.browser_observe({}); return await tools.browser_act({session:page.session,epoch:page.epoch,observation:page.observation,action:{type:"click",target:page.targets.find(t => t.label === "go").id}});';
    try {
      await page.getByLabel("Message").fill("request the fixture browser action");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const approval = page.getByRole("group", { name: "Approval request" });
      await approval.getByText("Approval needed for a browser action", { exact: true }).waitFor();
      await approval.getByText(/Browser page/).waitFor();
      expect(visited.filter((path) => path === "/clicked")).toHaveLength(beforeAction);
      await shoot("browser-approval-1440");
      await approval.getByRole("button", { name: "Approve once", exact: true }).click();
      await page.getByText("Hello", { exact: true }).waitFor();
      await expect.poll(() => visited.filter((path) => path === "/clicked").length).toBe(beforeAction + 1);
      await approval.getByText("Browser action approved", { exact: true }).waitFor();
    } finally {
      fixture.behavior.responses = "ok";
    }
    await panel.getByRole("button", { name: "Take control", exact: true }).click();
    await panel.getByText("You control this browser").waitFor();
    expect(pal.browsers.allows(chat.conversationId)).toBe(false);
    await panel.getByRole("button", { name: "Pause", exact: true }).click();
    await panel.getByText("Paused", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Take control", exact: true }).click();
    await panel.getByText("You control this browser").waitFor();
    await shoot("browser-1440");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    await panel.getByLabel("Page size").selectOption("Phone");
    await expect
      .poll(() => view.evaluate((image) => (image instanceof HTMLImageElement ? image.naturalWidth : 0)))
      .toBe(390);
    await view.scrollIntoViewIfNeeded();
    const phoneBox = await view.boundingBox();
    const windowBox = await view.locator("..").boundingBox();
    if (phoneBox === null || windowBox === null) throw new Error("no phone page view");
    expect(phoneBox.height).toBeLessThanOrEqual(windowBox.height);
    // Letterboxing is not part of the remote page; clicking it must not be clamped onto a page button.
    expect(phoneBox.x - windowBox.x).toBeGreaterThan(10);
    const clicks = visited.filter((path) => path === "/clicked").length;
    await page.mouse.click(windowBox.x + 5, phoneBox.y + (phoneBox.height * 40) / 844);
    await page.mouse.click(phoneBox.x + (phoneBox.width * 20) / 390, phoneBox.y + (phoneBox.height * 160) / 844);
    await panel.getByRole("textbox", { name: "Type into the page" }).fill("phone");
    await panel.getByRole("button", { name: "Type", exact: true }).click();
    await panel.getByRole("button", { name: "Enter", exact: true }).click();
    await expect.poll(() => visited.includes("/submit?q=phone")).toBe(true);
    expect(visited.filter((path) => path === "/clicked")).toHaveLength(clicks);
    await shoot("browser-390");
    await panel.getByRole("button", { name: "Hand to Pal…", exact: true }).click();
    await handoff.getByRole("button", { name: "Hand to Pal", exact: true }).click();
    await panel.getByText("Pal controls this browser").waitFor();
    await shoot("browser-agent-390");
    expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    await panel.getByRole("button", { name: "Take control", exact: true }).click();
    await panel.getByText("You control this browser").waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    await panel.getByRole("button", { name: "Close browser" }).click();
    await panel.getByRole("button", { name: "Open browser" }).waitFor();
    expect((await pal.browsers.status(project.id)).running).toBe(false);
    await panel.getByRole("button", { name: "Open browser" }).click();
    await panel.getByText("You control this browser").waitFor();
    await panel.getByRole("button", { name: "Clear browser data…" }).click();
    const confirmation = page.getByRole("alertdialog", { name: "Clear browser data?" });
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await pal.browsers.status(project.id)).running).toBe(true);
    await panel.getByRole("button", { name: "Clear browser data…" }).click();
    await confirmation.getByRole("button", { name: "Clear browser data", exact: true }).click();
    await panel.getByRole("button", { name: "Open browser" }).waitFor();
    expect((await pal.browsers.status(project.id)).running).toBe(false);
    await pal.chats.remove(chat.id, context);
  });

  it("lays out for tablet and phone", async () => {
    // From the main chat with no panel: a phone shows an open panel full screen, over the header.
    await page.goto(chatUrl);
    await page.setViewportSize({ width: 768, height: 1024 });
    await shoot("chat-768");
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot("chat-390");
    await page.getByRole("button", { name: "Projects and chats" }).click();
    await page.getByRole("navigation", { name: "Projects" }).getByText("Notes").waitFor();
    await shoot("drawer-390");
  });

  it("confirms chat deletion and project removal, including cancel and Escape", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "New chat in Notes", exact: true }).click();
    await page.getByRole("heading", { name: "Start the conversation" }).waitFor();
    const removedChat = page.url();
    await page.getByRole("button", { name: "Delete chat New chat", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    expect(await dialog.getByRole("button", { name: "Cancel" }).evaluate((button) => button.matches(":focus"))).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("heading", { name: "Start the conversation" }).waitFor();
    await page.getByRole("button", { name: "Delete chat New chat", exact: true }).click();
    await dialog.getByRole("button", { name: "Delete chat", exact: true }).click();
    await page.getByRole("heading", { name: "Pick a chat" }).waitFor();
    expect((await page.request.get(`${base}/api/chats/${removedChat.split("/").at(-1)}`)).status()).toBe(404);
    await page.getByRole("button", { name: "Remove project Notes", exact: true }).click();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Remove project Notes", exact: true }).click();
    await shoot("remove-project-1440");
    await dialog.getByRole("button", { name: "Remove project", exact: true }).click();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    expect(await pal.projects.list()).toEqual([]);
    await page
      .getByRole("region", { name: "Removed managed workspaces" })
      .getByRole("button", { name: "Delete workspace Notes", exact: true })
      .waitFor();
  });
});
