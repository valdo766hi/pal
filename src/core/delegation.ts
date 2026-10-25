import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  CompactionTask,
  configure,
  type ConversationId,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTool,
  type Extension,
  GenerationTask,
  type Harness,
  hook,
  type HookApi,
  LiveDoc,
  type Storage,
  type TaskId,
  ToolTask,
  UsageDoc,
} from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { abortBudgetTask } from "../pi/budget.ts";

export const HELPERS_EXTENSION = "pal.helpers";
export const AGENTS_NAMESPACE: CodemodeNamespace = {
  name: "agents",
  prefix: "agents_",
  description: "Read-only research helpers.",
  instructions:
    "agents_delegate hands one self-contained research question to a helper with this chat's model, its granted folders (read-only) and internet tools, and returns the helper's answer. Helpers cannot write files, run commands, use the browser or start helpers. State the purpose and everything the helper needs; it does not see this chat. An unanswered helper may have left internet-tool calls with unknown outcomes: inspect before repeating them.",
};
/** Bounds on one parent run's helpers; every one is enforced from durable state, so restarts keep them. */
export const HELPER_LIMITS = {
  perRun: 4,
  /** Helpers running at once in one project. */
  concurrent: 2,
  turns: 12,
  calls: 40,
  tokens: 200_000,
  /** All helpers of one parent run together. */
  runTokens: 500_000,
  minutes: 10,
};
export type HelperLimits = typeof HELPER_LIMITS;
/** Tools a helper may call: read-only project tools; internet tools are checked against the parent's grants. */
const HELPER_TOOLS = new Set([
  "files_folders",
  "files_list",
  "files_read",
  "files_search",
  "files_find",
  "instructions_scope",
  "skills_search",
  "skills_read",
]);
/** Extensions a helper's conversation never selects, whatever its parent has. */
const EXCLUDED = [HELPERS_EXTENSION, "pal.shell", "pal.browser", "pal.compact"];

type Effect = { task: number; tool: string; state: "started" | "finished" };
type Outcome = { id: string; status: "answered" | "unanswered"; reason: string; unknown: Effect[] };
const Helper = defineDoc({
  kind: "pal.helper",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    parent: 0,
    task: 0,
    run: 0,
    purpose: "",
    deadline: 0,
    turns: 0,
    calls: 0,
    stopped: null as string | null,
    effects: [] as Effect[],
    /** Written once: a replayed or retried completion returns this record, not a second one. */
    outcome: null as Outcome | null,
  }),
});
/** One parent run's helper allowance. */
const Allowance = defineDoc({
  kind: "pal.helpers",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ run: 0, started: 0, children: [] as number[] }),
});
const Slots = defineDocFamily({
  kind: "pal.helper-slots",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ tasks: [] as number[] }),
});

/** A helper conversation's owner edge to the chat conversation that delegated it; one level only. */
export type HelperLink = { readonly conversation: ConversationId; readonly task: TaskId };

/** Resolves helper conversations to their parent chat; owner edges are immutable, so answers are cached. */
export class HelperLinks {
  readonly #storage: Storage;
  readonly #database: SqliteDatabase;
  readonly #known = new Map<ConversationId, HelperLink | null>();

  constructor(storage: Storage, database: SqliteDatabase) {
    this.#storage = storage;
    this.#database = database;
  }

  async parent(conversation: ConversationId): Promise<HelperLink | undefined> {
    const cached = this.#known.get(conversation);
    if (cached !== undefined) return cached ?? undefined;
    const record = await this.#storage.conversation(conversation, BACKGROUND_CONTEXT);
    if (record === undefined) return undefined;
    const owner = record.owner;
    const chat =
      owner === undefined
        ? undefined
        : await this.#database.get("SELECT 1 AS chat FROM pal_chats WHERE conversation_id = ?", owner.conversationId);
    const link =
      owner === undefined || chat === undefined ? null : { conversation: owner.conversationId, task: owner.taskId };
    this.#known.set(conversation, link);
    return link ?? undefined;
  }

  /** The chat conversation whose grants apply: a helper's parent, or the conversation itself. */
  async chat(conversation: ConversationId): Promise<ConversationId> {
    return (await this.parent(conversation))?.conversation ?? conversation;
  }

