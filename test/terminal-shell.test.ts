import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { terminalShell } from "../src/core/terminal-shell.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), "pal-shell-config-"));
  roots.push(root);
  return root;
}

describe("host terminal shell configuration", () => {
  it("honors SHELL before the OS default without copying ambient credentials", async () => {
    const shell = await terminalShell(
      await home(),
      { SHELL: "/profile/bin/fish", PATH: "/trusted/bin", OPENAI_API_KEY: "not-for-the-terminal" },
      "/bin/zsh",
    );
    expect(shell.file).toBe("/profile/bin/fish");
    expect(shell.args).toContain("--no-config");
    expect(shell.args).toContain("--private");
    expect(shell.env).toEqual({
      SHELL: "/profile/bin/fish",
      PATH: "/profile/bin:/trusted/bin",
      HISTFILE: "/dev/null",
      HISTSIZE: "500",
    });
    expect(shell.args.at(-1)).toContain("$entries[501..-1]");
  });

  it("uses the OS login shell when the launcher has no SHELL", async () => {
    const root = await home();
    const shell = await terminalShell(root, { PATH: "/trusted/bin" }, "/bin/zsh");
    expect(shell.file).toBe("/bin/zsh");
    expect(shell.args).toEqual(["-d", "-i"]);
    expect(shell.env.ZDOTDIR).toBe(root);
    const config = join(root, ".zshrc");
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    expect(await readFile(config, "utf8")).toContain("SAVEHIST=0");
    expect(await readFile(config, "utf8")).toContain("up-history");
  });

  it("retains Bash's private Readline history and pinned fallback", async () => {
    const root = await home();
    const shell = await terminalShell(root, { PAL_BASH: "/tools/bin/bash" }, null);
    expect(shell.file).toBe("/tools/bin/bash");
    expect(shell.args).toEqual(["--noprofile", "--norc", "-i"]);
    const inputrc = join(root, "inputrc");
    expect(shell.env.INPUTRC).toBe(inputrc);
    expect((await stat(inputrc)).mode & 0o777).toBe(0o600);
    expect(await readFile(inputrc, "utf8")).toContain("previous-history");
    expect(shell.env.PS1).toContain("pal");
  });

  it.each(["fish", "/bin/nologin"])(
    "refuses unsupported or nonabsolute shell %s without silently changing it",
    async (SHELL) => {
      await expect(terminalShell(await home(), { SHELL }, "/bin/zsh")).rejects.toMatchObject({
        status: 503,
        code: "terminal_shell",
      });
    },
  );
});
