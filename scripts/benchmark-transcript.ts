import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Browser, chromium, type Page } from "playwright-core";
import { createApi } from "../src/core/api.ts";
import { openPal } from "../src/core/app.ts";
import { startServer } from "../src/core/server.ts";
import { GOOD_KEY, startProviderFixture } from "../test/fixtures/provider-server.ts";
import { distribution, sampleCount } from "./benchmark-startup.ts";

const ENTRIES = 500;
const UPDATES = 60;
type Cleanups = (() => Promise<unknown>)[];

/** A fresh loopback Pal with fake provider keys and one chat holding `entries` committed assistant messages. */
async function startFixture(webRoot: string, entries: number, cleanups: Cleanups) {
  const provider = await startProviderFixture();
  cleanups.push(provider.close);
  const root = await mkdtemp(join(tmpdir(), "pal-transcript-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pal = await openPal(
    {
      dataRoot: join(root, "data"),
      installRoot: "/nonexistent",
      providerOrigin: provider.origin,
      guidanceHome: join(root, "home"),
    },
    context,
  );
  cleanups.push(() => pal.close());
  const token = await pal.owner.setup(pal.owner.setupToken, "correct horse battery");
  const server = await startServer({ host: "127.0.0.1", port: 0, version: "benchmark", webRoot, api: createApi(pal) });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/${path}`, {
      method: "PUT",
      headers: { origin: base, cookie: `pal_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `Could not configure ${path}.`);
  };
  await put("providers/openrouter/key", { key: GOOD_KEY });
  await put("providers/openrouter/enabled", { enabled: true });
  await put("default-model", { provider: "openrouter", model: "~deepseek/deepseek-flash-latest" });
  const project = await pal.projects.create("benchmark-project", { name: "Benchmark" });
  const chat = await pal.chats.createChat("benchmark-chat", { projectId: project.id, title: "Long chat" }, context);
  assert.equal((await pal.workspaces.info(chat.id))?.state, "ready");
  const conversation = await pal.harness.conversation(chat.conversationId, context);
  assert(conversation !== undefined);
  for (let index = 0; index < entries; index++) {
    const text = `Profile row ${index}\n\nText with **bold**, \`inline\` and several words. `.repeat(3);
    await conversation.submit(
      { type: "write", entry: { kind: "pi.assistant", model: [fauxAssistantMessage(text)] } },
      context,
    );
  }
  return { base, token, chat, provider };
}

/** The chat stream API a bundle speaks: Pi 1.5's view changes, or the native events of earlier bundles. */
type Protocol = "view" | "events";
/** The path of the live answer's first text block within a conversation view. */
const LIVE_TEXT = ["docs", "pi.live", "generation", "message", "content", 0, "text"];

/** Sends live text through the page's own chat event stream, timing each update to the next animation frame. */
async function measureLiveText(page: Page, updates: number, protocol: Protocol) {
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  const metrics = async () =>
    new Map((await client.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]));
  const before = await metrics();
  const message = fauxAssistantMessage("Live profile");
  // The same answer and appends in each API: a view change, or a native event.
  const [start, update] =
    protocol === "view"
      ? [[["s", ["docs", "pi.live"], { generation: { attempt: 1, message } }]], [["a", LIVE_TEXT, "."]]]
      : [
          { type: "message_start", message },
          { type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "." }] },
        ];
  const frames = await page.evaluate(
    async ([payloads, updates]) => {
      const [start, update] = JSON.parse(payloads) as [unknown, unknown];
      const emit = (data: unknown) =>
        dispatchEvent(new CustomEvent("pal-benchmark-event", { detail: JSON.stringify(data) }));
      emit(start);
      const frames: number[] = [];
      for (let index = 0; index < updates; index++) {
        const started = performance.now();
        emit(update);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        frames.push(performance.now() - started);
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return frames;
    },
    [JSON.stringify([start, update]), updates] as const,
  );
  const after = await metrics();
  const milliseconds = (name: string) => {
    const start = before.get(name),
      end = after.get(name);
    assert(start !== undefined && end !== undefined, `Chromium did not report ${name}.`);
    return (end - start) * 1000;
  };
  return {
    taskMs: milliseconds("TaskDuration"),
    scriptMs: milliseconds("ScriptDuration"),
    layoutMs: milliseconds("LayoutDuration"),
    styleMs: milliseconds("RecalcStyleDuration"),
    framesMs: frames.reduce((sum, frame) => sum + frame, 0),
    slowestFrameMs: Math.max(...frames),
  };
}