  /** Whether a helper may call this tool; internet tools still need the parent's grants. */
  static allows(name: string, granted: (name: string) => Promise<boolean>): Promise<boolean> {
    return HELPER_TOOLS.has(name) ? Promise.resolve(true) : granted(name);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block: { type?: string; text?: string }) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("");
}

/**
 * The helpers capability: `agents_delegate` creates a conversation owned by the calling tool task, so aborting or
 * failing the call aborts the helper, and a rerun after a crash finds the same helper and submission.
 */
export function helperTools(options: {
  project: (conversation: ConversationId) => Promise<string | undefined>;
  /** Read at each check; tests lower them. */
  limits?: HelperLimits;
}) {
  const limits = options.limits ?? HELPER_LIMITS;
  return defineExtension({
    name: HELPERS_EXTENSION,
    tools: [
      defineTool({
        name: "agents_delegate",
        description:
          "Ask a read-only research helper one self-contained question and wait for its answer. The helper uses this chat's model and can read granted folders and use granted internet tools, but cannot write, run commands, browse or start helpers.",
        parameters: Type.Object({
          purpose: Type.String({ minLength: 1, maxLength: 200 }),
          task: Type.String({ minLength: 1, maxLength: 8000 }),
        }),
        callers: ["tools"],
        replay: "safe",
        outputLimits: { maxBytes: 16 * 1024, maxLines: 400 },
        structuredOutputSchema: Type.Object({
          resultId: Type.String(),
          status: Type.Enum(["answered", "unanswered"]),
          answer: Type.String(),
          reason: Type.String(),
          unknownEffects: Type.Array(Type.Object({ tool: Type.String(), task: Type.Number() })),
        }),
        execute: async (args, api, context) => {
          const live = await api.snapshot(LiveDoc, api.conversationId, context);
          const run = live?.run?.inputs[0];
          if (run === undefined) throw new Error("helpers need an active run");
          const project = await options.project(api.conversationId);
          if (project === undefined) throw new Error("this conversation has no active project");
          const excluded = EXCLUDED.flatMap((name) => api.registry.extension(name) ?? []) as Extension[];
          const child = await api.commit(async (tx) => {
            const known = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            if (known !== undefined) return known.id;
            if ((await tx.conversation(api.conversationId))?.owner !== undefined)
              throw new Error("helpers cannot start helpers");
            const slots = await tx.doc(Slots, project, null);
            const active: number[] = [];
            for (const id of slots.tasks) {
              const task = await tx.task(id as TaskId);
              if (task !== undefined && task.state.status !== "terminal") active.push(id);
            }
            if (active.length >= limits.concurrent)
              throw new Error(
                `${limits.concurrent} helpers are already running in this project; wait for one to finish`,
              );
            // Reserve with creation; slow recovery cannot temporarily free a live owner's slot.
            slots.tasks = [...active, api.taskId];
            const allowance = await tx.doc(Allowance, api.conversationId);
            if (allowance.run !== run) {
              allowance.run = run;
              allowance.started = 0;
              allowance.children = [];
            }
            if (allowance.started >= limits.perRun)
              throw new Error(`this run already started ${limits.perRun} helpers`);
            const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
            allowance.started++;
            allowance.children.push(created.id);
            await configure(tx, created.id, { extensions: { remove: excluded } });
            const helper = await tx.doc(Helper, created.id);
            helper.parent = api.conversationId;
            helper.task = api.taskId;
            helper.run = run;
            helper.purpose = args.purpose;
            helper.deadline = Date.now() + limits.minutes * 60_000;
            await tx.appendEntry(api.conversationId, {
              kind: "pal.helper",
              data: { helper: { task: api.taskId, conversation: created.id, purpose: args.purpose } },
            });
            return created.id;
          }, context);
          await api.details({ conversationId: child }, context);
          const handle = await api.conversation(child, context);
          if (handle === undefined) throw new Error("the helper conversation is missing");
          const submission = await handle.submit(
            {
              type: "input",
              requestId: `helper-${api.taskId}`,
              content: [
                "You are a read-only research helper for another Pal chat; that chat does not see this conversation.",
                `Purpose: ${args.purpose}`,
                "You can read and search the granted project folders and use the internet tools granted to the project. You cannot write files, run commands, use the browser or start helpers.",
                "Answer concisely with what you found and how you checked it, and say what you could not verify.",
                "",
                args.task,
              ].join("\n"),
            },
            context,
          );
          const state = await api.snapshot(Helper, child, context);
          if (state === undefined) throw new Error("the helper budget is missing");
          let timer: ReturnType<typeof setTimeout> | undefined;
          let settled;
          try {
            const deadline = new Promise<"deadline">((resolve) => {
              timer = setTimeout(() => resolve("deadline"), Math.max(0, state.deadline - Date.now()));
            });
            const result = await Promise.race([submission.wait(context), deadline]);
            if (result === "deadline") {
              await api.commit(async (tx) => {
                (await tx.doc(Helper, child)).stopped ??= `its ${limits.minutes}-minute limit passed`;
              }, context);
              await handle.abort(context);
              settled = await submission.wait(context);
            } else settled = result;
          } finally {
            clearTimeout(timer);
          }
          const answered = settled.type === "input" && settled.status === "done" ? settled.answer : undefined;
          const answer =
            answered === undefined
              ? ""
              : textOf((await api.commit((tx) => tx.entry(answered), context))?.model?.at(-1)?.content);
          const outcome = await api.commit(async (tx): Promise<Outcome> => {
            const helper = await tx.doc(Helper, child);
            if (helper.outcome === null) {
              helper.outcome = {
                id: `helper-${api.taskId}`,
                status: answered === undefined ? "unanswered" : "answered",
                reason: answered === undefined ? (helper.stopped ?? settled.reason ?? "it was stopped") : "",
                unknown: helper.effects.filter((effect) => effect.state === "started"),
              };
              await tx.appendEntry(api.conversationId, {
                kind: "pal.helper",
                data: {
                  result: {
                    task: api.taskId,
                    id: helper.outcome.id,
                    status: helper.outcome.status,
                    unknown: helper.outcome.unknown.length,
                  },
                },
              });
            }
            return { ...helper.outcome, unknown: helper.outcome.unknown.map((effect) => ({ ...effect })) };
          }, context);
          const unknownEffects = outcome.unknown.map(({ tool, task }) => ({ tool, task }));
          const warning =
            unknownEffects.length === 0
              ? ""
              : ` Outcome unknown for: ${unknownEffects.map((effect) => effect.tool).join(", ")}.`;
          return {
            output: [
              {
                type: "text",
                text:
                  outcome.status === "answered"
                    ? answer
                    : `The helper stopped without an answer: ${outcome.reason}.${warning}`,
              },
            ],
            structuredOutput: {
              resultId: outcome.id,
              status: outcome.status,
              answer,
              reason: outcome.reason,
              unknownEffects,
            },
          };
        },
      }),
    ],
  });
}

