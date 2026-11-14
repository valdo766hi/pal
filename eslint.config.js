import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "dist/",
      "coverage/",
      ".devenv/",
      ".direnv/",
      "result*",
      ".agents/",
      ".claude/",
      ".design/",
      "plugins/*/vendor/",
    ],
  },
  js.configs.recommended,
  ts.configs.strict,
  svelte.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: ["web/**", "plugins/*/ui/**", "test/fixtures/plugins/*/ui/**"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: { parserOptions: { parser: ts.parser, extraFileExtensions: [".svelte"] } },
  },
);
