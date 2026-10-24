import { writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { HttpError } from "./http.ts";

export async function terminalShell(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  loginShell: string | null = userInfo().shell,
): Promise<{ file: string; args: string[]; env: Record<string, string> }> {
  const file = env.SHELL || loginShell || env.PAL_BASH || "/bin/sh";
  if (!isAbsolute(file)) throw new HttpError(503, "terminal_shell", "SHELL must be an absolute executable path.");
  const variables = {
    SHELL: file,
    PATH: `${dirname(file)}:${env.PATH ?? "/run/current-system/sw/bin:/usr/bin:/bin"}`,
    HISTFILE: "/dev/null",
    HISTSIZE: "500",
  };
  switch (basename(file)) {
    case "bash": {
      const inputrc = join(home, "inputrc");
      await writeFile(inputrc, '"\\e[5~": previous-history\n"\\e[6~": next-history\n', { mode: 0o600, flag: "wx" });
      // Readline's non-printing markers keep prompt colors out of its cursor-width calculation.
      const sgr = (code: string) => `\x01\x1b[${code}m\x02`;
      return {
        file,
        args: ["--noprofile", "--norc", "-i"],
        env: {
          ...variables,
          INPUTRC: inputrc,
          PS1: `${sgr("2")}pal${sgr("0")} ${sgr("36")}\\w${sgr("0")} ${sgr("1;34")}\\$${sgr("0")} `,
          PROMPT_DIRTRIM: "2",
        },
      };
    }
    case "zsh":
      await writeFile(
        join(home, ".zshrc"),
        "HISTSIZE=500\nSAVEHIST=0\nHISTFILE=/dev/null\nbindkey -e\nbindkey '^[[5~' up-history\nbindkey '^[[6~' down-history\nPROMPT='%F{8}pal%f %F{6}%2~%f %F{4}$%f '\n",
        { mode: 0o600, flag: "wx" },
      );
      return { file, args: ["-d", "-i"], env: { ...variables, ZDOTDIR: home } };
    case "fish":
      return {
        file,
        env: variables,
        args: [
          "--no-config",
          "--private",
          "--interactive",
          "--init-command",
          String.raw`function fish_prompt; printf 'pal %s $ ' (prompt_pwd); end
function __pal_history_limit --on-event fish_preexec --on-event fish_postexec
  set -l entries (builtin history search --null | string split0)
  if test (count $entries) -gt 500
    builtin history delete --exact --case-sensitive -- $entries[501..-1]
  end
end
bind \e\[5~ history-search-backward
bind \e\[6~ history-search-forward`,
        ],
      };
    default:
      throw new HttpError(503, "terminal_shell", "Host terminals currently support Bash, Zsh and Fish. Check SHELL.");
  }
}
