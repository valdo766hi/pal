// The systems an evaluation runs. Pal and the baseline loop share one model and its credentials, so their results
// are model-matched; an external command's model and settings are outside Pal's control, so it is unmatched.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  Message,
  ModelThinkingLevel,
  Tool,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type Cursor,
  type EntryRecord,
  type JsonObject,
  UsageDoc,
  watchEvents,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Pal } from "../core/app.ts";
import { readFileSnapshot, resolveProjectPath } from "../core/files.ts";
import { gnuTimeout } from "../core/timeout.ts";
import { evaluationBudgetExceeded, evaluationBudgetTurns, setEvaluationBudget } from "../pi/evaluation-budget.ts";
import { CHATGPT_PROVIDER } from "../pi/chatgpt.ts";
import type { Continuation } from "./tasks.ts";

export type ModelChoice = {
  readonly provider: string;
  readonly modelId: string;
  readonly effort: ModelThinkingLevel;
};
export type Budget = { readonly seconds: number; readonly turns: number };
export type RunInput = {
  readonly workspace: string;
  readonly prompt: string;
  readonly continuations?: readonly Continuation[];
  readonly runId: string;
  readonly budget: Budget;
};
export type RunOutcome = {
  readonly status: "completed" | "budget_exceeded" | "harness_error";
  readonly error: string | null;
  readonly turns: number | null;
  readonly toolCalls: number | null;
  readonly failedToolCalls: number | null;
  /** Owner decisions the run needed, such as command approvals; null when unreported. */
  readonly interventions: number | null;
  /** Absent when the system does not report usage. */
  readonly usage: { input: number; output: number; totalTokens: number; cost: number | null } | null;
  readonly trace: unknown;
};
export type Harness = {
  readonly id: string;
  readonly version: number;
  readonly configuration: Readonly<JsonObject>;
  /** Uses the run's exact model and reasoning setting, unlike an uncontrolled external product. */
  readonly matched: boolean;
  run(input: RunInput): Promise<RunOutcome>;
};

const sumUsage = (messages: readonly { usage?: Usage }[], provider: string) => {
  const usage = messages.reduce(
    (total, message) =>
      message.usage === undefined
        ? total
        : {
            input: total.input + message.usage.input,
            output: total.output + message.usage.output,
            totalTokens: total.totalTokens + message.usage.totalTokens,
            cost: total.cost + message.usage.cost.total,
          },
    { input: 0, output: 0, totalTokens: 0, cost: 0 },
  );
  return { ...usage, cost: provider === CHATGPT_PROVIDER ? null : usage.cost };
};

export async function palTrace(pal: Pal, root: ConversationId) {
  const pending = [root];
  const conversations: {
    conversation: ConversationId;
    parent: ConversationId | null;
    task: number | null;
    entries: EntryRecord[];
  }[] = [];
  const usage: Usage[] = [];
  let count = 0,
    bytes = 0;
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i];
    if (id === undefined) throw new Error("missing evaluation conversation");
    const record = await pal.store.storage.conversation(id, context);
    if (record === undefined) throw new Error("evaluation conversation disappeared");
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await pal.store.storage.scanEntries(
        { conversationId: id, order: "ascending" },
        128,
        cursor,
        context,
      );
      for (const entry of page.items) {
        bytes += Buffer.byteLength(JSON.stringify(entry));
        if (++count > 32_768 || bytes > 64 * 1024 * 1024)
          throw new Error("evaluation trace exceeds its entry or byte limit");
        entries.push(entry);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    conversations.push({
      conversation: id,
      parent: record.owner?.conversationId ?? null,
      task: record.owner?.taskId ?? null,
      entries,
    });
    const spend = await pal.harness.snapshot(UsageDoc, id, context);
    usage.push(...Object.values(spend?.models ?? {}));
    const children = await pal.store.storage.scanConversations({ ownerConversationId: id }, 256, undefined, context);
    if (children.next !== undefined || pending.length + children.items.length > 256)
      throw new Error("evaluation trace exceeds its conversation limit");
    pending.push(...children.items.map((child) => child.id));
  }
  return { trace: { root, conversations }, usage };
}

