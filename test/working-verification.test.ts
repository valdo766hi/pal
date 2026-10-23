import { chmod, link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { runGit } from "../src/core/git.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const goal = {
  revision: 0,
  text: "Fix the two-file calculation",
  constraints: [],
  acceptance: ["The independent calculation check passes", "Review the resulting diff"],
};
const call = (code: string) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
const verify = (command: string, criterion = 0, goalRevision = 1) =>
  call(`return await tools.shell_run(${JSON.stringify({ command, timeout: 5, check: { goalRevision, criterion } })});`);

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-working-check-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const options = {
    dataRoot: join(root, "data"),
    installRoot: join(root, "install"),
    guidanceHome: join(root, "home"),
  };
  let pal = await openPal(options, context);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("check-project", { name: "Verification fixture" });
  const chat = await pal.chats.createChat("check-chat", { projectId: project.id }, context);
  await runGit(project.root, ["init", "--quiet", "--template=", "--initial-branch=fixture"], {
    signal: AbortSignal.timeout(5000),
  });
  await writeFile(join(project.root, "a.txt"), "old-a\n");
  await writeFile(join(project.root, "b.txt"), "old-b\n");
  await pal.working.setGoal(chat, goal, context);
  await pal.approvals.setMode(chat.id, "full");
  let input = 0;
  const run = async (responses: ReturnType<typeof fauxAssistantMessage>[]) => {
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const model = faux.getModel();
    const conversation = await pal.harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing verification conversation");
    await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    faux.setResponses(responses);
    await pal.chats.submit(chat.id, `check-input-${++input}`, { text: "Continue the fixture" }, context);
    await conversation.waitForIdle(context);
    return conversation.context(context);
  };
  return {
    root,
    project,
    chat,
    run,
    get pal() {
      return pal;
    },
    reopen: async () => {
      await pal.close();
      pal = await openPal(options, context);
    },
  };
}

