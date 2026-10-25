import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Trusted host dotfiles for PTY tests; never source the developer's actual startup files. */
export async function terminalHome(home: string): Promise<Record<string, string>> {
  const config = join(home, ".config");
  await mkdir(join(config, "fish"), { recursive: true });
  await writeFile(join(home, ".bash_profile"), '. "$HOME/.bashrc"\n');
  await writeFile(
    join(home, ".bashrc"),
    String.raw`HISTSIZE=700
HISTFILESIZE=700
HISTFILE="$HOME/.bash_history"
INPUTRC="$HOME/.inputrc"
PS1='\[\e[35m\]fixture\[\e[0m\] \w $ '
export HISTFILE INPUTRC PAL_TEST_PROFILE=loaded
`,
  );
  await writeFile(join(home, ".inputrc"), '"\\e[5~": previous-history\n"\\e[6~": next-history\n');
  // Synthetic dotfiles must not inherit machine-wide interactive customizations.
  await writeFile(join(home, ".zshenv"), "unsetopt GLOBAL_RCS\n");
  await writeFile(
    join(home, ".zshrc"),
    "HISTSIZE=700\nSAVEHIST=700\nHISTFILE=$HOME/.zsh_history\nexport PAL_TEST_PROFILE=loaded\nbindkey -e\nbindkey '^[[5~' up-history\nbindkey '^[[6~' down-history\nPROMPT='fixture %~ $ '\n",
  );
  await writeFile(
    join(config, "fish/config.fish"),
    String.raw`set -gx PAL_TEST_PROFILE loaded
function fish_prompt; printf 'fixture %s $ ' (prompt_pwd); end
bind \e\[5~ history-search-backward
bind \e\[6~ history-search-forward
`,
  );
  return {
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    ZDOTDIR: home,
  };
}
