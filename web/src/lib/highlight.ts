// Chat code blocks: a small synchronous highlighter. It escapes everything and only wraps recognized tokens, so a wrong
// guess costs a color, never content. Languages it does not list stay plain.

type Rule = [kind: string, pattern: string];
type Spec = {
  /** Tried in order at each position, before plain words. Patterns must not capture. */
  rules: Rule[];
  keywords?: string;
  types?: string;
  literals?: string;
  /** A name followed by "(" is a call; a capitalized name is a type. */
  names?: boolean;
  caseless?: boolean;
};
type Grammar = { pattern: RegExp; kinds: string[]; words: Map<string, string>; names: boolean; caseless: boolean };

const LIMIT = 200_000;
const LINE_LIMIT = 2048;
const END = String.raw`(?![\s\S])`;
const C_COMMENT: Rule = ["c", String.raw`\/\/.*|\/\*[\s\S]*?(?:\*\/|${END})`];
const HASH: Rule = ["c", "#.*"];
const SPACED_HASH: Rule = ["c", String.raw`(?<!\S)#.*`];
const DQ: Rule = ["s", String.raw`"(?:\\.|[^"\\\n])*"?`];
const SQ: Rule = ["s", String.raw`'(?:\\.|[^'\\\n])*'?`];
const BT: Rule = ["s", String.raw`\`(?:\\[\s\S]|[^\`\\])*\`?`];
const TRIPLE: Rule = ["s", String.raw`"""[\s\S]*?(?:"""|${END})|'''[\s\S]*?(?:'''|${END})`];
const NUMBER: Rule = ["n", String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`];
const FLAG: Rule = ["p", String.raw`(?<=\s)--?[A-Za-z][\w-]*`];
const SH_KEYWORDS =
  "if then else elif fi for while until do done case esac in function select return local export readonly declare unset";

const SPECS: Record<string, Spec> = {
  js: {
    rules: [C_COMMENT, BT, DQ, SQ, NUMBER],
    keywords:
      "as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function if implements import in instanceof interface keyof let new of private protected public readonly return satisfies static super switch this throw try type typeof var void while with yield",
    types: "any bigint boolean never number object string symbol unknown",
    literals: "true false null undefined NaN Infinity",
    names: true,
  },
  python: {
    rules: [HASH, TRIPLE, DQ, SQ, ["m", String.raw`@[\w.]+`], NUMBER],
    keywords:
      "and as assert async await break case class cls continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return self try while with yield",
    literals: "True False None",
    names: true,
  },
  go: {
    rules: [C_COMMENT, BT, DQ, SQ, NUMBER],
    keywords:
      "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    types:
      "any bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr",
    literals: "true false nil iota",
    names: true,
  },
  rust: {
    rules: [
      C_COMMENT,
      DQ,
      ["s", String.raw`'(?:\\.|[^'\\\n])'`],
      ["m", String.raw`'[A-Za-z_]\w*|#!?\[[^\]\n]*\]`],
      ["f", String.raw`\b[a-z_]\w*!(?=[([{])`],
      NUMBER,
    ],
    keywords:
      "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
    types: "bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize",
    literals: "true false",
    names: true,
  },
  shell: {
    rules: [
      SPACED_HASH,
      DQ,
      ["s", "'[^'\\n]*'?"],
      ["m", String.raw`\$\{[^}\n]*\}?|\$[\w@#?$!*-]`],
      // The command word: at a line start (after an optional "$ " prompt) or after a pipe, separator or "$(".
      [
        "f",
        String.raw`(?<=^[ \t]*(?:\$[ \t]+)?|[|;&(][ \t]*)(?!(?:${SH_KEYWORDS.replaceAll(" ", "|")})\b)[A-Za-z_][\w.-]*(?![\w.-]*=)`,
      ],
      FLAG,
      NUMBER,
    ],
    keywords: SH_KEYWORDS,
  },
  json: { rules: [C_COMMENT, ["p", String.raw`"(?:\\.|[^"\\\n])*"(?=\s*:)`], DQ, NUMBER], literals: "true false null" },
  yaml: {
    rules: [
      SPACED_HASH,
      ["p", String.raw`[\w.\/-]+(?=[ \t]*:(?:[ \t]|$))(?<=^[ \t]*(?:-[ \t]+)?[\w.\/-]+)`],
      DQ,
      SQ,
      NUMBER,
    ],
    literals: "true false null yes no on off",
  },
  toml: {
    rules: [
      HASH,
      TRIPLE,
      DQ,
      SQ,
      ["t", String.raw`^[ \t]*\[\[?[^\]\n]*\]\]?`],
      ["p", String.raw`[\w.\-"]+(?=[ \t]*=)(?<=^[ \t]*[\w.\-"]+)`],
      NUMBER,
    ],
    literals: "true false",
  },
  css: {
    rules: [
      ["c", String.raw`\/\*[\s\S]*?(?:\*\/|${END})`],
      DQ,
      SQ,
      ["k", String.raw`@[\w-]+`],
      ["n", String.raw`#[\da-fA-F]{3,8}\b`],
      ["p", String.raw`(?<=[{;]\s*)-{0,2}[A-Za-z][\w-]*(?=\s*:)|--[\w-]+`],
      ["t", String.raw`\.[A-Za-z_][\w-]*`],
      NUMBER,
    ],
    names: true,
  },
  html: {
    rules: [
      ["c", String.raw`<!--[\s\S]*?(?:-->|${END})`],
      // Lookbehinds come last, so they run only where a token already matched: long plain text stays linear.
      ["k", String.raw`<\/?[A-Za-z][\w:.-]*|\/?>(?<=<\/?[A-Za-z][^<>]*>)|\{[#:/@][A-Za-z]+`],
      ["p", String.raw`[\w:@.-]+(?=\s*=)(?<=<[A-Za-z][^<>]*\s[\w:@.-]+)`],
      ["s", String.raw`(?:"[^"]*"|'[^']*')(?<=<[A-Za-z][^<>]*=\s*(?:"[^"]*"|'[^']*'))`],
    ],
  },
  sql: {
    rules: [["c", String.raw`--.*|\/\*[\s\S]*?(?:\*\/|${END})`], ["s", "'(?:''|[^'\\n])*'?"], NUMBER],
    keywords:
      "add all alter and as asc begin between by cascade case check column commit constraint create cross default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references returning right rollback select set table then transaction union unique update using values view when where with",
    types:
      "bigint blob bool boolean char date datetime decimal double float int integer json jsonb numeric real serial smallint text time timestamp timestamptz uuid varchar",
    literals: "true false",
    names: true,
    caseless: true,
  },
  c: {
    rules: [C_COMMENT, ["m", String.raw`(?<=^[ \t]*)#[ \t]*[A-Za-z]+|@[A-Za-z]\w*|\$[A-Za-z_]\w*`], DQ, SQ, NUMBER],
    keywords:
      "abstract as async await break case catch class const constexpr continue default defer delete do else enum explicit export extends extern final finally for friend fun func goto guard if implements import in inline interface internal is let namespace new object open operator override package private protected public readonly register return sealed signed sizeof static struct super switch template this throw throws try typedef typename union unsigned using val var virtual void volatile when where while with yield",
    types:
      "auto bool boolean byte char double float int long short string size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t",
    literals: "true false null nullptr NULL nil",
    names: true,
  },
  ruby: {
    rules: [
      HASH,
      DQ,
      SQ,
      ["n", String.raw`(?<![\w:]):[A-Za-z_]\w*[?!]?`],
      ["m", String.raw`@{1,2}[A-Za-z_]\w*`],
      NUMBER,
    ],
    keywords:
      "alias and attr_accessor attr_reader attr_writer begin break case class def do else elsif end ensure extend for if in include module next not or private protected public raise redo require require_relative rescue retry return self super then undef unless until when while yield",
    literals: "true false nil",
    names: true,
  },
  nix: {
    rules: [
      ["c", String.raw`#.*|\/\*[\s\S]*?(?:\*\/|${END})`],
      ["s", String.raw`''[\s\S]*?(?:''|${END})`],
      DQ,
      ["s", String.raw`\.{0,2}\/[\w.\/-]+|<[\w.\/-]+>`],
      ["p", String.raw`[\w-]+(?:\.[\w-]+)*(?=\s*=(?!=))`],
      NUMBER,
    ],
    keywords: "assert else if import in inherit let or rec then with",
    literals: "true false null",
  },
  diff: {
    rules: [
      ["m", String.raw`^(?:diff |index |--- |\+\+\+ |@@).*`],
      ["a", String.raw`^\+.*`],
      ["d", "^-.*"],
    ],
  },
  dockerfile: {
    rules: [
      ["c", String.raw`^[ \t]*#.*`],
      [
        "k",
        String.raw`^[ \t]*(?:ADD|ARG|CMD|COPY|ENTRYPOINT|ENV|EXPOSE|FROM|HEALTHCHECK|LABEL|ONBUILD|RUN|SHELL|STOPSIGNAL|USER|VOLUME|WORKDIR)\b`,
      ],
      DQ,
      SQ,
      ["m", String.raw`\$\{[^}\n]*\}?|\$\w+`],
      FLAG,
    ],
  },
};

