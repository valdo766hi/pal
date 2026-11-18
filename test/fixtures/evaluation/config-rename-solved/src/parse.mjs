import { defaults } from "./defaults.mjs";

/** `timeoutMs` is the old name of `deadlineMs`, still accepted; `deadlineMs` wins when both are given. */
export function parse(options = {}) {
  return {
    deadlineMs: options.deadlineMs ?? options.timeoutMs ?? defaults.deadlineMs,
    retries: options.retries ?? defaults.retries,
  };
}