/** Pal itself: a project over the run's workspace and one chat, in Full access unless approvals are requested. */
export function palHarness(pal: Pal, model: ModelChoice, approvals: "full" | "approve-all" = "full"): Harness {
  return {
    id: "pal",
    version: 2,
    configuration: { model, approvals, tools: "Pal's selected capabilities through codemode" },
    matched: true,
    async run({ workspace, prompt, continuations = [], runId, budget }) {
      const expires = Date.now() + budget.seconds * 1000;
      const request = randomUUID();
      const project = await pal.projects.create(`eval-project-${request}`, { name: runId, folder: workspace });
      const chat = await pal.chats.createChat(`eval-chat-${request}`, { projectId: project.id, title: runId }, context);
      await pal.chats.configure(
        chat.id,
        { model: { provider: model.provider, modelId: model.modelId }, thinkingLevel: model.effort },
        context,
      );
      await pal.approvals.setMode(chat.id, approvals === "full" ? "full" : "ask");
      const conversation = await pal.harness.conversation(chat.conversationId, context);
      if (conversation === undefined) throw new Error("the evaluation chat has no conversation");
      let interventions = 0;
      let status: RunOutcome["status"] = "completed";
      let error: string | null = null;
      let approvalJob: Promise<void> | undefined;
      let approvalError: string | null = null;
      // Serialize automatic decisions; one pending approval is one intervention, not one polling tick.
      let approve: ReturnType<typeof setInterval> | undefined;
      if (approvals === "approve-all") {
        approve = setInterval(() => {
          if (approvalJob !== undefined) return;
          approvalJob = pal.approvals
            .view(chat.id)
            .then(async (view) => {
              for (const pending of view.approvals.filter((item) => item.state === "pending")) {
                await pal.approvals.decide(chat.id, pending.id, "approve", pending.digest);
                interventions++;
              }
            })
            .catch((failure: unknown) => {
              approvalError = failure instanceof Error ? failure.message : String(failure);
            })
            .finally(() => {
              approvalJob = undefined;
            });
        }, 200);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await setEvaluationBudget(pal.harness, chat.conversationId, budget.turns, expires, context);
        const deadline = new Promise<"timeout">((done) => {
          timer = setTimeout(() => done("timeout"), Math.max(0, expires - Date.now()));
        });
        let stage = 0;
        for (const input of [{ prompt, owner: false }, ...continuations]) {
          if (input.owner) interventions++;
          await pal.chats.submit(chat.id, `eval-input-${request}-${stage++}`, { text: input.prompt }, context);
          if ((await Promise.race([conversation.waitForIdle(context), deadline])) === "timeout") {
            status = "budget_exceeded";
            await conversation.abort(context);
            await conversation.waitForIdle(context);
            break;
          }
          if (await evaluationBudgetExceeded(pal.harness, chat.conversationId, context)) break;
          if (stage <= continuations.length) {
            const watch = await watchEvents(pal.harness, chat.conversationId, context);
            const messages = watch.snapshot.entries.flatMap((entry) => entry.model ?? []) as Message[];
            await watch.stop();
            const last = messages.findLast((message) => message.role === "assistant");
            if (last?.stopReason === "error" || last?.stopReason === "aborted") break;
          }
        }
        const watch = await watchEvents(pal.harness, chat.conversationId, context);
        const compactions = watch.snapshot.compactions;
        await watch.stop();
        if (
          (await Promise.race([
            Promise.all(compactions.map((task) => pal.harness.waitForTask(task.taskId, context))),
            deadline,
          ])) === "timeout"
        ) {
          status = "budget_exceeded";
          await conversation.abort(context, { background: true });
        }
      } catch (failure) {
        await conversation.abort(context, { background: true });
        status = "harness_error";
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        clearTimeout(timer);
        clearInterval(approve);
        await approvalJob;
      }
      if (await evaluationBudgetExceeded(pal.harness, chat.conversationId, context)) status = "budget_exceeded";
      if (approvalError !== null) {
        status = "harness_error";
        error = approvalError;
      }
      const recorded = await palTrace(pal, chat.conversationId);
      const messages = recorded.trace.conversations.flatMap((scope) =>
        scope.entries.flatMap((entry) => entry.model ?? []),
      ) as Message[];
      const assistant = messages.filter((message): message is AssistantMessage => message.role === "assistant");
      const results = messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
      const rootMessages = (recorded.trace.conversations[0]?.entries.flatMap((entry) => entry.model ?? []) ??
        []) as Message[];
      const last = rootMessages.findLast((message): message is AssistantMessage => message.role === "assistant");
      const calls = assistant.flatMap((message) => message.content.filter((block) => block.type === "toolCall"));
      if (status === "completed" && (last?.stopReason === "error" || last?.stopReason === "aborted")) {
        status = "harness_error";
        error = last.errorMessage ?? "the model request failed";
      }
      return {
        status,
        error,
        turns: await evaluationBudgetTurns(pal.harness, chat.conversationId, context),
        toolCalls: calls.length,
        failedToolCalls: results.length === calls.length ? results.filter((result) => result.isError).length : null,
        interventions,
        usage: sumUsage(
          recorded.usage.map((usage) => ({ usage })),
          model.provider,
        ),
        trace: recorded.trace,
      };
    },
  };
}

