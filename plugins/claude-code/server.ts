import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createProvider, type ProviderEnv } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { CompiledCapability } from "../../src/capabilities/contract.ts";
import { HttpError } from "../../src/core/http.ts";
import { validate } from "../../src/core/requests.ts";
import manifest from "./manifest.ts";
import { ALLOW_USAGE_CREDITS_ENV } from "./vendor/billing.ts";
import {
  captureProcess,
  closeClaudeProcesses,
  discoverClaudeModels,
  forgetClaudeReadiness,
  getClaudeStatus,
} from "./vendor/claude-cli.ts";
import { hostEnvironment } from "./vendor/env.ts";
import { CLAUDE_CODE_MODELS, modelFromDiscovery, PROVIDER_ID } from "./vendor/model-catalog.ts";
import { streamClaudeCode } from "./vendor/stream.ts";

const Settings = Type.Object(
  {
    command: Type.String({ minLength: 1, maxLength: 4096 }),
    configDir: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    allowUsageCredits: Type.Boolean(),
  },
  { additionalProperties: false },
);
type Settings = Static<typeof Settings>;
const DEFAULTS: Settings = { command: "claude", configDir: null, allowUsageCredits: false };
const BILLING =
  "Counts against your Claude plan's limits; not separate or unlimited usage. Pal stops a reply that Anthropic would charge to usage credits unless you allow them in Settings → Claude Code.";

function checked(settings: Settings): Settings {
  if (!isAbsolute(settings.command) && !/^[A-Za-z0-9._-]+$/.test(settings.command))
    throw new HttpError(400, "claude_code_command", "Give an absolute path or a plain command name such as claude.");
  if (settings.configDir !== null && !isAbsolute(settings.configDir))
    throw new HttpError(400, "claude_code_config", "The config directory must be an absolute path.");
  return settings;
}

// Pal's provider around the vendored pi-claude-code: settings come from this plugin, never Pal's environment.
export default {
  manifest,
  open(host) {
    const settings = async (): Promise<Settings> => {
      const stored = await host.settings.get("settings");
      try {
        return stored === undefined ? DEFAULTS : validate(Settings, stored);
      } catch {
        return DEFAULTS;
      }
    };
    let folder: Promise<string> | undefined;
    /** What Claude Code is started with besides the host allowlist: the command, its config and an empty folder. */
    const environment = async (): Promise<ProviderEnv> => {
      const current = await settings();
      folder ??= mkdtemp(join(tmpdir(), "pal-claude-code-"));
      return {
        PI_CLAUDE_CODE_COMMAND: current.command,
        PI_CLAUDE_CODE_CWD: await folder,
        PI_CLAUDE_CODE_UPSTREAM: host.endpoint("https://api.anthropic.com"),
        ...(current.configDir === null ? {} : { PI_CLAUDE_CODE_CONFIG_DIR: current.configDir }),
        ...(current.allowUsageCredits ? { [ALLOW_USAGE_CREDITS_ENV]: "1" } : {}),
      };
    };
    const status = async (signal: AbortSignal) => {
      const env = { ...hostEnvironment(), ...(await environment()) };
      const found = await getClaudeStatus(env, signal);
      const version =
        found.command === undefined
          ? undefined
          : (
              await captureProcess(found.command, ["--version"], env as Record<string, string>, signal).catch(
                () => undefined,
              )
            )?.stdout
              .trim()
              .split("\n")[0]
              ?.slice(0, 80);
      const detail = !found.available
        ? "Claude Code isn't installed for the account Pal runs as, or the command path is wrong."
        : !found.loggedIn
          ? (found.detail ?? "Claude Code isn't logged in. Open Terminal and run `claude auth login`.")
          : !found.subscription
            ? `Claude Code is logged in with ${found.authMethod ?? "an API key"}, not a Claude subscription.`
            : `Logged in with a Claude ${found.plan} subscription.`;
      return {
        ready: found.available && found.loggedIn && found.subscription,
        detail,
        installed: found.available,
        loggedIn: found.loggedIn,
        ...(version === undefined ? {} : { version }),
        ...(found.plan === undefined ? {} : { plan: found.plan }),
        ...(found.authMethod === undefined ? {} : { authMethod: found.authMethod }),
      };
    };

    // Settings changes and disabling end the warm processes, so none keeps an old command, account or credit choice.
    const release = async () => {
      forgetClaudeReadiness();
      await closeClaudeProcesses();
    };
    let discovered: Set<string> | undefined;
    const provider = createProvider({
      id: PROVIDER_ID,
      name: "Claude subscription (Claude Code)",
      baseUrl: "process://claude-code",
      auth: {
        // Claude Code owns its login; requests carry a placeholder and this plugin's settings, never a credential.
        apiKey: {
          name: "Claude Code login",
          resolve: async ({ signal }) => {
            signal.throwIfAborted();
            return { auth: { apiKey: "external-process" }, env: await environment(), source: "Claude Code CLI" };
          },
        },
      },
      models: CLAUDE_CODE_MODELS,
      async fetchModels({ signal }) {
        const env = { ...hostEnvironment(), ...(await environment()) };
        const models = (await discoverClaudeModels(env, signal)).map(modelFromDiscovery);
        discovered = new Set(models.map((model) => model.id));
        return models;
      },
      filterModels: (models) => (discovered === undefined ? models : models.filter(({ id }) => discovered?.has(id))),
      api: { stream: streamClaudeCode, streamSimple: streamClaudeCode },
    });

    return {
      providers: [
        {
          id: PROVIDER_ID,
          billing: BILLING,
          provider,
          status: async () => {
            const { ready, detail } = await status(AbortSignal.timeout(30_000));
            return { ready, detail };
          },
          stop: release,
        },
      ],
      // settings and status: owner requests. Only status starts Claude Code, and only when the owner asks.
      async api({ method, path, body }) {
        const [resource] = path;
        if (resource === "settings" && path.length === 1 && method === "GET") return settings();
        if (resource === "settings" && path.length === 1 && method === "PUT") {
          await host.settings.set("settings", checked(validate(Settings, body)));
          await release();
          return settings();
        }
        if (resource === "status" && path.length === 1 && method === "POST") return status(AbortSignal.timeout(30_000));
        throw new HttpError(404, "not_found", "no such Claude Code operation");
      },
      dispose: () => closeClaudeProcesses(),
    };
  },
} satisfies CompiledCapability;
