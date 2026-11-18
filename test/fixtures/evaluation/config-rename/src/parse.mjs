import { defaults } from "./defaults.mjs";

export function parse(options = {}) {
  return { timeoutMs: options.timeoutMs ?? defaults.timeoutMs, retries: options.retries ?? defaults.retries };
}
