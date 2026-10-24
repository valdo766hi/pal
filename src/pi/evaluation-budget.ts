import type { Context } from "@earendil-works/chord";
import {
  CompactionTask,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ToolTask,
  type ConversationId,
  type Harness,
  type HookApi,
} from "@earendil-works/pi-durable";
import { abortBudgetTask } from "./budget.ts";

type BudgetState = { maxTurns: number; turns: number; deadline: number; task: number; exceeded: boolean };
const Budget = defineDoc({
  kind: "pal.evaluation-budget",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (): BudgetState => ({ maxTurns: 0, turns: 0, deadline: 0, task: 0, exceeded: false }),
});

export async function setEvaluationBudget(
  harness: Harness,
  conversation: ConversationId,
  turns: number,
  deadline: number,
  context: Context,
): Promise<void> {
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > 200 || !Number.isSafeInteger(deadline) || deadline < 1)
    throw new Error("invalid evaluation budget");
  await harness.commit(async (tx) => {
    const budget = await tx.doc(Budget, conversation);
    if (budget.maxTurns !== 0 && (budget.maxTurns !== turns || budget.deadline !== deadline))
      throw new Error("an evaluation budget cannot be changed after assignment");
    budget.maxTurns = turns;
    budget.deadline = deadline;
  }, context);
}

export async function evaluationBudgetExceeded(harness: Harness, conversation: ConversationId, context: Context) {
  return (await harness.snapshot(Budget, conversation, context))?.exceeded === true;
}

export async function evaluationBudgetTurns(harness: Harness, conversation: ConversationId, context: Context) {
  return (await harness.snapshot(Budget, conversation, context))?.turns ?? null;
}

/** Composed into the mandatory context extension so reopening an evaluation store cannot drop its budget. */
export function evaluationBudget(harness: () => Harness) {
  async function allow(api: HookApi, turn: boolean, context: Context): Promise<boolean> {
    let conversation = api.conversationId;
    if ((await api.snapshot(Budget, conversation, context)) === undefined) {
      const parent = await harness().commit(
        async (tx) => (await tx.conversation(conversation))?.owner?.conversationId,
        context,
      );
      if (parent === undefined || (await api.snapshot(Budget, parent, context)) === undefined) return true;
      conversation = parent;
    }
    return harness().commit(async (tx) => {
      const budget = await tx.doc(Budget, conversation);
      if (
        budget.exceeded ||
        Date.now() >= budget.deadline ||
        (turn && budget.task !== api.taskId && budget.turns >= budget.maxTurns)
      ) {
        budget.exceeded = true;
        return false;
      }
      if (turn && budget.task !== api.taskId) {
        budget.turns++;
        budget.task = api.taskId;
      }
      return true;
    }, context);
  }
  return defineExtension({
    name: "pal.evaluation-budget",
    hooks: [
      // Native summary requests bypass the generation request hook.
      hook(CompactionTask, {
        beforeCompact: async (_compaction, api, context) =>
          (await allow(api, true, context)) ? undefined : { decline: true },
      }),
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          if (await allow(api, true, context)) return;
          return abortBudgetTask(harness(), api.taskId, context);
        },
      }),
      hook(ToolTask, {
        beforeTool: async (_call, api, context) =>
          (await allow(api, false, context)) ? undefined : { block: "the evaluation budget is exhausted" },
      }),
    ],
  });
}