/**
 * Helper budgets and effect journal, composed into the mandatory context extension like the evaluation budget, so a
 * helper's copied extension selection always carries them. Conversations without a helper record are untouched.
 */
export function helperBudget(harness: () => Harness, limits: HelperLimits = HELPER_LIMITS) {
  const tokens = async (api: HookApi, conversation: ConversationId, context: Context) =>
    Object.values((await api.snapshot(UsageDoc, conversation, context))?.models ?? {}).reduce(
      (sum, usage) => sum + (usage.totalTokens ?? 0),
      0,
    );
  async function exhausted(api: HookApi, context: Context, request = true): Promise<string | undefined> {
    const helper = await api.snapshot(Helper, api.conversationId, context);
    if (helper === undefined || helper.parent === 0) return undefined;
    if (helper.stopped !== null) return helper.stopped;
    const allowance = await api.snapshot(Allowance, helper.parent as ConversationId, context);
    let spent = 0;
    for (const child of allowance?.run === helper.run ? allowance.children : [api.conversationId])
      spent += await tokens(api, child as ConversationId, context);
    if (Date.now() >= helper.deadline) return `its ${limits.minutes}-minute limit passed`;
    if (request && helper.turns >= limits.turns) return `it used its ${limits.turns} model requests`;
    if ((await tokens(api, api.conversationId, context)) >= limits.tokens) return `it used its ${limits.tokens} tokens`;
    if (spent >= limits.runTokens) return `this run's helpers used their ${limits.runTokens} tokens`;
    return undefined;
  }
  const stop = (api: HookApi, reason: string, context: Context) =>
    harness().commit(async (tx) => {
      const helper = await tx.doc(Helper, api.conversationId);
      helper.stopped ??= reason;
    }, context);
  return defineExtension({
    name: "pal.helper-budget",
    hooks: [
      hook(CompactionTask, {
        beforeCompact: async (_compaction, api, context) => {
          // Summaries bypass request hooks; bounded single-question helpers must not buy uncounted requests.
          if (((await api.snapshot(Helper, api.conversationId, context))?.parent ?? 0) !== 0) return { decline: true };
          return undefined;
        },
      }),
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const reason = await exhausted(api, context);
          if (reason === undefined) {
            if (((await api.snapshot(Helper, api.conversationId, context))?.parent ?? 0) !== 0)
              await harness().commit(async (tx) => {
                (await tx.doc(Helper, api.conversationId)).turns++;
              }, context);
            return;
          }
          await stop(api, reason, context);
          return abortBudgetTask(harness(), api.taskId, context);
        },
      }),
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const helper = await api.snapshot(Helper, api.conversationId, context);
          if (helper === undefined || helper.parent === 0) return undefined;
          const reason =
            (await exhausted(api, context, false)) ??
            (helper.calls >= limits.calls ? `it made its ${limits.calls} tool calls` : undefined);
          if (reason !== undefined) {
            await stop(api, reason, context);
            return { block: `helper budget exhausted: ${reason}` };
          }
          await harness().commit(async (tx) => {
            const draft = await tx.doc(Helper, api.conversationId);
            draft.calls++;
            // Only internet tools can reach outside Pal; journal them so an interruption reports them.
            if (call.parent !== undefined && call.name.startsWith("mcp__"))
              draft.effects.push({ task: api.taskId, tool: call.name, state: "started" });
          }, context);
          return undefined;
        },
        afterTool: async (_call, result, api, context) => {
          const helper = await api.snapshot(Helper, api.conversationId, context);
          if (helper?.effects.some((effect) => effect.task === api.taskId && effect.state === "started"))
            await harness().commit(async (tx) => {
              for (const effect of (await tx.doc(Helper, api.conversationId)).effects)
                if (effect.task === api.taskId) effect.state = "finished";
            }, context);
          return result;
        },
      }),
    ],
  });
}

