import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CompiledCapability } from "../../src/capabilities/contract.ts";
import { createApi } from "../../src/core/api.ts";
import { openPal } from "../../src/core/app.ts";
import { startServer } from "../../src/core/server.ts";
import { type Answer, fakeAdvisor, RUN, withAdvisor } from "../fixtures/advisor.ts";
import { startSystemOneFixture } from "../fixtures/system-one-server.ts";

let browser: Browser;
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
});
afterAll(() => browser.close());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: { definitions?: readonly CompiledCapability[]; providerOrigin?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pal-auto-e2e-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pal = await openPal(
    {
      dataRoot: join(root, "data"),
      installRoot: "/nonexistent",
      guidanceHome: join(root, "host-home"),
      ...(options.providerOrigin === undefined ? {} : { providerOrigin: options.providerOrigin }),
    },
    context,
    options.definitions,
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
  const project = await pal.projects.create("auto-project", { name: "Auto" });
  const chat = await pal.chats.createChat("auto-chat", { projectId: project.id, title: "Auto" }, context);
  expect(await pal.workspaces.info(chat.id)).toMatchObject({ state: "ready" });
  const conversation = await pal.harness.conversation(chat.conversationId, context);
  if (conversation === undefined) throw new Error("missing conversation");
  let inputs = 0;
  /** One input whose script runs `command`. */
  const run = async (command: string, ifUnsafe?: "skip") => {
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const code = `return await tools.shell_run({ command: ${JSON.stringify(command)}, timeout: 5 });`;
    faux.setResponses([
      fauxAssistantMessage(
        ifUnsafe === undefined
          ? fauxToolCall("codemode", { code })
          : fauxToolCall("shell_run", { command, timeout: 5, ifUnsafe }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const model = faux.getModel();
    await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    await pal.chats.submit(chat.id, `auto-input-${++inputs}`, { text: "run the fixture" }, context);
  };
  const open = async (width: number, theme: "dark" | "light" = "dark", hash = `#/chat/${chat.id}`) => {
    const view = await browser.newContext({ viewport: { width, height: 900 } });
    cleanups.push(() => view.close());
    await view.addCookies([{ name: "pal_session", value: token, url: base, httpOnly: true, sameSite: "Strict" }]);
    await view.addInitScript((chosen) => localStorage.setItem("pal.theme", chosen), theme);
    const page = await view.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/${hash}`);
    return { page, errors };
  };
  return { pal, chat, project, run, open, idle: () => conversation.waitForIdle(context) };
}

async function shoot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const root = process.env.PAL_E2E_SCREENSHOTS;
  if (root === undefined) return;
  await mkdir(root, { recursive: true });
  await page.screenshot({ path: join(root, `${name}.png`), animations: "disabled" });
}
const modeButton = (page: Page) => page.getByRole("button", { name: /^Command approval:/ });

describe("Auto command mode in the browser", () => {
  it("offers Auto when ready, notes each decision and explains every card", async () => {
    let ready = true;
    const replies: Answer[] = [RUN, { ...RUN, confidence: 0.62 }, { ...RUN, verdict: "ask", confidence: 0.8 }];
    const advisor = fakeAdvisor(
      () => replies.shift() ?? RUN,
      () => ready,
    );
    const f = await setup({ definitions: withAdvisor(advisor.capability) });
    const { page, errors } = await f.open(1440);
    await page.getByLabel("Message", { exact: true }).waitFor();
    await modeButton(page).click();
    const menu = page.getByRole("radiogroup", { name: "Command approval mode" });
    const auto = menu.getByRole("radio", { name: /^Auto/ });
    await auto.getByText("The fixture decides.").waitFor();
    await shoot(page, "auto-menu-1440-dark");
    await auto.click();
    await expect.poll(() => modeButton(page).getAttribute("aria-label")).toBe("Command approval: Auto");

    await f.run("printf run >> marker");
    await f.idle();
    const line = page.locator(".activity > button.acth").last();
    await line.waitFor();
    if ((await line.getAttribute("aria-expanded")) !== "true") await line.click();
    await page.getByText(/^Approved by Fixture · 96% sure, at /).waitFor();
    expect(await readFile(join(f.project.root, "marker"), "utf8")).toBe("run");

    await f.run("printf unsure >> marker");
    const card = page.getByRole("group", { name: "Approval request" }).last();
    await card.getByText("Fixture wasn't sure (62%)").waitFor();
    await shoot(page, "auto-card-unsure-1440-dark");
    await card.getByRole("button", { name: "Approve once" }).click();
    await f.idle();

    await f.run("sudo printf floor >> marker");
    await card.getByText("Always asks: changes privileges").waitFor();
    await card.getByRole("button", { name: "Deny" }).click();
    await f.idle();
    await f.run("printf optional >> marker", "skip");
    await f.idle();
    const latest = page.locator(".activity > button.acth").last();
    if ((await latest.getAttribute("aria-expanded")) !== "true") await latest.click();
    await page.getByText("Command skipped").waitFor();
    await page
      .getByText(/^Fixture suggested asking \(80% sure\)\. Pal didn't run it and carried on; run it yourself/)
      .waitFor();
    await shoot(page, "auto-skipped-1440-dark");
    expect(await readFile(join(f.project.root, "marker"), "utf8")).toBe("rununsure");
    expect(advisor.calls.map((call) => call.command)).toEqual([
      "printf run >> marker",
      "printf unsure >> marker",
      "printf optional >> marker",
    ]);

    ready = false;
    for (const [width, theme] of [
      [1440, "light"],
      [768, "dark"],
      [390, "light"],
    ] as const) {
      const other = await f.open(width, theme);
      await other.page.getByLabel("Message", { exact: true }).waitFor();
      if (width < 700) await other.page.getByRole("button", { name: "Workspace tools" }).click();
      const button = modeButton(other.page);
      await expect
        .poll(() => button.getAttribute("aria-label"))
        .toBe("Command approval: Auto, unavailable, asking instead");
      await button.click();
      const disabled = other.page.getByRole("radiogroup", { name: "Command approval mode" }).getByRole("radio", {
        name: /^Auto/,
      });
      await disabled.getByText("Unavailable: Add a fixture key in Settings → Fixture").waitFor();
      await other.page.getByText("Auto is unavailable, so this chat asks you").waitFor();
      await shoot(other.page, `auto-unavailable-${width}-${theme}`);
      expect(other.errors).toEqual([]);
    }
    expect(errors).toEqual([]);
  });

  it("keeps Jev's keys write-only in Settings and checks the chosen connection", async () => {
    const fixture = await startSystemOneFixture(["ts-e2e-key-0001", "sk-or-e2e-key-0002"]);
    cleanups.push(fixture.close);
    const f = await setup({ providerOrigin: fixture.origin });
    for (const [width, theme] of [
      [1440, "dark"],
      [768, "light"],
      [390, "dark"],
    ] as const) {
      const { page, errors } = await f.open(width, theme, "#/settings/jev");
      const connections = page.getByRole("radiogroup", { name: "Jev connection" });
      await connections.getByRole("radio", { name: /TypeSafe/ }).waitFor();
      if (width === 1440) {
        expect(await connections.getByRole("radio", { name: /TypeSafe/ }).isChecked()).toBe(true);
        const key = page.getByLabel("Key", { exact: true });
        await key.fill("ts-e2e-key-0001");
        await page.getByRole("button", { name: "Save key" }).click();
        await page.getByRole("button", { name: "Check key (one billed test)" }).click();
        await page.getByText("TypeSafe answered a test classification (billed).").waitFor();
        expect(await page.getByLabel("Replace the key").inputValue()).toBe("");
        expect(await page.content()).not.toContain("ts-e2e-key-0001");
        await connections.getByRole("radio", { name: /OpenRouter/ }).check();
        await page.getByText("OpenRouter API key").waitFor();
        await page.getByLabel("Key", { exact: true }).fill("sk-or-e2e-key-0002");
        await page.getByRole("button", { name: "Save key" }).click();
        await page.getByRole("button", { name: "Check key", exact: true }).click();
        await page.getByText("OpenRouter accepted the key.").waitFor();
        expect(fixture.requests.map(({ path, key }) => [path, key])).toEqual([
          ["/v1/systemone", "ts-e2e-key-0001"],
          ["/api/v1/key", "sk-or-e2e-key-0002"],
        ]);
      }
      await page.getByText("Recent decisions").waitFor();
      await shoot(page, `jev-settings-${width}-${theme}`);
      expect(errors).toEqual([]);
    }
  });
});
