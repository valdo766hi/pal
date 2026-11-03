import { untrack } from "svelte";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type { Admission, Upload } from "./api.ts";
import type { ReviewFeedback } from "../../../src/core/feedback.ts";

import { MAX_INPUT_ATTACHMENTS, MAX_INPUT_CHARS } from "../../../src/protocol/limits.ts";

export const MAX_DRAFT_CHATS = 32;
type BusyMode = "followUp" | "steer";
export type DraftSnapshot = Readonly<{
  revision: number;
  text: string;
  attachments: readonly string[];
  whenBusy: BusyMode;
  feedback?: ReviewFeedback | undefined;
}>;
export type PendingInput = Readonly<{
  chatId: string;
  requestId: string;
  revision: number;
  body: Readonly<{
    text: string;
    attachments: readonly string[];
    whenBusy: BusyMode;
    configuration: string;
    feedback?: ReviewFeedback | undefined;
  }>;
}>;
type FeedbackBlock = Readonly<{ text: string; receipt: ReviewFeedback }>;
const freezeFeedback = (feedback: ReviewFeedback) =>
  Object.freeze({ ids: Object.freeze([...feedback.ids]), scope: feedback.scope });

/** Where a tab keeps its drafts across reloads: `sessionStorage` in the browser, so each tab has its own. */
export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const KEY = "pal.draft.";
type Saved = {
  v: 1;
  revision: number;
  text: string;
  attachments: readonly Upload[];
  whenBusy: BusyMode;
  feedback: readonly FeedbackBlock[];
  pending?: PendingInput | undefined;
};
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const receipt = (value: unknown): value is ReviewFeedback =>
  typeof value === "object" &&
  value !== null &&
  strings((value as ReviewFeedback).ids) &&
  ["normal", "include-ignored"].includes((value as ReviewFeedback).scope);
const busy = (value: unknown): value is BusyMode => value === "followUp" || value === "steer";

/** A saved draft this code wrote, or undefined for anything else; storage is shared with whatever runs on the origin. */
function parse(raw: string | null, chatId: string): Saved | undefined {
  let value: Partial<Saved>;
  try {
    value = raw === null ? {} : (JSON.parse(raw) as Partial<Saved>);
  } catch {
    return undefined;
  }
  const pending = value.pending;
  const valid =
    value.v === 1 &&
    Number.isSafeInteger(value.revision) &&
    typeof value.text === "string" &&
    value.text.length <= MAX_INPUT_CHARS &&
    Array.isArray(value.attachments) &&
    value.attachments.length <= MAX_INPUT_ATTACHMENTS &&
    value.attachments.every(
      (file) =>
        typeof file?.id === "string" &&
        typeof file.name === "string" &&
        typeof file.mediaType === "string" &&
        Number.isSafeInteger(file.size) &&
        file.state === "ready",
    ) &&
    busy(value.whenBusy) &&
    Array.isArray(value.feedback) &&
    value.feedback.every((block) => typeof block?.text === "string" && receipt(block.receipt)) &&
    (pending === undefined ||
      (pending.chatId === chatId &&
        typeof pending.requestId === "string" &&
        Number.isSafeInteger(pending.revision) &&
        typeof pending.body?.text === "string" &&
        strings(pending.body.attachments) &&
        busy(pending.body.whenBusy) &&
        typeof pending.body.configuration === "string" &&
        (pending.body.feedback === undefined || receipt(pending.body.feedback))));
  return valid ? (value as Saved) : undefined;
}

export class ChatDraft {
  readonly chatId: string;
  readonly blocked: boolean;
  readonly #controller = new AbortController();
  readonly #store: DraftStore | undefined;
  #active = $state(true);
  #text = $state("");
  #attachments = $state.raw<readonly Readonly<Upload>[]>([]);
  #feedback = $state.raw<readonly FeedbackBlock[]>([]);
  #revision = 0;
  #whenBusy = $state<BusyMode>("followUp");
  #pending = $state.raw<PendingInput | undefined>();
  sending = $state(false);
  uploading = $state(0);
  error = $state<string | undefined>();
  notice = $state<string | undefined>();
  /** False once this tab couldn't save the draft; it then lives only in memory until the next successful save. */
  saved = $state(true);
  /** True for a saved send restored after a reload, until its admission is looked up. */
  recovered = $state(false);

