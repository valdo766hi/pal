import { createHash } from "node:crypto";
import {
  CodemodeSandbox,
  type CodemodeRun,
  type CodemodeRunOptions,
  type CodemodeSandboxOptions,
} from "@earendil-works/pi-codemode";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import {
  type Agent,
  type ConversationId,
  defineExtension,
  type Extension,
  hook,
  type JsonObject,
  ToolTask,
} from "@earendil-works/pi-durable";
import {
  CODEMODE_TOOL_NAME,
  type CodemodeNamespace,
  createCodemodeExtension,
} from "@earendil-works/pi-durable/codemode";

/** Host limits for every script; a script's own options may lower the first two, never raise them. */
export type CodemodeCaps = {
  /** Wall-clock deadline per script, recorded with the script so it also bounds a resumed run. */
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  /** Calls one script may make, counted by VM call number (discovery globals included). */
  readonly maxCalls: number;
  readonly memoryLimitBytes: number;
  /** Script workers alive at once, counted until each worker actually exits. */
  readonly maxWorkers: number;
};

export const DEFAULT_CODEMODE_CAPS: CodemodeCaps = {
  timeoutMs: 120_000,
  maxOutputTokens: 8_000,
  maxCalls: 100,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxWorkers: 2,
};

/** The host's current decision whether a conversation's scripts may call a tool; asked before every nested call. */
export type ToolPolicy = (conversationId: ConversationId, toolName: string) => boolean | Promise<boolean>;

export type PalCodemodeOptions = {
  readonly allows: ToolPolicy;
  readonly caps?: CodemodeCaps;
  readonly namespaces?: readonly CodemodeNamespace[];
};

const CALL_LIMIT_GLOBAL = "palCallLimit";

class CallLimitedSandbox extends CodemodeSandbox {
  readonly #maxCalls: number;

  constructor(options: CodemodeSandboxOptions, maxCalls: number) {
    super(options);
    this.#maxCalls = maxCalls;
  }

  override start(code: string, options: CodemodeRunOptions): CodemodeRun {
    return super.start(code, {
      ...options,
      // The VM fingerprint omits host policy; an interrupted script must retain its call limit.
      onStarted: (fingerprint) =>
        options.onStarted?.(
          createHash("sha256")
            .update(JSON.stringify(["pal.calls.v1", fingerprint, this.#maxCalls]))
            .digest("hex"),
        ),
      // Denials stay in Pi's global-call journal, with the VM's original ID and replay order.
      onCall: (call) =>
        options.onCall(
          call.id <= this.#maxCalls
            ? call
            : {
                id: call.id,
                target: "global",
                name: CALL_LIMIT_GLOBAL,
                args: null,
              },
        ),
    });
  }
}

/**
 * Pi's durable `codemode` extension under Pal's host policy. `models: false`: no implicit model or image helpers.
 * The returned sandbox belongs to the caller, who closes it after the Harness.
 */
export function createPalCodemode(options: PalCodemodeOptions): {
  extensions: Extension[];
  sandbox: CodemodeSandbox;
  /** The `codemode` extension over the same sandbox with other namespaces; installing it replaces the current one. */
  withNamespaces(namespaces: readonly CodemodeNamespace[]): Extension;
} {
  const caps = options.caps ?? DEFAULT_CODEMODE_CAPS;
  let workers = 0;
  const sandbox = new CallLimitedSandbox(
    {
      memoryLimitBytes: caps.memoryLimitBytes,
      acquireWorker: () => {
        if (workers >= caps.maxWorkers) throw new Error(`at most ${caps.maxWorkers} scripts may run at once`);
        workers += 1;
        return () => {
          workers -= 1;
        };
      },
    },
    caps.maxCalls,
  );

  const policy = defineExtension({
    name: "pal.policy",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          if (call.parent === undefined) {
            return call.name === CODEMODE_TOOL_NAME ? capScript(call.arguments.code, caps) : undefined;
          }
          if (!(await options.allows(api.conversationId, call.name))) {
            return { block: `${call.name} is not granted to this conversation` };
          }
          return undefined;
        },
      }),
    ],
  });

  async function permitted(agent: Agent, conversation: ConversationId): Promise<Agent> {
    const allowed = await Promise.all(agent.callable.map((tool) => options.allows(conversation, tool.name)));
    return { ...agent, callable: agent.callable.filter((_tool, index) => allowed[index]) };
  }
  const withNamespaces = (namespaces: readonly CodemodeNamespace[]): Extension => {
    const extension = createCodemodeExtension({
      sandbox,
      models: false,
      namespaces,
      globals: [
        {
          name: CALL_LIMIT_GLOBAL,
          execute: async () => {
            throw new Error(`script call limit of ${caps.maxCalls} reached`);
          },
        },
      ],
    });
    // Native Code Mode snapshots callable metadata; execution checks alone would still expose ungranted tools.
    return {
      ...extension,
      tools: (extension.tools ?? []).map((tool) => ({
        ...tool,
        execute: (args, api, context) =>
          tool.execute(
            args,
            { ...api, agent: async (ctx) => permitted(await api.agent(ctx), api.conversationId) },
            context,
          ),
      })),
      sections: (extension.sections ?? []).map((section) => ({
        ...section,
        render: async (input, context) =>
          section.render({ ...input, agent: await permitted(input.agent, input.conversationId) }, context),
      })),
    };
  };
  return { extensions: [policy, withNamespaces(options.namespaces ?? [])], sandbox, withNamespaces };
}

/** Rewrite the script's options line within the caps; an invalid script is left for code mode to report. */
function capScript(source: unknown, caps: CodemodeCaps): { arguments: JsonObject } | undefined {
  if (typeof source !== "string") return undefined;
  let parsed;
  try {
    parsed = parseCodemodeSource(source);
  } catch {
    return undefined;
  }
  const line = `// @options: ${JSON.stringify({
    max_output_tokens: Math.min(parsed.options.maxOutputTokens ?? caps.maxOutputTokens, caps.maxOutputTokens),
    timeout_ms: Math.min(parsed.options.timeoutMs ?? caps.timeoutMs, caps.timeoutMs),
  })}`;
  // The parser blanks an options line, so a changed first line means there was one to replace.
  const hadOptions = source.split("\n", 1)[0] !== parsed.code.split("\n", 1)[0];
  const body = hadOptions ? parsed.code.slice(parsed.code.indexOf("\n") + 1) : parsed.code;
  // `code` is the code mode tool's only parameter.
  return { arguments: { code: `${line}\n${body}` } };
}
