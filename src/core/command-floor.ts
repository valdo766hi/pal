/**
 * Commands that always go to the owner in Auto mode, before and whatever a decision model would say. A deterministic
 * guard against obvious mistakes and prompt-injected commands, not a sandbox: anything it misses still runs as the
 * Pal host user once approved.
 */
const RULES: readonly { reason: string; test: (command: string) => boolean }[] = [
  {
    reason: "changes privileges",
    test: (command) => /(?:^|[\s;&|(`])(?:[^\s;&|()`]*\/)?(?:sudo|doas|su|pkexec|run0)(?=$|[\s;&|)])/.test(command),
  },
  { reason: "pushes with Git", test: (command) => /\bgit\b[^;&|\n]*\spush\b/.test(command) },
  {
    reason: "publishes a package",
    test: (command) =>
      /\b(?:npm|pnpm|yarn|bun|cargo|poetry|uv)\b[^;&|\n]*\spublish\b|\btwine\s+upload\b|\bgem\s+push\b|\b(?:docker|podman)\s+push\b|\bgh\s+release\s+create\b/.test(
        command,
      ),
  },
  { reason: "deletes recursively outside the folder", test: recursiveDelete },
  {
    reason: "runs a downloaded script",
    test: (command) =>
      /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|python3?|node|perl|ruby)\b/.test(
        command,
      ) || /\b(?:sh|bash|zsh)\b[^;&|\n]*(?:<\(|\$\()\s*(?:curl|wget)\b/.test(command),
  },
  {
    reason: "touches SSH keys or credentials",
    test: (command) =>
      /(?:^|[\s"'=:/])\.ssh(?:\/|\s|$)|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.aws\/credentials|\.netrc\b|\.gnupg\b|\.docker\/config\.json|\.kube\/config|\.config\/gh\b|\.git-credentials\b|\.npmrc\b|\.pypirc\b|\bsecurity\s+(?:find|dump)-\w+/.test(
        command,
      ),
  },
  {
    reason: "changes the system or its services",
    test: (command) =>
      /\b(?:systemctl|launchctl|service|shutdown|reboot|halt|poweroff|mkfs(?:\.\w+)?)\b|\bdd\b[^;&|\n]*\bof=\/dev\//.test(
        command,
      ),
  },
];

// Conservative: a target counts as outside unless it is a plain relative path and no `cd` came before it.
function recursiveDelete(command: string): boolean {
  let moved = false;
  for (const segment of command.split(/[;&|\n]+/)) {
    const words = segment
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/^[("'`{]+|["'`)}]+$/g, ""));
    const at = words.findIndex((word) => /(?:^|\/)rm$/.test(word));
    moved ||= words.slice(0, at === -1 ? undefined : at).some((word) => word === "cd" || word === "pushd");
    if (at === -1) continue;
    const rest = words.slice(at + 1);
    const recursive = rest.some((word) => /^-[a-zA-Z]*[rR]/.test(word) || word === "--recursive");
    const targets = rest.filter((word) => !word.startsWith("-"));
    if (recursive && targets.some((word) => moved || /^[/~]|(?:^|\/)\.\.(?:\/|$)|[$`]/.test(word))) return true;
  }
  return false;
}

/** Why `command` must ask the owner even in Auto; undefined when the decision model may judge it. */
export function alwaysAsks(command: string, privatePaths: readonly string[]): string | undefined {
  if (privatePaths.some((path) => path !== "" && command.includes(path))) return "touches Pal's own data";
  return RULES.find((rule) => rule.test(command))?.reason;
}