  constructor(chatId: string, problem?: string, store?: DraftStore) {
    this.chatId = chatId;
    this.blocked = problem !== undefined;
    this.error = problem;
    this.#store = this.blocked ? undefined : store;
    let raw: string | null = null;
    try {
      raw = this.#store?.getItem(KEY + chatId) ?? null;
    } catch {
      this.saved = false;
    }
    if (raw === null) return;
    const saved = parse(raw, chatId);
    if (saved === undefined) {
      this.#save();
      return;
    }
    this.#revision = saved.revision;
    this.#text = saved.text;
    this.#attachments = Object.freeze(saved.attachments.map((file) => Object.freeze({ ...file })));
    this.#whenBusy = saved.whenBusy;
    this.#feedback = Object.freeze(
      saved.feedback.map((block) => Object.freeze({ text: block.text, receipt: freezeFeedback(block.receipt) })),
    );
    if (saved.pending !== undefined) {
      this.#pending = freezeEnvelope(saved.pending);
      this.recovered = true;
    }
  }

  /** Mirrors this draft to the tab's store; an empty draft leaves nothing behind. Inactive drafts never write. */
  #save() {
    if (!this.active || this.#store === undefined) return;
    try {
      if (this.#text === "" && this.#attachments.length === 0 && this.#pending === undefined)
        this.#store.removeItem(KEY + this.chatId);
      else
        this.#store.setItem(
          KEY + this.chatId,
          JSON.stringify({
            v: 1,
            revision: this.#revision,
            text: this.#text,
            attachments: this.#attachments.filter((file) => file.state === "ready"),
            whenBusy: this.#whenBusy,
            feedback: this.#feedback,
            pending: this.#pending,
          } satisfies Saved),
        );
      this.saved = true;
    } catch {
      this.saved = false;
    }
  }
  get whenBusy() {
    return this.#whenBusy;
  }
  set whenBusy(value: BusyMode) {
    this.#whenBusy = value;
    this.#save();
  }
  get pending() {
    return this.#pending;
  }

  get active() {
    return this.#active;
  }
  get signal() {
    return this.#controller.signal;
  }
  get text() {
    return this.#text;
  }
  set text(value: string) {
    if (!this.active || this.blocked) return;
    if (value.length > MAX_INPUT_CHARS) {
      this.error = `A draft can contain at most ${MAX_INPUT_CHARS.toLocaleString()} characters; nothing was added.`;
      return;
    }
    this.#text = value;
    this.#feedback = this.#feedback.filter((block) => value.includes(block.text));
    this.#revision++;
    if (this.pending === undefined) this.error = undefined;
    this.#save();
  }
  get attachments() {
    return this.#attachments;
  }
  set attachments(value: readonly Readonly<Upload>[]) {
    if (!this.active || this.blocked) return;
    if (value.length > MAX_INPUT_ATTACHMENTS) {
      this.error = `A draft can attach at most ${MAX_INPUT_ATTACHMENTS} files; nothing was added.`;
      return;
    }
    this.#attachments = Object.freeze(value.map((file) => Object.freeze({ ...file })));
    this.#revision++;
    this.#save();
  }
  get empty() {
    return (
      this.text === "" &&
      this.attachments.length === 0 &&
      this.pending === undefined &&
      !this.sending &&
      this.uploading === 0
    );
  }
  append(text: string): boolean {
    if (!this.active || this.blocked) return false;
    const value = `${this.text}${this.text ? "\n\n" : ""}${text}`;
    if (value.length > MAX_INPUT_CHARS) {
      this.error = `This would exceed ${MAX_INPUT_CHARS.toLocaleString()} characters; nothing was added.`;
      return false;
    }
    this.text = value;
    return true;
  }
  get feedback(): ReviewFeedback | undefined {
    if (this.#feedback.length === 0) return undefined;
    return freezeFeedback({
      ids: [...new SvelteSet(this.#feedback.flatMap((block) => block.receipt.ids))],
      scope: this.#feedback.some((block) => block.receipt.scope === "include-ignored") ? "include-ignored" : "normal",
    });
  }
  appendFeedback(text: string, receipt: ReviewFeedback): boolean {
    if (!this.active || this.blocked) return false;
    const ids = new SvelteSet([...(this.feedback?.ids ?? []), ...receipt.ids]);
    if (receipt.ids.length === 0 || ids.size > 200) {
      this.error = "A draft can link at most 200 review comments; nothing was added.";
      return false;
    }
    const copied = this.#feedback.find(
      (block) => block.text === text && receipt.ids.every((id) => block.receipt.ids.includes(id)),
    );
    if (copied !== undefined) {
      if (copied.receipt.scope !== receipt.scope) {
        this.#feedback = this.#feedback.map((block) =>
          block === copied ? Object.freeze({ text, receipt: freezeFeedback(receipt) }) : block,
        );
        this.touch();
      }
      return true;
    }
    if (!this.append(text)) return false;
    this.#feedback = [...this.#feedback, Object.freeze({ text, receipt: freezeFeedback(receipt) })];
    this.#save();
    return true;
  }
  unlinkFeedback(ids: readonly string[]) {
    this.#feedback = this.#feedback.filter((block) => !block.receipt.ids.some((id) => ids.includes(id)));
    this.touch();
  }
  touch() {
    this.#revision++;
    this.#save();
  }
  snapshot(running: boolean): DraftSnapshot {
    if (!this.active || this.blocked || this.text.trim() === "") throw new Error("This draft cannot be sent.");
    return Object.freeze({
      revision: this.#revision,
      text: this.text.trim(),
      attachments: Object.freeze(this.attachments.map((file) => file.id)),
      whenBusy: running ? this.whenBusy : "followUp",
      feedback: this.feedback,
    });
  }
  stage(requestId: string, snapshot: DraftSnapshot, configuration: string): PendingInput {
    if (!this.active || this.blocked || this.pending !== undefined) throw new Error("Resolve the saved send first.");
    const envelope = freezeEnvelope({
      chatId: this.chatId,
      requestId,
      revision: snapshot.revision,
      body: { ...snapshot, configuration },
    });
    // Saved before the caller sends it, so a reload during the request can find out what became of it.
    this.#pending = envelope;
    this.#save();
    return envelope;
  }
  confirm(envelope: PendingInput, admission: Admission) {
    if (!this.active || this.pending !== envelope) return;
    if (admission.chatId !== envelope.chatId || admission.requestId !== envelope.requestId)
      throw new Error("Pal acknowledged a different input; the saved send is kept.");
    if (this.#revision === envelope.revision) {
      this.#text = "";
      this.#attachments = [];
      this.#feedback = [];
      this.#revision++;
      this.notice = undefined;
    } else this.notice = "The earlier message was admitted. Your newer draft is kept.";
    this.#pending = undefined;
    this.recovered = false;
    this.error = undefined;
    this.#save();
  }
  reject(envelope: PendingInput) {
    if (this.pending !== envelope) return;
    this.#pending = undefined;
    this.recovered = false;
    this.#save();
  }
  dispose() {
    this.#active = false;
    this.#controller.abort();
    this.#text = "";
    this.#attachments = [];
    this.#feedback = [];
    this.#pending = undefined;
    this.error = undefined;
    this.notice = undefined;
  }
}