it("records host-run checks, survives a restart between multi-file edits and testing, and marks later edits stale", async () => {
  const f = await fixture();
  await f.pal.changes.list(f.project.id);
  await f.run([
    call(
      'const put = async (path, content) => { const read = await tools.files_read({path}); const match = /\\[sha256: ([a-f0-9]{64})\\]/.exec(read); if (!match) throw new Error("missing file revision"); return await tools.files_write({path, expectedHash: match[1], content}); }; await put("a.txt", "fixed-a\\n"); return await put("b.txt", "fixed-b\\n");',
    ),
    fauxAssistantMessage("edits saved"),
  ]);
  await f.reopen();
  const command = 'test "$(cat a.txt)" = fixed-a && test "$(cat b.txt)" = fixed-b';
  await f.run([verify(command), fauxAssistantMessage("checked")]);
  expect(await readFile(join(f.project.root, "a.txt"), "utf8")).toBe("fixed-a\n");
  expect(await readFile(join(f.project.root, "b.txt"), "utf8")).toBe("fixed-b\n");
  const view = await f.pal.working.inspect(f.chat, context);
  expect(view).toMatchObject({
    verification: {
      attempts: 1,
      state: "needs-checks",
      checks: [{ criterion: 0, outcome: "passed", exitCode: 0, stale: false }],
    },
  });
  const changes = await f.pal.changes.list(f.project.id);
  expect(changes.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
  await f.reopen();
  expect(await f.pal.working.inspect(f.chat, context)).toEqual(view);
  await writeFile(join(f.project.root, "a.txt"), "changed-after-test\n");
  expect(await f.pal.working.inspect(f.chat, context)).toMatchObject({
    verification: { checks: [{ outcome: "passed", stale: true }] },
  });
  await f.run([call("return await tools.working_checks({});"), fauxAssistantMessage("stale check visible")]);
});

it("retains failed results and refuses obsolete goal bindings before executing their command", async () => {
  const f = await fixture();
  await f.run([verify("exit 7"), fauxAssistantMessage("failure retained")]);
  expect(await f.pal.working.inspect(f.chat, context)).toMatchObject({
    verification: { state: "blocked", checks: [{ outcome: "failed", exitCode: 7, stale: false }] },
  });
  await f.pal.working.setGoal(f.chat, { ...goal, revision: 1, text: "Corrected goal" }, context);
  await f.run([verify("printf unsafe > obsolete-goal-marker"), fauxAssistantMessage("obsolete binding refused")]);
  expect(await readFile(join(f.project.root, "obsolete-goal-marker"), "utf8").catch(() => undefined)).toBeUndefined();
  expect(await f.pal.working.inspect(f.chat, context)).toMatchObject({ verification: { attempts: 0, checks: [] } });
});

it("requires every current criterion, invalidates mode changes, and never calls receipts completion", async () => {
  const f = await fixture();
  await f.run([verify("true", 0), verify("true", 1), fauxAssistantMessage("both checks ran")]);
  const first = await f.pal.working.inspect(f.chat, context);
  expect(first.verification).toMatchObject({ state: "ready-for-review", remaining: [], attempts: 2 });
  expect(first.verification.checks).toHaveLength(2);
  expect(first.verification.notice).toContain("not test adequacy");
  await chmod(join(f.project.root, "a.txt"), 0o700);
  const stale = await f.pal.working.inspect(f.chat, context);
  expect(stale.verification.state).toBe("needs-checks");
  expect(stale.verification.checks.every((check) => check.stale)).toBe(true);
  await f.run([verify("printf changed > a.txt"), fauxAssistantMessage("source changed during the check")]);
  const changed = (await f.pal.working.inspect(f.chat, context)).verification;
  expect(changed.state).toBe("blocked");
  expect(changed.checks).toHaveLength(2);
  expect(changed.checks[0]).toMatchObject({ criterion: 0, outcome: "changed", stale: false });
  expect(changed.checks[1]).toMatchObject({ criterion: 1, outcome: "passed", stale: true });
});

it("persists the attempt limit and does not reset it for an identical goal retry", async () => {
  const f = await fixture();
  await f.run([
    call(
      'for (let i = 0; i < 16; i++) await tools.shell_run({command:"exit 1",check:{goalRevision:1,criterion:0}}); return await tools.shell_run({command:"printf unsafe > budget-marker",check:{goalRevision:1,criterion:0}});',
    ),
    fauxAssistantMessage("budget exhausted"),
  ]);
  expect(await readFile(join(f.project.root, "budget-marker"), "utf8").catch(() => undefined)).toBeUndefined();
  expect((await f.pal.working.inspect(f.chat, context)).verification).toMatchObject({
    state: "budget-exhausted",
    attempts: 16,
    limit: 16,
  });
  await f.reopen();
  await f.pal.working.setGoal(f.chat, goal, context);
  expect((await f.pal.working.inspect(f.chat, context)).verification.attempts).toBe(16);
  await f.pal.working.setGoal(f.chat, { ...goal, revision: 1, text: "Owner explicitly revised the goal" }, context);
  expect((await f.pal.working.inspect(f.chat, context)).verification.attempts).toBe(0);
});

it.each(["private-alias", "symlink", "oversized"])(
  "refuses an unverifiable %s source before dispatch",
  async (kind) => {
    const f = await fixture();
    if (kind === "private-alias") await link(join(f.root, "data/credentials.key"), join(f.project.root, "alias.txt"));
    if (kind === "symlink") await symlink("a.txt", join(f.project.root, "alias.txt"));
    if (kind === "oversized") await writeFile(join(f.project.root, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 97));
    await f.run([verify("printf unsafe > source-marker"), fauxAssistantMessage("source refused")]);
    expect(await readFile(join(f.project.root, "source-marker"), "utf8").catch(() => undefined)).toBeUndefined();
    expect((await f.pal.working.inspect(f.chat, context)).verification).toMatchObject({ attempts: 0, checks: [] });
  },
);

it("retains unknown effects after Stop and reopen without rerunning the interrupted check", async () => {
  const f = await fixture();
  await writeFile(join(f.project.root, ".gitignore"), "effect.log\n");
  const running = f.run([
    call(
      'return await tools.shell_run({command:"printf once >> effect.log; sleep 30",timeout:120,check:{goalRevision:1,criterion:0}});',
    ),
    fauxAssistantMessage("stopped"),
  ]);
  try {
    await vi.waitFor(async () => expect(await readFile(join(f.project.root, "effect.log"), "utf8")).toBe("once"), {
      timeout: 5000,
      interval: 20,
    });
  } finally {
    await (await f.pal.harness.conversation(f.chat.conversationId, context))?.abort(context);
    await running;
  }
  expect((await f.pal.working.inspect(f.chat, context)).verification).toMatchObject({
    state: "blocked",
    attempts: 1,
    checks: [{ outcome: "unknown", exitCode: null }],
  });
  await f.reopen();
  expect((await f.pal.working.inspect(f.chat, context)).verification.checks[0]?.outcome).toBe("unknown");
  await f.run([fauxAssistantMessage("inspect effects before continuing")]);
  expect(await readFile(join(f.project.root, "effect.log"), "utf8")).toBe("once");
  expect((await f.pal.working.inspect(f.chat, context)).goal.text).toBe(goal.text);
});

it("keeps UTF-8 command previews bounded and retains truncation without duplicating command output", async () => {
  const f = await fixture();
  const command = ": #" + "界".repeat(300);
  await f.run([verify(command), fauxAssistantMessage("bounded receipt")]);
  const receipt = (await f.pal.working.inspect(f.chat, context)).verification.checks[0];
  expect(receipt).toMatchObject({ outcome: "passed", commandTruncated: true, outputTruncated: false });
  expect(Buffer.byteLength(receipt?.command ?? "")).toBeLessThanOrEqual(503);
  expect(receipt).not.toHaveProperty("output");
});

it("does not let supplied check results forge a receipt", async () => {
  const f = await fixture();
  await f.run([
    call(
      'return await tools.shell_run({command:"printf unsafe > forged-marker",check:{goalRevision:1,criterion:0,outcome:"passed"}});',
    ),
    fauxAssistantMessage("forgery refused"),
  ]);
  expect(await readFile(join(f.project.root, "forged-marker"), "utf8").catch(() => undefined)).toBeUndefined();
  expect((await f.pal.working.inspect(f.chat, context)).verification.checks).toEqual([]);
});

it("keeps exact command approval and rechecks an owner correction before dispatch", async () => {
  const f = await fixture();
  await f.pal.approvals.setMode(f.chat.id, "ask");
  const running = f.run([verify("printf unsafe > approval-marker"), fauxAssistantMessage("stale goal refused")]);
  try {
    let approval: Awaited<ReturnType<typeof f.pal.approvals.view>>["approvals"][number] | undefined;
    await vi.waitFor(
      async () => {
        approval = (await f.pal.approvals.view(f.chat.id)).approvals.find((item) => item.state === "pending");
        expect(approval).toBeDefined();
      },
      { timeout: 5000, interval: 20 },
    );
    if (approval === undefined) throw new Error("missing check approval");
    expect(approval.command).toBe("printf unsafe > approval-marker");
    await f.pal.working.setGoal(f.chat, { ...goal, revision: 1, text: "Changed while waiting" }, context);
    await f.pal.approvals.decide(f.chat.id, approval.id, "approve", approval.digest);
    await running;
    expect(await readFile(join(f.project.root, "approval-marker"), "utf8").catch(() => undefined)).toBeUndefined();
    expect((await f.pal.working.inspect(f.chat, context)).verification.attempts).toBe(0);
  } finally {
    await (await f.pal.harness.conversation(f.chat.conversationId, context))?.abort(context);
    await running;
  }
});

it("does not require a working goal or revision scan for ordinary shell commands", async () => {
  const f = await fixture();
  await f.pal.working.setGoal(f.chat, { revision: 1, text: "", constraints: [], acceptance: [] }, context);
  await f.run([
    call('return await tools.shell_run({command:"printf ordinary > ordinary-marker"});'),
    fauxAssistantMessage("simple command"),
  ]);
  expect(await readFile(join(f.project.root, "ordinary-marker"), "utf8")).toBe("ordinary");
  expect(await f.pal.working.inspect(f.chat, context)).toMatchObject({ verification: { attempts: 0, checks: [] } });
});
