import { homedir } from "node:os";

/** One simple command as the shell would run it: its name (without a path) and arguments, quotes removed. */
type Simple = { readonly name: string; readonly args: readonly string[]; readonly via: readonly string[] };

/**
 * Commands that always go to the owner in Auto mode, before and whatever a decision model would say. A deterministic
 * guard against obvious mistakes and prompt-injected commands, not a sandbox: anything it misses still runs as the
 * Pal host user once approved. Rules about what runs read the shell's words, so a commit message, a search pattern or
 * an `echo` that merely mentions a command doesn't count; rules about paths read the whole text.
 */
const RULES: readonly { reason: string; test: (commands: readonly Simple[], text: readonly string[]) => boolean }[] = [
  {
    reason: "changes privileges",
    test: (commands) => commands.some(({ name }) => ["sudo", "doas", "su", "pkexec", "run0"].includes(name)),
  },
  {
    reason: "pushes with Git",
    test: (commands) => commands.some(({ name, args }) => name === "git" && gitSubcommand(args) === "push"),
  },
  {
    reason: "publishes a package",
    test: (commands) =>
      commands.some(({ name, args }) => {
        const own = args.slice(0, args.includes("--") ? args.indexOf("--") : undefined);
        if (["npm", "pnpm", "yarn", "bun", "cargo", "poetry", "uv"].includes(name)) return own.includes("publish");
        if (name === "twine") return own.includes("upload");
        if (name === "gem" || name === "docker" || name === "podman") return own.includes("push");
        return name === "gh" && own.includes("release") && own.includes("create");
      }),
  },
  { reason: "deletes recursively outside the folder", test: recursiveDelete },
  {
    reason: "runs a downloaded script",
    test: (_, text) =>
      text.some(
        (form) =>
          /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|python3?|node|perl|ruby)\b/.test(
            form,
          ) || /\b(?:sh|bash|zsh)\b[^;&|\n]*(?:<\(|\$\()\s*(?:curl|wget)\b/.test(form),
      ),
  },
  {
    reason: "touches SSH keys or credentials",
    test: (_, text) =>
      text.some((form) =>
        /(?:^|[\s"'=:/])\.(?:ssh|aws)(?:\/|\s|$)|(?:^|[\s"'=:/<>])\.env(?:\.(?!example\b|sample\b|template\b)[\w-]+)*(?=$|[\s"';&|)<>])|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.netrc\b|\.gnupg\b|\.docker\/config\.json|\.kube\/config|\.config\/gh\b|\.git-credentials\b|\.npmrc\b|\.pypirc\b|\bsecurity\s+(?:find|dump)-\w+/.test(
          form,
        ),
      ),
  },
  {
    reason: "changes the system or its services",
    test: (commands) =>
      commands.some(
        ({ name, args }) =>
          ["systemctl", "launchctl", "service", "shutdown", "reboot", "halt", "poweroff"].includes(name) ||
          /^mkfs(?:\.\w+)?$/.test(name) ||
          (name === "dd" && args.some((arg) => arg.startsWith("of=/dev/"))),
      ),
  },
];

/**
 * Conservative: a path counts as outside unless it is plain and relative with no `cd` before it. `rm` fed by `xargs`
 * or without a target, and `find -delete` or `find -exec rm` from such a path, count too.
 */
