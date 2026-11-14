import type { ContextUsageInfo } from "./api.ts";

const short = (value: number) => (value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, ""));

/** Token counts are estimates, so they read short: 720, 16.2k, 1M. */
export function tokens(count: number): string {
  const sign = count < 0 ? "−" : "";
  const size = Math.abs(count);
  if (size < 1000) return `${sign}${size}`;
  if (size < 999_500) return `${sign}${short(size / 1000)}k`;
  return `${sign}${short(size / 1_000_000)}M`;
}

/** A part of the context window, as the breakdown lists it. */
export function share(count: number, window: number): string {
  const percent = (count / window) * 100;
  return percent > 0 && percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

/** The whole window's use, as the ring shows it; undefined without a known window or request. */
export function percentUsed(usage: ContextUsageInfo): string | undefined {
  if (usage.usedTokens === null || usage.contextWindow === null) return undefined;
  const percent = (usage.usedTokens / usage.contextWindow) * 100;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

/** At or past the point where Pi summarizes earlier messages before the next request. */
export function nearSummarizing(usage: ContextUsageInfo): boolean {
  return (
    usage.usedTokens !== null &&
    usage.contextWindow !== null &&
    usage.usedTokens >= usage.contextWindow - usage.reserveTokens
  );
}
