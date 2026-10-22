import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Browser, chromium, type Page, type WebSocketRoute } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../src/core/api.ts";
import { openPal } from "../../src/core/app.ts";
import type { CompiledCapability } from "../../src/capabilities/contract.ts";
import { exampleCapability } from "../../src/capabilities/example.ts";
import { startServer } from "../../src/core/server.ts";
import { runGit } from "../../src/core/git.ts";
import { GOOD_KEY, startProviderFixture } from "../fixtures/provider-server.ts";
import { startMcpFixture } from "../fixtures/mcp-server.ts";

let browser: Browser;
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
});
afterAll(async () => browser.close());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(width: number, definitions?: readonly CompiledCapability[]) {
  const provider = await startProviderFixture();
  cleanups.push(provider.close);
  const root = await mkdtemp(join(tmpdir(), "pal-chat-settings-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const options = {
    dataRoot: join(root, "data"),
    installRoot: "/nonexistent",
    providerOrigin: provider.origin,
    guidanceHome: join(root, "host-home"),
  };
  let pal = await openPal(options, context, definitions);
  cleanups.push(() => pal.close());
  const token = await pal.owner.setup(pal.owner.setupToken, "correct horse battery");
  const serve = (port: number) =>
    startServer({
      host: "127.0.0.1",
      port,
      version: "test",
      webRoot: join(import.meta.dirname, "../../dist/public"),
      api: createApi(pal),
    });
  let server = await serve(0);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = async (path: string, body: object) => {
    const response = await fetch(`${base}/api/${path}`, {
      method: "PUT",
      headers: { origin: base, cookie: `pal_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
  };
  for (const id of ["openrouter", "anthropic"]) {
    await put(`providers/${id}/key`, { key: GOOD_KEY });
    await put(`providers/${id}/enabled`, { enabled: true });
  }
  await put("default-model", { provider: "openrouter", model: "~deepseek/deepseek-flash-latest" });
  const project = await pal.projects.create("settings-project", { name: "Settings" });
  const saved = await pal.chats.createChat(
    "saved-chat",
    { projectId: project.id, title: "Saved destination" },
    context,
  );
  const other = await pal.chats.createChat(
    "other-chat",
    { projectId: project.id, title: "Other destination" },
    context,
  );
  await put(`chats/${saved.id}/model`, { provider: "anthropic", model: "claude-haiku-4-5" });
  for (const chat of [saved, other]) expect(await pal.workspaces.info(chat.id)).toMatchObject({ state: "ready" });
  const view = await browser.newContext({ viewport: { width, height: 900 } });
  cleanups.push(() => view.close());
  await view.addCookies([{ name: "pal_session", value: token, url: base, httpOnly: true, sameSite: "Strict" }]);
  const page = await view.newPage();
  const errors: string[] = [];
  const mutations: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/chats/"))
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const restart = async () => {
    const port = (server.address() as AddressInfo).port;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pal.close();
    pal = await openPal(options, context, definitions);
    server = await serve(port);
    return pal;
  };
  return { pal, page, base, project, saved, other, provider, errors, mutations, restart };
}

async function holdMetadata(page: Page, id: string) {
  const seen = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const done = Promise.withResolvers<undefined>();
  let started = false;
  await page.route(`**/api/chats/${id}`, async (route) => {
    started = true;
    try {
      const response = await route.fetch({ timeout: 5000 });
      seen.resolve(undefined);
      await release.promise;
      await route.fulfill({ response });
    } finally {
      done.resolve(undefined);
    }
  });
  cleanups.push(async () => {
    release.resolve(undefined);
    if (started) await done.promise;
  });
  return { seen: seen.promise, release: () => release.resolve(undefined), done: done.promise };
}
async function modelControl(page: Page, width: number) {
  if (width < 700) await page.getByRole("button", { name: "Workspace tools" }).click();
  return page.getByRole("button", { name: /^Model and reasoning:/ });
}
async function dismissTools(page: Page, width: number) {
  if (width < 700) await page.keyboard.press("Escape");
}
async function screenshot(page: Page, name: string) {
  const bounds = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  expect(bounds.content).toBeLessThanOrEqual(bounds.viewport);
  const root = process.env.PAL_E2E_SCREENSHOTS;
  if (root === undefined) return;
  await mkdir(root, { recursive: true });
  await page.screenshot({ path: join(root, `${name}.png`), animations: "disabled" });
}

describe("saved chat settings", () => {
  it.each([1440, 390])("waits for the saved provider before any model change or input at %s px", async (width) => {
    const { page, base, saved, provider, errors, mutations } = await setup(width);
    const held = await holdMetadata(page, saved.id);
    await page.goto(`${base}/#/chat/${saved.id}`);
    await held.seen;
    await page.getByLabel("Message", { exact: true }).fill("Use the saved destination");
    expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
    await page.getByLabel("Message", { exact: true }).press("Enter");
    const control = await modelControl(page, width);
    expect(await control.isDisabled()).toBe(true);
    await dismissTools(page, width);
    expect(mutations).toEqual([]);
    expect(provider.requests).toEqual([]);
    await screenshot(page, `settings-loading-${width}`);
    held.release();
    await held.done;
    await expect.poll(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
    const loaded = await modelControl(page, width);
    expect(await loaded.getAttribute("title")).toContain("Anthropic API");
    await dismissTools(page, width);
    const admitted = admission(page, saved.id);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // Admission is asserted separately so a slow run start is distinguishable from a lost or refused send.
    expect((await admitted).status()).toBe(200);
    await expect.poll(() => provider.requests.map((request) => request.path)).toEqual(["/v1/messages"]);
    expect(provider.requests[0]?.body.model).toBe("claude-haiku-4-5");
    expect(mutations).toEqual([`POST /api/chats/${saved.id}/inputs`]);
    expect(errors).toEqual([]);
  });

  it.each([1440, 390])(
    "offers retry after a metadata failure without falling back or clearing text at %s px",
    async (width) => {
      const { page, base, saved, provider, errors, mutations } = await setup(width);
      let attempts = 0;
      await page.route(`**/api/chats/${saved.id}`, async (route) => {
        if (++attempts === 1)
          await route.fulfill({ status: 503, json: { error: "fixture", message: "Saved settings unavailable" } });
        else await route.continue();
      });
      await page.goto(`${base}/#/chat/${saved.id}`);
      await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
      await page.getByRole("alert").filter({ hasText: "Couldn't load saved chat settings" }).waitFor();
      expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
      expect(await (await modelControl(page, width)).isDisabled()).toBe(true);
      await dismissTools(page, width);
      expect(mutations).toEqual([]);
      expect(provider.requests).toEqual([]);
      await screenshot(page, `settings-failed-${width}`);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect.poll(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
      expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe("Keep this draft");
      expect(await (await modelControl(page, width)).getAttribute("title")).toContain("Anthropic API");
      await dismissTools(page, width);
      expect(attempts).toBe(2);
      expect(errors).toEqual([]);
    },
  );

  it("refuses a destination changed in another tab and keeps the draft for an explicit retry", async () => {
    const { pal, page, base, saved, provider, errors } = await setup(1440);
    const transport: { event: string; method: string; path: string; status: number | undefined }[] = [];
    const observe = (event: string, request: import("playwright-core").Request, status?: number) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith(`/api/chats/${saved.id}`)) transport.push({ event, method: request.method(), path, status });
    };
    page.on("request", (request) => observe("request", request));
    page.on("response", (response) => observe("response", response.request(), response.status()));
    page.on("requestfailed", (request) => observe("failed", request));
    await page.goto(`${base}/#/chat/${saved.id}`);
    const control = page.getByRole("button", { name: /^Model and reasoning:/ });
    await expect.poll(() => control.getAttribute("title")).toContain("Anthropic API");
    const changed = await page.request.put(`${base}/api/chats/${saved.id}/model`, {
      headers: { origin: base },
      data: { provider: "openrouter", model: "~deepseek/deepseek-flash-latest" },
    });
    expect(changed.status()).toBe(200);
    await page.getByLabel("Message", { exact: true }).fill("Keep this destination explicit");
    const [submitted] = await Promise.all([
      page.waitForResponse(`${base}/api/chats/${saved.id}/inputs`),
      page.getByRole("button", { name: "Send", exact: true }).click(),
    ]);
    expect(submitted.status()).toBe(409);
    expect(provider.requests).toEqual([]);
    await page.getByRole("alert").filter({ hasText: "Chat settings changed elsewhere" }).waitFor();
    expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe("Keep this destination explicit");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => control.getAttribute("title")).toContain("OpenRouter");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    try {
      await expect.poll(() => provider.requests.map((request) => request.path)).toEqual(["/api/v1/chat/completions"]);
    } catch (failure) {
      const admissions = await pal.store.database.all(
        "SELECT request_id, state, submission_id FROM pal_admissions WHERE chat_id = ?",
        saved.id,
      );
      const tasks = (
        await pal.store.storage.scanTasks({ conversationId: saved.conversationId }, 20, undefined, context)
      ).items.map(({ id, state }) => {
        const checkpoint = "checkpoint" in state ? state.checkpoint : null;
        const phase =
          checkpoint !== null && typeof checkpoint === "object" && !Array.isArray(checkpoint)
            ? checkpoint.phase
            : undefined;
        return { id, status: state.status, phase: typeof phase === "string" ? phase : undefined };
      });
      throw new Error(`Routing fixture: ${JSON.stringify({ transport, admissions, tasks, errors })}`, {
        cause: failure,
      });
    }
    expect(errors).toEqual([]);
  });

  it("keeps malformed successful responses out of chat and project settings", async () => {
    const { page, base, saved, errors, mutations } = await setup(1440);
    await page.route(`**/api/chats/${saved.id}`, (route) =>
      route.fulfill({ contentType: "application/json", body: '{"model":' }),
    );
    await page.route("**/api/projects/*/mcp", (route) =>
      route.fulfill({ contentType: "application/json", body: '{"servers":' }),
    );
    await page.goto(`${base}/#/chat/${saved.id}`);
    await page.getByRole("alert").filter({ hasText: "Couldn't load saved chat settings" }).waitFor();
    expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Project internet tools", exact: true }).click();
    await page.getByRole("dialog", { name: "Internet tools", exact: true }).getByRole("alert").waitFor();
    expect(mutations).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("ignores a late metadata response after navigating to a different chat", async () => {
    const { page, base, saved, other, provider, errors } = await setup(1440);
    const held = await holdMetadata(page, saved.id);
    await page.goto(`${base}/#/chat/${saved.id}`);
    await held.seen;
    const loaded = page.waitForResponse(`${base}/api/chats/${other.id}`);
    await page.evaluate((id) => {
      location.hash = `#/chat/${id}`;
    }, other.id);
    await loaded;
    await expect
      .poll(() => page.getByRole("button", { name: /^Model and reasoning:/ }).getAttribute("title"))
      .toContain("OpenRouter");
    held.release();
    await held.done;
    await page.getByLabel("Message", { exact: true }).fill("Use the other chat");
    await expect.poll(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
    const admitted = admission(page, other.id);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    expect((await admitted).status()).toBe(200);
    await expect.poll(() => provider.requests.map((request) => request.path)).toEqual(["/api/v1/chat/completions"]);
    expect(errors).toEqual([]);
  });
});

function admission(page: Page, id: string) {
  return page.waitForResponse(
    (reply) => new URL(reply.url()).pathname === `/api/chats/${id}/inputs` && reply.request().method() === "POST",
  );
}

async function attach(page: Page, name: string) {
  const response = page.waitForResponse(
    (reply) => reply.url().endsWith("/uploads") && reply.request().method() === "POST",
  );
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(`Fixture ${name}`) });
  const body = (await (await response).json()) as { upload: { id: string } };
  await page.getByRole("button", { name: `Remove ${name}`, exact: true }).waitFor();
  return body.upload.id;
}

async function navigateChat(page: Page, id: string) {
  const loaded = page.waitForResponse(new URL(`/api/chats/${id}`, page.url()).href);
  await page.evaluate((chatId) => {
    location.hash = `#/chat/${chatId}`;
  }, id);
  await loaded;
  await expect
    .poll(async () => (await page.getByRole("button", { name: /^Model and reasoning:/ }).getAttribute("title")) ?? "")
    .toMatch(/Anthropic API|OpenRouter/);
}

describe("chat draft admission", () => {
  it.each([1440, 390])(
    "keeps newer text and attachment edits when an older input is acknowledged at %s px",
    async (width) => {
      const { pal, page, base, saved, errors } = await setup(width);
      await page.goto(`${base}/#/chat/${saved.id}`);
      const oldFile = await attach(page, "before.txt");
      const message = page.getByLabel("Message", { exact: true });
      await message.fill("Original message");
      const seen = Promise.withResolvers<string>(),
        release = Promise.withResolvers<undefined>(),
        done = Promise.withResolvers<undefined>();
      await page.route(
        `**/api/chats/${saved.id}/inputs`,
        async (route) => {
          const response = await route.fetch({ timeout: 5000 });
          seen.resolve(route.request().postData() ?? "");
          await release.promise;
          await route.fulfill({ response });
          done.resolve(undefined);
        },
        { times: 1 },
      );
      cleanups.push(async () => {
        release.resolve(undefined);
      });
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const sent = JSON.parse(await seen.promise) as { text: string; attachments: string[] };
      expect(sent).toMatchObject({ text: "Original message", attachments: [oldFile] });
      await message.fill("A newer draft");
      await page.getByRole("button", { name: "Remove before.txt", exact: true }).click();
      await attach(page, "after.txt");
      expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
      release.resolve(undefined);
      await done.promise;
      await expect.poll(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
      expect(await message.inputValue()).toBe("A newer draft");
      expect(await page.getByRole("button", { name: "Remove before.txt", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Remove after.txt", exact: true }).count()).toBe(1);
      expect(
        await pal.store.database.get("SELECT count(*) AS n FROM pal_admissions WHERE chat_id = ?", saved.id),
      ).toEqual({ n: 1 });
      await screenshot(page, `draft-newer-${width}`);
      expect(errors).toEqual([]);
    },
  );

  it("reserves the ten-file budget before starting concurrent uploads", async () => {
    const { page, base, saved, project, provider, errors } = await setup(1440);
    await page.goto(`${base}/#/chat/${saved.id}`);
    const release = Promise.withResolvers<undefined>(),
      reserved = Promise.withResolvers<undefined>();
    const transfers: Promise<void>[] = [];
    let requests = 0;
    await page.route(`**/api/projects/${project.id}/uploads`, async (route) => {
      requests++;
      if (requests === 10) reserved.resolve(undefined);
      const transfer = (async () => {
        await release.promise;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const { upload } = (await response.json()) as { upload: { id: string } };
        const received = page.waitForResponse(`${base}/api/uploads/${upload.id}`);
        await route.fulfill({ response });
        const result = await received;
        expect(result.status()).toBe(200);
        expect(await result.json()).toMatchObject({ upload: { state: "ready" } });
      })();
      transfers.push(transfer);
      await transfer;
    });
    cleanups.push(async () => {
      release.resolve(undefined);
      await Promise.allSettled(transfers);
    });
    for (let i = 0; i < 11; i++)
      await page
        .locator('input[type="file"]')
        .setInputFiles({ name: `slot-${i}.txt`, mimeType: "text/plain", buffer: Buffer.from("fixture") });
    await reserved.promise;
    expect(requests).toBe(10);
    await page.getByRole("alert").filter({ hasText: "at most 10 files" }).waitFor();
    release.resolve(undefined);
    await Promise.all(transfers);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        page.getByRole("button", { name: `Remove slot-${i}.txt`, exact: true }).waitFor(),
      ),
    );
    expect(await page.getByRole("button", { name: /^Remove slot-/ }).count()).toBe(10);
    expect(requests).toBe(10);
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("retains an in-flight envelope across navigation without enabling a duplicate send", async () => {
    const { pal, page, base, saved, other, errors } = await setup(1440);
    await page.goto(`${base}/#/chat/${saved.id}`);
    await attach(page, "navigation.txt");
    await page.getByLabel("Message", { exact: true }).fill("Keep the original admission");
    const seen = Promise.withResolvers<undefined>(),
      release = Promise.withResolvers<undefined>(),
      done = Promise.withResolvers<undefined>();
    await page.route(
      `**/api/chats/${saved.id}/inputs`,
      async (route) => {
        const response = await route.fetch({ timeout: 5000 });
        seen.resolve(undefined);
        await release.promise;
        await route.fulfill({ response });
        done.resolve(undefined);
      },
      { times: 1 },
    );
    cleanups.push(async () => {
      release.resolve(undefined);
    });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await seen.promise;
    await navigateChat(page, other.id);
    expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe("");
    await navigateChat(page, saved.id);
    expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe("Keep the original admission");
    expect(await page.getByRole("button", { name: "Remove navigation.txt", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
    await page.getByLabel("Message", { exact: true }).fill("Typed after coming back");
    release.resolve(undefined);
    await done.promise;
    await expect.poll(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
    expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe("Typed after coming back");
    expect(
      await pal.store.database.get("SELECT count(*) AS n FROM pal_admissions WHERE chat_id = ?", saved.id),
    ).toEqual({ n: 1 });
    expect(errors).toEqual([]);
  });

  it("retries the identical steering envelope after a lost reply and run end", async () => {
    const { pal, page, base, other, provider, errors } = await setup(1440);
    provider.behavior.hold = true;
    await page.goto(`${base}/#/chat/${other.id}`);
    await page.getByLabel("Message", { exact: true }).fill("Hold the first run");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => provider.holding).toBe(1);
    await page.getByRole("radio", { name: "Steer", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("A steering message");
    const lost = Promise.withResolvers<string>();
    await page.route(
      `**/api/chats/${other.id}/inputs`,
      async (route) => {
        await route.fetch({ timeout: 5000 });
        lost.resolve(route.request().postData() ?? "");
        await route.abort("failed");
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "Steer", exact: true }).click();
    const original = await lost.promise;
    expect(JSON.parse(original)).toMatchObject({ whenBusy: "steer", text: "A steering message" });
    await page.getByRole("alert").waitFor();
    provider.behavior.hold = false;
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(() => page.getByRole("button", { name: "Stop", exact: true }).count()).toBe(0);
    await page.setViewportSize({ width: 390, height: 900 });
    await screenshot(page, "draft-saved-send-390");
    // The old UI retried through Send; exercise the enabled retry action in either UI.
    const retry = page.locator("button:enabled").and(page.getByRole("button", { name: /^(Retry saved send|Send)$/ }));
    const [response] = await Promise.all([page.waitForResponse(`${base}/api/chats/${other.id}/inputs`), retry.click()]);
    expect(response.request().postData()).toBe(original);
    expect(response.status()).toBe(200);
    const key = (JSON.parse(original) as { requestId: string }).requestId;
    expect(
      await pal.store.database.get(
        "SELECT count(*) AS n FROM pal_admissions WHERE chat_id = ? AND request_id = ?",
        other.id,
        key,
      ),
    ).toEqual({ n: 1 });
    expect(errors).toEqual([]);
  });

  it("keeps unsent drafts per chat but clears them on reload and sign-out", async () => {
    const { page, base, saved, other, provider, errors } = await setup(1440);
    await page.goto(`${base}/#/chat/${saved.id}`);
    await page.getByLabel("Message", { exact: true }).fill("Unsent saved-chat draft");
    await attach(page, "unsent.txt");
    await navigateChat(page, other.id);
    await page.getByLabel("Message", { exact: true }).fill("Other chat draft");
    await navigateChat(page, saved.id);
    expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe("Unsent saved-chat draft");
    expect(await page.getByRole("button", { name: "Remove unsent.txt", exact: true }).count()).toBe(1);
    await page.reload();
    await expect.poll(() => page.getByRole("button", { name: /^Model and reasoning:/ }).isEnabled()).toBe(true);
    expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe("");
    expect(await page.getByRole("button", { name: "Remove unsent.txt", exact: true }).count()).toBe(0);
    await page.getByLabel("Message", { exact: true }).fill("Discard this on sign-out");
    await page.evaluate(() => {
      location.hash = "#/settings/general";
    });
    await page.getByRole("button", { name: "Sign out of Pal", exact: true }).click();
    await page.getByLabel("Passphrase", { exact: true }).fill("correct horse battery");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Sign out of Pal", exact: true }).waitFor();
    await navigateChat(page, saved.id);
    expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe("");
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("MCP catalog consent", () => {
  it.each([1440, 390])(
    "keeps a stale tab's selection but requires the changed definitions to be reviewed at %s px",
    async (width) => {
      const { pal, page, base, provider, errors } = await setup(width);
      const fixture = await startMcpFixture();
      cleanups.push(fixture.close);
      const server = await pal.mcp.add({
        name: "Catalog fixture",
        url: fixture.url,
        auth: { kind: "none" },
        private: true,
      });
      const a = await pal.mcp.test(server.id);
      await pal.mcp.approve(server.id, ["fetch"], a.catalog);
      const tab = await page.context().newPage();
      tab.on("pageerror", (error) => errors.push(error.message));
      for (const view of [page, tab]) {
        await view.goto(`${base}/#/settings/mcp`);
        await view.getByRole("button", { name: /^Catalog fixture/ }).click();
        await view.getByRole("checkbox", { name: /^fetch/ }).waitFor();
      }
      await page.getByRole("checkbox", { name: /^search/ }).check();
      const search = fixture.state.tools[0];
      if (search === undefined) throw new Error("missing fixture tool");
      search.description = "Search definition B needs scope";
      search.inputSchema.required = ["query", "scope"];
      await tab.getByRole("button", { name: "Test connection", exact: true }).click();
      await tab.getByText(search.description, { exact: true }).waitFor();
      const approval = page.getByRole("button", { name: "Approve selected tools", exact: true });
      const [stale] = await Promise.all([
        page.waitForResponse(`${base}/api/mcp/servers/${server.id}/tools`),
        approval.click(),
      ]);
      expect(stale.status()).toBe(409);
      await page
        .getByRole("alert")
        .filter({ hasText: /catalog.*changed/ })
        .waitFor();
      await page.getByText(search.description, { exact: true }).waitFor();
      expect(await page.getByRole("checkbox", { name: /^search/ }).isChecked()).toBe(true);
      expect(await page.getByRole("checkbox", { name: /^fetch/ }).isChecked()).toBe(true);
      expect(await approval.isDisabled()).toBe(true);
      expect((await pal.mcp.get(server.id)).tools.filter((tool) => tool.approved).map((tool) => tool.name)).toEqual([
        "fetch",
      ]);
      await page.getByText("Previously reviewed catalog and selection", { exact: true }).click();
      const previous = page
        .locator("details")
        .filter({ has: page.getByText("Previously reviewed catalog and selection", { exact: true }) });
      expect(await previous.innerText()).toContain("Search the fixture web index");
      expect(await previous.innerText()).not.toContain(search.description);
      expect(await previous.innerText()).toContain('"selection": [');
      await page.getByText("Definition: search", { exact: true }).click();
      const definition = page.locator("details").filter({ has: page.getByText("Definition: search", { exact: true }) });
      expect(await definition.innerText()).toContain('"scope"');
      await screenshot(page, `mcp-catalog-conflict-${width}`);
      await page.getByRole("button", { name: "I reviewed the current catalog", exact: true }).click();
      const [approved] = await Promise.all([
        page.waitForResponse(`${base}/api/mcp/servers/${server.id}/tools`),
        approval.click(),
      ]);
      expect(approved.status()).toBe(200);
      await expect
        .poll(async () => (await pal.mcp.get(server.id)).tools.find((tool) => tool.name === "search")?.approved)
        .toBe(true);
      expect((await pal.mcp.get(server.id)).tools.find((tool) => tool.name === "search")?.changed).toBe(false);
      expect(fixture.calls).toEqual([]);
      expect(provider.requests).toEqual([]);
      expect(errors).toEqual([]);
    },
  );
});

async function reviewFixture(width: number) {
  const fixture = await setup(width);
  const { pal, project, saved, page, base } = fixture;
  const workspace = await pal.workspaces.info(saved.id);
  if (workspace?.state !== "ready" || workspace.root === null) throw new Error("missing review workspace");
  const root = workspace.root;
  const git = (...args: string[]) =>
    runGit(
      root,
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
      { signal: AbortSignal.timeout(5000) },
    );
  await git("init", "-q");
  for (const path of ["a.txt", "b.txt"]) await writeFile(join(root, path), `Base ${path}\n`);
  await git("add", "a.txt", "b.txt");
  await git("commit", "-qm", "Baseline");
  await pal.changes.capture(root);
  for (const path of ["a.txt", "b.txt"]) await writeFile(join(root, path), `Changed ${path}\n`);
  const changes = await pal.changes.list(project.id, "normal", workspace.id);
  const a = changes.files.find((file) => file.path === "a.txt"),
    b = changes.files.find((file) => file.path === "b.txt");
  if (a === undefined || b === undefined) throw new Error("missing review fixtures");
  await page.goto(`${base}/#/chat/${saved.id}`);
  if (width < 700) await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Workspace panel" });
  await panel.getByRole("button", { name: /^a\.txt/ }).click();
  await panel.getByRole("button", { name: "Comment on line 1", exact: true }).waitFor();
  return { ...fixture, workspace, root, a, b, panel };
}

describe("review comment drafts", () => {
  it.each([1440, 390])(
    "keeps copied feedback recoverable through reload and a lost admission reply at %s px",
    async (width) => {
      const { pal, page, base, saved, project, workspace, panel, errors } = await reviewFixture(width);
      await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
      await panel.getByRole("textbox", { name: "Comment on line 1", exact: true }).fill("Keep this feedback.");
      await panel.getByRole("button", { name: "Add comment", exact: true }).click();
      await panel.getByText("Keep this feedback.", { exact: true }).waitFor();
      const [comment] = (await pal.changes.list(project.id, "normal", workspace.id)).comments;
      if (comment === undefined) throw new Error("missing feedback fixture");
      await panel.getByRole("button", { name: "Send feedback to chat (1)", exact: true }).click();
      await expect.poll(() => page.getByLabel("Message", { exact: true }).inputValue()).toContain(comment.body);
      expect((await pal.changes.list(project.id, "normal", workspace.id)).comments[0]?.sent).toBe(false);
      if (width < 700) {
        await panel.waitFor({ state: "detached" });
        await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
        await page.getByRole("button", { name: "Changes", exact: true }).click();
      }
      await panel.getByText("In composer · not admitted", { exact: true }).waitFor();
      await panel.getByRole("button", { name: "Copy feedback again (1)", exact: true }).click();
      const composed = await page.getByLabel("Message", { exact: true }).inputValue();
      expect(composed.split(comment.body)).toHaveLength(2);
      await page.reload();
      if (width < 700) await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
      await expect.poll(() => page.getByRole("button", { name: /^Model and reasoning:/ }).isEnabled()).toBe(true);
      expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe("");
      await page.getByRole("button", { name: "Changes", exact: true }).click();
      await panel.getByText("Not sent", { exact: true }).waitFor();
      const legacy = await page.request.post(`${base}/api/projects/${project.id}/comments/sent`, {
        headers: { origin: base },
        data: { ids: [comment.id], workspace: workspace.id },
      });
      expect(legacy.status()).toBe(404);
      expect((await pal.changes.list(project.id, "normal", workspace.id)).comments[0]?.sent).toBe(false);
      await panel.getByRole("button", { name: "Send feedback to chat (1)", exact: true }).click();
      if (width < 700) await panel.waitFor({ state: "detached" });
      const lost = Promise.withResolvers<string>();
      await page.route(
        `**/api/chats/${saved.id}/inputs`,
        async (route) => {
          const response = await route.fetch({ timeout: 5000 });
          expect(response.status()).toBe(200);
          lost.resolve(route.request().postData() ?? "");
          await route.abort("failed");
        },
        { times: 1 },
      );
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const original = await lost.promise;
      expect(JSON.parse(original)).toMatchObject({ feedback: { ids: [comment.id], scope: "normal" } });
      await page.getByRole("alert").filter({ hasText: "This send isn't confirmed" }).waitFor();
      expect((await pal.changes.list(project.id, "normal", workspace.id)).comments[0]?.sent).toBe(true);
      const [retried] = await Promise.all([
        page.waitForResponse(`${base}/api/chats/${saved.id}/inputs`),
        page.getByRole("button", { name: "Retry saved send", exact: true }).click(),
      ]);
      expect(retried.status()).toBe(200);
      expect(retried.request().postData()).toBe(original);
      expect(
        await pal.store.database.get("SELECT count(*) AS n FROM pal_admissions WHERE chat_id = ?", saved.id),
      ).toEqual({ n: 1 });
      if (width < 700) {
        await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
        await page.getByRole("button", { name: "Changes", exact: true }).click();
      }
      await panel.getByText("Admitted to chat", { exact: true }).waitFor();
      await screenshot(page, `feedback-admitted-${width}`);
      expect(errors).toEqual([]);
    },
  );

  it("does not acknowledge copied comments when the owner sends different text", async () => {
    const { pal, page, project, workspace, panel, saved, base, errors } = await reviewFixture(1440);
    await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
    await panel.getByRole("textbox", { name: "Comment on line 1", exact: true }).fill("Keep the original note.");
    await panel.getByRole("button", { name: "Add comment", exact: true }).click();
    await panel.getByText("Keep the original note.", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Send feedback to chat (1)", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Send an unrelated message instead.");
    const [response] = await Promise.all([
      page.waitForResponse(`${base}/api/chats/${saved.id}/inputs`),
      page.getByRole("button", { name: "Send", exact: true }).click(),
    ]);
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).not.toHaveProperty("feedback");
    expect((await pal.changes.list(project.id, "normal", workspace.id)).comments).toMatchObject([
      { body: "Keep the original note.", sent: false },
    ]);
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await panel.getByRole("button", { name: "Send feedback to chat (1)", exact: true }).waitFor();
    expect(errors).toEqual([]);
  });

  it("keeps text editable after a definitive stale-feedback rejection without retrying a different body", async () => {
    const { pal, page, project, workspace, panel, saved, base, errors } = await reviewFixture(1440);
    await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "Comment on line 1", exact: true })
      .fill("A note the owner later deletes.");
    await panel.getByRole("button", { name: "Add comment", exact: true }).click();
    await panel.getByText("A note the owner later deletes.", { exact: true }).waitFor();
    const [comment] = (await pal.changes.list(project.id, "normal", workspace.id)).comments;
    if (comment === undefined) throw new Error("missing feedback fixture");
    await panel.getByRole("button", { name: "Send feedback to chat (1)", exact: true }).click();
    const text = await page.getByLabel("Message", { exact: true }).inputValue();
    await pal.changes.uncomment(project.id, comment.id, workspace.id);
    const [rejected] = await Promise.all([
      page.waitForResponse(`${base}/api/chats/${saved.id}/inputs`),
      page.getByRole("button", { name: "Send", exact: true }).click(),
    ]);
    expect(rejected.status()).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: "feedback_stale" });
    await page.getByRole("alert").filter({ hasText: "linked comment was removed" }).waitFor();
    expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe(text);
    expect(await page.getByRole("button", { name: "Retry saved send", exact: true }).count()).toBe(0);
    expect(await pal.store.database.get("SELECT count(*) AS n FROM pal_admissions")).toEqual({ n: 0 });
    const [sent] = await Promise.all([
      page.waitForResponse(`${base}/api/chats/${saved.id}/inputs`),
      page.getByRole("button", { name: "Send", exact: true }).click(),
    ]);
    expect(sent.status()).toBe(200);
    expect(sent.request().postDataJSON()).toMatchObject({ text });
    expect(sent.request().postDataJSON()).not.toHaveProperty("feedback");
    expect(sent.request().postDataJSON().requestId).not.toBe(rejected.request().postDataJSON().requestId);
    expect(await pal.store.database.get("SELECT count(*) AS n FROM pal_admissions")).toEqual({ n: 1 });
    expect(errors).toEqual([]);
  });

  it("keeps review feedback recoverable if the composer cannot accept the text", async () => {
    const { pal, page, project, workspace, panel, provider, errors } = await reviewFixture(1440);
    await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
    await panel.getByRole("textbox", { name: "Comment on line 1", exact: true }).fill("Small feedback");
    await panel.getByRole("button", { name: "Add comment", exact: true }).click();
    await panel.getByText("Small feedback", { exact: true }).waitFor();
    const text = "x".repeat(100_000);
    await page.getByLabel("Message", { exact: true }).fill(text);
    await panel.getByRole("button", { name: "Send feedback to chat (1)", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Feedback could not be added" }).waitFor();
    expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe(text);
    expect((await pal.changes.list(project.id, "normal", workspace.id)).comments).toMatchObject([
      { body: "Small feedback", sent: false },
    ]);
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });

  it.each([1440, 390])(
    "keeps the original target through a delayed refresh and only retargets explicitly at %s px",
    async (width) => {
      const { pal, page, base, project, workspace, root, a, panel, errors } = await reviewFixture(width);
      await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
      const draft = panel.getByRole("textbox", { name: "Comment on line 1", exact: true });
      await draft.fill("Feedback about revision A");
      await writeFile(join(root, "a.txt"), "New revision B\n");
      const seen = Promise.withResolvers<undefined>(),
        release = Promise.withResolvers<undefined>(),
        done = Promise.withResolvers<undefined>();
      await page.route(
        "**/api/projects/*/changes?*",
        async (route) => {
          const response = await route.fetch();
          seen.resolve(undefined);
          await release.promise;
          await route.fulfill({ response });
          done.resolve(undefined);
        },
        { times: 1 },
      );
      cleanups.push(async () => {
        release.resolve(undefined);
      });
      await panel.getByRole("button", { name: "Refresh", exact: true }).click();
      await seen.promise;
      await draft.fill("Feedback about revision A, edited while refreshing");
      release.resolve(undefined);
      await done.promise;
      await panel
        .getByRole("region", { name: "File diff", exact: true })
        .getByText("New revision B", { exact: true })
        .waitFor();
      const path = `${base}/api/projects/${project.id}/comments`;
      const [stale] = await Promise.all([
        page.waitForResponse(path),
        panel.getByRole("button", { name: "Add comment", exact: true }).click(),
      ]);
      expect(stale.request().postDataJSON()).toMatchObject({
        path: "a.txt",
        revision: a.revision,
        line: 1,
        workspace: workspace.id,
      });
      expect(stale.status()).toBe(409);
      await panel
        .getByRole("alert")
        .filter({ hasText: /draft.*kept/ })
        .waitFor();
      expect(await draft.inputValue()).toBe("Feedback about revision A, edited while refreshing");
      expect((await pal.changes.list(project.id, "normal", workspace.id)).comments).toEqual([]);
      await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
      expect(await draft.inputValue()).toBe("Feedback about revision A, edited while refreshing");
      await panel.getByRole("button", { name: "Retarget draft", exact: true }).click();
      await screenshot(page, `review-retarget-${width}`);
      const [submitted] = await Promise.all([
        page.waitForResponse(path),
        panel.getByRole("button", { name: "Add comment", exact: true }).click(),
      ]);
      expect(submitted.status()).toBe(200);
      const comments = (await pal.changes.list(project.id, "normal", workspace.id)).comments;
      expect(comments).toMatchObject([
        {
          path: "a.txt",
          line: 1,
          lineText: "New revision B",
          body: "Feedback about revision A, edited while refreshing",
        },
      ]);
      expect(comments[0]?.revision).not.toBe(a.revision);
      expect(errors).toEqual([]);
    },
  );

  it("keeps newer comment text when an older comment acknowledgement arrives", async () => {
    const { pal, page, base, project, workspace, panel, errors } = await reviewFixture(1440);
    const events: string[] = [];
    page.on("request", (request) => events.push(`request ${request.method()} ${request.url()}`));
    page.on("response", (response) => events.push(`response ${response.status()} ${response.url()}`));
    page.on("requestfinished", (request) => events.push(`finished ${request.url()}`));
    page.on("requestfailed", (request) => events.push(`failed ${request.url()} ${request.failure()?.errorText}`));
    await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
    const draft = panel.getByRole("textbox", { name: "Comment on line 1", exact: true });
    await draft.fill("First comment");
    const seen = Promise.withResolvers<{ status: number; body: unknown }>(),
      release = Promise.withResolvers<undefined>(),
      done = Promise.withResolvers<undefined>();
    // Auto-expiring interception can strand the refresh in Chromium.
    await page.route("**/api/projects/*/comments", async (route) => {
      const response = await route.fetch();
      seen.resolve({ status: response.status(), body: await response.json() });
      await release.promise;
      await route.fulfill({ response });
      done.resolve(undefined);
    });
    cleanups.push(async () => {
      release.resolve(undefined);
    });
    await panel.getByRole("button", { name: "Add comment", exact: true }).click();
    const posted = await seen.promise;
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ comment: { body: "First comment" } });
    await draft.fill("Newer unsent comment");
    const refreshed = page.waitForResponse((response) =>
      response.url().startsWith(`${base}/api/projects/${project.id}/changes?`),
    );
    release.resolve(undefined);
    await done.promise;
    try {
      const response = await refreshed;
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ comments: [{ body: "First comment" }] });
      await panel.getByText("First comment", { exact: true }).waitFor();
    } catch (failure) {
      await screenshot(page, "review-late-ack-failed");
      throw new Error(JSON.stringify({ panel: await panel.innerText(), events, errors }), { cause: failure });
    }
    expect(await draft.inputValue()).toBe("Newer unsent comment");
    expect((await pal.changes.list(project.id, "normal", workspace.id)).comments).toMatchObject([
      { body: "First comment" },
    ]);
    expect(errors).toEqual([]);
  });

  it("retains an ignored-file draft without exposing it while ignored review is off", async () => {
    const { page, root, panel, errors } = await reviewFixture(1440);
    await writeFile(join(root, ".gitignore"), "private.secret\n");
    await writeFile(join(root, "private.secret"), "Private fixture excerpt\n");
    await panel.locator(".details > summary").click();
    const scope = panel.getByRole("checkbox", { name: "Include ignored files for review", exact: true });
    await scope.check();
    await panel.getByRole("button", { name: /private\.secret/ }).click();
    await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
    await panel.getByRole("textbox", { name: "Comment on line 1", exact: true }).fill("Private draft fixture");
    await scope.uncheck();
    await panel.getByText("Your ignored-file draft is kept.", { exact: false }).waitFor();
    expect(await panel.getByRole("textbox", { name: /Comment on line/ }).count()).toBe(0);
    expect(await panel.innerText()).not.toContain("Private fixture excerpt");
    expect(await panel.innerText()).not.toContain("Private draft fixture");
    await scope.check();
    expect(await panel.getByRole("textbox", { name: "Comment on line 1", exact: true }).inputValue()).toBe(
      "Private draft fixture",
    );
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await panel.getByRole("textbox", { name: /Comment on line/ }).count()).toBe(0);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  it("keeps a draft on its original file when another file is selected", async () => {
    const { pal, page, base, project, workspace, a, panel, errors } = await reviewFixture(1440);
    await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
    await panel.getByRole("textbox", { name: "Comment on line 1", exact: true }).fill("Only about a.txt");
    await panel.getByRole("button", { name: /^b\.txt/ }).click();
    expect(await panel.getByRole("textbox", { name: "Comment on line 1", exact: true }).inputValue()).toBe(
      "Only about a.txt",
    );
    const [submitted] = await Promise.all([
      page.waitForResponse(`${base}/api/projects/${project.id}/comments`),
      panel.getByRole("button", { name: "Add comment", exact: true }).click(),
    ]);
    expect(submitted.status()).toBe(200);
    expect(submitted.request().postDataJSON()).toMatchObject({
      path: "a.txt",
      revision: a.revision,
      workspace: workspace.id,
    });
    expect((await pal.changes.list(project.id, "normal", workspace.id)).comments).toMatchObject([
      { path: "a.txt", body: "Only about a.txt" },
    ]);
    expect(errors).toEqual([]);
  });
});

describe("scoped instruction sources", () => {
  async function openInstructions(page: Page, base: string, id: string, width: number) {
    await page.goto(`${base}/#/chat/${id}`);
    if (width < 700) await page.getByRole("button", { name: "Workspace tools" }).click();
    await page.getByRole("button", { name: "Context", exact: true }).click();
    const panel = page.getByRole("region", { name: "Scoped instruction sources", exact: true });
    await panel.getByRole("button", { name: "Configure instruction sources" }).waitFor();
    return panel;
  }

  it.each([1440, 390])("inspects escaped source bytes and retains stale settings drafts at %s px", async (width) => {
    const { pal, page, base, project, saved, errors, provider } = await setup(width);
    const text = 'Fixture guidance <img src=x onerror="alert(1)">';
    await writeFile(join(project.root, "AGENTS.md"), text);
    const panel = await openInstructions(page, base, saved.id, width);
    await panel.getByText("project · . · loaded", { exact: true }).click();
    expect(await panel.locator("pre").textContent()).toBe(text);
    expect(await panel.locator("img").count()).toBe(0);
    await panel.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await screenshot(page, `instruction-sources-loaded-${width}`);
    await panel.getByRole("button", { name: "Configure instruction sources" }).click();
    const field = panel.getByRole("textbox", { name: "Global instructions file on the host" });
    await field.fill("/fixture/my-unsaved-AGENTS.md");
    const current = await pal.instructions.settings(project.id);
    await pal.instructions.configure(saved.conversationId, { ...current, globalFile: null });
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith(`/api/chats/${saved.id}/instructions`) && res.request().method() === "PUT",
      ),
      panel.getByRole("button", { name: "Save instruction sources" }).click(),
    ]);
    expect(response.status()).toBe(409);
    await panel.getByRole("alert").filter({ hasText: "draft is retained" }).waitFor();
    expect(await field.inputValue()).toBe("/fixture/my-unsaved-AGENTS.md");
    await panel.getByRole("button", { name: "Refresh sources" }).click();
    await expect.poll(async () => (await pal.instructions.settings(project.id)).revision).toBe(1);
    expect(await field.inputValue()).toBe("/fixture/my-unsaved-AGENTS.md");
    await panel.getByRole("button", { name: "Reload current source settings" }).click();
    expect(await field.inputValue()).toBe("");
    await panel.getByRole("checkbox", { name: "Load project and nested AGENTS.md files" }).uncheck();
    await panel.getByRole("button", { name: "Save instruction sources" }).click();
    await panel.getByRole("button", { name: "Configure instruction sources" }).waitFor();
    expect(await pal.instructions.settings(project.id)).toMatchObject({
      revision: 2,
      globalFile: null,
      project: false,
    });
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
    await panel.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await screenshot(page, `instruction-sources-${width}`);
  });

  it("does not apply a late source-settings acknowledgement to another project", async () => {
    const { pal, page, base, project, saved, errors } = await setup(1440);
    const otherProject = await pal.projects.create("other-instruction-project", { name: "Other instructions" });
    const other = await pal.chats.createChat("other-instruction-chat", { projectId: otherProject.id }, context);
    const panel = await openInstructions(page, base, saved.id, 1440);
    await panel.getByRole("button", { name: "Configure instruction sources" }).click();
    await panel
      .getByRole("textbox", { name: "Global instructions file on the host" })
      .fill("/fixture/original-project-AGENTS.md");
    const seen = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const done = Promise.withResolvers<undefined>();
    let entered = false;
    await page.route(`**/api/chats/${saved.id}/instructions`, async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      entered = true;
      try {
        const response = await route.fetch();
        seen.resolve(undefined);
        await release.promise;
        await route.fulfill({ response });
      } finally {
        done.resolve(undefined);
      }
    });
    cleanups.push(async () => {
      release.resolve(undefined);
      if (entered) await done.promise;
    });
    await panel.getByRole("button", { name: "Save instruction sources" }).click();
    await seen.promise;
    await page.getByRole("button", { name: "Context", exact: true }).click();
    const next = await openInstructions(page, base, other.id, 1440);
    await next.getByRole("button", { name: "Configure instruction sources" }).click();
    const field = next.getByRole("textbox", { name: "Global instructions file on the host" });
    const expected = (await pal.instructions.settings(otherProject.id)).globalFile;
    expect(await field.inputValue()).toBe(expected);
    release.resolve(undefined);
    await done.promise;
    expect(await field.inputValue()).toBe(expected);
    expect((await pal.instructions.settings(project.id)).globalFile).toBe("/fixture/original-project-AGENTS.md");
    expect((await pal.instructions.settings(otherProject.id)).revision).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe("compiled capability composition", () => {
  it.each([1440, 390])("keeps core Context usable without the compiled memory package at %s px", async (width) => {
    const { page, base, saved, errors, provider } = await setup(width, []);
    const memoryRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.includes("/memory")) memoryRequests.push(request.url());
    });
    await page.goto(`${base}/#/chat/${saved.id}`);
    if (width < 700) await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
    const response = page.waitForResponse(`${base}/api/chats/${saved.id}/context`);
    await page.getByRole("button", { name: "Context", exact: true }).click();
    expect((await response).status()).toBe(200);
    expect(memoryRequests).toEqual([]);
    await page.getByRole("button", { name: "Configure instruction sources", exact: true }).waitFor();
    await page.getByRole("button", { name: "Choose skills for this chat", exact: true }).waitFor();
    expect(await page.getByRole("region", { name: "Curated memory", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Add memory", exact: true }).count()).toBe(0);
    expect(memoryRequests).toEqual([]);
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
    await screenshot(page, `core-context-without-memory-${width}`);
  });

  it("shows the compiled template's bounded tool, compatibility, identity and new-chat setting", async () => {
    const { pal, page, base, errors } = await setup(390, [exampleCapability]);
    await page.goto(`${base}/#/settings/extensions`);
    const row = page.locator(".extension").filter({ has: page.getByText("Example echo", { exact: true }) });
    await row.getByRole("switch", { name: "Enable Example echo for new chats", exact: true }).waitFor();
    expect(await row.innerText()).toContain("Core API 1–1");
    expect(await row.innerText()).toContain("example_echo · safe · project.read");
    expect(await row.innerText()).toContain("Contributes: Context");
    const item = (await pal.extensions.view()).catalog.find((item) => item.id === "example");
    if (item === undefined) throw new Error("missing compiled template");
    expect(await row.innerText()).toContain(item.implementation);
    expect(await row.getByRole("switch").isChecked()).toBe(false);
    await row.getByRole("switch").check();
    await expect
      .poll(async () => (await pal.extensions.view()).selected.some((item) => item.id === "example"))
      .toBe(true);
    expect(errors).toEqual([]);
    await screenshot(page, "compiled-capability-template-390");
  });

  it("does not silently upgrade another capability default while toggling a different contribution", async () => {
    const second = { ...exampleCapability, manifest: { ...exampleCapability.manifest, version: 2 } };
    const { pal, page, base, errors, provider } = await setup(390, [second]);
    await pal.store.database.run(
      "INSERT INTO pal_settings (key, value) VALUES ('extensions:selection', ?)",
      JSON.stringify({
        selected: [
          { id: "files", version: 1 },
          { id: "example", version: 1 },
        ],
      }),
    );
    await page.goto(`${base}/#/settings/extensions`);
    const files = page.getByRole("switch", { name: "Enable Files and changes for new chats", exact: true });
    await files.waitFor();
    const response = page.waitForResponse(
      (res) => res.url().endsWith("/api/extensions") && res.request().method() === "PUT",
    );
    await files.uncheck();
    const result = await response;
    expect((await pal.extensions.view()).selected.find((item) => item.id === "example")).toEqual({
      id: "example",
      version: 1,
    });
    expect(result.status()).toBe(409);
    const row = page.locator(".extension").filter({ has: page.getByText("Example echo", { exact: true }) });
    expect(await row.innerText()).toContain("Default pins v1, unavailable");
    await row.getByRole("switch").uncheck();
    await expect
      .poll(async () => (await pal.extensions.view()).selected.some((item) => item.id === "example"))
      .toBe(false);
    await row.getByRole("switch").check();
    await expect
      .poll(async () => (await pal.extensions.view()).selected.find((item) => item.id === "example")?.version)
      .toBe(2);
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("legacy capability responses", () => {
  it("keeps compiled controls and core Context usable with the previous release's fields", async () => {
    const { pal, page, base, saved, errors, provider } = await setup(390);
    await page.route("**/api/extensions", async (route) => {
      const response = await route.fetch();
      const view: Awaited<ReturnType<typeof pal.extensions.view>> = await response.json();
      await route.fulfill({
        response,
        json: {
          ...view,
          catalog: view.catalog.map((item) => ({
            id: item.id,
            version: item.version,
            native: item.native,
            name: item.name,
            description: item.description,
            panels: item.panels,
            optIn: item.optIn,
          })),
        },
      });
    });
    await page.goto(`${base}/#/settings/extensions`);
    const memory = page.getByRole("switch", { name: "Enable Context and memory for new chats", exact: true });
    await memory.waitFor();
    expect(await page.getByText("Not in this build", { exact: true }).count()).toBe(0);
    await memory.uncheck();
    await expect
      .poll(async () => (await pal.extensions.view()).selected.some((item) => item.id === "memory"))
      .toBe(false);
    await expect.poll(() => memory.isEnabled()).toBe(true);
    await memory.check();
    await expect
      .poll(async () => (await pal.extensions.view()).selected.some((item) => item.id === "memory"))
      .toBe(true);
    await page.goto(`${base}/#/chat/${saved.id}`);
    await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
    await page.getByRole("button", { name: "Context", exact: true }).click();
    await page.getByRole("button", { name: "Add memory", exact: true }).waitFor();
    await page.getByRole("button", { name: "Configure instruction sources", exact: true }).waitFor();
    expect(await page.getByText("Memory is not included in this build", { exact: false }).count()).toBe(0);
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("lazy skill sources", () => {
  async function catalog(page: Page, base: string, id: string, width: number) {
    await page.goto(`${base}/#/chat/${id}`);
    if (width < 700) await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
    await page.getByRole("button", { name: "Context", exact: true }).click();
    const panel = page.getByRole("region", { name: "Skill sources", exact: true });
    await panel.getByRole("button", { name: "Choose skills for this chat", exact: true }).waitFor();
    return panel;
  }
  async function library(root: string, directory: string, name: string, body: string) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(
      join(root, directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Use this procedure for fixture tasks\n---\n${body}\n`,
    );
  }

  it.each([1440, 390])("inspects and explicitly selects escaped global/project skills at %s px", async (width) => {
    const { pal, page, base, project, saved, provider, errors } = await setup(width);
    const settings = await pal.skills.settings(project.id);
    const global = settings.global[0];
    if (global === undefined) throw new Error("missing global fixture root");
    await library(global.path, "global 界", "global-skill", "GLOBAL-SKILL-NOT-SELECTED");
    const text = 'SELECTED-SKILL <img src=x onerror="alert(1)">';
    await library(join(project.root, ".agents", "skills"), "project 界", "project-skill", text);
    const panel = await catalog(page, base, saved.id, width);
    expect(await panel.innerText()).toContain("global-skill");
    expect(await panel.innerText()).toContain("project-skill");
    expect(await panel.innerText()).not.toContain("GLOBAL-SKILL-NOT-SELECTED");
    expect(await panel.innerText()).not.toContain("SELECTED-SKILL <img");
    await panel.getByRole("button", { name: "Choose skills for this chat", exact: true }).click();
    await panel.getByRole("checkbox", { name: "Select project-skill from project", exact: true }).check();
    const [response] = await Promise.all([
      page.waitForResponse(`${base}/api/chats/${saved.id}/skills/selection`),
      panel.getByRole("button", { name: "Save skill selection", exact: true }).click(),
    ]);
    expect(response.status()).toBe(200);
    const content = panel.getByRole("region", { name: "Selected skill content", exact: true });
    await content.getByText("View current selected bytes", { exact: true }).click();
    expect(await content.locator("pre").textContent()).toContain(text);
    expect(await content.locator("img").count()).toBe(0);
    expect(await panel.innerText()).not.toContain("GLOBAL-SKILL-NOT-SELECTED");
    expect(await content.innerText()).toContain("sha256:");
    await panel.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await screenshot(page, `skill-sources-${width}`);
    if (width < 700) await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Use project-skill for this fixture");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => provider.requests.length).toBe(1);
    expect(JSON.stringify(provider.requests[0]?.body)).toContain("SELECTED-SKILL");
    expect(JSON.stringify(provider.requests[0]?.body)).not.toContain("GLOBAL-SKILL-NOT-SELECTED");
    expect(errors).toEqual([]);
  });

  it("retains stale source-settings drafts and disables a global skill only for its project", async () => {
    const { pal, page, base, project, saved, other, errors } = await setup(1440);
    const settings = await pal.skills.settings(project.id);
    const global = settings.global[0];
    if (global === undefined) throw new Error("missing global root");
    await library(global.path, "shared", "shared-skill", "GLOBAL-REUSABLE-BODY");
    const panel = await catalog(page, base, saved.id, 1440);
    await panel.getByRole("button", { name: "Choose skills for this chat", exact: true }).click();
    await panel.getByRole("checkbox", { name: "Select shared-skill from global", exact: true }).check();
    await panel.getByRole("button", { name: "Save skill selection", exact: true }).click();
    await panel.getByRole("button", { name: "Choose skills for this chat", exact: true }).waitFor();
    await panel.getByRole("button", { name: "Configure skill sources", exact: true }).click();
    const disabled = panel.getByRole("textbox", { name: "Disabled skill names for this project", exact: true });
    await disabled.fill("shared-skill");
    await pal.skills.configure(saved.conversationId, { ...settings, disabled: ["different-skill"] });
    const [stale] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith(`/api/chats/${saved.id}/skills`) && res.request().method() === "PUT",
      ),
      panel.getByRole("button", { name: "Save skill sources", exact: true }).click(),
    ]);
    expect(stale.status()).toBe(409);
    await panel.getByRole("alert").filter({ hasText: "draft is retained" }).waitFor();
    expect(await disabled.inputValue()).toBe("shared-skill");
    const seen = Promise.withResolvers<undefined>(),
      release = Promise.withResolvers<undefined>(),
      done = Promise.withResolvers<undefined>();
    let entered = false;
    await page.route(
      `**/api/chats/${saved.id}/skills`,
      async (route) => {
        entered = true;
        try {
          const response = await route.fetch();
          seen.resolve(undefined);
          await release.promise;
          await route.fulfill({ response });
        } finally {
          done.resolve(undefined);
        }
      },
      { times: 1 },
    );
    cleanups.push(async () => {
      release.resolve(undefined);
      if (entered) await done.promise;
    });
    await panel.getByRole("button", { name: "Refresh skills", exact: true }).click();
    await seen.promise;
    expect(await disabled.inputValue()).toBe("shared-skill");
    expect(await panel.getByRole("button", { name: "Reload current skill settings", exact: true }).isDisabled()).toBe(
      true,
    );
    release.resolve(undefined);
    await done.promise;
    await panel.getByRole("button", { name: "Reload current skill settings", exact: true }).click();
    await expect.poll(() => disabled.inputValue()).toBe("different-skill");
    await disabled.fill("shared-skill");
    await panel.getByRole("button", { name: "Save skill sources", exact: true }).click();
    await panel.getByRole("button", { name: "Configure skill sources", exact: true }).waitFor();
    expect((await pal.skills.inspect(other.conversationId, context)).current.catalog[0]).toMatchObject({
      state: "disabled",
    });
    await panel.getByRole("button", { name: "Choose skills for this chat", exact: true }).click();
    const selected = panel.getByRole("checkbox", { name: "Select shared-skill from global", exact: true });
    expect(await selected.isEnabled()).toBe(true);
    await selected.uncheck();
    await panel.getByRole("button", { name: "Save skill selection", exact: true }).click();
    await panel.getByRole("button", { name: "Choose skills for this chat", exact: true }).waitFor();
    expect((await pal.skills.inspect(saved.conversationId, context)).selection.items).toEqual([]);
    const nextProject = await pal.projects.create("other-skill-project", { name: "Other skill scope" });
    const next = await pal.chats.createChat("other-skill-chat", { projectId: nextProject.id }, context);
    expect((await pal.skills.inspect(next.conversationId, context)).current.catalog[0]).toMatchObject({
      state: "ready",
    });
    expect(errors).toEqual([]);
  });

  it("does not apply a late selection acknowledgement to another chat", async () => {
    const { pal, page, base, project, saved, other, errors } = await setup(1440);
    await library(join(project.root, ".agents", "skills"), "selection", "late-skill", "LATE-SELECTION-BODY");
    const panel = await catalog(page, base, saved.id, 1440);
    await panel.getByRole("button", { name: "Choose skills for this chat", exact: true }).click();
    await panel.getByRole("checkbox", { name: "Select late-skill from project", exact: true }).check();
    const seen = Promise.withResolvers<undefined>(),
      release = Promise.withResolvers<undefined>(),
      done = Promise.withResolvers<undefined>();
    let entered = false;
    await page.route(`**/api/chats/${saved.id}/skills/selection`, async (route) => {
      entered = true;
      try {
        const response = await route.fetch();
        seen.resolve(undefined);
        await release.promise;
        await route.fulfill({ response });
      } finally {
        done.resolve(undefined);
      }
    });
    cleanups.push(async () => {
      release.resolve(undefined);
      if (entered) await done.promise;
    });
    await panel.getByRole("button", { name: "Save skill selection", exact: true }).click();
    await seen.promise;
    await page.getByRole("button", { name: "Context", exact: true }).click();
    const next = await catalog(page, base, other.id, 1440);
    await next.getByRole("button", { name: "Choose skills for this chat", exact: true }).click();
    const choice = next.getByRole("checkbox", { name: "Select late-skill from project", exact: true });
    expect(await choice.isChecked()).toBe(false);
    release.resolve(undefined);
    await done.promise;
    expect(await choice.isChecked()).toBe(false);
    expect(await next.innerText()).not.toContain("LATE-SELECTION-BODY");
    expect((await pal.skills.inspect(other.conversationId, context)).selection.items).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("keeps core skill inspection available when optional memory tools are omitted", async () => {
    const { pal, page, base, project, errors } = await setup(1440);
    const view = await pal.extensions.view();
    await pal.extensions.select({
      digest: view.digest,
      selected: view.selected.filter((item) => item.id !== "memory"),
    });
    const chat = await pal.chats.createChat("no-memory-skills", { projectId: project.id }, context);
    await page.goto(`${base}/#/chat/${chat.id}`);
    await page.getByLabel("Message", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Context", exact: true }).count()).toBe(1);
    await page.getByRole("button", { name: "Context", exact: true }).click();
    const panel = page.getByRole("region", { name: "Skill sources", exact: true });
    await panel.getByRole("button", { name: "Choose skills for this chat", exact: true }).waitFor();
    expect(errors).toEqual([]);
  });
});

describe("chat code rendering", () => {
  it.each([1440, 390])("keeps adversarial YAML/TOML responsive, escaped and intact at %s px", async (width) => {
    const { pal, page, base, saved, provider, errors } = await setup(width);
    const code = " ".repeat(100_000) + "x <img src=x onerror=alert(1)>&";
    const body = ["yaml", "toml"].map((language) => `\`\`\`${language}\n${code}\n\`\`\``).join("\n\n");
    const conversation = await pal.harness.conversation(saved.conversationId, context);
    if (conversation === undefined) throw new Error("missing fixture chat");
    await conversation.submit(
      { type: "write", entry: { kind: "pi.assistant", model: [fauxAssistantMessage(body)] } },
      context,
    );
    const started = Date.now();
    await page.goto(`${base}/#/chat/${saved.id}`);
    await expect.poll(() => page.locator(".code pre code").count()).toBe(2);
    await page.getByLabel("Message", { exact: true }).fill("Still responsive");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await page.locator(".code pre code").allTextContents()).toEqual([code, code]);
    expect(await page.locator(".code img").count()).toBe(0);
    await screenshot(page, `highlight-long-lines-${width}`);
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });
});

/** Marks the chat stream's first snapshot and approvals view, and returns a way to send it events as the server would. */
async function bridgeChatEvents(page: Page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (!String(url).includes("/events")) return;
        const marks = document.documentElement.dataset;
        this.addEventListener("snapshot", (event) => {
          marks.chatSnapshot ??= (event as MessageEvent<string>).data;
          marks.chatSnapshots = String(Number(marks.chatSnapshots ?? 0) + 1);
        });
        this.addEventListener("approvals", () => (marks.chatApprovals = "seen"));
        addEventListener("chat-test-event", (event) => {
          const { name, data } = (event as CustomEvent<{ name: string; data?: string }>).detail;
          this.dispatchEvent(data === undefined ? new Event(name) : new MessageEvent(name, { data }));
        });
      }
    };
  });
  return (name: string, data?: unknown) =>
    page.evaluate(
      (detail) => dispatchEvent(new CustomEvent("chat-test-event", { detail })),
      data === undefined ? { name } : { name, data: JSON.stringify(data) },
    );
}

describe("durable tool activity", () => {
  it.each([1440, 390])("uses native tool state without reviving older calls at %s px", async (width) => {
    const { pal, page, base, saved, provider, errors, mutations, restart } = await setup(width);
    const conversation = await pal.harness.conversation(saved.conversationId, context);
    if (conversation === undefined) throw new Error("missing fixture conversation");
    const message = (code: string) =>
      fauxAssistantMessage(
        { type: "toolCall", id: "reused-call", name: "codemode", arguments: { code } },
        { stopReason: "toolUse" },
      );
    for (const code of ["text('Older observation');", "text('Latest observation');"])
      await conversation.submit({ type: "write", entry: { kind: "pi.assistant", model: [message(code)] } }, context);
    const emit = await bridgeChatEvents(page);
    await page.goto(`${base}/#/chat/${saved.id}`);
    const activities = page.locator(".activity");
    await expect.poll(() => activities.count()).toBe(2);
    const older = activities.nth(0),
      latest = activities.nth(1);
    for (const activity of [older, latest]) {
      await activity.locator(".acth").click();
      await activity.getByText("Outcome unconfirmed", { exact: true }).waitFor({ timeout: 5000 });
      await activity.getByText("Call reused-call", { exact: true }).waitFor();
      expect(await activity.locator(".spin").count()).toBe(0);
      expect(await activity.getByRole("button", { name: /retry|repeat|run again/i }).count()).toBe(0);
    }
    const draft = page.getByLabel("Message", { exact: true });
    await draft.fill("Keep this while task state changes");
    await screenshot(page, `tool-activity-${width}`);
    const snapshots = () => page.locator("html").getAttribute("data-chat-snapshots").then(Number);
    const before = await snapshots();
    await restart();
    await expect.poll(snapshots, { timeout: 15_000 }).toBeGreaterThan(before);
    for (const activity of [older, latest]) await activity.getByText("Outcome unconfirmed", { exact: true }).waitFor();
    const snapshot = JSON.parse((await page.locator("html").getAttribute("data-chat-snapshot")) ?? "{}") as {
      entries: { id: number }[];
    };
    const tools = [{ callId: "reused-call", name: "codemode", status: "pending" }];
    await emit("snapshot", { ...snapshot, run: { inputs: [1] }, tools, inbox: [] });
    await latest.getByText("Queued", { exact: true }).waitFor();
    await older.getByText("Outcome unconfirmed", { exact: true }).waitFor();
    await emit("event", {
      type: "tool_execution_start",
      toolCallId: "reused-call",
      toolName: "codemode",
      taskId: 42,
    });
    await latest.getByText("Running", { exact: true }).waitFor();
    await latest.getByText("Task 42", { exact: true }).waitFor();
    await older.getByText("Outcome unconfirmed", { exact: true }).waitFor();
    await emit("error");
    await latest.getByText("Last observed running", { exact: true }).waitFor();
    expect(await latest.locator(".spin").count()).toBe(0);
    await emit("open");
    await latest.getByText("Running", { exact: true }).waitFor();
    await emit("event", {
      type: "tool_execution_start",
      toolCallId: "reused-call/child",
      parentToolCallId: "reused-call",
      toolName: "files_write",
      taskId: 43,
      parentTaskId: 42,
    });
    await emit("event", { type: "tool_execution_end", toolCallId: "reused-call", toolName: "codemode", taskId: 42 });
    await latest.getByText("Outcome unconfirmed", { exact: true }).waitFor();
    expect(await latest.getByText("Done", { exact: true }).count()).toBe(0);
    await emit("snapshot", {
      ...snapshot,
      run: { inputs: [1] },
      inbox: [],
      tools: [{ ...tools[0], status: "running", taskId: 42 }],
    });
    await latest.getByText("Running", { exact: true }).waitFor();
    await emit("event", { type: "run_end" });
    await latest.getByText("Outcome unconfirmed", { exact: true }).waitFor();
    expect(await latest.locator(".spin").count()).toBe(0);
    await emit("event", {
      type: "message_end",
      entry: {
        id: Math.max(...snapshot.entries.map((entry) => entry.id)) + 1,
        kind: "pi.tool-result",
        model: [{ role: "toolResult", toolCallId: "reused-call", content: [{ type: "text", text: "Known result" }] }],
      },
    });
    await latest.getByText("Done", { exact: true }).waitFor();
    await older.getByText("Outcome unconfirmed", { exact: true }).waitFor();
    expect(await draft.inputValue()).toBe("Keep this while task state changes");
    expect(mutations).toEqual([]);
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("chat connection and Stop failures", () => {
  it.each([1440, 390])("shows loading the saved conversation without clearing the draft at %s px", async (width) => {
    const { page, base, saved, pal, provider, errors, mutations } = await setup(width);
    const conversation = await pal.harness.conversation(saved.conversationId, context);
    if (conversation === undefined) throw new Error("missing fixture conversation");
    await conversation.submit(
      {
        type: "write",
        entry: { kind: "pi.assistant", model: [fauxAssistantMessage("Saved reply before connecting")] },
      },
      context,
    );
    const seen = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const done = Promise.withResolvers<undefined>();
    let started = false;
    await page.route(`**/api/chats/${saved.id}/events`, async (route) => {
      started = true;
      seen.resolve(undefined);
      try {
        await release.promise;
        await route.continue();
      } finally {
        done.resolve(undefined);
      }
    });
    cleanups.push(async () => {
      release.resolve(undefined);
      if (started) await done.promise;
    });
    await page.goto(`${base}/#/chat/${saved.id}`);
    await seen.promise;
    const input = page.getByLabel("Message", { exact: true });
    await input.fill("Keep this while history loads");
    const loading = page.getByRole("status").filter({ hasText: "Loading saved conversation" });
    await loading.waitFor({ timeout: 5000 });
    await screenshot(page, `chat-loading-${width}`);
    release.resolve(undefined);
    await page.getByText("Saved reply before connecting", { exact: true }).waitFor();
    expect(await loading.count()).toBe(0);
    expect(await input.inputValue()).toBe("Keep this while history loads");
    expect(mutations).toEqual([]);
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });

  it.each([1440, 390])("keeps unconfirmed command outcomes distinct after a server restart at %s px", async (width) => {
    const { pal, page, base, project, saved, provider, errors, mutations, restart } = await setup(width);
    const conversation = await pal.harness.conversation(saved.conversationId, context);
    if (conversation === undefined) throw new Error("missing fixture conversation");
    const marker = join(project.root, "must-not-run");
    const command = `touch ${JSON.stringify(marker)}`;
    for (const shell of [
      { callId: "unconfirmed-call", command, status: "started" },
      { callId: "completed-call", command: "printf done", status: "started" },
      { callId: "completed-call", command: "printf done", status: "finished", exitCode: 0, output: "done" },
    ])
      await conversation.submit(
        { type: "write", entry: { kind: "pal.shell", data: { shell: { cwd: project.root, ...shell } } } },
        context,
      );
    await bridgeChatEvents(page);
    await page.goto(`${base}/#/chat/${saved.id}`);
    const uncertain = page.locator("details.activity").filter({ hasText: command });
    await uncertain.getByText("Outcome unconfirmed", { exact: true }).waitFor({ timeout: 5000 });
    await uncertain.locator("summary").click();
    await uncertain.getByText("Call unconfirmed-call", { exact: true }).waitFor();
    await uncertain.getByText("No completion receipt yet.", { exact: false }).waitFor();
    const input = page.getByLabel("Message", { exact: true });
    await input.fill("Keep this across restart");
    const snapshots = () => page.locator("html").getAttribute("data-chat-snapshots").then(Number);
    const before = await snapshots();
    const reopened = await restart();
    await expect.poll(snapshots, { timeout: 15_000 }).toBeGreaterThan(before);
    await uncertain.getByText("Outcome unconfirmed", { exact: true }).waitFor();
    expect(await page.getByRole("status").filter({ hasText: "Running" }).count()).toBe(0);
    expect(
      await page
        .locator("details.activity")
        .filter({ hasText: "printf done" })
        .getByText("Exit 0", { exact: true })
        .count(),
    ).toBe(1);
    expect(await uncertain.getByRole("button", { name: /retry|repeat|run again/i }).count()).toBe(0);
    expect(await input.inputValue()).toBe("Keep this across restart");
    expect((await reopened.approvals.view(saved.id)).approvals).toEqual([]);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mutations).toEqual([]);
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("keeps the draft and retries while the chat stream is unreachable on first load", async () => {
    const { page, base, saved, provider, errors } = await setup(1440);
    let blocked = true;
    await page.route(`**/api/chats/${saved.id}/events`, (route) =>
      blocked ? route.abort("connectionrefused") : route.continue(),
    );
    await page.goto(`${base}/#/chat/${saved.id}`);
    const input = page.getByLabel("Message", { exact: true });
    await input.fill("Keep this while offline");
    const offline = page.getByRole("status").filter({ hasText: "Can't reach Pal yet; retrying." });
    await offline.waitFor();
    await screenshot(page, "chat-unreachable-1440");
    blocked = false;
    await page.getByRole("heading", { name: "Start the conversation" }).waitFor({ timeout: 15_000 });
    expect(await offline.count()).toBe(0);
    expect(await input.inputValue()).toBe("Keep this while offline");
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("offers an explicit reconnect when the server refuses the chat stream", async () => {
    const { page, base, saved, provider, errors } = await setup(390);
    let refuse = true;
    await page.route(`**/api/chats/${saved.id}/events`, (route) =>
      refuse ? route.fulfill({ status: 503, body: "unavailable" }) : route.continue(),
    );
    await page.goto(`${base}/#/chat/${saved.id}`);
    const input = page.getByLabel("Message", { exact: true });
    await input.fill("Keep this after a refusal");
    const closed = page.getByRole("alert").filter({ hasText: "Pal stopped sending this chat's updates." });
    await closed.waitFor();
    await screenshot(page, "chat-stream-closed-390");
    refuse = false;
    await closed.getByRole("button", { name: "Reconnect", exact: true }).click();
    await page.getByRole("heading", { name: "Start the conversation" }).waitFor();
    expect(await closed.count()).toBe(0);
    expect(await input.inputValue()).toBe("Keep this after a refusal");
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("links an unconfirmed send's request ID to its durable admission in chat diagnostics", async () => {
    const { page, base, other, errors } = await setup(1440);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.goto(`${base}/#/chat/${other.id}`);
    await page.getByLabel("Message", { exact: true }).fill("Admit me, then lose the reply");
    await expect.poll(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
    const posted = Promise.withResolvers<string>();
    await page.route(
      `**/api/chats/${other.id}/inputs`,
      async (route) => {
        await route.fetch({ timeout: 5000 });
        posted.resolve(route.request().postData() ?? "");
        await route.abort("failed");
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const { requestId } = JSON.parse(await posted.promise) as { requestId: string };
    const unconfirmed = page.getByRole("alert").filter({ hasText: "This send isn't confirmed." });
    await unconfirmed.getByText(`Request ${requestId}`, { exact: true }).waitFor();
    await unconfirmed.getByRole("button", { name: "Copy diagnostics", exact: true }).click();
    await unconfirmed.getByRole("button", { name: "Copied", exact: true }).waitFor();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as {
      chat: { inputs: { requestId: string; state: string; submissionId: number | null }[] };
    };
    expect(copied.chat.inputs).toContainEqual(
      expect.objectContaining({ requestId, state: "admitted", submissionId: expect.any(Number) }),
    );
    expect(errors).toEqual([]);
  });

  it("copies redacted installation and chat diagnostics for support", async () => {
    const { page, base, saved, provider, errors } = await setup(1440);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    const clipboard = async () => JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as unknown;
    await page.goto(`${base}/#/settings/general`);
    await page.getByRole("button", { name: "Copy diagnostics", exact: true }).click();
    await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
    const installation = await clipboard();
    expect(installation).toMatchObject({
      format: 1,
      providers: expect.arrayContaining([{ id: "openrouter", enabled: true, hasKey: true }]),
    });

    await page.route(`**/api/chats/${saved.id}/events`, (route) => route.fulfill({ status: 503, body: "unavailable" }));
    await page.goto(`${base}/#/chat/${saved.id}`);
    const closed = page.getByRole("alert").filter({ hasText: "Pal stopped sending this chat's updates." });
    await closed.getByRole("button", { name: "Copy diagnostics", exact: true }).click();
    await closed.getByRole("button", { name: "Copied", exact: true }).waitFor();
    expect(await clipboard()).toMatchObject({ chat: { chat: saved.id, running: false, inputs: [] } });
    const exported = JSON.stringify([installation, await clipboard()]);
    for (const secret of [GOOD_KEY, "correct horse battery", provider.origin]) expect(exported).not.toContain(secret);
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("shows a failed Stop and lets the owner try again without an unhandled rejection", async () => {
    const { page, base, saved, errors, mutations } = await setup(1440);
    const emit = await bridgeChatEvents(page);
    let fail = true;
    await page.route(`**/api/chats/${saved.id}/stop`, (route) =>
      fail
        ? route.fulfill({ status: 503, json: { error: "fixture", message: "Stop is unavailable." } })
        : route.continue(),
    );
    await page.goto(`${base}/#/chat/${saved.id}`);
    await expect.poll(() => page.locator("html").getAttribute("data-chat-approvals")).toBe("seen");
    await emit("event", { type: "run_start" });
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await stop.click();
    const failed = page.getByRole("alert").filter({ hasText: "Stop didn't reach Pal: Stop is unavailable." });
    await failed.waitFor();
    expect(await page.getByRole("status").filter({ hasText: "Running" }).count()).toBe(1);
    await screenshot(page, "chat-stop-failed-1440");
    fail = false;
    const stopped = page.waitForResponse(
      (reply) => new URL(reply.url()).pathname === `/api/chats/${saved.id}/stop` && reply.status() === 200,
    );
    await stop.click();
    await stopped;
    await expect.poll(() => failed.count()).toBe(0);
    expect(mutations).toEqual([`POST /api/chats/${saved.id}/stop`, `POST /api/chats/${saved.id}/stop`]);
    expect(errors).toEqual([]);
  });
});

describe("long transcript updates", () => {
  it("keeps history, draft, scroll and approval order while live text changes and reconnects reset it", async () => {
    const { pal, page, base, saved, provider, errors } = await setup(1440);
    const conversation = await pal.harness.conversation(saved.conversationId, context);
    if (conversation === undefined) throw new Error("missing fixture chat");
    for (let index = 0; index < 80; index++) {
      await conversation.submit(
        { type: "write", entry: { kind: "pi.assistant", model: [fauxAssistantMessage(`History ${index}`)] } },
        context,
      );
    }
    const emit = await bridgeChatEvents(page);
    await page.goto(`${base}/#/chat/${saved.id}`);
    await page.getByText("History 79", { exact: true }).waitFor();
    // Synthetic approvals must not race the server's initial view.
    await expect.poll(() => page.locator("html").getAttribute("data-chat-approvals")).toBe("seen");
    const snapshot = JSON.parse((await page.locator("html").getAttribute("data-chat-snapshot")) ?? "{}") as {
      entries: { id: number }[];
    };
    expect(snapshot.entries).toHaveLength(80);
    const pending = (id: string, assistant: number | null, command: string) => ({
      id,
      assistant,
      tool: "shell_run",
      command,
      cwd: "/fixture",
      timeout: 30,
      digest: "a".repeat(64),
      state: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      decidedAt: null,
    });
    await emit("approvals", {
      mode: "ask",
      approvals: [pending("turn", snapshot.entries[40]?.id ?? null, "echo turn"), pending("loose", null, "echo loose")],
    });
    const input = page.getByLabel("Message", { exact: true });
    await input.fill("Keep this draft");
    await page.locator(".scroller").evaluate((node) => (node.scrollTop = node.scrollHeight / 3));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const scrollBefore = await page.locator(".scroller").evaluate((node) => node.scrollTop);
    const order = () =>
      page
        .locator(".transcript > .item")
        .evaluateAll((items) =>
          items.map(
            (item) => item.querySelector(".cmd")?.textContent ?? item.querySelector(".md")?.textContent?.trim(),
          ),
        );
    await emit("event", { type: "message_start", message: fauxAssistantMessage("Live") });
    for (let index = 0; index < 20; index++)
      await emit("event", { type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "." }] });
    const history = Array.from({ length: 80 }, (_, index) => `History ${index}`);
    await expect
      .poll(order)
      .toEqual([...history.slice(0, 41), "echo turn", ...history.slice(41), "echo loose", `Live${".".repeat(20)}`]);
    expect(await page.locator(".scroller").evaluate((node) => node.scrollTop)).toBe(scrollBefore);
    expect(await input.inputValue()).toBe("Keep this draft");
    expect(await input.evaluate((node) => node === document.activeElement)).toBe(true);

    // A reconnect replaces live state from the server snapshot: the stale partial goes, new history arrives.
    await emit("error");
    await page.getByRole("status").filter({ hasText: "Reconnecting to Pal" }).waitFor();
    const appended = { id: Math.max(...snapshot.entries.map((entry) => entry.id)) + 1, kind: "pi.assistant" };
    await emit("snapshot", {
      ...snapshot,
      entries: [...snapshot.entries, { ...appended, model: [fauxAssistantMessage("History 80")] }],
    });
    await expect
      .poll(order)
      .toEqual([...history.slice(0, 41), "echo turn", ...history.slice(41), "History 80", "echo loose"]);
    expect(await page.getByRole("status").filter({ hasText: "Reconnecting to Pal" }).count()).toBe(0);
    await emit("snapshot", { ...snapshot, generation: { message: fauxAssistantMessage("Resumed") } });
    await expect
      .poll(order)
      .toEqual([...history.slice(0, 41), "echo turn", ...history.slice(41), "echo loose", "Resumed"]);
    expect(await input.inputValue()).toBe("Keep this draft");
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("scheduled messages", () => {
  it.each([1440, 390])(
    "needs the opt-in, shows cost and effects, then schedules, pauses, resumes and cancels at %s px",
    async (width) => {
      const { pal, page, base, saved, provider, errors } = await setup(width);
      const message = page.getByLabel("Message", { exact: true });
      const openDialog = async () => {
        await page.getByRole("button", { name: "Add", exact: true }).click();
        await page.getByRole("menuitem", { name: /Schedule a message/ }).click();
        return page.getByRole("dialog", { name: "Schedule a message" });
      };
      await page.goto(`${base}/#/chat/${saved.id}`);
      await message.fill("Check the nightly build");
      const off = await openDialog();
      await off.getByText("Scheduled messages are off").waitFor();
      await off.getByRole("button", { name: "Open Settings" }).click();
      const toggle = page.getByRole("switch", { name: /^Scheduled messages/ });
      await toggle.check();
      await expect.poll(() => pal.schedules.enabled()).toBe(true);

      await page.goto(`${base}/#/chat/${saved.id}`);
      const dialog = await openDialog();
      const notice = dialog.getByRole("note");
      await notice.getByText(/claude-haiku-4-5 on Anthropic API, reasoning/).waitFor();
      await notice.getByText(/Pay per token on your Anthropic API account/).waitFor();
      await notice.getByText(/Ask for approval/).waitFor();
      expect(await dialog.getByLabel("Message").inputValue()).toBe("Check the nightly build");
      await dialog.getByLabel("Time", { exact: true }).fill("07:30");
      await dialog.getByLabel("Time zone").fill("UTC");
      await screenshot(page, `schedule-notice-${width}`);
      await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
      const item = dialog.getByRole("listitem").filter({ hasText: "Every day at 07:30 (UTC)" });
      await item.getByText("active", { exact: true }).waitFor();
      await screenshot(page, `schedule-list-${width}`);
      await item.getByRole("button", { name: "Pause" }).click();
      await item.getByText("paused", { exact: true }).waitFor();
      await item.getByRole("button", { name: "Resume with current settings" }).click();
      await item.getByText("active", { exact: true }).waitFor();
      await item.getByRole("button", { name: "Cancel" }).click();
      await item.getByText("cancelled", { exact: true }).waitFor();
      expect(await pal.schedules.list(saved.id)).toMatchObject([
        { text: "Check the nightly build", state: "cancelled", binding: { mode: "ask" }, fired: 0 },
      ]);
      expect(provider.requests).toEqual([]);
      expect(errors).toEqual([]);
    },
  );
});

describe("research helper status", () => {
  it.each([1440, 390])(
    "recovers status without letting an older response hide an unknown effect at %s px",
    async (width) => {
      const { pal, page, base, saved, provider, errors, mutations } = await setup(width);
      const conversation = await pal.harness.conversation(saved.conversationId, context);
      if (conversation === undefined) throw new Error("missing fixture conversation");
      await conversation.submit(
        {
          type: "write",
          entry: {
            kind: "pal.helper",
            data: { helper: { task: 42, conversation: 43, purpose: "Find the build result" } },
          },
        },
        context,
      );
      const emit = await bridgeChatEvents(page);
      const pending = Promise.withResolvers<undefined>(),
        release = Promise.withResolvers<undefined>();
      cleanups.push(async () => release.resolve(undefined));
      let requests = 0;
      const stopped = {
        task: 42,
        conversation: 43,
        purpose: "Find the build result",
        status: "unanswered",
        reason: "its time limit passed",
        turns: 2,
        calls: 3,
        tokens: 10,
        unknownEffects: [{ tool: "mcp__web__search", task: 44 }],
      };
      await page.route(`**/api/chats/${saved.id}/helpers`, async (route) => {
        const request = ++requests;
        if (request === 1) {
          await route.fulfill({ status: 503, json: { error: "fixture", message: "Status unavailable" } });
          return;
        }
        if (request === 2) {
          pending.resolve(undefined);
          await release.promise;
        }
        await route.fulfill({
          json: {
            helpers: [request === 2 ? { ...stopped, status: "running", reason: null, unknownEffects: [] } : stopped],
          },
        });
      });
      await page.goto(`${base}/#/chat/${saved.id}`);
      const alert = page.getByRole("alert").filter({ hasText: "Couldn't load helper status" });
      await alert.waitFor({ timeout: 5000 });
      const note = page.locator(".note.helper");
      expect(await note.innerText()).not.toContain("working");
      await alert.getByRole("button", { name: "Retry helper status" }).click();
      await pending.promise;
      try {
        const snapshot = JSON.parse((await page.locator("html").getAttribute("data-chat-snapshot")) ?? "{}");
        await emit("snapshot", { ...snapshot, run: { inputs: [1] }, inbox: [] });
        await note.getByText("stopped: its time limit passed", { exact: true }).waitFor();
        expect(await note.innerText()).toContain("Outcome unknown for mcp__web__search; check before repeating.");
        const oldResponse = page.waitForResponse((response) => response.url().endsWith(`/chats/${saved.id}/helpers`));
        release.resolve(undefined);
        await (await oldResponse).finished();
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
        expect(await note.innerText()).toContain("stopped: its time limit passed");
        expect(await note.innerText()).toContain("Outcome unknown for mcp__web__search");
        expect(await note.innerText()).not.toContain("working");
        await emit("event", { type: "run_end" });
        await screenshot(page, `helper-recovery-${width}`);
        expect(mutations).toEqual([]);
        expect(provider.requests).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        release.resolve(undefined);
      }
    },
  );
});

describe("browser address drafts", () => {
  it.each([1440, 390])(
    "keeps an unsent address through unrelated state, but not across tabs or control at %s px",
    async (width) => {
      const { page, base, project, saved, provider, errors } = await setup(width);
      await page.route(`**/api/projects/${project.id}/browser`, (route) =>
        route.fulfill({ json: { available: true, running: false } }),
      );
      const connected = Promise.withResolvers<WebSocketRoute>();
      const sent: string[] = [];
      const state = {
        type: "state",
        epoch: 1,
        control: true,
        mode: "human",
        busy: false,
        agent: null,
        viewport: { width: 1280, height: 800 },
        tabs: [{ id: "first", url: "about:blank", active: true }],
        dialog: null,
      };
      await page.routeWebSocket(`**/api/projects/${project.id}/browser/socket`, (socket) => {
        socket.onMessage((data) => sent.push(String(data)));
        socket.send(JSON.stringify(state));
        connected.resolve(socket);
      });
      await page.goto(`${base}/#/chat/${saved.id}`);
      if (width < 700) await page.getByRole("button", { name: "Workspace tools" }).click();
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Workspace panel" });
      await panel.getByRole("button", { name: "Open browser" }).click();
      await panel.getByText("You control this browser").waitFor();
      const socket = await connected.promise;
      const destination = "https://destination.example/unsent";
      const address = panel.getByLabel("Address");
      const size = panel.getByLabel("Page size");
      await address.fill(destination);
      await size.focus();
      socket.send(JSON.stringify({ ...state, viewport: { width: 768, height: 1024 } }));
      await expect.poll(() => size.inputValue()).toBe("Tablet");
      expect(await address.inputValue()).toBe(destination);
      await panel.getByRole("button", { name: "Go", exact: true }).click();
      await expect
        .poll(() => sent.map((value) => JSON.parse(value) as unknown))
        .toContainEqual({
          type: "navigate",
          url: destination,
          epoch: state.epoch,
        });
      await address.fill("https://unused.example/first-tab-draft");
      const tabs = [
        { id: "first", url: destination, active: false },
        { id: "second", url: "https://second.example/", active: true },
      ];
      socket.send(JSON.stringify({ ...state, tabs }));
      await panel.getByRole("tab", { name: "https://second.example/", exact: true }).waitFor();
      expect(await address.inputValue()).toBe("https://second.example/");
      await address.fill("https://unused.example/second-tab-draft");
      socket.send(JSON.stringify({ ...state, tabs, control: false, mode: "paused" }));
      await panel.getByText("Paused", { exact: true }).waitFor();
      expect(await address.inputValue()).toBe("https://second.example/");
      expect(await address.isDisabled()).toBe(true);
      expect(provider.requests).toEqual([]);
      expect(errors).toEqual([]);
    },
  );
});