const ALIASES: Record<string, string> = {
  javascript: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  typescript: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  py: "python",
  python3: "python",
  golang: "go",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ksh: "shell",
  console: "shell",
  shellsession: "shell",
  jsonc: "json",
  json5: "json",
  yml: "yaml",
  scss: "css",
  less: "css",
  htm: "html",
  xhtml: "html",
  xml: "html",
  svg: "html",
  svelte: "html",
  vue: "html",
  sqlite: "sql",
  postgres: "sql",
  postgresql: "sql",
  psql: "sql",
  mysql: "sql",
  h: "c",
  cpp: "c",
  "c++": "c",
  cc: "c",
  cxx: "c",
  hpp: "c",
  java: "c",
  cs: "c",
  csharp: "c",
  kotlin: "c",
  kt: "c",
  kts: "c",
  swift: "c",
  php: "c",
  dart: "c",
  scala: "c",
  groovy: "c",
  zig: "c",
  objc: "c",
  rb: "ruby",
  patch: "diff",
  docker: "dockerfile",
  containerfile: "dockerfile",
};

const grammars = new Map<string, Grammar>();

function grammar(language: string): Grammar | undefined {
  const name = (Object.hasOwn(ALIASES, language) ? ALIASES[language] : undefined) ?? language;
  const cached = grammars.get(name);
  if (cached !== undefined) return cached;
  const spec = Object.hasOwn(SPECS, name) ? SPECS[name] : undefined;
  if (spec === undefined) return undefined;
  const words = new Map<string, string>();
  for (const [kind, list] of [
    ["n", spec.literals],
    ["t", spec.types],
    ["k", spec.keywords],
  ] as const) {
    for (const word of list?.split(" ") ?? []) words.set(word, kind);
  }
  const alternatives = spec.rules.map(([, pattern]) => `(${pattern})`);
  const built = {
    pattern: new RegExp(`${alternatives.join("|")}|([A-Za-z_$][\\w$]*)`, "gm"),
    kinds: spec.rules.map(([kind]) => kind),
    words,
    names: spec.names === true,
    caseless: spec.caseless === true,
  };
  grammars.set(name, built);
  return built;
}

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escaped HTML for `code`, with recognized tokens wrapped in `<span class="hl-…">`. */
export function highlight(code: string, language: string): string {
  const rules = code.length > LIMIT ? undefined : grammar(language.toLowerCase());
  if (rules === undefined) return escapeHtml(code);
  // Bound per-line prefix scans and failed token matches, not just total input.
  let lineStart = 0;
  for (let at = 0; at < code.length; at++) {
    if (code[at] === "\n") lineStart = at + 1;
    else if (at - lineStart >= LINE_LIMIT) return escapeHtml(code);
  }
  let html = "";
  let last = 0;
  for (const match of code.matchAll(rules.pattern)) {
    const text = match[0];
    const at = match.index;
    const group = match.findIndex((value, index) => index > 0 && value !== undefined);
    let kind = rules.kinds[group - 1] ?? "";
    if (group > rules.kinds.length) {
      // A name after "." is a member, never a keyword: `map.get(`, `event.type`.
      const member = code[at - 1] === "." && code[at - 2] !== ".";
      if (!member) kind = rules.words.get(rules.caseless ? text.toLowerCase() : text) ?? "";
      if (kind === "" && rules.names) {
        if (code[at + text.length] === "(") kind = "f";
        else if (/^[A-Z]/.test(text)) kind = "t";
      }
    }
    if (kind === "") continue;
    html += `${escapeHtml(code.slice(last, at))}<span class="hl-${kind}">${escapeHtml(text)}</span>`;
    last = at + text.length;
  }
  return html + escapeHtml(code.slice(last));
}
