import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CompiledCapability } from "../src/capabilities/contract.ts";
import { openPal, type Pal } from "../src/core/app.ts";
import { ADVICE_TIMEOUT_MS, type CommandApproval } from "../src/core/approvals.ts";
import { PLUGINS } from "../src/core/extensions.ts";
import { type Answer, fakeAdvisor, RUN, withAdvisor } from "./fixtures/advisor.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const shell = (command: string) => `return await tools.shell_run({ command: ${JSON.stringify(command)}, timeout: 5 });`;
const NO_ADVISOR = PLUGINS.filter(({ manifest }) => manifest.advisor === undefined);

function answer(pal: Pal, codes: string[]) {
  const faux = fauxProvider();
  (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  faux.setResponses([
    ...codes.map((code) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" })),
    fauxAssistantMessage("done"),
  ]);
  return faux.getModel();
}

async function setup(definitions: readonly CompiledCapability[]) {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-auto-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const open = (with_: readonly CompiledCapability[]) =>
    openPal({ dataRoot, installRoot: "/nonexistent-install" }, context, with_);
  let pal = await open(definitions);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("auto-project", { name: "Fixture" });
  const chat = await pal.chats.createChat("auto-chat", { projectId: project.id }, context);
  const conversation = async () => {
    const found = await pal.harness.conversation(chat.conversationId, context);
    if (found === undefined) throw new Error("fixture conversation missing");
    return found;
  };
  let inputs = 0;
  /** Run one input whose script calls `command`, until it waits for the owner or finishes. */
  const run = async (command: string) => {
    const model = answer(pal, [shell(command)]);
    await (await conversation()).configure({ model: { provider: model.provider, modelId: model.id } }, context);
    await pal.chats.submit(chat.id, `auto-input-${++inputs}`, { text: "run the fixture" }, context);
    let idle = false;
    void (await conversation()).waitForIdle(context).then(
      () => (idle = true),
      () => {},
    );
    for (let attempt = 0; attempt < 1000; attempt++) {
      const view = await pal.approvals.view(chat.id);
      const pending = view.approvals.find((approval) => approval.state === "pending");
      if (pending !== undefined) return pending;
      if (idle) return view.approvals.at(-1);
      await sleep(10);
    }
    throw new Error("the run neither waited nor finished");
  };
  const idle = async () => (await conversation()).waitForIdle(context);
  return {
    dataRoot,
    project,
    chat,
    run,
    idle,
    marker: () => readFile(join(project.root, "marker"), "utf8").catch(() => ""),
    get pal() {
      return pal;
    },
    reopen: async (with_: readonly CompiledCapability[]) => {
      await pal.close();
      pal = await open(with_);
      return pal;
    },
  };
}

describe("Auto command mode", () => {
  it("runs a confident routine command without a card and asks for anything less", async () => {
    const replies: Answer[] = [RUN, { ...RUN, verdict: "ask", confidence: 0.87 }, { ...RUN, confidence: 0.62 }];
    const advisor = fakeAdvisor(() => replies.shift() ?? RUN);
    const f = await setup(withAdvisor(advisor.capability));
    expect((await f.pal.approvals.view(f.chat.id)).auto).toEqual({
      ready: true,
      label: "Fixture",
      note: "The fixture decides.",
    });
    await f.pal.approvals.setMode(f.chat.id, "auto");

    const routine = await f.run("printf run >> marker");
    await f.idle();
    expect(routine).toMatchObject({
      state: "approved",
      decidedBy: "advisor",
      advice: { by: "advisor", advisor: "Fixture", verdict: "run", confidence: 0.96, threshold: 0.9 },
    } satisfies Partial<CommandApproval>);
    expect(await f.marker()).toBe("run");
    expect(advisor.calls).toEqual([
      {
        tool: "shell_run",
        command: "printf run >> marker",
        cwd: await realpath(f.project.root),
        timeoutSeconds: 5,
        folderAccess: "write",
      },
    ]);

    const suggested = await f.run("printf asked >> marker");
    expect(suggested).toMatchObject({
      state: "pending",
      decidedBy: null,
      advice: { verdict: "ask", confidence: 0.87 },
    });
    if (suggested === undefined) throw new Error("no card");
    await f.pal.approvals.decide(f.chat.id, suggested.id, "approve", suggested.digest);
    await f.idle();
    expect(await f.marker()).toBe("runasked");
    expect((await f.pal.approvals.view(f.chat.id)).approvals.at(-1)).toMatchObject({ decidedBy: "owner" });

    const unsure = await f.run("printf unsure >> marker");
    expect(unsure).toMatchObject({ state: "pending", advice: { verdict: "run", confidence: 0.62 } });
    if (unsure === undefined) throw new Error("no card");
    await f.pal.approvals.decide(f.chat.id, unsure.id, "deny", unsure.digest);
    await f.idle();
    expect(await f.marker()).toBe("runasked");
    expect(advisor.calls).toHaveLength(3);
  });

  it("returns an unsafe command the agent can skip unrun, so it goes on, and still asks for one it needs", async () => {
    const replies: Answer[] = [{ ...RUN, verdict: "ask", confidence: 0.8 }, RUN];
    const advisor = fakeAdvisor(() => replies.shift() ?? RUN);
    const f = await setup(withAdvisor(advisor.capability));
    await f.pal.approvals.setMode(f.chat.id, "auto");
    const direct = (command: string, ifUnsafe?: "skip") =>
      fauxAssistantMessage(
        fauxToolCall("shell_run", { command, timeout: 5, ...(ifUnsafe === undefined ? {} : { ifUnsafe }) }),
        { stopReason: "toolUse" },
      );
    const faux = fauxProvider();
    (f.pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    faux.setResponses([
      direct("printf optional >> marker", "skip"),
      direct("printf next >> marker"),
      direct("sudo printf floor >> marker", "skip"),
      fauxAssistantMessage("Please run `printf optional >> marker` yourself."),
    ]);
    const model = faux.getModel();
    const conversation = await f.pal.harness.conversation(f.chat.conversationId, context);
    await conversation?.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    await f.pal.chats.submit(f.chat.id, "auto-skip-input", { text: "do the work" }, context);
    await f.idle();
    expect(await f.marker()).toBe("next");
    const results = (await conversation?.context(context))?.messages.flatMap((message) =>
      message.role === "toolResult"
        ? [message.content.map((block) => (block.type === "text" ? block.text : "")).join("")]
        : [],
    );
    expect(results?.[0]).toContain(
      "Not run: Fixture judged it needs the owner (80% sure). Continue with other commands if you can",
    );
    expect(results?.[2]).toContain("Not run: this command always needs the owner (changes privileges)");
    expect((await f.pal.approvals.view(f.chat.id)).approvals).toMatchObject([
      { command: "printf optional >> marker", state: "skipped", decidedBy: null, advice: { verdict: "ask" } },
      { command: "printf next >> marker", state: "approved", decidedBy: "advisor" },
      { command: "sudo printf floor >> marker", state: "skipped", advice: { by: "rule" } },
    ]);
    expect(advisor.calls.map((call) => call.command)).toEqual(["printf optional >> marker", "printf next >> marker"]);
  });

  it("asks for hard-floor commands without asking the advisor", async () => {
    const advisor = fakeAdvisor();
    const f = await setup(withAdvisor(advisor.capability));
    await f.pal.approvals.setMode(f.chat.id, "auto");
    for (const command of ["sudo printf x >> marker", "git push origin main", "cat ~/.ssh/id_ed25519"]) {
      const card = await f.run(command);
      expect(card).toMatchObject({ state: "pending", advice: { by: "rule" } });
      if (card === undefined) throw new Error("no card");
      await f.pal.approvals.decide(f.chat.id, card.id, "deny", card.digest);
      await f.idle();
    }
    expect(advisor.calls).toEqual([]);
    expect(await f.marker()).toBe("");
  });

  it("asks the owner, never runs unasked and never denies, when the advisor can't answer", async () => {
    let ready = true;
    const replies: Answer[] = [new Error("connection refused"), "malformed", "hang"];
    const advisor = fakeAdvisor(
      () => replies.shift() ?? RUN,
      () => ready,
    );
    const f = await setup(withAdvisor(advisor.capability));
    await f.pal.approvals.setMode(f.chat.id, "auto");
    const reasons: string[] = [];
    const started = Date.now();
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt === 3) ready = false;
      const card = await f.run("printf ran >> marker");
      expect(card).toMatchObject({ state: "pending", decidedBy: null, advice: { by: "unavailable" } });
      if (card?.advice?.by !== "unavailable") throw new Error("no card");
      reasons.push(card.advice.reason);
      await f.pal.approvals.decide(f.chat.id, card.id, "deny", card.digest);
      await f.idle();
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(ADVICE_TIMEOUT_MS);
    expect(reasons).toEqual([
      "Fixture couldn't decide: connection refused",
      "Fixture gave an unexpected answer.",
      "Fixture couldn't decide: no answer in time",
      "Auto is unavailable: Add a fixture key in Settings → Fixture",
    ]);
    expect(advisor.calls).toHaveLength(3);
    expect(await f.marker()).toBe("");
  }, 30_000);

  it("keeps stored decisions and waiting cards when the mode changes, and offers Auto only when ready", async () => {
    let ready = true;
    const advisor = fakeAdvisor(
      () => ({ ...RUN, verdict: "ask", confidence: 0.7 }),
      () => ready,
    );
    const f = await setup(withAdvisor(advisor.capability));
    await f.pal.approvals.setMode(f.chat.id, "auto");
    const card = await f.run("printf waited >> marker");
    if (card === undefined) throw new Error("no card");
    await f.pal.approvals.setMode(f.chat.id, "ask");
    await f.pal.approvals.setMode(f.chat.id, "full");
    expect((await f.pal.approvals.view(f.chat.id)).approvals).toEqual([card]);
    ready = false;
    await expect(f.pal.approvals.setMode(f.chat.id, "auto")).rejects.toMatchObject({ code: "auto_unavailable" });
    expect((await f.pal.approvals.view(f.chat.id)).mode).toBe("full");
    await f.pal.approvals.decide(f.chat.id, card.id, "approve", card.digest);
    await f.idle();
    expect(await f.marker()).toBe("waited");
    expect(advisor.calls).toHaveLength(1);
  });

  it("treats a chat left in Auto as Ask, with a note, once the advisor is gone", async () => {
    const advisor = fakeAdvisor();
    const f = await setup(withAdvisor(advisor.capability));
    await f.pal.approvals.setMode(f.chat.id, "auto");
    const pal = await f.reopen(NO_ADVISOR);
    expect(await pal.approvals.view(f.chat.id)).toMatchObject({ mode: "auto", auto: { ready: false, label: null } });
    await expect(pal.approvals.setMode(f.chat.id, "auto")).rejects.toMatchObject({ code: "auto_unavailable" });
    const card = await f.run("printf ran >> marker");
    expect(card).toMatchObject({
      state: "pending",
      advice: { by: "unavailable", reason: "Auto is unavailable: No decision model is part of this Pal build." },
    });
    expect(advisor.calls).toEqual([]);
  });

  it("reuses a decision stored before a crash, without asking the advisor again", async () => {
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-auto-kill-")));
    cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
    const calls = join(dataRoot, "advisor-calls");
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        join(import.meta.dirname, "fixtures/auto-child.ts"),
        dataRoot,
        calls,
        "printf once >> marker",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    const [line] = await once(createInterface({ input: child.stdout }), "line");
    const ready = JSON.parse(String(line)) as { root: string; chatId: string };
    const [, signal] = await once(child, "exit");
    expect(signal).toBe("SIGKILL");
    expect(await readFile(calls, "utf8")).toBe("x");
    expect(await readFile(join(ready.root, "marker"), "utf8").catch(() => "")).toBe("");

    const advisor = fakeAdvisor();
    const pal = await openPal(
      { dataRoot, installRoot: "/nonexistent-install" },
      context,
      withAdvisor(advisor.capability),
    );
    cleanups.push(() => pal.close());
    answer(pal, []);
    await pal.harness.waitForIdle(context);
    expect(await readFile(join(ready.root, "marker"), "utf8")).toBe("once");
    expect(advisor.calls).toEqual([]);
    expect(await readFile(calls, "utf8")).toBe("x");
    expect((await pal.approvals.view(ready.chatId)).approvals).toMatchObject([
      { state: "approved", decidedBy: "advisor", advice: { by: "advisor", confidence: 0.96 } },
    ]);
  }, 30_000);
});
