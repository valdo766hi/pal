import { describe, expect, it } from "vitest";
import { escapeHtml, highlight } from "../web/src/lib/highlight.ts";

const plain = (html: string) =>
  html
    .replaceAll(/<\/?span[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
const spans = (html: string) =>
  [...html.matchAll(/<span class="hl-(\w)">([^<]*)<\/span>/g)].map((m) => `${m[1]}:${m[2]}`);

describe("code highlighting", () => {
  it("never changes or unescapes the code, in any language", () => {
    const samples: [string, string][] = [
      ["go", 'package main\n\nfunc main() {\n\tfmt.Println("<b>&") // done\n}'],
      ["html", '<a href="x">it\'s > 3 & <b>bold</b></a><!-- open'],
      ["bash", '$ FOO=1 make && echo "$HOME" # <tag>'],
      ["sql", "SELECT 'it''s' FROM t -- <x>"],
      ["unknown", "<script>alert(1)</script>"],
      ["", "a < b"],
    ];
    for (const [language, code] of samples) {
      const html = highlight(code, language);
      expect(plain(html)).toBe(code);
      expect(html.replaceAll(/<\/?span[^>]*>/g, "")).not.toMatch(/[<>]/);
    }
  });

  it("colors keywords, strings, numbers, comments, calls and types", () => {
    expect(spans(highlight('func main() { x := http.Server{Addr: ":80"}; return nil } // hi', "go"))).toEqual([
      "k:func",
      "f:main",
      "t:Server",
      "t:Addr",
      's:":80"',
      "k:return",
      "n:nil",
      "c:// hi",
    ]);
    expect(spans(highlight('{"ok": true, "n": 2}', "json"))).toEqual(['p:"ok"', "n:true", 'p:"n"', "n:2"]);
    expect(spans(highlight("SELECT count(*) FROM t", "sql"))).toEqual(["k:SELECT", "f:count", "k:FROM"]);
  });

  it("treats members as names and keeps unfinished strings to one line while code streams in", () => {
    expect(spans(highlight("map.get(key); event.type; Type; Type()", "ts"))).toEqual(["f:get", "t:Type", "f:Type"]);
    expect(spans(highlight('const a = "open\nconst b = 1', "js"))).toEqual(["k:const", 's:"open', "k:const", "n:1"]);
  });

  it("resolves aliases and ignores names that are not languages", () => {
    expect(highlight("let x = 1", "TypeScript")).toContain("hl-k");
    const code = 'const value = "<tag>&";';
    for (const language of ["constructor", "__proto__", "(a+)+$", "js|.*", "[", "sql(?=.)"])
      expect(highlight(code, language)).toBe('const value = "&lt;tag&gt;&amp;";');
  });

  it("keeps ordinary YAML and TOML keys, values and sections highlighted", () => {
    expect(spans(highlight("name: 'Pal'\nenabled: true\n- mode: local", "yaml"))).toEqual([
      "p:name",
      "s:'Pal'",
      "p:enabled",
      "n:true",
      "p:mode",
    ]);
    expect(spans(highlight('[server]\nname = "Pal"\nenabled = true', "toml"))).toEqual([
      "t:[server]",
      "p:name",
      's:"Pal"',
      "p:enabled",
      "n:true",
    ]);
  });

  it.each(["yaml", "toml"])("bounds adversarial %s work below the total size limit", (language) => {
    const cases = [
      " ".repeat(100_000) + "x",
      "\t".repeat(100_000) + "x",
      ".".repeat(100_000) + "!",
      " ".repeat(50_000) + 'key: "<tag>&',
      '[section]\nkey = "' + "x".repeat(100_000) + "<>&",
    ];
    for (const code of cases) {
      const started = performance.now();
      const html = highlight(code, language);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(html).toBe(escapeHtml(code));
      expect(plain(html)).toBe(code);
    }
    const shortLines = (" ".repeat(2047) + "x\n").repeat(95);
    const started = performance.now();
    expect(plain(highlight(shortLines, language))).toBe(shortLines);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("uses escaped plain text above the highlighting limit", () => {
    const code = "x".repeat(200_000) + "<>&";
    expect(highlight(code, "js")).toBe("x".repeat(200_000) + "&lt;&gt;&amp;");
  });
});
