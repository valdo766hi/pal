import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { InputBody, MAX_INPUT_CHARS } from "../src/core/chats.ts";
import type { Admission, Upload } from "../web/src/lib/api.ts";
import {
  ChatDraft,
  ChatDrafts,
  MAX_DRAFT_CHARS,
  MAX_DRAFT_CHATS,
  MAX_DRAFT_FILES,
  type PendingInput,
} from "../web/src/lib/drafts.svelte.ts";

const file = (id = "upload-one"): Upload => ({
  id,
  name: `${id}.txt`,
  mediaType: "text/plain",
  size: 1,
  state: "ready",
});
const ack = (envelope: PendingInput): Admission => ({
  chatId: envelope.chatId,
  requestId: envelope.requestId,
  submissionId: 1 as Admission["submissionId"],
});
function pending(draft: ChatDraft) {
  return draft.stage("request-one", draft.snapshot(true), "a".repeat(64));
}

describe("per-chat draft ownership", () => {
  it("freezes text, files, busy mode and destination independently of later edits", () => {
    const draft = new ChatDraft("chat-one");
    draft.text = "  original  ";
    draft.attachments = [file()];
    draft.whenBusy = "steer";
    const snapshot = draft.snapshot(true);
    draft.text = "new text before model configuration finishes";
    draft.attachments = [file("new-upload")];
    draft.whenBusy = "followUp";
    const envelope = draft.stage("request-one", snapshot, "a".repeat(64));
    expect(envelope).toMatchObject({
      chatId: "chat-one",
      requestId: "request-one",
      body: { text: "original", attachments: ["upload-one"], whenBusy: "steer", configuration: "a".repeat(64) },
    });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.body)).toBe(true);
    expect(Object.isFrozen(envelope.body.attachments)).toBe(true);
    expect(draft.snapshot(false).whenBusy).toBe("followUp");
    expect(draft.pending).toBe(envelope);
  });

  it("clears only an unchanged draft after its exact acknowledgement", () => {
    const draft = new ChatDraft("chat-one");
    draft.text = "original";
    draft.attachments = [file()];
    const envelope = pending(draft);
    draft.confirm(envelope, ack(envelope));
    expect(draft.text).toBe("");
    expect(draft.attachments).toEqual([]);
    expect(draft.pending).toBeUndefined();
    expect(draft.empty).toBe(true);
  });

  it.each(["text", "files", "same-bytes", "upload-start"])(
    "retains a draft edited through %s while its send is outstanding",
    (edit) => {
      const draft = new ChatDraft("chat-one");
      draft.text = "original";
      draft.attachments = [file()];
      const envelope = pending(draft);
      if (edit === "text") draft.text = "newer";
      if (edit === "files") draft.attachments = [];
      if (edit === "same-bytes") {
        draft.text = "changed";
        draft.text = "original";
      }
      if (edit === "upload-start") draft.touch();
      const text = draft.text,
        files = draft.attachments;
      draft.confirm(envelope, ack(envelope));
      expect(draft.text).toBe(text);
      expect(draft.attachments).toEqual(files);
      expect(draft.notice).toContain("newer draft is kept");
      expect(draft.pending).toBeUndefined();
    },
  );

  it("refuses to replace an unresolved envelope or accept another request's acknowledgement", () => {
    const draft = new ChatDraft("chat-one");
    draft.text = "original";
    const envelope = pending(draft);
    expect(() => pending(draft)).toThrow(/Resolve the saved send/);
    expect(() => draft.confirm(envelope, { ...ack(envelope), requestId: "another-request" })).toThrow(
      /different input/,
    );
    expect(() => draft.confirm(envelope, { ...ack(envelope), chatId: "another-chat" })).toThrow(/different input/);
    expect(draft.pending).toBe(envelope);
    expect(draft.text).toBe("original");
    draft.reject(envelope);
    expect(draft.pending).toBeUndefined();
    expect(draft.text).toBe("original");
    expect(pending(draft)).not.toBe(envelope);
  });

  it("returns the same cells across navigation without conflating chats", () => {
    const drafts = new ChatDrafts();
    const one = drafts.open("one");
    one.text = "draft one";
    one.attachments = [file()];
    one.sending = true;
    const envelope = pending(one);
    const two = drafts.open("two");
    two.text = "draft two";
    expect(drafts.open("one")).toBe(one);
    expect(drafts.open("one").pending).toBe(envelope);
    expect(drafts.open("two").text).toBe("draft two");
    expect(two.attachments).toEqual([]);
  });

  it("bounds retained chats without evicting unsent text or unresolved admissions", () => {
    const drafts = new ChatDrafts();
    for (let i = 0; i < MAX_DRAFT_CHATS; i++) drafts.open(String(i)).text = `draft ${i}`;
    const first = drafts.open("0");
    const envelope = pending(first);
    first.text = "";
    const blocked = drafts.open("overflow");
    expect(blocked.blocked).toBe(true);
    expect(blocked.append("do not lose an existing draft")).toBe(false);
    expect(first.pending).toBe(envelope);
    expect(drafts.open("1").text).toBe("draft 1");
    drafts.open("1").text = "";
    expect(drafts.open("overflow").blocked).toBe(false);
    expect(first.pending).toBe(envelope);
  });

  it("does not recycle entries while uploads or send preparation are outstanding", () => {
    const drafts = new ChatDrafts();
    const uploading = drafts.open("uploading");
    uploading.uploading = 1;
    const sending = drafts.open("sending");
    sending.sending = true;
    drafts.open("next");
    expect(drafts.open("uploading")).toBe(uploading);
    expect(drafts.open("sending")).toBe(sending);
    expect(uploading.signal.aborted).toBe(false);
    expect(sending.signal.aborted).toBe(false);
  });

  it("matches host message limits and refuses oversized inserts without truncating the current draft", () => {
    expect(MAX_DRAFT_CHARS).toBe(MAX_INPUT_CHARS);
    expect(Value.Check(InputBody, { text: "x", attachments: Array(MAX_DRAFT_FILES).fill("file") })).toBe(true);
    expect(Value.Check(InputBody, { text: "x", attachments: Array(MAX_DRAFT_FILES + 1).fill("file") })).toBe(false);
    const draft = new ChatDraft("one");
    draft.text = "x".repeat(MAX_DRAFT_CHARS);
    expect(draft.append("extra")).toBe(false);
    expect(draft.text).toHaveLength(MAX_DRAFT_CHARS);
    draft.text = "y".repeat(MAX_DRAFT_CHARS + 1);
    expect(draft.text).toBe("x".repeat(MAX_DRAFT_CHARS));
    draft.attachments = Array.from({ length: MAX_DRAFT_FILES }, (_, i) => file(String(i)));
    draft.attachments = [...draft.attachments, file("overflow")];
    expect(draft.attachments).toHaveLength(MAX_DRAFT_FILES);
    expect(draft.error).toMatch(/nothing was added/);
  });

  it("links only unchanged copied feedback and freezes its receipt with the saved send", () => {
    const draft = new ChatDraft("feedback-chat");
    const receipt = { ids: ["comment-one"], scope: "normal" as const };
    expect(draft.appendFeedback("Review feedback: original", receipt)).toBe(true);
    const text = draft.text;
    expect(draft.appendFeedback(text, receipt)).toBe(true);
    expect(draft.text).toBe(text);
    const snapshot = draft.snapshot(false);
    receipt.ids.push("not-copied");
    draft.text = "An unrelated message";
    expect(draft.feedback).toBeUndefined();
    expect(draft.snapshot(false).feedback).toBeUndefined();
    const envelope = draft.stage("feedback-request", snapshot, "a".repeat(64));
    expect(envelope.body.feedback).toEqual({ ids: ["comment-one"], scope: "normal" });
    expect(Object.isFrozen(envelope.body.feedback)).toBe(true);
    expect(Object.isFrozen(envelope.body.feedback?.ids)).toBe(true);
    draft.confirm(envelope, ack(envelope));
    expect(draft.text).toBe("An unrelated message");
  });

  it("bounds feedback links, retains separate blocks and lets explicit ignored-scope review replace a copied scope", () => {
    const draft = new ChatDraft("feedback-chat");
    const ids = Array.from({ length: 200 }, (_, i) => `comment-${i}`);
    expect(draft.appendFeedback("First block", { ids, scope: "normal" })).toBe(true);
    expect(draft.appendFeedback("Overflow", { ids: ["overflow"], scope: "normal" })).toBe(false);
    expect(draft.text).toBe("First block");
    expect(draft.feedback?.ids).toHaveLength(200);
    expect(draft.appendFeedback("First block", { ids, scope: "include-ignored" })).toBe(true);
    expect(draft.text).toBe("First block");
    expect(draft.feedback?.scope).toBe("include-ignored");
    draft.text = "";
    draft.appendFeedback("First block", { ids: ["one"], scope: "normal" });
    draft.appendFeedback("Second block", { ids: ["two"], scope: "include-ignored" });
    draft.text = "Second block";
    expect(draft.feedback).toEqual({ ids: ["two"], scope: "include-ignored" });
    draft.unlinkFeedback(["two"]);
    expect(draft.text).toBe("Second block");
    expect(draft.feedback).toBeUndefined();
    draft.appendFeedback("Third block", { ids: ["three"], scope: "normal" });
    const envelope = pending(draft);
    draft.confirm(envelope, ack(envelope));
    expect(draft.feedback).toBeUndefined();
    expect(draft.empty).toBe(true);
  });

  it("clears and fences old cells on sign-out instead of exposing them to a later session", () => {
    const drafts = new ChatDrafts();
    const old = drafts.open("one");
    old.text = "private draft fixture";
    old.attachments = [file()];
    const envelope = pending(old);
    drafts.clear();
    drafts.clear();
    expect(old.signal.aborted).toBe(true);
    expect(old.active).toBe(false);
    expect(old.text).toBe("");
    expect(old.attachments).toEqual([]);
    expect(old.pending).toBeUndefined();
    old.confirm(envelope, ack(envelope));
    expect(old.append("late result")).toBe(false);
    expect(() => old.snapshot(false)).toThrow();
    expect(drafts.open("one").text).toBe("");
    expect(drafts.open("one")).not.toBe(old);
  });
});