function freezeEnvelope(envelope: PendingInput): PendingInput {
  const { text, attachments, whenBusy, configuration, feedback } = envelope.body;
  return Object.freeze({
    chatId: envelope.chatId,
    requestId: envelope.requestId,
    revision: envelope.revision,
    body: Object.freeze({
      text,
      attachments: Object.freeze([...attachments]),
      whenBusy,
      configuration,
      feedback: feedback === undefined ? undefined : freezeFeedback(feedback),
    }),
  });
}

export class ChatDrafts {
  readonly #drafts = new SvelteMap<string, ChatDraft>();
  readonly #store: DraftStore | undefined;
  constructor(store: DraftStore | undefined = browserStore()) {
    this.#store = store;
  }
  open(chatId: string): ChatDraft {
    return untrack(() => {
      const known = this.#drafts.get(chatId);
      if (known !== undefined) return known;
      for (const [id, draft] of this.#drafts) {
        if (draft.empty) {
          draft.dispose();
          this.#drafts.delete(id);
        }
      }
      const problem =
        this.#drafts.size >= MAX_DRAFT_CHATS
          ? `This tab holds ${MAX_DRAFT_CHATS} drafts. Confirm a saved send, or clear another chat's unsent text and files, before drafting here.`
          : undefined;
      const draft = new ChatDraft(chatId, problem, this.#store);
      if (!draft.blocked) this.#drafts.set(chatId, draft);
      return draft;
    });
  }
  /** Signing out forgets every draft this tab kept, in memory and in its store. */
  clear() {
    for (const draft of this.#drafts.values()) draft.dispose();
    this.#drafts.clear();
    try {
      const keys = Array.from({ length: this.#store?.length ?? 0 }, (_, i) => this.#store?.key(i));
      for (const key of keys) if (key?.startsWith(KEY)) this.#store?.removeItem(key);
    } catch {
      // Nothing saved is reachable either.
    }
  }
}

function browserStore(): DraftStore | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export const drafts = new ChatDrafts();
