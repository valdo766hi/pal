import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { InputBody } from "../../src/core/chats.ts";
import { commentFeedback } from "../../src/core/feedback.ts";
import { runGit } from "../../src/core/git.ts";
import { openFeedback } from "./feedback.ts";

const [mode, dataRoot, barrier] = process.argv.slice(2);
if (dataRoot === undefined) throw new Error("missing feedback fixture directory");
const fixture = await openFeedback(dataRoot, (point) => {
  if (mode === "run" && point === barrier) process.kill(process.pid, "SIGKILL");
});
const { store, projects, changes, chats, workspaces, harness } = fixture;
const beforeRetry = {
  admitted: (
    await store.database.get<{ n: number }>("SELECT count(*) AS n FROM pal_admissions WHERE state = 'admitted'")
  )?.n,
  feedback: (
    await store.database.get<{ n: number }>(
      "SELECT count(*) AS n FROM pal_change_comments WHERE submission_id IS NOT NULL",
    )
  )?.n,
};
const project = await projects.create("feedback-project", { name: "Feedback" });
const chat = await chats.createChat("feedback-chat", { projectId: project.id }, context);
const workspace = await workspaces.info(chat.id);
if (workspace === undefined) throw new Error("missing feedback fixture workspace");
const saved = join(dataRoot, "fixture-input.json");
let body: InputBody;
if (mode === "run") {
  await runGit(project.root, ["init", "-q"], { signal: AbortSignal.timeout(5000) });
  await changes.capture(project.root);
  await writeFile(join(project.root, "review.txt"), "Review this line.\n");
  const file = (await changes.list(project.id, "normal", workspace.id)).files[0];
  if (file === undefined) throw new Error("missing feedback fixture diff");
  const comment = await changes.comment(
    project.id,
    file.path,
    file.revision,
    1,
    "Keep this note.",
    "normal",
    workspace.id,
  );
  body = { text: commentFeedback(comment), feedback: { ids: [comment.id], scope: "normal" } };
  await writeFile(saved, JSON.stringify(body));
} else body = JSON.parse(await readFile(saved, "utf8")) as InputBody;
const receipt = await chats.submit(chat.id, "feedback-crash-input", body, context);
await harness.waitForIdle(context);
if (mode === "inspect") {
  const conversation = await harness.conversation(chat.conversationId, context);
  const comments = (await changes.list(project.id, "normal", workspace.id)).comments;
  const linked = await store.database.get<{ submission_id: number }>("SELECT submission_id FROM pal_change_comments");
  console.log(
    JSON.stringify({
      beforeRetry,
      admissions: (await store.database.get<{ n: number }>("SELECT count(*) AS n FROM pal_admissions"))?.n,
      userMessages: (await conversation?.context(context))?.messages.filter((message) => message.role === "user")
        .length,
      linked: comments[0]?.sent === true && linked?.submission_id === receipt.submissionId,
    }),
  );
}
await fixture.close();
