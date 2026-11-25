import { describe, expect, it } from "vitest";
import type { CommandApproval, Entry, Message } from "../web/src/lib/chat.svelte.ts";
import { build, group, place, type Item, type Row } from "../web/src/lib/projection.ts";

const call = (id: string, code: string) => ({ type: "toolCall" as const, id, name: "codemode", arguments: { code } });
const turn = (id: number, content: Message["content"], extra: Partial<Message> = {}): Entry => ({
  id,
  kind: "pi.assistant",
  model: [{ role: "assistant", content, ...extra }],
});
const result = (id: number, toolCallId: string, text: string): Entry =>
  ({
    id,
    kind: "pi.tool-result",
    model: [{ role: "toolResult", toolCallId, content: [{ type: "text", text }] }],
  }) as unknown as Entry;
const user = (id: number, text: string): Entry => ({ id, kind: "pi.user", model: [{ role: "user", content: text }] });
const approval = (id: string, assistant: number | null, state = "pending") =>
  ({ id, assistant, state }) as unknown as CommandApproval;
const none = () => undefined;
const rows = (items: Item[], retried: ReadonlySet<string> = new Set()) =>
  items.reduce<Row[]>((all, item) => place(all, item, retried), []);

describe("transcript projection", () => {
  it("matches each result to its own turn's call when call IDs repeat across turns", () => {
    const items = build(
      [
        user(1, "go"),
        turn(2, [call("c1", "a()")]),
        result(3, "c1", "first"),
        turn(4, [call("c1", "b()")]),
        result(5, "c1", "second"),
      ],
      undefined,
      [],
      none,
    );
    const steps = items.flatMap((item) => (item.kind === "assistant" ? item.steps : []));
    expect(steps.map((step) => [step.code, step.result?.text, step.latest])).toEqual([
      ["a()", "first", false],
      ["b()", "second", true],
    ]);
  });

  it("keeps the live turn after history, with each command request under the turn that asked", () => {
    const items = build(
      [user(1, "go"), turn(2, [call("c1", "x()")])],
      { role: "assistant", content: "partial" },
      [approval("a", 2), approval("b", null)],
      none,
    );
    expect(items.map((item) => [item.kind, item.id])).toEqual([
      ["user", "1"],
      ["assistant", "2"],
      ["approval", "approval-a"],
      ["approval", "approval-b"],
      ["assistant", "live"],
    ]);
    expect(items.at(-1)).toMatchObject({ live: true, texts: ["partial"] });
  });

  it("groups a run's tool activity into one line and says below it when a step's turn failed", () => {
    const items = build(
      [
        user(1, "go"),
        turn(2, [call("c1", "x()")]),
        result(3, "c1", "ok"),
        turn(4, [call("c2", "y()")], { stopReason: "error", errorMessage: "boom" }),
        turn(5, "done"),
      ],
      undefined,
      [],
      none,
    );
    expect(rows(items).map((row) => [row.kind, row.id])).toEqual([
      ["user", "1"],
      ["work", "work-1"],
      ["assistant", "4-end"],
      ["assistant", "5"],
    ]);
    // A turn Pi retried joins the line instead of reporting its failure.
    expect(rows(items, new Set(["4"])).map((row) => row.id)).toEqual(["1", "work-1", "5"]);
  });

  it("shows a plugin's entry as the chat's renderer lookup says", () => {
    const entry: Entry = { id: 1, kind: "pal.example" };
    const items = build([entry], undefined, [], (kind) => (kind === "pal.example" ? "missing" : undefined));
    expect(items).toEqual([{ kind: "plugin", id: "1", entry, piece: "missing" }]);
  });

  it("groups committed history identically to place without mutating inputs or cached history on live append", () => {
    const entries: Entry[] = [
      user(1, "go"),
      turn(2, [call("c1", "a()")]),
      result(3, "c1", "ok"),
      { id: 4, kind: "pal.shell", data: { shell: { callId: "s1", status: "started", command: "ls", cwd: "/tmp" } } },
      turn(5, [call("c2", "b()")], { stopReason: "error", errorMessage: "boom" }),
      turn(6, [call("c3", "c()")], { stopReason: "aborted" }),
      turn(7, "final answer"),
    ];
    const approvals = [approval("done", 2, "approved"), approval("wait", 5, "pending")];
    const items = build(entries, undefined, approvals, none);
    const snapshot = structuredClone(items);

    for (const retried of [new Set<string>(), new Set(["5"])]) {
      const expected = rows(items, retried);
      const actual = group(items, retried);
      expect(actual).toEqual(expected);
      expect(items).toEqual(snapshot);
    }

    // Live append via place() onto cached historyRows must never mutate cached work.items arrays.
    const committed = build([user(1, "go"), turn(2, [call("c1", "a()")])], undefined, [], none);
    const historyRows = group(committed, new Set());
    const work = historyRows.at(-1);
    expect(work?.kind).toBe("work");
    const cachedWorkItems = work?.kind === "work" ? [...work.items] : [];
    const liveItems = build([], { role: "assistant", content: [call("c2", "live()")] }, [], none);
    const combined = liveItems.reduce((all, item) => place(all, item, new Set()), [...historyRows]);

    expect(work?.kind === "work" ? work.items : []).toEqual(cachedWorkItems);
    const combinedWork = combined.at(-1);
    expect(combinedWork?.kind).toBe("work");
    expect(combinedWork?.kind === "work" ? combinedWork.items.length : 0).toBe(cachedWorkItems.length + 1);
  });
});
