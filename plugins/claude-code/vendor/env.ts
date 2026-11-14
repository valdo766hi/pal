/** Whether an environment flag is set to something other than an explicit "off" value. */
export function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && !["0", "false", "no", "off"].includes(normalized);
}

// Pal: the only host variables a Claude Code process inherits. Pal's own environment (keys, tokens, settings) never
// reaches it; the provider's settings arrive through the request's `env`.
const HOST_ENV = /^(?:PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|SSL_CERT_FILE|NIX_SSL_CERT_FILE|XDG_(?:CONFIG|CACHE|DATA|STATE)_HOME|XDG_RUNTIME_DIR)$/;

export function hostEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => HOST_ENV.test(name)));
}
