import type { Context } from "@earendil-works/chord";
import {
  CompactionTask,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ToolTask,
  type ConversationId,
  type Harness,
  type HookApi,
} from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { abortBudgetTask } from "../pi/budget.ts";
import { HttpError } from "./http.ts";
import type { Working } from "./working-state.ts";

const MAX = { steps: 64, calls: 256 };
const Limits = Type.Object(
  {
    steps: Type.Integer({ minimum: 1, maximum: MAX.steps }),
    calls: Type.Integer({ minimum: 1, maximum: MAX.calls }),
  },
  { additionalProperties: false },
);
export const AllowanceChange = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    goalRevision: Type.Integer({ minimum: 0 }),
    limits: Type.Union([Limits, Type.Null()]),
  },
  { additionalProperties: false },
);
const Blocked = Type.Object({
  reason: Type.Enum(["steps", "calls", "goal-changed"]),
  task: Type.Integer(),
  at: Type.Number(),
});
type Data = {
  revision: number;
  goalRevision: number;
  limits: Static<typeof Limits> | null;
  steps: number[];
  calls: number[];
  blocked: Static<typeof Blocked> | null;
  updatedAt: number | null;
};
const initial = (): Data => ({
  revision: 0,
  goalRevision: 0,
  limits: null,
  steps: [],
  calls: [],
  blocked: null,
  updatedAt: null,
});
const Allowance = defineDoc({
  kind: "pal.working-allowance",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial,
});
const View = Type.Object({
  revision: Type.Integer(),
  goalRevision: Type.Integer(),
  state: Type.Enum(["disabled", "ready", "at-limit", "blocked", "goal-changed"]),
  limits: Type.Union([Limits, Type.Null()]),
  used: Type.Object({ steps: Type.Integer(), calls: Type.Integer() }),
  max: Type.Object({ steps: Type.Integer(), calls: Type.Integer() }),
  blocked: Type.Union([Blocked, Type.Null()]),
  updatedAt: Type.Union([Type.Number(), Type.Null()]),
  notice: Type.String(),
});
type Host = {
  working: typeof Working;
  harness(): Harness;
  root(conversation: ConversationId): Promise<ConversationId>;
  ready(conversation: ConversationId): Promise<void>;
};

/** Counts logical native tasks, not provider retries, tokens, wall time or money. */
export function workingAllowance(host: Host) {
  async function inspect(conversation: ConversationId, context: Context): Promise<Static<typeof View>> {
    await host.ready(conversation);
    const harness = host.harness();
    const goal = (await harness.snapshot(host.working, conversation, context))?.goal;
    const saved = (await harness.snapshot(Allowance, conversation, context)) ?? initial();
    let state: Static<typeof View>["state"] = "ready";
    if (saved.limits === null) state = "disabled";
    else if (goal?.revision !== saved.goalRevision || !goal.text) state = "goal-changed";
    else if (saved.blocked !== null) state = "blocked";
    else if (saved.steps.length >= saved.limits.steps || saved.calls.length >= saved.limits.calls) state = "at-limit";
    await host.ready(conversation);
    return {
      revision: saved.revision,
      goalRevision: saved.goalRevision,
      limits: saved.limits,
      used: { steps: saved.steps.length, calls: saved.calls.length },
      max: { ...MAX },
      state,
      blocked: saved.blocked,
      updatedAt: saved.updatedAt,
      notice:
        "Owner opt-in only. Counts native model steps (including summaries and helpers) and tool attempts (including Code Mode and nested calls), not provider retries, discovery globals, tokens, wall time or money. Existing per-call limits and grants still apply. Saving/renewing resets this allowance without starting or resuming work; identical retries do not. Goal correction blocks new work until the owner renews or disables it. In-flight effects are not undone.",
    };
  }

  async function configure(conversation: ConversationId, args: Static<typeof AllowanceChange>, context: Context) {
    await host.harness().commit(async (tx) => {
      await host.ready(conversation);
      const working = await tx.doc(host.working, conversation);
      if (working.goal.revision !== args.goalRevision || (args.limits !== null && !working.goal.text))
        throw new HttpError(
          409,
          "working_allowance_stale",
          "Review the current saved goal before assigning an execution allowance.",
        );
      const state = await tx.doc(Allowance, conversation);
      const same =
        state.goalRevision === args.goalRevision &&
        (state.limits === null
          ? args.limits === null
          : args.limits !== null &&
            state.limits.steps === args.limits.steps &&
            state.limits.calls === args.limits.calls);
      if (state.revision === args.revision + 1 && same) return;
      if (state.revision !== args.revision)
        throw new HttpError(
          409,
          "working_allowance_stale",
          "The execution allowance changed. Refresh and review it before renewing.",
        );
      state.revision++;
      state.goalRevision = args.goalRevision;
      state.limits = args.limits === null ? null : { steps: args.limits.steps, calls: args.limits.calls };
      state.steps = [];
      state.calls = [];
      state.blocked = null;
      state.updatedAt = Date.now();
    }, context);
  }

  async function allow(api: HookApi, kind: "steps" | "calls", context: Context) {
    const root = await host.root(api.conversationId);
    const previous = await api.snapshot(Allowance, root, context);
    if (previous?.limits == null) return true;
    return host.harness().commit(async (tx) => {
      const state = await tx.doc(Allowance, root);
      if (state.limits === null) return true;
      const working = await tx.doc(host.working, root);
      let reason: Static<typeof Blocked>["reason"] | undefined;
      if (!working.goal.text || working.goal.revision !== state.goalRevision) reason = "goal-changed";
      else if (state.blocked !== null) return false;
      else if (state[kind].includes(Number(api.taskId))) return true;
      else if (state[kind].length >= state.limits[kind]) reason = kind;
      if (reason !== undefined) {
        state.blocked ??= { reason, task: Number(api.taskId), at: Date.now() };
        return false;
      }
      state[kind].push(Number(api.taskId));
      return true;
    }, context);
  }

  const extension = defineExtension({
    name: "pal.working-allowance",
    tools: [
      defineTool({
        name: "working_allowance",
        description:
          "Read the owner's current execution allowance and recorded exhaustion. Cannot change limits or resume work. The owner can inspect/renew/disable exhausted allowances in Context.",
        parameters: Type.Object({}, { additionalProperties: false }),
        structuredOutputSchema: View,
        outputLimits: { maxBytes: 4096, maxLines: 100 },
        callers: ["tools"],
        replay: "safe",
        execute: async (_args, api, context) => {
          const result = await inspect(api.conversationId, context);
          return { structuredOutput: result, details: result };
        },
      }),
    ],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          let permitted = false;
          try {
            permitted = await allow(api, "steps", context);
          } catch {
            context.abortSignal?.throwIfAborted();
          }
          if (!permitted) return abortBudgetTask(host.harness(), api.taskId, context);
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (_request, api, context) => {
          try {
            if (await allow(api, "steps", context)) return;
          } catch {
            context.abortSignal?.throwIfAborted();
          }
          return { decline: true };
        },
      }),
      hook(ToolTask, {
        beforeTool: async (_call, api, context) =>
          (await allow(api, "calls", context))
            ? undefined
            : {
                block:
                  "Owner-set execution allowance exhausted or bound to a different goal. Inspect Context and explicitly renew/disable it before new work. This call was not dispatched; inspect any earlier unknown effects before continuing.",
              },
      }),
    ],
  });
  return { extension, inspect, configure };
}
