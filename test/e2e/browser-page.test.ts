import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOwnerNeeded, BrowserPage, type BrowserActionInput } from "../../src/core/browser-page.ts";
import { privateBrowserPages } from "../fixtures/private-browser-pages.ts";

let browser: Browser;
let page: Page;
let model: BrowserPage;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
});
afterAll(async () => browser.close());
beforeEach(async () => {
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    route.request().url() === "https://embedded.invalid/login"
      ? route.fulfill({ contentType: "text/html", body: '<input type="password" value="protected-canary">' })
      : route.abort(),
  );
  page = await context.newPage();
  model = new BrowserPage(page);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await page.context().close();
});
const input = (observation: string, action: BrowserActionInput["action"]): BrowserActionInput => ({
  session: "fixture",
  epoch: 1,
  observation,
  action,
});
const publicPage =
  '<title>Public fixture</title><p>Public content</p><span id="search-label">Search</span><input name="query" aria-label="Search" aria-labelledby="search-label" value="input-canary"><textarea name="note">textarea-canary</textarea><input type="hidden" name="csrf-token" value="hidden-canary"><button onclick="this.dataset.clicked=\'yes\'">Go</button>';

describe("bounded browser-page privacy", () => {
  it.each(privateBrowserPages)(
    "requires owner control for $id without returning protected content",
    async ({ html }) => {
      await page.setContent(`<title>private-title-canary</title><p>private-text-canary</p>${html}`);
      const observed = await model.observe();
      expect(observed).toMatchObject({ login: true, text: "", title: "", targets: [], truncated: false });
      expect(JSON.stringify(observed)).not.toMatch(/canary/);
      expect(await model.privatePage()).toBe(true);
      expect(() => model.current(observed.observation)).toThrow(/expired or changed/);
      await expect(model.act(input(observed.observation, { type: "key", key: "Enter" }), () => {})).rejects.toThrow();
    },
  );

  it("excludes native field values but retains explicitly approved public text actions", async () => {
    await page.setContent(publicPage);
    const observed = await model.observe();
    expect(observed).toMatchObject({ login: false, truncated: false, title: "Public fixture" });
    expect(observed.text).toContain("Public content");
    expect(JSON.stringify(observed)).not.toMatch(/input-canary|textarea-canary|hidden-canary/);
    const target = observed.targets.find((target) => target.label === "Search");
    if (target === undefined) throw new Error("missing public input");
    await model.act(input(observed.observation, { type: "type", target: target.id, text: "public query" }), () => {});
    expect(await page.getByRole("textbox", { name: "Search" }).inputValue()).toBe("public query");
    expect(() => model.current(observed.observation)).toThrow(/expired or changed/);
  });

  it.each(["name", "autocomplete", "placeholder", "aria-labelledby"])(
    "rejects changed target %s metadata",
    async (attribute) => {
      await page.setContent(publicPage);
      const observed = await model.observe();
      const target = observed.targets.find((target) => target.label === "Search");
      if (target === undefined) throw new Error("missing public input");
      await page
        .locator('input[name="query"]')
        .evaluate((element, attribute) => element.setAttribute(attribute, "changed"), attribute);
      await expect(
        model.act(input(observed.observation, { type: "type", target: target.id, text: "not entered" }), () => {}),
      ).rejects.toThrow();
      expect(await page.getByRole("textbox", { name: "Search" }).inputValue()).toBe("input-canary");
    },
  );

  it("rechecks ambiguous widgets inserted after asynchronous preflight", async () => {
    await page.setContent(publicPage);
    const observed = await model.observe();
    const target = observed.targets.find((target) => target.label === "Go");
    if (target === undefined) throw new Error("missing public button");
    const preflight = model.privatePage.bind(model);
    vi.spyOn(model, "privatePage").mockImplementationOnce(async (guard) => {
      expect(await preflight(guard)).toBe(false);
      await page.evaluate(() =>
        document.body.insertAdjacentHTML("beforeend", '<div contenteditable="true">protected-canary</div>'),
      );
      return false;
    });
    await expect(
      model.act(input(observed.observation, { type: "click", target: target.id }), () => {}),
    ).rejects.toThrow(BrowserOwnerNeeded);
    expect(await page.getByRole("button", { name: "Go" }).getAttribute("data-clicked")).toBeNull();
    expect(() => model.current(observed.observation)).toThrow(/expired or changed/);
  });

  it("hands off a private second step without retaining the previous public observation", async () => {
    await page.setContent(publicPage);
    const observed = await model.observe();
    await page
      .locator('input[name="query"]')
      .evaluate((element) => element.setAttribute("autocomplete", "one-time-code"));
    await expect(model.act(input(observed.observation, { type: "key", key: "Enter" }), () => {})).rejects.toThrow(
      /private or unsupported/,
    );
    expect(() => model.current(observed.observation)).toThrow(/expired or changed/);
  });

  it("does not inspect or offer input targets inside an unrecognizable closed shadow root", async () => {
    await page.setContent(
      '<p>Public content</p><div id="widget"></div><script>document.querySelector("#widget").attachShadow({mode:"closed"}).innerHTML="<input type=password value=protected-canary>"</script>',
    );
    const observed = await model.observe();
    expect(observed).toMatchObject({ login: false, targets: [] });
    expect(observed.text).toContain("Public content");
    expect(JSON.stringify(observed)).not.toContain("protected-canary");
  });

  it("refuses an oversized DOM instead of exporting a partial privacy decision", async () => {
    await page.setContent("<p>uninspected-canary</p>" + "<div></div>".repeat(5001));
    expect(await model.observe()).toMatchObject({ truncated: true, text: "", title: "", targets: [] });
    expect(await model.privatePage()).toBe(true);
  });
});