const MAX_OUTPUT = 16 * 1024;
const TOOLS: Tool[] = [
  {
    name: "list_files",
    description: "List a folder's entries, relative to the workspace.",
    parameters: Type.Object({ path: Type.String() }),
  },
  {
    name: "read_file",
    description: "Read a UTF-8 file, relative to the workspace.",
    parameters: Type.Object({ path: Type.String() }),
  },
  {
    name: "write_file",
    description: "Create or replace a UTF-8 file, relative to the workspace.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  },
  {
    name: "run",
    description: "Run a shell command in the workspace (30 s limit) and return its output.",
    parameters: Type.Object({ command: Type.String() }),
  },
];

/**
 * A deliberately plain reference agent: the same model in a loop with four workspace tools and no planning,
 * memory, approvals or recovery. It is a baseline for what Pal's harness adds, not a sandbox.
 */
export function baselineHarness(
  models: Pick<Pal["models"], "completeSimple">,
  model: Parameters<Pal["models"]["completeSimple"]>[0],
  choice: ModelChoice,
): Harness {
  return {
    id: "baseline-loop",
    version: 2,
    configuration: { model: choice, approvals: "full", tools: TOOLS.map((tool) => tool.name) },
    matched: true,
    async run({ workspace, prompt, continuations = [], budget }) {
      const root = await realpath(workspace);
      const deadline = Date.now() + budget.seconds * 1000;
      const signal = AbortSignal.timeout(budget.seconds * 1000);
      const inside = async (path: unknown, missing: "reject" | "allow" = "reject") => {
        if (typeof path !== "string") throw new Error("use a path relative to the workspace");
        return (await resolveProjectPath(root, path, [], missing)).target;
      };
      const tools: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
        list_files: async ({ path }) => (await readdir(await inside(path ?? "."))).sort().join("\n"),
        read_file: async ({ path }) => (await readFileSnapshot(await inside(path), MAX_OUTPUT)).bytes.toString("utf8"),
        write_file: async ({ path, content }) => {
          const target = await inside(path, "allow");
          await writeFile(target, String(content));
          return `wrote ${relative(root, target)}`;
        },
        run: async ({ command }) => {
          const result = await shell(root, String(command), Math.min(30, (deadline - Date.now()) / 1000), {}, signal);
          const output = `exit ${result.exitCode}\n${result.output}`;
          if (result.exitCode !== 0 || result.timedOut) throw new Error(output);
          return output;
        },
      };
      const system =
        "You are a coding agent working in a repository. Use the tools to inspect and change files and to run " +
        "commands. When the task is done, reply with a short summary and no tool calls.";
      const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
      const assistant: AssistantMessage[] = [];
      let toolCalls = 0,
        failedToolCalls = 0,
        interventions = 0,
        stage = 0;
      try {
        for (let turn = 0; turn < budget.turns; turn++) {
          if (Date.now() >= deadline) return outcome("budget_exceeded", null);
          const reply = await models.completeSimple(
            model,
            { systemPrompt: system, messages, tools: TOOLS },
            { signal, ...(choice.effort === "off" ? {} : { reasoning: choice.effort }) },
          );
          assistant.push(reply);
          messages.push(reply);
          if (signal.aborted) return outcome("budget_exceeded", null);
          if (reply.stopReason === "error" || reply.stopReason === "aborted")
            return outcome("harness_error", reply.errorMessage ?? "the model request failed");
          const calls = reply.content.filter((block) => block.type === "toolCall");
          if (calls.length === 0) {
            const next = continuations[stage++];
            if (next === undefined) return outcome("completed", null);
            if (next.owner) interventions++;
            messages.push({ role: "user", content: next.prompt, timestamp: Date.now() });
          }
          for (const call of calls) {
            signal.throwIfAborted();
            const result = await execute(tools, call);
            toolCalls++;
            if (result.isError) failedToolCalls++;
            messages.push(result);
          }
        }
        return outcome("budget_exceeded", null);
      } catch (failure) {
        return outcome(
          signal.aborted ? "budget_exceeded" : "harness_error",
          failure instanceof Error ? failure.message : String(failure),
        );
      }
      function outcome(status: RunOutcome["status"], error: string | null): RunOutcome {
        return {
          status,
          error,
          turns: assistant.length,
          toolCalls,
          failedToolCalls,
          interventions,
          usage: sumUsage(assistant, choice.provider),
          trace: messages,
        };
      }
    },
  };
}

