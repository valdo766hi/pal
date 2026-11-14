import { type ClassifierApi, type ClassifierModel, createModels, type Provider } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { Type } from "typebox";
import type { Advice, AdviceRequest, CapabilityHost, CompiledCapability } from "../../src/capabilities/contract.ts";
import { HttpError } from "../../src/core/http.ts";
import { validate } from "../../src/core/requests.ts";
import manifest from "./manifest.ts";

const TIMEOUT_MS = 5_000;
const KEPT = 20;
/** Each connection bills its own account with its own key; models are fixed here, so a change is a reviewed one. */
const CONNECTIONS = {
  typesafe: {
    label: "TypeSafe",
    bills: "TypeSafe credits",
    model: "jev-latest",
    secret: "typesafe-key",
    provider: typesafeProvider,
  },
  openrouter: {
    label: "OpenRouter",
    bills: "OpenRouter credits",
    model: "typesafe/jev-1.14",
    secret: "openrouter-key",
    provider: openrouterProvider,
  },
} as const;
type Connection = keyof typeof CONNECTIONS;
const QUESTIONS = {
  verdict: {
    type: "choice",
    instructions: "May this command run without asking the owner first?",
    criteria: {
      run: "Routine and reversible inside the working folder: read, list, search, build, test, lint, format, git status/diff/log/add/commit",
      ask: "Anything else: deletes or writes outside the folder, network uploads, credentials, system or service changes, git push, publishing, privilege changes, unclear intent",
    },
  },
} as const;
const SENT =
  "Each command, its folder, its timeout and the folder's access. No file contents, environment, output, chat text or credentials.";

type Decision = {
  at: number;
  connection: Connection;
  model: string;
  command: string;
  verdict?: "run" | "ask";
  confidence?: number;
  tokens?: number;
  costUsd?: number;
  latencyMs: number;
  error?: string;
};
const ConnectionBody = Type.Object(
  { connection: Type.Enum(Object.keys(CONNECTIONS) as Connection[]) },
  { additionalProperties: false },
);
const KeyBody = Type.Object({ key: Type.String({ minLength: 8, maxLength: 512 }) }, { additionalProperties: false });
const ThresholdBody = Type.Object(
  { threshold: Type.Number({ minimum: 0.5, maximum: 0.99 }) },
  { additionalProperties: false },
);

/** A registry of its own per connection: only that provider, its fixed model and the key passed per request. */
function connect(id: Connection, host: CapabilityHost) {
  const base = CONNECTIONS[id].provider() as Provider;
  const found = (base.getAllModels?.() ?? []).find(
    (model): model is ClassifierModel<ClassifierApi> =>
      model.type === "classifier" && model.id === CONNECTIONS[id].model,
  );
  if (found === undefined) throw new Error(`${CONNECTIONS[id].label} has no ${CONNECTIONS[id].model} model`);
  const model = { ...found, baseUrl: host.endpoint(found.baseUrl) };
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider({
    ...base,
    // Only the key each request passes; never the environment or a stored provider credential.
    auth: {
      apiKey: {
        name: `${CONNECTIONS[id].label} key for Jev`,
        resolve: async ({ credential }) => {
          const key = credential?.type === "api_key" ? credential.key : undefined;
          return key ? { auth: { apiKey: key }, source: "Jev settings" } : undefined;
        },
      },
    },
    getModels: () => [],
    getAllModels: () => [model],
  });
  return { models, model };
}

