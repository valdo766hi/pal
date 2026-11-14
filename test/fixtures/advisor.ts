// A stand-in decision model for Auto command mode: an installation plugin whose answers the test scripts.
import type { Advice, AdviceRequest, CompiledCapability } from "../../src/capabilities/contract.ts";
import { PLUGINS } from "../../src/core/extensions.ts";

export type Answer = Advice | Error | "hang" | "malformed";

export function fakeAdvisor(answer: (request: AdviceRequest) => Answer = () => RUN, ready = () => true) {
  const calls: AdviceRequest[] = [];
  const capability: CompiledCapability = {
    manifest: {
      id: "fixture-advisor",
      version: 1,
      native: "pal.fixture-advisor",
      name: "Fixture advisor",
      description: "Answers Auto mode's questions as the test scripts them.",
      core: { min: 3, max: 3 },
      order: 95,
      scope: "installation",
      advisor: { label: "Fixture" },
    },
    open: () => ({
      advisor: {
        status: async () =>
          ready()
            ? { ready: true, note: "The fixture decides." }
            : { ready: false, note: "Add a fixture key in Settings → Fixture" },
        advise: async (request, signal) => {
          calls.push(request);
          const reply = answer(request);
          if (reply === "hang")
            return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
          if (reply === "malformed") return { verdict: "maybe", confidence: 2 } as unknown as Advice;
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    }),
  };
  return { capability, calls };
}

export const RUN: Advice = { verdict: "run", confidence: 0.96, threshold: 0.9, model: "fixture-1", via: "Fixture" };
/** The build's plugins with this advisor in place of the bundled one. */
export const withAdvisor = (capability: CompiledCapability) => [
  ...PLUGINS.filter(({ manifest }) => manifest.advisor === undefined),
  capability,
];
