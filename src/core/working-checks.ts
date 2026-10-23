import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineTool,
  type ConversationId,
  type Harness,
  type TaskId,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import type { ShellResult } from "./execution.ts";
import { HttpError } from "./http.ts";
import type { Working } from "./working-state.ts";
import { REVISION_SCOPE } from "./workspace-revision.ts";

const ATTEMPTS = 16;
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Receipt = Type.Object({
  task: Type.Integer(),
  goalRevision: Type.Integer(),
  criterion: Type.Integer(),
  command: Type.String(),
  commandDigest: Digest,
  commandTruncated: Type.Boolean(),
  workspace: Type.String(),
  before: Digest,
  after: Type.Union([Digest, Type.Null()]),
  startedAt: Type.Number(),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
  outcome: Type.Enum(["started", "passed", "failed", "changed", "unavailable"]),
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  timedOut: Type.Boolean(),
  outputTruncated: Type.Boolean(),
});
type Record = Static<typeof Receipt>;
type Data = { goalRevision: number; attempts: number; records: Record[] };
const initial = (): Data => ({ goalRevision: 0, attempts: 0, records: [] });
const Checks = defineDoc({
  kind: "pal.working-checks",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial,
});
const View = Type.Object({
  goalRevision: Type.Integer(),
  attempts: Type.Integer(),
  limit: Type.Integer(),
  state: Type.Enum(["not-started", "needs-checks", "blocked", "budget-exhausted", "ready-for-review"]),
  checks: Type.Array(
    Type.Object({
      ...Receipt.properties,
      outcome: Type.Enum(["started", "passed", "failed", "changed", "unavailable", "unknown"]),
      stale: Type.Boolean(),
    }),
  ),
  remaining: Type.Array(Type.Integer()),
  scope: Type.String(),
  notice: Type.String(),
});
type Snapshot = { workspace: string; root: string; revision: string };
type Host = {
  working: typeof Working;
  harness(): Harness;
  ready(conversation: ConversationId): Promise<void>;
  revision(conversation: ConversationId, context: Context): Promise<Snapshot>;
};

/** Receipts come only from the host shell executor, never from an agent checkpoint or supplied result. */
export class WorkingChecks {
  readonly tools;
  readonly #host: Host;
  constructor(host: Host) {
    this.#host = host;
    this.tools = [
      defineTool({
        name: "working_checks",
        description:
          "Read host-run acceptance command receipts and current source freshness. A zero exit is not proof that a command adequately tests the owner's criterion. Unknown effects require inspection, never blind retry.",
        parameters: Type.Object({}, { additionalProperties: false }),
        structuredOutputSchema: View,
        outputLimits: { maxBytes: 16 * 1024, maxLines: 300 },
        callers: ["tools"],
        replay: "safe",
        execute: async (_args, api, context) => {
          const result = await this.inspect(api.conversationId, context);
          return { structuredOutput: result, details: result };
        },
      }),
    ];
  }

  async clear(tx: Tx, conversation: ConversationId, goalRevision: number) {
    Object.assign(await tx.doc(Checks, conversation), { goalRevision, attempts: 0, records: [] });
  }

