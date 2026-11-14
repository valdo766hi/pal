# Vendored pi-claude-code

Copied from [earendil-works/pi-claude-code](https://github.com/earendil-works/pi-claude-code) at commit
`d5b5e04c314d3452d357174d16d10dda34daa2d2` (2026-11-05), under its MIT licence (`LICENSE`). It is not published to
npm and ships TypeScript source, which Node does not strip under `node_modules`, so Pal builds it like its own code.
Lint and formatting rules don't apply here; the type checker does.

Not copied: `src/index.ts` (it needs `@earendil-works/pi-coding-agent`) and `src/provider.ts` (Pal's
`../server.ts` builds the provider from the plugin's settings instead of the process environment).

Pal's changes, all marked or type-only:

- `env.ts`: `hostEnvironment()`, the only host variables a Claude Code process inherits; `claude-cli.ts` uses it
  wherever upstream read `process.env`.
- `stream.ts`: the working directory comes from the provider (`PI_CLAUDE_CODE_CWD`, an empty folder), not Pal's own.
- Pal compiles with `exactOptionalPropertyTypes` and `erasableSyntaxOnly`: optional fields accept `undefined`,
  constructor parameter properties are plain fields, and optional Pi message fields are set or removed explicitly.

Revisit once upstream publishes a built package.
