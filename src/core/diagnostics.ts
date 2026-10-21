// The owner's redacted support snapshot: versions, states, counts, request IDs and receipt outcomes. It never
// includes credentials, tokens, server addresses, commands, outputs, or chat and file contents.
import { arch, platform } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import pkg from "../../package.json" with { type: "json" };
import type { Pal } from "./app.ts";
import { unfinishedWork } from "./backup.ts";

const RECENT = 20;

type Entry = {
  readonly id: number;
  readonly kind: string;
  readonly model?: readonly { readonly stopReason?: string; readonly errorMessage?: string }[];
  readonly data?: {
    readonly shell?: { callId: string; status: string; exitCode?: number; timedOut?: boolean; truncated?: boolean };
    readonly mcp?: { callId: string; tool: string; isError: boolean };
  };
};

/** Installation-wide state for support, with no secrets or contents. */
export async function installationDiagnostics(pal: Pal) {
  const database = pal.store.database;
  const tables = new Set(
    (await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((t) => t.name),
  );
  const extensions = await pal.extensions.view();
  return {
    format: 1,
    generatedAt: new Date().toISOString(),
    pal: {
      version: pkg.version,
      status: pal.status,
      release: extensions.release,
      schema: (await database.get<{ n: number }>("SELECT max(version) AS n FROM pal_migrations"))?.n ?? null,
    },
    host: { platform: platform(), arch: arch(), node: process.version },
    capabilities: extensions.catalog.map(({ id, available }) => ({
      id,
      available,
      selected: extensions.selected.some((choice) => choice.id === id),
    })),
    providers: (await pal.providers.list()).map(({ id, enabled, hasKey }) => ({ id, enabled, hasKey })),
    chatgpt: { connected: (await pal.chatgpt.account()) !== undefined },
    mcp: (await pal.mcp.list()).map((server) => ({
      id: server.id,
      preset: server.preset,
      transport: server.stdio === null ? "http" : "stdio",
      enabled: server.enabled,
      state: server.state,
      keyConfigured: server.keyConfigured,
      tools: server.tools.length,
      approvedTools: server.tools.filter((tool) => tool.approved).length,
    })),
    unfinished: await unfinishedWork(database, tables),
  };
}

/** One chat's run state and the outcomes of its inputs, approvals and effects, for support. */
export async function chatDiagnostics(pal: Pal, chatId: string, conversationId: Parameters<typeof watchEvents>[1]) {
  const database = pal.store.database;
  const workspace = await pal.workspaces.info(chatId);
  const watch = await watchEvents(pal.harness, conversationId, context);
  let snapshot;
  try {
    snapshot = watch.snapshot as {
      entries: readonly Entry[];
      run?: unknown;
      generation?: { retry?: { error: string } };
      inbox: readonly unknown[];
    };
  } finally {
    await watch.stop();
  }
  const finished = new Set(
    snapshot.entries.flatMap((entry) => (entry.data?.shell?.status === "finished" ? [entry.data.shell.callId] : [])),
  );
  const shells = snapshot.entries.flatMap((entry) =>
    entry.kind === "pal.shell" && entry.data?.shell !== undefined ? [{ entry: entry.id, ...entry.data.shell }] : [],
  );
  return {
    chat: chatId,
    workspace: workspace === undefined ? null : { mode: workspace.mode, state: workspace.state },
    commandMode: await pal.approvals.mode(chatId),
    running: snapshot.run !== undefined,
    retrying: snapshot.generation?.retry === undefined ? null : failureCause(snapshot.generation.retry.error),
    queued: snapshot.inbox.length,
    inputs: await database.all<{ requestId: string; state: string; submissionId: number | null; createdAt: number }>(
      "SELECT request_id AS requestId, state, submission_id AS submissionId, created_at AS createdAt FROM pal_admissions WHERE chat_id = ? ORDER BY seq DESC LIMIT ?",
      chatId,
      RECENT,
    ),
    approvals: await database.all<{
      id: string;
      tool: string;
      state: string;
      createdAt: number;
      decidedAt: number | null;
    }>(
      "SELECT id, tool, state, created_at AS createdAt, decided_at AS decidedAt FROM pal_command_approvals WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?",
      chatId,
      RECENT,
    ),
    commands: shells
      .flatMap(({ entry, callId, status, exitCode, timedOut, truncated }) =>
        status === "finished" ? [{ entry, callId, exitCode, timedOut, truncated }] : [],
      )
      .slice(-RECENT),
    // Started without a completion receipt: the effect may or may not have happened, so nothing retries it.
    unknownEffects: shells
      .flatMap(({ entry, callId, status }) =>
        status === "started" && !finished.has(callId) ? [{ entry, callId }] : [],
      )
      .slice(-RECENT),
    internet: snapshot.entries
      .flatMap((entry) =>
        entry.kind === "pal.mcp" && entry.data?.mcp !== undefined
          ? [
              {
                entry: entry.id,
                callId: entry.data.mcp.callId,
                tool: entry.data.mcp.tool,
                isError: entry.data.mcp.isError,
              },
            ]
          : [],
      )
      .slice(-RECENT),
    modelFailures: snapshot.entries
      .flatMap((entry) => {
        const message = entry.kind === "pi.assistant" ? entry.model?.[0] : undefined;
        return message?.stopReason === "error"
          ? [{ entry: entry.id, cause: failureCause(message.errorMessage ?? "") }]
          : [];
      })
      .slice(-RECENT),
  };
}

// Free-form errors can echo opaque credentials and private contents; export only a coarse category.
function failureCause(text: string): string {
  if (/\b(?:401|403)\b|api.?key|authenticat/i.test(text)) return "credentials-rejected";
  if (/\b429\b|rate.?limit|quota|too many requests/i.test(text)) return "rate-limit";
  if (/context.{0,20}(?:length|limit)|maximum context|token limit/i.test(text)) return "context-limit";
  return "model-request-failed";
}
