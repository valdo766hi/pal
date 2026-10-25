import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { AdmissionStopped, type Barrier } from "../src/core/chats.ts";
import { commentFeedback } from "../src/core/feedback.ts";
import { runGit } from "../src/core/git.ts";
import { InvalidRequest, RequestConflict } from "../src/core/requests.ts";
import { openFeedback } from "./fixtures/feedback.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function dataDirectory() {
  const root = await mkdtemp(join(tmpdir(), "pal-feedback-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function setup(barrier?: (point: Barrier) => void | Promise<void>) {
  const dataRoot = await dataDirectory();
  const fixture = await openFeedback(dataRoot, barrier);
  cleanups.push(fixture.close);
  const project = await fixture.projects.create("feedback-project", { name: "Feedback" });
  const git = (...args: string[]) => runGit(project.root, args, { signal: AbortSignal.timeout(5000) });
  await git("init", "-q");
  await writeFile(join(project.root, "base.txt"), "before\n");
  await git("add", "base.txt");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "base",
  );
  await fixture.changes.capture(project.root);
  await writeFile(join(project.root, "review.txt"), "after\n");
  const chat = await fixture.chats.createChat("feedback-chat", { projectId: project.id }, context);
  const workspace = await fixture.workspaces.info(chat.id);
  if (workspace === undefined) throw new Error("missing feedback workspace");
  const file = (await fixture.changes.list(project.id, "normal", workspace.id)).files[0];
  if (file === undefined) throw new Error("missing feedback diff");
  const comment = await fixture.changes.comment(
    project.id,
    file.path,
    file.revision,
    1,
    "Keep the note.",
    "normal",
    workspace.id,
  );
  const body = {
    text: `Review feedback:\n\n${commentFeedback(comment)}`,
    feedback: { ids: [comment.id], scope: "normal" as const },
  };
  const comments = async () => (await fixture.changes.list(project.id, "include-ignored", workspace.id)).comments;
  return { ...fixture, dataRoot, project, chat, workspace, comment, body, comments };
}