async function execute(
  tools: Record<string, (args: Record<string, unknown>) => Promise<string>>,
  call: { id: string; name: string; arguments: Record<string, unknown> },
): Promise<ToolResultMessage> {
  let text: string,
    isError = false;
  try {
    const tool = tools[call.name];
    if (tool === undefined) throw new Error(`unknown tool ${call.name}`);
    text = await tool(call.arguments);
  } catch (failure) {
    text = failure instanceof Error ? failure.message : String(failure);
    isError = true;
  }
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

/** Another product run from its own command line in the workspace, with the task prompt in PAL_EVAL_PROMPT. */
export function externalHarness(id: string, command: string): Harness {
  return {
    id,
    version: 2,
    configuration: {
      command,
      model: "uncontrolled",
      turns: "uncontrolled",
      permissions: "owner command",
      continuations: false,
    },
    matched: false,
    async run({ workspace, prompt, continuations = [], budget }) {
      try {
        if (continuations.length !== 0) throw new Error("this external command cannot deliver continuations");
        const result = await shell(workspace, command, budget.seconds, { PAL_EVAL_PROMPT: prompt });
        let status: RunOutcome["status"] = "completed";
        let error: string | null = null;
        if (result.timedOut) {
          status = "budget_exceeded";
          error = "command exceeded its time budget";
        } else if (result.exitCode !== 0) {
          status = "harness_error";
          error = `command exited ${result.exitCode}`;
        }
        return {
          status,
          error,
          turns: null,
          toolCalls: null,
          failedToolCalls: null,
          interventions: null,
          usage: null,
          trace: { command, ...result },
        };
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        return {
          status: "harness_error",
          error: message,
          turns: null,
          toolCalls: null,
          failedToolCalls: null,
          interventions: null,
          usage: null,
          trace: { command },
        };
      }
    },
  };
}

/** Unlike a single tool call, an external harness may use the whole run's (up to one-hour) budget. */
async function shell(
  cwd: string,
  command: string,
  seconds: number,
  env: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<{ output: string; exitCode: number; timedOut: boolean }> {
  signal?.throwIfAborted();
  if (!(seconds > 0 && seconds <= 3600)) throw new Error("invalid evaluation command deadline");
  const home = await mkdtemp(join(tmpdir(), "pal-evaluation-command-"));
  try {
    signal?.throwIfAborted();
    return await new Promise((done, fail) => {
      const child = spawn(
        gnuTimeout(),
        ["--kill-after=1s", `${seconds}s`, process.env.PAL_BASH ?? "bash", "--noprofile", "--norc", "-c", command],
        {
          cwd,
          detached: true,
          env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home, LANG: "C.UTF-8", ...env },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      let timedOut = false;
      const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")] as const;
      const take = (text: string) => {
        const tail = Buffer.from(output + text).subarray(-MAX_OUTPUT);
        let offset = 0;
        while (offset < tail.length && ((tail[offset] ?? 0) & 0xc0) === 0x80) offset++;
        output = tail.subarray(offset).toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => take(decoders[0].write(chunk)));
      child.stderr.on("data", (chunk: Buffer) => take(decoders[1].write(chunk)));
      const kill = () => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          kill();
        },
        seconds * 1000 + 1500,
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        kill();
      };
      child.once("error", (error) => {
        cleanup();
        fail(error);
      });
      child.once("exit", kill);
      child.once("close", (code) => {
        cleanup();
        for (const decoder of decoders) take(decoder.end());
        if (signal?.aborted) fail(signal.reason);
        else done({ output, exitCode: code ?? 137, timedOut: timedOut || code === 124 });
      });
      signal?.addEventListener("abort", kill, { once: true });
      if (signal?.aborted) kill();
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
