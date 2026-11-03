// Adding a plugin is its folder plus its line in plugins/index.ts. This adds the example test plugin to a copy of the
// source that way, builds the interface and the server from that copy, uses the plugin's panel and entry renderer,
// fails its panel's import, then reopens the data with a build that lacks the plugin.
import { appendFile, cp, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { build as bundle } from "esbuild";
import { type Browser, chromium } from "playwright-core";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../src/core/api.ts";
import { openPal } from "../../src/core/app.ts";
import { startServer } from "../../src/core/server.ts";

const repo = join(import.meta.dirname, "../..");
const current = { openPal, createApi, startServer };
type Build = typeof current;
let browser: Browser;
let root: string;
let added: Build;

/** Copy a plugin written for test/fixtures/plugins into plugins/, two directories shallower. */
async function install(from: string, to: string) {
  await cp(from, to, { recursive: true });
  for (const entry of await readdir(to, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    await writeFile(path, (await readFile(path, "utf8")).replaceAll('"../../../../', '"../../'));
  }
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  root = await realpath(await mkdtemp(join(tmpdir(), "pal-plugin-build-")));
  for (const path of ["src", "web", "plugins", "vite.config.ts", "tsconfig.json"])
    await cp(join(repo, path), join(root, path), { recursive: true });
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
    await cp(join(repo, file), join(root, file));
  await symlink(await realpath(join(repo, "node_modules")), join(root, "node_modules"), "dir");
  await install(join(repo, "test/fixtures/plugins/example"), join(root, "plugins/example"));
  await appendFile(join(root, "plugins/index.ts"), 'export { default as example } from "./example/server.ts";\n');
  await build({
    configFile: join(root, "vite.config.ts"),
    root: join(root, "web"),
    logLevel: "warn",
    build: { outDir: join(root, "dist/public"), emptyOutDir: true },
  });
  await bundle({
    stdin: {
      contents: ["app", "api", "server"].map((name) => `export * from "./src/core/${name}.ts";`).join("\n"),
      resolveDir: root,
    },
    outfile: join(root, "dist/app.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    packages: "external",
    logLevel: "warning",
  });
  added = await import(pathToFileURL(join(root, "dist/app.mjs")).href);
}, 180_000);
afterAll(async () => {
  await browser?.close();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("a plugin added as its folder and inventory line", () => {
  it("shows its panel, setting and entries, survives a failed panel import and leaves a note once removed", async () => {
    const data = await realpath(await mkdtemp(join(tmpdir(), "pal-plugin-data-")));
    const options = { dataRoot: join(data, "data"), guidanceHome: join(data, "home") };
    let close: () => Promise<unknown> = async () => {};
    const start = async (from: Build, installRoot: string, webRoot: string) => {
      const pal = await from.openPal({ ...options, installRoot }, context);
      const listener = await from.startServer({
        host: "127.0.0.1",
        port: 0,
        version: "test",
        webRoot,
        api: from.createApi(pal),
        upgrade: (request, socket, head) => pal.upgrade(request, socket, head),
      });
      close = async () => {
        close = async () => {};
        listener.closeAllConnections();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        await pal.close();
      };
      return { pal, base: `http://127.0.0.1:${(listener.address() as AddressInfo).port}` };
    };
    try {
      const { pal, base } = await start(added, root, join(root, "dist/public"));
      const token = await pal.owner.setup(pal.owner.setupToken, "correct horse battery");
      const view = await pal.extensions.view();
      await pal.extensions.select({ selected: [...view.selected, { id: "example", version: 1 }], digest: view.digest });
      const project = await pal.projects.create("plugin-project", { name: "Plugins" });
      const chat = await pal.chats.createChat("plugin-chat", { projectId: project.id, title: "With example" }, context);
      await pal.harness.commit(
        (tx) => tx.appendEntry(chat.conversationId, { kind: "pal.example", data: { text: "from the plugin" } }),
        context,
      );
      const open = async (at: string) => {
        const session = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await session.addCookies([{ name: "pal_session", value: token, url: at, httpOnly: true, sameSite: "Strict" }]);
        const page = await session.newPage();
        await page.goto(`${at}/#/chat/${chat.id}`);
        return { session, page };
      };

      const first = await open(base);
      await first.page.getByText("Example echo: from the plugin").waitFor();
      await first.page.getByRole("button", { name: "Example", exact: true }).click();
      await first.page.getByText("Example panel for Plugins · With example").waitFor();
      // Its Settings tab keeps the owner's value through the plugin's own route.
      await first.page.goto(`${base}/#/settings/example`);
      await first.page.getByLabel("Echo prefix").fill("» ");
      await first.page.getByRole("button", { name: "Save prefix" }).click();
      await first.page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
      await first.page.reload();
      await expect.poll(() => first.page.getByLabel("Echo prefix").inputValue()).toBe("» ");
      await first.session.close();

      // A panel whose code doesn't load reports it in place; the rest of the shell keeps working.
      const failed = await open(base);
      await failed.page.route(/\/assets\/ExamplePanel-[^/]+\.js$/, (route) => route.abort());
      await failed.page.getByRole("button", { name: "Example", exact: true }).click();
      await failed.page.getByRole("alert").filter({ hasText: "Couldn't load Example echo" }).waitFor();
      await failed.page.getByRole("button", { name: "Context", exact: true }).click();
      await failed.page.getByRole("heading", { name: "Project instructions" }).waitFor();
      await failed.session.close();

      // Without the plugin, the chat's history keeps its entry as a plain note.
      await close();
      const without = await start(current, "/nonexistent-install", join(repo, "dist/public"));
      const removed = await open(without.base);
      await removed.page.getByText("Recorded by a plugin this build doesn't include.").waitFor();
      await removed.session.close();
    } finally {
      await close();
      await rm(data, { recursive: true, force: true });
    }
  });
});
