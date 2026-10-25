import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
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
  it.each(["bash", "zsh", "fish", "sh"])("starts %s with normal login/interactive configuration", async (name) => {
    const root = await home();
    const shell = await terminalShell(
      root,
      {
        SHELL: `/profile/bin/${name}`,
        USER: "not-the-host-user",
        LOGNAME: "not-the-host-user",
        PATH: "/trusted/bin",
        XDG_CONFIG_HOME: "/host/config",
        ZDOTDIR: "/host/zsh",
        STARSHIP_CONFIG: "/host/starship.toml",
        OPENAI_API_KEY: "not-for-the-terminal",
        PAL_SECRET: "not-for-the-terminal",
        BASH_ENV: "/untrusted/script",
        PS1: "not-a-host-prompt",
      },
      "/bin/zsh",
    );
    expect(shell.file).toBe(`/profile/bin/${name}`);
    expect(shell.args).toEqual(["-l", "-i"]);
    expect(shell.env).toEqual({
      HOME: root,
      USER: userInfo().username,
      LOGNAME: userInfo().username,
      SHELL: `/profile/bin/${name}`,
      PATH: "/trusted/bin",
      LANG: "C.UTF-8",
      XDG_CONFIG_HOME: "/host/config",
      ZDOTDIR: "/host/zsh",
      STARSHIP_CONFIG: "/host/starship.toml",
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("uses the OS login shell when the launcher has no SHELL", async () => {
    const root = await home();
    const shell = await terminalShell(root, { PATH: "/trusted/bin", LANG: "en_US.UTF-8" }, "/bin/zsh");
    expect(shell.file).toBe("/bin/zsh");
    expect(shell.env.HOME).toBe(root);
    expect(shell.env.LANG).toBe("en_US.UTF-8");
    expect(shell.env).not.toHaveProperty("ZDOTDIR");
  });

  it("refuses an undetectable host shell instead of substituting Pal's Bash", async () => {
    await expect(async () => terminalShell(await home(), { PAL_BASH: "/tools/bin/bash" }, null)).rejects.toMatchObject({
      status: 503,
      code: "terminal_shell",
    });
  });

  it.each(["fish", "/bin/nologin"])(
    "refuses unsupported or nonabsolute shell %s without silently changing it",
    async (SHELL) => {
      await expect(async () => terminalShell(await home(), { SHELL }, "/bin/zsh")).rejects.toMatchObject({
        status: 503,
        code: "terminal_shell",
      });
    },
  );
});