describe("feedback admission receipts", () => {
  it("acknowledges only after Pi admission and deduplicates concurrent and lost-reply retries", async () => {
    const reached = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const fixture = await setup(async (point) => {
      if (point === "input-submitted") {
        reached.resolve(undefined);
        await release.promise;
      }
    });
    cleanups.push(async () => {
      release.resolve(undefined);
    });
    const { chats, chat, body, comments, harness, store } = fixture;
    const first = chats.submit(chat.id, "feedback-input", body, context);
    await reached.promise;
    expect((await comments())[0]?.sent).toBe(false);
    expect(await store.database.get("SELECT state FROM pal_admissions WHERE chat_id = ?", chat.id)).toEqual({
      state: "admitting",
    });
    const repeated = chats.submit(chat.id, "feedback-input", body, context);
    release.resolve(undefined);
    const receipt = await first;
    expect(await repeated).toEqual(receipt);
    expect(
      await chats.submit(
        chat.id,
        "feedback-input",
        { ...body, feedback: { scope: body.feedback.scope, ids: body.feedback.ids } },
        context,
      ),
    ).toEqual(receipt);
    await expect(
      chats.submit(
        chat.id,
        "feedback-input",
        { ...body, feedback: { ...body.feedback, ids: ["other-comment"] } },
        context,
      ),
    ).rejects.toBeInstanceOf(RequestConflict);
    expect((await comments())[0]?.sent).toBe(true);
    expect(
      await store.database.get("SELECT submission_id FROM pal_change_comments WHERE id = ?", fixture.comment.id),
    ).toEqual({ submission_id: receipt.submissionId });
    await fixture.changes.uncomment(fixture.project.id, fixture.comment.id, fixture.workspace.id);
    expect(await chats.submit(chat.id, "feedback-input", body, context)).toEqual(receipt);
    await harness.waitForIdle(context);
    const conversation = await harness.conversation(chat.conversationId, context);
    expect((await conversation?.context(context))?.messages.filter((message) => message.role === "user")).toHaveLength(
      1,
    );
  });

  it("refuses missing, foreign, edited and newly ignored references before recording work", async () => {
    const { chats, chat, body, project, projects, workspaces, store, comment, comments } = await setup();
    const foreign = await projects.create("feedback-foreign-project", { name: "Other project" });
    const other = await chats.createChat("feedback-other-chat", { projectId: foreign.id }, context);
    await expect(chats.submit(other.id, "feedback-foreign", body, context)).rejects.toMatchObject({
      code: "feedback_stale",
    });
    const worktree = await chats.createChat(
      "feedback-worktree-chat",
      { projectId: project.id, workspace: "worktree" },
      context,
    );
    await workspaces.provision(worktree.id);
    await expect(chats.submit(worktree.id, "feedback-other-worktree", body, context)).rejects.toMatchObject({
      code: "feedback_stale",
    });
    await expect(
      chats.submit(
        chat.id,
        "feedback-missing",
        { ...body, feedback: { ...body.feedback, ids: ["missing-comment"] } },
        context,
      ),
    ).rejects.toMatchObject({ code: "feedback_stale" });
    await expect(
      chats.submit(chat.id, "feedback-edited", { ...body, text: "An unrelated message" }, context),
    ).rejects.toMatchObject({ code: "feedback_mismatch" });
    await writeFile(join(project.root, ".gitignore"), "review.txt\n");
    await expect(chats.submit(chat.id, "feedback-ignored", body, context)).rejects.toMatchObject({
      code: "ignored_permission",
    });
    expect(await store.database.get("SELECT count(*) AS n FROM pal_admissions")).toEqual({ n: 0 });
    expect((await comments())[0]).toMatchObject({ id: comment.id, sent: false });
    expect(chats.stopped).toBe(false);
    await chats.submit(
      chat.id,
      "feedback-explicit-ignored",
      { ...body, feedback: { ...body.feedback, scope: "include-ignored" } },
      context,
    );
    expect((await comments())[0]?.sent).toBe(true);
  });

  it("bounds and validates feedback references at admission", async () => {
    const { chats, chat, body, store } = await setup();
    for (const feedback of [
      { ids: [], scope: "normal" },
      { ids: ["same", "same"], scope: "normal" },
      { ids: Array.from({ length: 201 }, (_, i) => String(i)), scope: "normal" },
      { ids: ["comment"], scope: "implicit" },
      { ids: ["comment"], scope: "normal", workspace: "untrusted" },
    ])
      await expect(chats.submit(chat.id, "feedback-invalid", { ...body, feedback }, context)).rejects.toBeInstanceOf(
        InvalidRequest,
      );
    expect(await store.database.get("SELECT count(*) AS n FROM pal_admissions")).toEqual({ n: 0 });
    expect(chats.stopped).toBe(false);
  });

  it("rolls back the acknowledgement and admission together if either update fails", async () => {
    const { store, chats, chat, body, comments, dataRoot, close } = await setup();
    await store.database.exec(
      "CREATE TRIGGER reject_feedback BEFORE UPDATE OF submission_id ON pal_change_comments BEGIN SELECT RAISE(ABORT, 'fixture feedback commit failure'); END",
    );
    await expect(chats.submit(chat.id, "feedback-atomic", body, context)).rejects.toBeInstanceOf(AdmissionStopped);
    expect((await comments())[0]?.sent).toBe(false);
    expect(
      await store.database.get("SELECT state, submission_id FROM pal_admissions WHERE chat_id = ?", chat.id),
    ).toEqual({ state: "admitting", submission_id: null });
    expect(chats.stopped).toBe(true);
    await store.database.exec("DROP TRIGGER reject_feedback");
    await close();
    const recovered = await openFeedback(dataRoot);
    cleanups.push(recovered.close);
    const receipt = await recovered.chats.submit(chat.id, "feedback-atomic", body, context);
    expect(
      await recovered.store.database.get(
        "SELECT submission_id FROM pal_change_comments WHERE id = ?",
        body.feedback.ids[0] ?? "",
      ),
    ).toEqual({ submission_id: receipt.submissionId });
    await recovered.harness.waitForIdle(context);
    const conversation = await recovered.harness.conversation(chat.conversationId, context);
    expect((await conversation?.context(context))?.messages.filter((message) => message.role === "user")).toHaveLength(
      1,
    );
  });

  it.each(["input-recorded", "input-submitted", "input-admitted"] as const)(
    "reconciles feedback and exactly one input after SIGKILL at %s",
    async (barrier) => {
      const dataRoot = await dataDirectory();
      const run = async (mode: string) => {
        const child = spawn(
          process.execPath,
          [join(import.meta.dirname, "fixtures/feedback-child.ts"), mode, dataRoot, barrier],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        const [code, signal] = await once(child, "exit");
        return { code, signal, output };
      };
      const crashed = await run("run");
      expect(crashed).toEqual({ code: null, signal: "SIGKILL", output: "" });
      const db = new DatabaseSync(join(dataRoot, "pal.sqlite"), { readOnly: true });
      try {
        const admitted = barrier === "input-admitted";
        expect(db.prepare("SELECT state FROM pal_admissions").get()).toEqual({
          state: admitted ? "admitted" : "admitting",
        });
        expect(db.prepare("SELECT submission_id IS NOT NULL AS admitted FROM pal_change_comments").get()).toEqual({
          admitted: Number(admitted),
        });
      } finally {
        db.close();
      }
      const recovered = await run("inspect");
      expect(recovered.code).toBe(0);
      expect(JSON.parse(recovered.output)).toMatchObject({
        beforeRetry: { admitted: 1, feedback: 1 },
        admissions: 1,
        userMessages: 1,
        linked: true,
      });
    },
  );
});