function recursiveDelete(commands: readonly Simple[]): boolean {
  let moved = false;
  const outside = (word: string) =>
    moved || word === "" || word === "{}" || /^[/~]|(?:^|\/)\.\.(?:\/|$)|[$`]/.test(word);
  for (const { name, args, via } of commands) {
    if (name === "cd" || name === "pushd") moved = true;
    else if (name === "find") {
      const exec = args.findIndex((arg) => /^-(?:exec|execdir|ok|okdir)$/.test(arg));
      if (!args.includes("-delete") && !(exec !== -1 && base(args[exec + 1] ?? "") === "rm")) continue;
      const options = args.findIndex((arg) => /^[-(!]/.test(arg));
      const starts = args.slice(0, options === -1 ? undefined : options);
      if (starts.length === 0 ? moved : starts.some(outside)) return true;
    } else if (
      name === "rm" &&
      !via.includes("find") &&
      args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === "--recursive")
    ) {
      const targets = args.filter((arg) => !arg.startsWith("-"));
      if (via.includes("xargs") || targets.length === 0 || targets.some(outside)) return true;
    }
  }
  return false;
}

/** Git's subcommand after its global options. */
function gitSubcommand(args: readonly string[]): string | undefined {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) at++;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

const base = (word: string) => word.slice(word.lastIndexOf("/") + 1);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{"]);
/** Commands that run the command after them, with their options that take a value. */
const WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  env: ["-u", "-C", "-S"],
  exec: ["-a"],
  nohup: [],
  command: [],
  builtin: [],
  time: [],
  nice: ["-n"],
  timeout: ["-s", "-k"],
  stdbuf: [],
  caffeinate: [],
  watch: ["-n"],
  xargs: ["-I", "-n", "-P", "-L", "-d", "-s", "-E", "-a"],
};

/** Every simple command `text` runs, including command substitutions, `sh -c` scripts and `eval` arguments. */
function simpleCommands(text: string, depth = 0): Simple[] {
  const found: Simple[] = [];
  const { outer, inner } = substitutions(text);
  for (const words of split(outer)) {
    const via: string[] = [];
    let at = 0;
    while (at < words.length) {
      const word = words[at] as string;
      if (/^[A-Za-z_]\w*=/.test(word) || KEYWORDS.has(word)) {
        at++;
        continue;
      }
      const values = WRAPPERS[base(word)];
      if (values === undefined) break;
      via.push(base(word));
      at++;
      while (at < words.length && (words[at]?.startsWith("-") || /^[A-Za-z_]\w*=/.test(words[at] as string))) {
        at += words[at] === "--" ? 1 : values.includes(words[at] as string) ? 2 : 1;
        if (words[at - 1] === "--") break;
      }
      if (base(word) === "timeout" && /^\d/.test(words[at] ?? "")) at++;
    }
    if (at >= words.length) continue;
    const name = base(words[at] as string);
    const args = words.slice(at + 1);
    found.push({ name, args, via });
    // `find -exec` runs a command of its own; deletes through it are judged with the find.
    for (let exec = 0; exec < args.length; exec++) {
      if (name !== "find" || !/^-(?:exec|execdir|ok|okdir)$/.test(args[exec] as string)) continue;
      const stop = args.findIndex((arg, at) => at > exec && (arg === ";" || arg === "+"));
      const [run, ...rest] = args.slice(exec + 1, stop === -1 ? undefined : stop);
      if (run !== undefined) found.push({ name: base(run), args: rest, via: [...via, "find"] });
    }
    if (depth >= 4) continue;
    const script = SHELLS.has(name) ? args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) : -1;
    const body = script === -1 ? undefined : args[script + 1];
    if (body !== undefined) found.push(...simpleCommands(body, depth + 1));
    if (name === "eval") found.push(...simpleCommands(args.join(" "), depth + 1));
    // A command run over SSH is still a command the agent chose; judge it like a local one.
    if (name === "ssh") {
      const host = args.findIndex(
        (arg, at) => !arg.startsWith("-") && !/^-[bcDEeFIiJLlmOopQRSWw]$/.test(args[at - 1] ?? ""),
      );
      if (host !== -1 && host < args.length - 1)
        found.push(...simpleCommands(args.slice(host + 1).join(" "), depth + 1));
    }
  }
  if (depth < 4) for (const body of inner) found.push(...simpleCommands(body, depth + 1));
  return found;
}

/** `text` with each `$(…)`, `<(…)`, `>(…)` and backquoted command replaced by `$_`, and those commands' text. */
function substitutions(text: string): { outer: string; inner: string[] } {
  let outer = "";
  const inner: string[] = [];
  let quote: "'" | '"' | undefined;
  for (let at = 0; at < text.length; at++) {
    const char = text[at] as string;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      outer += char;
      continue;
    }
    if (char === "\\") {
      outer += text.slice(at, at + 2);
      at++;
      continue;
    }
    const opens = char === "`" || ("$<>".includes(char) && text[at + 1] === "(");
    if (!opens) {
      if (char === '"') quote = quote === '"' ? undefined : '"';
      else if (char === "'" && quote === undefined) quote = "'";
      outer += char;
      continue;
    }
    let end = at + 1;
    if (char === "`") while (end < text.length && text[end] !== "`") end += text[end] === "\\" ? 2 : 1;
    else
      for (let open = 0, inside: "'" | '"' | undefined; end < text.length; end++) {
        const next = text[end];
        if (inside !== undefined) {
          if (next === inside) inside = undefined;
        } else if (next === "'" || next === '"') inside = next;
        else if (next === "(") open++;
        else if (next === ")" && --open === 0) break;
      }
    inner.push(text.slice(char === "`" ? at + 1 : at + 2, end));
    outer += "$_";
    at = end;
  }
  return { outer, inner };
}

/** Simple commands' words: split on unquoted separators, with quotes, escapes, comments and redirections removed. */
function split(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  let redirect = false;
  const end = () => {
    if (word !== undefined && !redirect) words.push(word);
    if (word !== undefined) redirect = false;
    word = undefined;
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at] as string;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && at + 1 < text.length) word += text[++at] as string;
      else word += char;
    } else if (char === "\\") word = (word ?? "") + (text[++at] ?? "");
    else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "#" && word === undefined) while (at + 1 < text.length && text[at + 1] !== "\n") at++;
    else if (char === "<" || char === ">") {
      if (word !== undefined && /^\d+$/.test(word)) word = undefined;
      end();
      while (text[at + 1] === "<" || text[at + 1] === ">" || text[at + 1] === "&") at++;
      redirect = true;
    } else if (";&|\n()".includes(char)) {
      end();
      redirect = false;
      if (words.length > 0) commands.push(words);
      words = [];
    } else if (/\s/.test(char)) end();
    else word = (word ?? "") + char;
  }
  end();
  if (words.length > 0) commands.push(words);
  return commands;
}

/** The command as the shell reads its words: quotes and backslash escapes removed, `~` and `$HOME` expanded. */
function unquoted(command: string, home: string): string {
  return command
    .replace(/\\(.)/g, "$1")
    .replace(/["']/g, "")
    .replace(/(^|[\s=:;&|(`])(?:~|\$HOME\b|\$\{HOME\})(?=\/|$|[\s;&|)])/g, `$1${home}`);
}

/** Why `command` must ask the owner even in Auto; undefined when the decision model may judge it. */
export function alwaysAsks(command: string, privatePaths: readonly string[], home = homedir()): string | undefined {
  const text = [command, unquoted(command, home)];
  // Compared without case: macOS folders usually ignore it, so a differently cased path reaches the same files.
  const lower = text.map((form) => form.toLowerCase());
  if (privatePaths.some((path) => path !== "" && lower.some((form) => form.includes(path.toLowerCase()))))
    return "touches Pal's own data";
  const commands = simpleCommands(command);
  return RULES.find((rule) => rule.test(commands, text))?.reason;
}