/** One fresh fixture and browser context; a sample counts only if the transcript stays exact and undisturbed. */
export async function sampleTranscript(browser: Browser, webRoot: string, entries = ENTRIES, updates = UPDATES) {
  const cleanups: Cleanups = [];
  try {
    const { base, token, chat, provider } = await startFixture(webRoot, entries, cleanups);
    const view = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    cleanups.push(() => view.close());
    await view.addCookies([{ name: "pal_session", value: token, url: base, httpOnly: true, sameSite: "Strict" }]);
    // Nothing leaves the loopback fixture.
    await view.route("**/*", (route) =>
      new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
    );
    const page = await view.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Forwards page-dispatched benchmark events into the chat's event stream, as if the server had sent them, in the
    // API the bundle subscribes to. A bundle from before Pi 1.5 gets each snapshot in its own native-event form.
    await page.addInitScript(() => {
      const Native = window.EventSource;
      const host = window as Window & { palBenchmarkSnapshot?: string; palBenchmarkProtocol?: Protocol };
      type View = { entries: unknown[]; docs: Record<string, Record<string, unknown> | undefined> };
      const legacy = ({ view, earlier }: { view: View; earlier: unknown[] }) => {
        const live = view.docs["pi.live"] ?? {};
        return {
          entries: [...earlier, ...view.entries],
          run: live.run,
          generation: live.generation,
          tools: live.tools ?? [],
          nestedTools: live.nestedTools ?? [],
          compactions: live.compactions ?? [],
          compactionFailure: live.compactionFailure,
          inbox: view.docs["pi.inbox"]?.items ?? [],
          agent: view.docs["pi.agent"] ?? {},
          usage: view.docs["pi.usage"] ?? { models: {}, tools: {} },
        };
      };
      window.EventSource = class extends Native {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          if (!String(url).includes("/events")) return;
          const add = this.addEventListener.bind(this) as (type: string, listener: (event: Event) => void) => void;
          this.addEventListener = ((type: string, listener: (event: MessageEvent<string>) => void) => {
            if (type === "change") host.palBenchmarkProtocol = "view";
            else if (type === "event") host.palBenchmarkProtocol ??= "events";
            add(type, (event) => {
              const message = event as MessageEvent<string>;
              listener(
                type === "snapshot" && host.palBenchmarkProtocol === "events"
                  ? new MessageEvent("snapshot", { data: JSON.stringify(legacy(JSON.parse(message.data))) })
                  : message,
              );
            });
          }) as typeof this.addEventListener;
          // The first snapshot, which the benchmark later sends again as a reconnect would.
          add("snapshot", (event) => (host.palBenchmarkSnapshot ??= (event as MessageEvent<string>).data));
          addEventListener("pal-benchmark-event", (event) =>
            this.dispatchEvent(
              new MessageEvent(host.palBenchmarkProtocol === "view" ? "change" : "event", {
                data: (event as CustomEvent<string>).detail,
              }),
            ),
          );
          addEventListener("pal-benchmark-snapshot", (event) =>
            this.dispatchEvent(new MessageEvent("snapshot", { data: (event as CustomEvent<string>).detail })),
          );
        }
      };
    });
    await page.goto(`${base}/#/chat/${chat.id}`);
    await page
      .getByText(`Profile row ${entries - 1}`, { exact: true })
      .first()
      .waitFor({ timeout: 15_000 });
    const input = page.getByLabel("Message", { exact: true });
    await input.fill("Preserve my draft and focus");
    const scroller = page.locator(".scroller");
    const settle = () =>
      page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // The scroller is column-reverse: 0 is the newest end and older history lies at negative offsets.
    await scroller.evaluate((node) => (node.scrollTop = -(node.scrollHeight - node.clientHeight) / 3));
    await settle();
    const anchor = await scroller.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const rows = [...node.querySelectorAll(".assistant")];
      const middle = box.top + box.height / 2;
      const index = rows.findIndex((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top <= middle && rect.bottom >= middle;
      });
      return { index, scrollTop: node.scrollTop, text: rows[index]?.querySelector("p")?.textContent };
    });
    assert(
      anchor.scrollTop < 0 &&
        anchor.index >= 0 &&
        anchor.index < entries - 3 &&
        anchor.text === `Profile row ${anchor.index}`,
      "The benchmark did not reach older history.",
    );
    const offset = () =>
      scroller.evaluate(
        (node, index) =>
          (node.querySelectorAll(".assistant")[index]?.getBoundingClientRect().top ?? Number.NaN) -
          node.getBoundingClientRect().top,
        anchor.index,
      );
    const visible = await offset();
    const steady = async (step: string) =>
      assert(Math.abs((await offset()) - visible) <= 1, `The visible history moved during ${step}.`);
    const protocol = await page.evaluate(
      () => (window as Window & { palBenchmarkProtocol?: Protocol }).palBenchmarkProtocol,
    );
    assert(protocol !== undefined, "The page never subscribed to its chat stream.");
    const sample = await measureLiveText(page, updates, protocol);

    // A fast but wrong transcript is not a measurement.
    const text = "Live profile" + ".".repeat(updates);
    const exact = async (step: string) => {
      assert.equal(
        await page.locator(".assistant .md").count(),
        entries + 1,
        `History was not fully rendered ${step}.`,
      );
      assert.equal(
        await page.locator(".assistant .md").last().locator("p").textContent(),
        text,
        `The live text is not exact ${step}.`,
      );
    };
    await steady("live text");
    await exact("after live text");
    // The answer commits, then a reconnect replaces the transcript with a snapshot; the reader's place holds.
    const emit = (name: "event" | "snapshot", data: unknown) =>
      page.evaluate(([type, detail]) => dispatchEvent(new CustomEvent(type, { detail })), [
        `pal-benchmark-${name}`,
        JSON.stringify(data),
      ] as const);
    type Entry = { id: number };
    const snapshot = JSON.parse(
      await page.evaluate(() => (window as Window & { palBenchmarkSnapshot?: string }).palBenchmarkSnapshot ?? "{}"),
    ) as { view: { entries: Entry[] }; earlier: Entry[] };
    const history = [...snapshot.earlier, ...snapshot.view.entries];
    assert.equal(history.length, entries, "The page did not receive the fixture's snapshot.");
    const committed = {
      id: Math.max(...history.map((entry) => entry.id)) + 1,
      kind: "pi.assistant",
      model: [fauxAssistantMessage(text)],
    };
    await emit(
      "event",
      protocol === "view"
        ? [
            ["p", ["entries"], snapshot.view.entries.length, 0, [committed]],
            ["d", ["docs", "pi.live", "generation"]],
          ]
        : { type: "message_end", message: committed.model[0], entry: committed },
    );
    await settle();
    await steady("the commit");
    await exact("after the commit");
    await emit("snapshot", { ...snapshot, view: { ...snapshot.view, entries: [...snapshot.view.entries, committed] } });
    await settle();
    await steady("snapshot replacement");
    await exact("after snapshot replacement");
    assert.equal(await input.inputValue(), "Preserve my draft and focus", "The draft changed.");
    assert(await input.evaluate((node) => node === document.activeElement), "The composer lost focus.");
    assert.deepEqual(provider.requests, [], "The benchmark reached a model provider.");
    assert.deepEqual(errors, [], "The page reported errors.");
    return sample;
  } finally {
    for (const cleanup of cleanups.toReversed()) await cleanup();
  }
}

