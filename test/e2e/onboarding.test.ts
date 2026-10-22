import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../src/core/api.ts";
import { openPal } from "../../src/core/app.ts";
import { startServer } from "../../src/core/server.ts";
import { browse, startOpenAIFixture } from "../fixtures/openai-server.ts";
import { GOOD_KEY, startProviderFixture } from "../fixtures/provider-server.ts";

let browser: Browser;
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
});
afterAll(async () => browser.close());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(width: number) {
  const chatgpt = await startOpenAIFixture();
  cleanups.push(chatgpt.close);
  const provider = await startProviderFixture();
  cleanups.push(provider.close);
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-onboarding-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const options = {
    dataRoot: join(root, "data"),
    installRoot: "/nonexistent-install",
    endpoints: chatgpt.endpoints,
    providerOrigin: provider.origin,
    guidanceHome: join(root, "host-home"),
  };
  let pal = await openPal(options, context);
  cleanups.push(() => pal.close());
  const serve = (port: number) =>
    startServer({
      host: "127.0.0.1",
      port,
      version: "test",
      webRoot: join(import.meta.dirname, "../../dist/public"),
      api: createApi(pal),
    });
  let server = await serve(0);
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(stop);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  cleanups.push(() => page.close());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/#setup=${pal.owner.setupToken}`);
  await page.getByLabel("Passphrase", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm passphrase").fill("correct horse battery");
  await page.getByRole("button", { name: "Create owner" }).click();
  await page.getByRole("heading", { name: "Connect a model provider" }).waitFor();
  const restart = async () => {
    const port = (server.address() as AddressInfo).port;
    await stop();
    await pal.close();
    pal = await openPal(options, context);
    server = await serve(port);
    await page.reload();
    return pal;
  };
  return { pal, page, base, provider, chatgpt, errors, restart };
}

async function chooseProvider(page: Page, name: RegExp) {
  await page.getByRole("radiogroup", { name: "Model provider" }).getByRole("radio", { name }).check();
  await page.getByRole("button", { name: "Continue" }).click();
}
async function optionalTools(page: Page) {
  await page.getByText("Enable internet tools?").waitFor();
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByRole("heading", { name: "Create your first project" }).waitFor();
}
async function createProject(page: Page) {
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create project" });
  await dialog.getByLabel("Project name").fill("Onboarding fixture");
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("heading", { name: "Start the conversation" }).waitFor();
}
async function send(page: Page, reply: string) {
  await page.getByLabel("Message", { exact: true }).fill("Hello from isolated onboarding");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText(reply, { exact: true }).waitFor();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

describe("isolated provider onboarding", () => {
  it.each([1440, 390])("persists skip, resumes explicitly and keeps Send disabled at %i px", async (width) => {
    const { page, pal, provider, chatgpt, errors, restart, base } = await setup(width);
    await page.getByRole("button", { name: "Set up later" }).click();
    await optionalTools(page);
    await page.getByRole("status").filter({ hasText: "Send stays disabled" }).waitFor();
    await noOverflow(page);
    await page.reload();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    const reopened = await restart();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    expect(await reopened.settings.modelSetupDeferred()).toBe(true);
    expect(await reopened.settings.defaultModel()).toBeUndefined();
    await page.getByRole("button", { name: "Set up a model", exact: true }).click();
    await page.getByRole("heading", { name: "Connect a model provider" }).waitFor();
    expect(await reopened.settings.modelSetupDeferred()).toBe(false);
    expect(await page.getByRole("radio", { checked: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Set up later" }).click();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    await createProject(page);
    await page.getByText("No model is chosen.").waitFor();
    await page.getByLabel("Message", { exact: true }).fill("Must stay on this device");
    expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
    expect([chatgpt.authorizations, chatgpt.tokenRequests, chatgpt.apiRequests, provider.requests]).toEqual([
      [],
      [],
      [],
      [],
    ]);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Models", exact: true }).waitFor();
    const card = page.getByRole("group", { name: "OpenRouter", exact: true });
    await card.getByLabel("API key", { exact: true }).fill(GOOD_KEY);
    await card.getByRole("button", { name: "Save key" }).click();
    await card.getByText("Ready · off").waitFor();
    await card.getByRole("switch").check();
    await card.getByText("Enabled", { exact: true }).waitFor();
    expect(await reopened.settings.defaultModel()).toBeUndefined();
    const project = (await reopened.projects.list())[0];
    if (project === undefined) throw new Error("missing created project");
    const chat = (await reopened.chats.list(project.id))[0];
    if (chat === undefined) throw new Error("missing created chat");
    await page.goto(`${base}/#/chat/${chat.id}`);
    await page.reload();
    if (width < 700) await page.getByRole("button", { name: "Workspace tools" }).click();
    await page.getByRole("button", { name: /^Model and reasoning:/ }).click();
    await page.getByRole("button", { name: /^Choose model \(/ }).click();
    await page.getByLabel("Search models").fill("deepseek-flash-latest");
    await page.getByRole("radiogroup", { name: "OpenRouter models" }).getByRole("radio").click();
    if (width < 700) await page.keyboard.press("Escape");
    await send(page, "Hello from the provider fixture");
    expect(provider.requests.at(-1)?.path).toBe("/api/v1/chat/completions");
    expect([chatgpt.authorizations, chatgpt.tokenRequests, chatgpt.apiRequests]).toEqual([[], [], []]);
    expect(await reopened.settings.defaultModel()).toBeUndefined();
    expect(errors).toEqual([]);
    expect(pal.status).toBe("closed");
  });

  it.each([
    { width: 1440, kind: "chatgpt" },
    { width: 390, kind: "chatgpt" },
    { width: 1440, kind: "key" },
    { width: 390, kind: "key" },
    { width: 1440, kind: "keyless" },
    { width: 390, kind: "keyless" },
  ])("requires an explicit $kind default and preserves it across restart at $width px", async ({ width, kind }) => {
    const { page, pal, provider, chatgpt, errors, restart } = await setup(width);
    const next = page.getByRole("button", { name: "Continue" });
    expect(await next.isDisabled()).toBe(true);
    expect(await page.getByRole("radio", { checked: true }).count()).toBe(0);
    if (kind === "chatgpt") {
      await chooseProvider(page, /^ChatGPT/);
      await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
      const url = await page.getByRole("link", { name: "Open ChatGPT sign-in" }).getAttribute("href");
      if (url === null) throw new Error("missing fixture authorization");
      await browse(url);
      await page.getByText("Signed in as").waitFor();
    } else if (kind === "key") {
      await chooseProvider(page, /^OpenRouter/);
      const card = page.getByRole("group", { name: "OpenRouter", exact: true });
      await card.getByLabel("API key", { exact: true }).fill(GOOD_KEY);
      await card.getByRole("button", { name: "Save key" }).click();
      await card.getByText("Ready · off").waitFor();
      await page.reload();
      await chooseProvider(page, /^OpenRouter/);
      await card.getByLabel("Replace API key").waitFor();
      expect(await card.getByLabel("Replace API key").inputValue()).toBe("");
      expect(await page.content()).not.toContain(GOOD_KEY);
    } else {
      await chooseProvider(page, /^OpenAI-compatible endpoint/);
      const card = page.getByRole("group", { name: "OpenAI-compatible endpoint", exact: true });
      await card.getByLabel("Name", { exact: true }).fill("Local fixture");
      await card.getByLabel("Base URL").fill(`${provider.origin}/compat/v1`);
      await card.getByLabel("Model IDs, one per line").fill("local-a");
      await card.getByLabel("This endpoint needs no key").check();
      await card.getByRole("button", { name: "Save endpoint" }).click();
      await card.getByText("Ready · off").waitFor();
    }
    expect(await pal.settings.defaultModel()).toBeUndefined();
    await next.click();
    await page.getByRole("heading", { name: "Choose a model" }).waitFor();
    await page.getByText("Chat history is not sent until you send a message.", { exact: false }).waitFor();
    expect(await next.isDisabled()).toBe(true);
    expect(await pal.settings.defaultModel()).toBeUndefined();
    if (kind === "keyless") await page.getByText(`${provider.origin}/compat/v1`, { exact: false }).waitFor();
    const models = page.getByRole("radiogroup", { name: "Default model" });
    if (kind === "key") await page.getByLabel("Search models").fill("deepseek-flash-latest");
    await models
      .getByRole("radio", {
        name: kind === "chatgpt" ? /gpt-5\.5/ : kind === "key" ? /deepseek-flash-latest/ : /local-a/,
      })
      .check();
    await expect.poll(() => next.isEnabled()).toBe(true);
    const expected = {
      provider: kind === "chatgpt" ? "openai" : kind === "key" ? "openrouter" : "compatible",
      modelId: kind === "chatgpt" ? "gpt-5.5" : kind === "key" ? "~deepseek/deepseek-flash-latest" : "local-a",
    };
    expect(await pal.settings.defaultModel()).toEqual(expected);
    await noOverflow(page);
    await next.click();
    await optionalTools(page);
    const reopened = await restart();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    expect(await reopened.settings.defaultModel()).toEqual(expected);
    expect(await reopened.settings.modelSetupDeferred()).toBe(false);
    await createProject(page);
    expect(provider.requests).toEqual([]);
    expect(chatgpt.apiRequests.filter((request) => request.path === "/v1/responses")).toEqual([]);
    await send(page, kind === "chatgpt" ? "Hello" : "Hello from the provider fixture");
    if (kind === "chatgpt") {
      expect(provider.requests).toEqual([]);
      expect(chatgpt.apiRequests.at(-1)?.path).toBe("/v1/responses");
    } else {
      expect([chatgpt.authorizations, chatgpt.tokenRequests, chatgpt.apiRequests]).toEqual([[], [], []]);
      expect(provider.requests.at(-1)?.path).toBe(
        kind === "key" ? "/api/v1/chat/completions" : "/compat/v1/chat/completions",
      );
      expect(provider.requests.at(-1)?.headers.authorization).toBe(
        kind === "key" ? `Bearer ${GOOD_KEY}` : "Bearer no-key",
      );
    }
    expect(errors).toEqual([]);
  });

  it("keeps a failed deferral on the provider step and lets the owner retry", async () => {
    const { page, pal, chatgpt, provider, errors } = await setup(390);
    await page.route("**/api/model-setup", async (route) => {
      if (route.request().method() === "PUT")
        await route.fulfill({ status: 503, json: { error: "unavailable", message: "Fixture save failed" } });
      else await route.continue();
    });
    await page.getByRole("button", { name: "Set up later" }).click();
    await page.getByRole("alert").filter({ hasText: "Fixture save failed" }).waitFor();
    await page.getByRole("heading", { name: "Connect a model provider" }).waitFor();
    expect(await pal.settings.modelSetupDeferred()).toBe(false);
    await page.unroute("**/api/model-setup");
    await page.getByRole("button", { name: "Set up later" }).click();
    await optionalTools(page);
    expect(await pal.settings.defaultModel()).toBeUndefined();
    expect([chatgpt.authorizations, chatgpt.tokenRequests, chatgpt.apiRequests, provider.requests]).toEqual([
      [],
      [],
      [],
      [],
    ]);
    expect(errors).toEqual([]);
  });
});
