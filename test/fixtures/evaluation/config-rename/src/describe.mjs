export function describe(options) {
  return `timeout ${options.timeoutMs}ms, ${options.retries} retries`;
}
