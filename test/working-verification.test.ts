import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { runGit } from "../src/core/git.ts";
import { authority, grade } from "../src/evaluation/grade.ts";
import { checkout } from "../src/evaluation/tasks.ts";

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

it("requires owner acceptance of the exact checked revision and stales it after new source or check evidence", async () => {
  const f = await fixture();
  await f.run([verify("true", 0), verify("true", 1), fauxAssistantMessage("ready for owner review")]);
  const ready = (await f.pal.working.inspect(f.chat, context)).verification;
  expect(ready.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(ready.review).toBeNull();
  const accepted = await f.pal.working.acceptChecks(f.chat, { digest: ready.reviewDigest }, context);
  expect(accepted.verification).toMatchObject({
    state: "completed",
    review: { digest: ready.reviewDigest, stale: false },
  });
  const repeated = await f.pal.working.acceptChecks(f.chat, { digest: ready.reviewDigest }, context);
  expect(repeated.verification.review).toEqual(accepted.verification.review);
  await f.reopen();
  expect((await f.pal.working.inspect(f.chat, context)).verification).toEqual(accepted.verification);
  await f.run([verify("true", 0), fauxAssistantMessage("new receipt, same source")]);
  const replaced = (await f.pal.working.inspect(f.chat, context)).verification;
  expect(replaced).toMatchObject({ state: "ready-for-review", review: { stale: true } });
  expect(replaced.reviewDigest).not.toBe(ready.reviewDigest);
  await expect(f.pal.working.acceptChecks(f.chat, { digest: ready.reviewDigest }, context)).rejects.toMatchObject({
    status: 409,
  });
  await f.pal.working.acceptChecks(f.chat, { digest: replaced.reviewDigest }, context);
  await writeFile(join(f.project.root, "a.txt"), "later edit\n");
  expect((await f.pal.working.inspect(f.chat, context)).verification).toMatchObject({
    state: "needs-checks",
    reviewDigest: null,
    review: { stale: true },
  });
  await expect(f.pal.working.acceptChecks(f.chat, { digest: ready.reviewDigest }, context)).rejects.toMatchObject({
    status: 409,
  });
  await f.run([verify("true", 0), verify("true", 1), fauxAssistantMessage("new checks")]);
  const updated = (await f.pal.working.inspect(f.chat, context)).verification;
  expect(updated.state).toBe("ready-for-review");
  expect(updated.reviewDigest).not.toBe(ready.reviewDigest);
  expect(updated.review?.stale).toBe(true);
  await expect(f.pal.working.acceptChecks(f.chat, { digest: ready.reviewDigest }, context)).rejects.toMatchObject({
    status: 409,
  });
  await f.pal.working.acceptChecks(f.chat, { digest: updated.reviewDigest }, context);
  await f.pal.working.setGoal(f.chat, { ...goal, revision: 1, text: "New owner goal" }, context);
  expect((await f.pal.working.inspect(f.chat, context)).verification.review).toBeNull();
});

it("refuses missing checks, forged acceptance and owner-corrected review bindings", async () => {
  const f = await fixture();
  await expect(f.pal.working.acceptChecks(f.chat, { digest: "a".repeat(64) }, context)).rejects.toMatchObject({
    status: 409,
  });
  await f.run([verify("true", 0), fauxAssistantMessage("one criterion remains")]);
  expect((await f.pal.working.inspect(f.chat, context)).verification.reviewDigest).toBeNull();
  await f.run([verify("true", 1), fauxAssistantMessage("both criteria")]);
  const ready = (await f.pal.working.inspect(f.chat, context)).verification;
  await expect(
    f.pal.working.acceptChecks(f.chat, { digest: ready.reviewDigest, completed: true }, context),
  ).rejects.toThrow(/completed.*schema is false/);
  await f.pal.working.setGoal(f.chat, { ...goal, revision: 1, text: "Owner corrected the goal" }, context);
  await expect(f.pal.working.acceptChecks(f.chat, { digest: ready.reviewDigest }, context)).rejects.toMatchObject({
    status: 409,
  });
});

it("never accepts a workspace while a native shell mutation owns its lock", async () => {
  const f = await fixture();
  await writeFile(join(f.project.root, ".gitignore"), "busy-marker\n");
  await f.run([verify("true", 0), verify("true", 1), fauxAssistantMessage("checked")]);
  const ready = (await f.pal.working.inspect(f.chat, context)).verification;
  const running = f.run([
    call('return await tools.shell_run({command:"printf busy > busy-marker; sleep 30",timeout:120});'),
    fauxAssistantMessage("stopped"),
  ]);
  try {
    await vi.waitFor(async () => expect(await readFile(join(f.project.root, "busy-marker"), "utf8")).toBe("busy"), {
      timeout: 5000,
      interval: 20,
    });
    await expect(f.pal.working.acceptChecks(f.chat, { digest: ready.reviewDigest }, context)).rejects.toThrow(/busy/i);
    expect((await f.pal.working.inspect(f.chat, context)).verification.review).toBeNull();
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

it("independently grades a real two-file fix through plan, restart, checks, diff review and owner acceptance", async () => {
  const f = await fixture();
  const fixtures = new URL("fixtures/evaluation/", import.meta.url);
  const read = (path: string) => readFile(new URL(path, fixtures), "utf8");
  const paths = ["src/prices.mjs", "src/receipt.mjs", "src/main.mjs", "test.mjs"];
  const evaluator = await authority();
  await Promise.all(["a.txt", "b.txt"].map((path) => rm(join(f.project.root, path))));
  await mkdir(join(f.project.root, "src"));
  for (const path of paths) await writeFile(join(f.project.root, path), await read(`buggy/${path}`));
  await runGit(f.project.root, ["add", "--", ...paths], { signal: AbortSignal.timeout(5000) });
  await runGit(
    f.project.root,
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "fixture",
    ],
    { signal: AbortSignal.timeout(5000) },
  );
  await f.pal.changes.list(f.project.id);
  await f.pal.working.setGoal(
    f.chat,
    {
      revision: 1,
      text: checkout.prompt,
      constraints: ["Do not change the CLI or public test"],
      acceptance: ["Independent decimal rounding cases pass", "Patch whitespace checks pass"],
    },
    context,
  );
  const artifact = async (name: string) => {
    const root = join(f.root, name);
    await mkdir(root);
    await mkdir(join(root, "src"));
    cleanups.push(async () => {
      await chmod(root, 0o700);
      await chmod(join(root, "src"), 0o700);
    });
    for (const path of paths)
      await writeFile(join(root, path), await readFile(join(f.project.root, path)), { mode: 0o444 });
    await chmod(join(root, "src"), 0o555);
    await chmod(root, 0o555);
    return realpath(root);
  };
  await f.run([
    call('return await tools.shell_run({command:"node test.mjs",timeout:5});'),
    fauxAssistantMessage("Public smoke test alone is insufficient"),
  ]);
  const baseline = await grade(await artifact("before-fix"), checkout);
  expect(baseline.passed).toBe(false);
  expect(baseline.cases.filter((test) => !test.passed)).toHaveLength(3);
  expect((await f.pal.working.inspect(f.chat, context)).verification.checks).toEqual([]);
  const patch = await Promise.all(
    ["src/prices.mjs", "src/receipt.mjs"].map(async (path) => [path, await read(`fixed/${path}`)]),
  );
  await f.run([
    call(
      'return await tools.working_checkpoint({revision:0,goalRevision:2,summary:"Fix unit rounding before multiplying quantities",plan:["Preserve the JSON CLI and public test","Edit prices and receipt calculation","Run independent cases and inspect the two-file diff"],next:"Verify the changed calculation",questions:[]});',
    ),
    call(
      `for (const [path, content] of ${JSON.stringify(patch)}) { const read = await tools.files_read({path}); const match = /\\[sha256: ([a-f0-9]{64})\\]/.exec(read); if (!match) throw new Error("missing file revision"); await tools.files_write({path, expectedHash:match[1], content}); }`,
    ),
    fauxAssistantMessage("Edits retained for verification"),
  ]);
  await f.reopen();
  expect((await f.pal.working.inspect(f.chat, context)).checkpoint).toMatchObject({
    goalRevision: 2,
    next: "Verify the changed calculation",
  });
  const script =
    'import assert from "node:assert/strict"; import {receipt} from "./src/receipt.mjs"; for (const test of ' +
    JSON.stringify(checkout.cases) +
    ") assert.deepEqual(receipt(test.input), test.expected);";
  const command = `node --permission --allow-fs-read=. --input-type=module -e '${script}'`;
  await f.run([
    call(
      'const state = await tools.working_read({}); if (state.goal.revision !== 2 || state.checkpoint.next !== "Verify the changed calculation") throw new Error("lost working state"); return state;',
    ),
    verify(command, 0, 2),
    verify("git diff --check", 1, 2),
    fauxAssistantMessage("Checks ready for owner review"),
  ]);
  const checked = (await f.pal.working.inspect(f.chat, context)).verification;
  expect(checked).toMatchObject({ state: "ready-for-review", attempts: 2, remaining: [], review: null });
  expect(checked.checks).toHaveLength(2);
  expect(
    checked.checks.every((check) => check.outcome === "passed" && !check.stale && check.before === check.after),
  ).toBe(true);
  const result = await grade(await artifact("after-fix"), checkout);
  expect(result.passed).toBe(true);
  expect(result.cases).toHaveLength(4);
  expect(result.cases.every((test) => test.passed && test.exitCode === 0)).toBe(true);
  expect(await authority()).toBe(evaluator);
  for (const path of ["src/main.mjs", "test.mjs"])
    expect(await readFile(join(f.project.root, path), "utf8")).toBe(await read(`buggy/${path}`));
  const changes = await f.pal.changes.list(f.project.id);
  expect(changes.truncated).toBe(false);
  expect(changes.files.map((file) => file.path)).toEqual(["src/prices.mjs", "src/receipt.mjs"]);
  for (const file of changes.files) {
    expect(file.status).toBe("M");
    expect(file.patch).toContain(`+++ b/${file.path}`);
    await f.pal.changes.review(f.project.id, file.path, file.revision, true);
  }
  expect((await f.pal.working.inspect(f.chat, context)).verification.reviewDigest).toBe(checked.reviewDigest);
  expect((await f.pal.working.acceptChecks(f.chat, { digest: checked.reviewDigest }, context)).verification.state).toBe(
    "completed",
  );
  await writeFile(join(f.project.root, "src/prices.mjs"), await read("buggy/src/prices.mjs"));
  expect((await f.pal.working.inspect(f.chat, context)).verification).toMatchObject({
    state: "needs-checks",
    review: { stale: true },
  });
});