export type HelperView = {
  task: number;
  conversation: number;
  purpose: string;
  status: "running" | "answered" | "unanswered" | "stopped";
  reason: string | null;
  turns: number;
  calls: number;
  tokens: number;
  unknownEffects: { tool: string; task: number }[];
};

/** The owner's view of a chat's helpers, from durable state only; an interrupted helper's started calls are unknown. */
export async function helperViews(
  harness: Harness,
  storage: Storage,
  conversation: ConversationId,
  context: Context,
): Promise<HelperView[]> {
  const children = await storage.scanConversations({ ownerConversationId: conversation }, 100, undefined, context);
  return Promise.all(
    children.items.map(async (record): Promise<HelperView> => {
      const helper = await harness.snapshot(Helper, record.id, context);
      const outcome = helper?.outcome ?? null;
      const task = record.owner === undefined ? undefined : await harness.getTask(record.owner.taskId, context);
      const usage = await harness.snapshot(UsageDoc, record.id, context);
      const active = task !== undefined && task.state.status !== "terminal";
      const unknown = (helper?.effects ?? []).filter((effect) => effect.state === "started");
      let status: HelperView["status"] = active ? "running" : "stopped";
      if (outcome !== null) status = outcome.status;
      return {
        task: Number(record.owner?.taskId ?? 0),
        conversation: record.id,
        purpose: helper?.purpose ?? "",
        status,
        reason: outcome?.reason || helper?.stopped || null,
        turns: helper?.turns ?? 0,
        calls: helper?.calls ?? 0,
        tokens: Object.values(usage?.models ?? {}).reduce((sum, item) => sum + (item.totalTokens ?? 0), 0),
        unknownEffects: active ? [] : unknown.map(({ tool, task }) => ({ tool, task })),
      };
    }),
  );
}
