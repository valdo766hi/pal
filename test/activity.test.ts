import { describe as suite, expect, it } from "vitest";
import { describe, summarize } from "../web/src/lib/activity.ts";

const call = (name: string, args?: object) => ({ name, args: args === undefined ? undefined : JSON.stringify(args) });

suite("run activity wording", () => {
  it("summarizes calls by what they did, in the order each kind first happened", () => {
    expect(
      summarize([
        call("files_read", { path: "a.md" }),
        call("shell_run", { command: "ls" }),
        call("files_read", { path: "b.md" }),
        call("files_edit", { path: "a.md" }),
        call("shell_run", { command: "pwd" }),
        call("mcp__exa__web_search_exa", { query: "pi" }),
      ]),
    ).toBe("Read 2 files, ran 2 commands, edited 1 file, used 1 tool");
    expect(summarize([])).toBe("");
  });

  it("counts a file read or edited twice once, and unreadable arguments separately", () => {
    expect(summarize([call("files_read", { path: "a.md" }), call("files_read", { path: "a.md" })])).toBe("Read 1 file");
    expect(summarize([{ name: "files_read", args: '{"path":"a.m' }, { name: "files_read" }])).toBe("Read 2 files");
  });

  it("names what a single call acted on, and falls back to the summary", () => {
    expect(describe([call("files_read", { path: "src/index.ts" })])).toEqual({ verb: "Read", object: "src/index.ts" });
    expect(describe([call("files_search", { query: "answer" })])).toEqual({ verb: "Searched", object: "answer" });
    expect(describe([call("mcp__exa__web_search_exa", { query: "pi" })])).toEqual({
      verb: "Used",
      object: "exa · web_search_exa",
    });
    expect(describe([call("files_list", {})])).toEqual({ verb: "Listed files" });
    expect(describe([call("files_read", { path: "a" }), call("files_read", { path: "b" })])).toEqual({
      verb: "Read 2 files",
    });
    expect(describe([])).toEqual({ verb: "" });
  });
});