async function main(args: readonly string[]) {
  assert(args.length >= 1 && args.length <= 2, "Usage: pal-benchmark-transcript <web root> [3–25 samples]");
  const [input, requestedCount] = args;
  assert(input !== undefined);
  const count = sampleCount(requestedCount);
  const webRoot = await realpath(input);
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  const entry = /src="(\/assets\/[^"]+\.js)"/.exec(index)?.[1];
  assert(entry !== undefined, "The web root has no application entry.");
  const digest = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const samples: Awaited<ReturnType<typeof sampleTranscript>>[] = [];
    for (let i = 0; i < count; i++) samples.push(await sampleTranscript(browser, webRoot));
    return {
      format: 1,
      scenario: "long-transcript-live-text",
      workload: { entries: ENTRIES, updates: UPDATES, viewport: "1440x900" },
      metrics: "Chromium CDP task/script/layout/style durations and requestAnimationFrame waits during updates",
      limits: "this tree's server and fixture with the selected web bundle; not network, model or full-page latency",
      identity: {
        webRoot,
        index: createHash("sha256").update(index).digest("hex"),
        entry: await digest(join(webRoot, entry)),
      },
      browser: browser.version(),
      host: {
        os: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
        node: process.version,
      },
      samples,
      summary: Object.fromEntries(
        (["taskMs", "scriptMs", "layoutMs", "styleMs", "framesMs", "slowestFrameMs"] as const).map((key) => [
          key,
          distribution(samples.map((sample) => sample[key])),
        ]),
      ),
    };
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `pal-benchmark-transcript: ${error instanceof Error ? error.message : "measurement failed"}\n`,
    );
    process.exitCode = 1;
  }
}
