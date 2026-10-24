import { userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";
import { HttpError } from "./http.ts";

export function terminalShell(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  loginShell: string | null = userInfo().shell,
): { file: string; args: string[]; env: Record<string, string> } {
  const file = env.SHELL || loginShell;
  if (!file || !isAbsolute(file))
    throw new HttpError(503, "terminal_shell", "Set an absolute SHELL or configure the host account's login shell.");
  if (!["bash", "zsh", "fish", "sh"].includes(basename(file)))
    throw new HttpError(503, "terminal_shell", "Host terminals currently support Bash, Zsh, Fish and sh. Check SHELL.");
  const username = userInfo().username;
  const variables: Record<string, string> = {
    HOME: home,
    USER: username,
    LOGNAME: username,
    SHELL: file,
    PATH: env.PATH ?? "/run/current-system/sw/bin:/usr/bin:/bin",
    LANG: env.LANG ?? "C.UTF-8",
  };
  // Load the owner's shell configuration without copying Pal's credential-bearing environment.
  for (const key of [
    "LC_ALL",
    "LC_CTYPE",
    "LOCALE_ARCHIVE",
    "TERMINFO",
    "TERMINFO_DIRS",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "ZDOTDIR",
    "STARSHIP_CONFIG",
  ]) {
    const value = env[key];
    if (value !== undefined) variables[key] = value;
  }
  return { file, args: ["-l", "-i"], env: variables };
}