export default {
  manifest,
  open(host) {
    const registries = new Map<Connection, ReturnType<typeof connect>>();
    const registry = (id: Connection) => {
      let found = registries.get(id);
      if (found === undefined) registries.set(id, (found = connect(id, host)));
      return found;
    };
    const connection = async (): Promise<Connection> =>
      (await host.settings.get("connection")) === "openrouter" ? "openrouter" : "typesafe";
    const threshold = async () => {
      const value = await host.settings.get("threshold");
      return typeof value === "number" && value >= 0.5 && value <= 0.99 ? value : 0.9;
    };
    const recent = async (): Promise<Decision[]> => {
      const value = await host.settings.get("recent");
      return Array.isArray(value) ? (value as Decision[]) : [];
    };
    const remember = async (decision: Decision) =>
      host.settings.set("recent", [decision, ...(await recent())].slice(0, KEPT));

    /** One classification on the chosen connection with its own key; never retried, never another connection. */
    async function classify(id: Connection, request: AdviceRequest, signal: AbortSignal) {
      const key = await host.secrets.get(CONNECTIONS[id].secret);
      if (key === undefined) throw new Error(`no ${CONNECTIONS[id].label} key`);
      const { models, model } = registry(id);
      const started = Date.now();
      const result = await models.classify(
        model,
        { state: { ...request }, questions: QUESTIONS },
        { apiKey: key, maxRetries: 0, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) },
      );
      const latencyMs = Date.now() - started;
      // A service that echoes the key in an error must not get it into a reason, log or setting.
      const error = result.errorMessage?.replaceAll(key, "[key]");
      const answer = result.answers.verdict;
      return {
        latencyMs,
        model: result.model,
        ...(result.usage === undefined ? {} : { tokens: result.usage.totalTokens }),
        ...(result.usage?.cost.total ? { costUsd: result.usage.cost.total } : {}),
        ...(result.stopReason !== "stop"
          ? { error: result.stopReason === "aborted" ? "no answer in time" : (error ?? "the request failed") }
          : answer?.type !== "choice" || (answer.choice !== "run" && answer.choice !== "ask")
            ? { error: "an unexpected answer" }
            : { verdict: answer.choice as "run" | "ask", confidence: answer.confidence }),
      };
    }

    return {
      advisor: {
        async status() {
          const id = await connection();
          const { label } = CONNECTIONS[id];
          return (await host.secrets.has(CONNECTIONS[id].secret))
            ? {
                ready: true,
                note: `A decision model lets routine commands run; anything else asks you. Each command, its folder and timeout are sent to Jev through ${label}. Not a sandbox.`,
              }
            : { ready: false, note: "Add a Jev key in Settings → Jev" };
        },
        async advise(request, signal): Promise<Advice> {
          const id = await connection();
          const decided = await classify(id, request, signal);
          await remember({ at: Date.now(), connection: id, command: request.command.slice(0, 200), ...decided });
          if ("error" in decided) throw new Error(decided.error);
          return {
            verdict: decided.verdict,
            confidence: decided.confidence,
            threshold: await threshold(),
            model: decided.model,
            via: CONNECTIONS[id].label,
            latencyMs: decided.latencyMs,
            ...(decided.tokens === undefined ? {} : { tokens: decided.tokens }),
            ...(decided.costUsd === undefined ? {} : { costUsd: decided.costUsd }),
          };
        },
      },
      // status, connection, threshold, keys/<connection>[/check]: all owner requests.
      async api({ method, path, body }) {
        const [resource, target, action] = path;
        if (resource === "status" && path.length === 1 && method === "GET") {
          const decisions = await recent();
          return {
            connection: await connection(),
            threshold: await threshold(),
            sent: SENT,
            connections: await Promise.all(
              (Object.keys(CONNECTIONS) as Connection[]).map(async (id) => ({
                id,
                label: CONNECTIONS[id].label,
                bills: CONNECTIONS[id].bills,
                model: CONNECTIONS[id].model,
                keySet: await host.secrets.has(CONNECTIONS[id].secret),
              })),
            ),
            recent: decisions,
          };
        }
        if (resource === "connection" && path.length === 1 && method === "PUT") {
          await host.settings.set("connection", validate(ConnectionBody, body).connection);
          return { saved: true };
        }
        if (resource === "threshold" && path.length === 1 && method === "PUT") {
          await host.settings.set("threshold", validate(ThresholdBody, body).threshold);
          return { saved: true };
        }
        if (resource === "keys" && target !== undefined && Object.hasOwn(CONNECTIONS, target)) {
          const id = target as Connection;
          if (path.length === 2 && method === "PUT") {
            await host.secrets.set(CONNECTIONS[id].secret, validate(KeyBody, body).key.trim());
            return { keySet: true };
          }
          if (path.length === 2 && method === "DELETE") {
            await host.secrets.clear(CONNECTIONS[id].secret);
            return { keySet: false };
          }
          if (path.length === 3 && action === "check" && method === "POST") return check(id);
        }
        throw new HttpError(404, "not_found", "no such Jev operation");
      },
    };

    /** OpenRouter's key check is free; TypeSafe has none, so its check is one tiny billed classification. */
    async function check(id: Connection) {
      const key = await host.secrets.get(CONNECTIONS[id].secret);
      if (key === undefined) throw new HttpError(409, "jev_no_key", `Add a ${CONNECTIONS[id].label} key first.`);
      if (id === "openrouter") {
        const response = await fetch(host.endpoint("https://openrouter.ai/api/v1/key"), {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
        return response?.ok === true
          ? { ok: true, detail: "OpenRouter accepted the key." }
          : {
              ok: false,
              detail: response === undefined ? "OpenRouter couldn't be reached." : "OpenRouter refused the key.",
            };
      }
      const decided = await classify(
        id,
        { tool: "shell_run", command: "ls", cwd: "/project", timeoutSeconds: 10, folderAccess: "write" },
        AbortSignal.timeout(TIMEOUT_MS),
      );
      return "error" in decided
        ? { ok: false, detail: `TypeSafe answered with ${decided.error}.` }
        : { ok: true, detail: "TypeSafe answered a test classification (billed)." };
    }
  },
} satisfies CompiledCapability;