  async start(
    api: ToolExecutionApi,
    binding: { goalRevision: number; criterion: number },
    cwd: string,
    command: string,
    context: Context,
  ) {
    await this.#host.ready(api.conversationId);
    const previous = await api.snapshot(Checks, api.conversationId, context);
    if (previous?.goalRevision === binding.goalRevision && previous.attempts >= ATTEMPTS) throw this.#budget();
    const snapshot = await this.#host.revision(api.conversationId, context);
    if (snapshot.root !== cwd) throw new HttpError(409, "working_stale", "The verification workspace changed.");
    await api.commit(async (tx) => {
      const working = await tx.doc(this.#host.working, api.conversationId);
      if (
        !working.goal.text ||
        working.goal.revision !== binding.goalRevision ||
        working.goal.acceptance[binding.criterion] === undefined
      )
        throw new HttpError(
          409,
          "working_stale",
          "Read the current owner goal and acceptance criteria before running a check.",
        );
      const state = await tx.doc(Checks, api.conversationId);
      if (state.goalRevision !== binding.goalRevision)
        Object.assign(state, { goalRevision: binding.goalRevision, attempts: 0, records: [] });
      if (state.attempts >= ATTEMPTS) throw this.#budget();
      state.attempts++;
      state.records = state.records.filter((record) => record.criterion !== binding.criterion);
      state.records.push({
        task: Number(api.taskId),
        ...binding,
        command: Buffer.from(command).subarray(0, 500).toString("utf8"),
        commandDigest: createHash("sha256").update(command).digest("hex"),
        commandTruncated: Buffer.byteLength(command) > 500,
        workspace: snapshot.workspace,
        before: snapshot.revision,
        after: null,
        startedAt: Date.now(),
        finishedAt: null,
        outcome: "started",
        exitCode: null,
        timedOut: false,
        outputTruncated: false,
      });
    }, context);
  }

  async finish(api: ToolExecutionApi, result: ShellResult, context: Context) {
    let snapshot: Snapshot | undefined;
    try {
      snapshot = await this.#host.revision(api.conversationId, context);
    } catch {
      context.abortSignal?.throwIfAborted();
    }
    await api.commit(async (tx) => {
      const state = await tx.doc(Checks, api.conversationId);
      const record = state.records.find((record) => record.task === Number(api.taskId));
      if (record === undefined) return;
      record.after = snapshot?.workspace === record.workspace ? snapshot.revision : null;
      record.finishedAt = Date.now();
      record.exitCode = result.exitCode;
      record.timedOut = result.timedOut;
      record.outputTruncated = result.truncated;
      if (record.after === null) record.outcome = "unavailable";
      else if (record.after !== record.before) record.outcome = "changed";
      else if (result.exitCode !== 0 || result.timedOut) record.outcome = "failed";
      else record.outcome = "passed";
    }, context);
  }

  #budget() {
    return new HttpError(
      409,
      "working_check_budget",
      "This goal used its 16 verification attempts. Review the evidence and revise the goal explicitly; no command was dispatched.",
    );
  }

  async inspect(conversation: ConversationId, context: Context): Promise<Static<typeof View>> {
    await this.#host.ready(conversation);
    const harness = this.#host.harness();
    const goal = (await harness.snapshot(this.#host.working, conversation, context))?.goal;
    const saved = await harness.snapshot(Checks, conversation, context);
    const state = saved !== undefined && saved.goalRevision === goal?.revision ? saved : initial();
    let current: Snapshot | undefined;
    if (state.records.length > 0) {
      try {
        current = await this.#host.revision(conversation, context);
      } catch {
        context.abortSignal?.throwIfAborted();
      }
    }
    const checks = await Promise.all(
      state.records.map(async (record) => {
        let outcome: Static<typeof View>["checks"][number]["outcome"] = record.outcome;
        if (outcome === "started") {
          const task = await harness.getTask(record.task as TaskId, context);
          if (task === undefined || task.state.status === "terminal") outcome = "unknown";
        }
        return {
          ...record,
          outcome,
          stale: current === undefined || current.workspace !== record.workspace || current.revision !== record.after,
        };
      }),
    );
    checks.sort((a, b) => a.criterion - b.criterion);
    const remaining = (goal?.acceptance ?? []).flatMap((_criterion, index) =>
      checks.some((check) => check.criterion === index && check.outcome === "passed" && !check.stale) ? [] : [index],
    );
    let status: Static<typeof View>["state"] = "needs-checks";
    if ((goal?.acceptance.length ?? 0) > 0 && remaining.length === 0) status = "ready-for-review";
    else if (state.attempts >= ATTEMPTS) status = "budget-exhausted";
    else if (checks.some((check) => check.outcome !== "passed" && check.outcome !== "started")) status = "blocked";
    else if (checks.length === 0) status = "not-started";
    await this.#host.ready(conversation);
    return {
      goalRevision: goal?.revision ?? 0,
      attempts: state.attempts,
      limit: ATTEMPTS,
      checks,
      remaining,
      state: status,
      scope: REVISION_SCOPE,
      notice:
        "Receipts prove command outcomes and observed source freshness, not test adequacy, owner review or completion. Command and bounded output remain in the shell task/transcript. Inspect unknown effects before a new attempt; no command is automatically retried.",
    };
  }
}
