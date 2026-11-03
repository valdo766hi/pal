import { defaults } from "./defaults.mjs";
import { regions } from "./regions.mjs";

export function config(overrides = {}) {
  const base = { ...defaults, ...overrides };
  return { ...base, ...(regions[base.region] ?? {}) };
}
