import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink, link, rename, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getSystemMessageText,
  type Message,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPal } from "../src/core/app.ts";
import { GuidanceFiles } from "../src/core/guidance-files.ts";
import { runGit } from "../src/core/git.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function skill(
  root: string,
  directory: string,
  name: string,
  body = "LAZY-SKILL-BODY",
  description = `Use ${name} for fixture tasks`,
) {
  const path = join(root, directory);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`,
  );
  return path;
}
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-skills-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const guidanceHome = join(root, "Host user 界");
  await mkdir(guidanceHome);
  const options = { dataRoot: join(root, "data"), installRoot: "/nonexistent-install", guidanceHome };
  let pal = await openPal(options, context);
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("skills-project", { name: "Skill fixture" });
  const chat = await pal.chats.createChat("skills-chat", { projectId: project.id }, context);
  const global = join(guidanceHome, ".agents", "skills"),
    local = join(project.root, ".agents", "skills");
  const faux = fauxProvider({ models: [{ id: "skills-fixture" }] });
  let sequence = 0;
  async function run(codes: string[] = [], target = chat) {
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const conversation = await pal.harness.conversation(target.conversationId, context);
    if (conversation === undefined) throw new Error("missing skill conversation");
    const model = faux.getModel();
    await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    const requests: (readonly Message[])[] = [];
    faux.setResponses([
      ...codes.map((code) => (request: { messages: readonly Message[] }) => {
        requests.push(request.messages);
        return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
      }),
      (request) => {
        requests.push(request.messages);
        return fauxAssistantMessage("fixture answer");
      },
    ]);
    await pal.chats.submit(
      target.id,
      `skills-input-${++sequence}`,
      { text: "Use the relevant fixture skill" },
      context,
    );
    await conversation.waitForIdle(context);
    return {
      system: requests.map(getCurrentSystemPrompt),
      historicalSystem: requests.map((messages) =>
        messages
          .filter((m) => m.role === "system")
          .map(getSystemMessageText)
          .join("\n"),
      ),
      results: JSON.stringify((await conversation.context(context)).messages.filter((m) => m.role === "toolResult")),
    };
  }
  return {
    root,
    guidanceHome,
    options,
    project,
    chat,
    global,
    local,
    run,
    get pal() {
      return pal;
    },
    async reopen() {
      await pal.close();
      pal = await openPal(options, context);
    },
  };
}

describe("lazy scoped skills", () => {
  it("discovers metadata without bodies, reads relevant skills through Code Mode, and keeps projects separate", async () => {
    const f = await setup();
    await skill(f.global, "global library", "Global 界", "GLOBAL-LAZY-BODY");
    const path = await skill(f.local, "project library", "Project 界", "PROJECT-LAZY-BODY");
    await writeFile(join(path, "reference.md"), "LAZY-REFERENCE");
    await writeFile(join(path, "script.sh"), "touch must-not-run\n");
    const info = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(info.current.catalog).toMatchObject([
      { name: "Global 界", scope: "global", state: "ready" },
      { name: "Project 界", scope: "project", state: "ready" },
    ]);
    const before = await f.run();
    expect(before.system[0]).toContain("Use Project 界 for fixture tasks");
    expect(before.system[0]).not.toContain("PROJECT-LAZY-BODY");
    expect(before.system[0]).not.toContain("GLOBAL-LAZY-BODY");
    expect(before.system[0]).not.toContain("LAZY-REFERENCE");
    const chosen = info.current.catalog.find((item) => item.scope === "project");
    if (chosen === undefined) throw new Error("missing fixture skill");
    const args = JSON.stringify({ id: chosen.id, revision: chosen.revision });
    const used = await f.run([
      'return await tools.skills_search({query:"Project 界"});',
      `return await tools.skills_read(${args});`,
      `return await tools.skills_read(${JSON.stringify({ id: chosen.id, revision: chosen.revision, reference: "reference.md" })});`,
    ]);
    expect(used.results).toContain("PROJECT-LAZY-BODY");
    expect(used.results).toContain("LAZY-REFERENCE");
    expect(used.results).not.toContain("GLOBAL-LAZY-BODY");
    expect((await f.pal.skills.inspect(f.chat.conversationId, context)).selection.used).toMatchObject([
      {
        id: chosen.id,
        revision: chosen.revision,
        sha256: createHash("sha256")
          .update(await readFile(join(path, "SKILL.md")))
          .digest("hex"),
      },
    ]);
    await expect(readFile(join(f.project.root, "must-not-run"))).rejects.toMatchObject({ code: "ENOENT" });
    const other = await f.pal.projects.create("other-skills", { name: "Other" });
    const chat = await f.pal.chats.createChat("other-skills-chat", { projectId: other.id }, context);
    const next = await f.pal.skills.inspect(chat.conversationId, context);
    expect(next.current.catalog.map((item) => item.name)).toEqual(["Global 界"]);
    expect(next.selection.used).toEqual([]);
  });

  it("honors explicit selection, withholds changed bytes until reselected, and retains exact old prompts on restart", async () => {
    const f = await setup();
    const path = await skill(f.global, "selected", "selected", "FIRST-SELECTED-BODY");
    const initial = await f.pal.skills.inspect(f.chat.conversationId, context);
    const item = initial.current.catalog[0];
    if (item === undefined) throw new Error("missing skill");
    await f.pal.skills.select(
      f.chat.conversationId,
      { revision: 0, skills: [{ id: item.id, revision: item.revision }] },
      context,
    );
    expect((await f.run()).system[0]).toContain("FIRST-SELECTED-BODY");
    const prompt = await f.pal.context.prompt(f.chat, { offset: 0 }, context);
    await writeFile(
      join(path, "SKILL.md"),
      "---\nname: selected\ndescription: Useful changed procedure\n---\nSECOND-SELECTED-BODY\n",
    );
    await f.reopen();
    expect((await f.pal.context.prompt(f.chat, { offset: 0 }, context)).sections).toEqual(prompt.sections);
    const next = await f.run();
    expect(next.system[0]).not.toContain("FIRST-SELECTED-BODY");
    expect(next.system[0]).not.toContain("SECOND-SELECTED-BODY");
    expect(next.historicalSystem[0]).toContain("FIRST-SELECTED-BODY");
    expect(next.system[0]).toContain('"state":"stale"');
    const stale = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(stale.current.selected[0]).toMatchObject({ state: "stale", text: null });
    await expect(
      f.pal.skills.read(f.chat.conversationId, { id: item.id, revision: item.revision }, context),
    ).rejects.toMatchObject({ code: "skill_stale" });
    const updated = stale.current.catalog[0];
    if (updated === undefined) throw new Error("missing edited skill");
    await f.pal.skills.select(
      f.chat.conversationId,
      { revision: 1, skills: [{ id: updated.id, revision: updated.revision }] },
      context,
    );
    expect((await f.run()).system[0]).toContain("SECOND-SELECTED-BODY");
  });

  it("makes overrides, normalized duplicates and project disabling deterministic without a hidden fallback", async () => {
    const f = await setup();
    await skill(f.global, "base", "Café", "GLOBAL-OVERRIDDEN");
    await skill(f.local, "override", "Cafe\u0301", "PROJECT-OVERRIDE");
    let info = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(info.current.catalog.map((item) => item.state)).toEqual(["shadowed", "ready"]);
    await f.pal.skills.configure(f.chat.conversationId, { ...info.settings, disabled: ["CAFÉ"] });
    info = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(info.current.catalog.map((item) => item.state)).toEqual(["disabled", "disabled"]);
    expect((await f.run()).system[0]).not.toContain("GLOBAL-OVERRIDDEN");
    await f.pal.skills.configure(f.chat.conversationId, { ...info.settings, disabled: [] });
    await skill(f.local, "duplicate", "ＣＡＦÉ", "AMBIGUOUS-PROJECT");
    info = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(info.current.catalog.map((item) => item.state)).toEqual(["shadowed", "duplicate", "duplicate"]);
    const global = info.current.catalog[0];
    if (global === undefined) throw new Error("missing global");
    await expect(
      f.pal.skills.read(f.chat.conversationId, { id: global.id, revision: global.revision }, context),
    ).rejects.toMatchObject({ code: "skill_unavailable" });
  });

  it("keeps malformed, oversized, unreadable and missing sources diagnostic instead of breaking chat", async () => {
    const f = await setup();
    const empty = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(empty.current.catalog).toEqual([]);
    expect(empty.current.roots.map((root) => root.state)).toEqual(["missing", "missing"]);
    const invalid = [
      "---\nname: duplicated\nname: again\ndescription: Wrong\n---\nbody",
      "---\nname: &a alias\ndescription: *a\n---\nbody",
      "---\nname: !execute hostile\ndescription: Wrong\n---\nbody",
      "---\nname: missing-description\n---\nbody",
      "---\nname: [not, a, string]\ndescription: Wrong\n---\nbody",
      `---\nname: ${"ﬃ".repeat(80)}\ndescription: Expanded name\n---\nbody`,
      "---\nname: ／\ndescription: Normalized path separator\n---\nbody",
      "---\n" + "#".repeat(9000),
      "---\nname: giant\ndescription: Too large\n---\n" + "x".repeat(70000),
    ];
    for (const [i, body] of invalid.entries()) {
      await mkdir(join(f.local, `bad-${i}`), { recursive: true });
      await writeFile(join(f.local, `bad-${i}`, "SKILL.md"), body);
    }
    const unreadable = await skill(f.local, "unreadable", "unreadable");
    await chmod(unreadable, 0);
    cleanups.push(() => chmod(unreadable, 0o700));
    const info = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(info.current.catalog).toHaveLength(10);
    expect(info.current.catalog.every((item) => item.state === "invalid" && item.diagnostic !== null)).toBe(true);
    expect((await f.run()).system[0]).toContain("skills");
  });

  it("confines skill bodies and references without executing scripts or exposing protected objects", async () => {
    const f = await setup();
    const path = await skill(f.local, "confined", "confined", "Never grant shell or private data access");
    await writeFile(join(f.root, "outside.md"), "UNGRANTED-OUTSIDE");
    await symlink(join(f.root, "outside.md"), join(path, "escaped.md"));
    await link(join(f.options.dataRoot, "credentials.key"), join(path, "hardlink.md"));
    const info = await f.pal.skills.inspect(f.chat.conversationId, context);
    const item = info.current.catalog[0];
    if (item === undefined) throw new Error("missing skill");
    for (const reference of ["../SKILL.md", "/etc/passwd", "escaped.md", "hardlink.md", "nested/../../outside.md"]) {
      await expect(
        f.pal.skills.read(f.chat.conversationId, { id: item.id, revision: item.revision, reference }, context),
      ).rejects.toBeDefined();
    }
    const original = join(f.options.dataRoot, "credentials.key");
    await rm(join(path, "hardlink.md"));
    await rename(original, join(path, "moved.md"));
    await expect(
      f.pal.skills.read(
        f.chat.conversationId,
        { id: item.id, revision: item.revision, reference: "moved.md" },
        context,
      ),
    ).rejects.toBeDefined();
    const malicious = await f.run([
      `return await tools.skills_read(${JSON.stringify({ id: item.id, revision: item.revision, reference: "escaped.md" })});`,
    ]);
    expect(malicious.results).not.toContain("UNGRANTED-OUTSIDE");
    const refused = await f.run(['return await tools.files_read({path:"../outside.md"});']);
    expect(refused.results).not.toContain("UNGRANTED-OUTSIDE");
  });

  it("reads the actual Local, Read-only and committed Worktree versions", async () => {
    const f = await setup();
    const source = join(f.root, "Source repo 界");
    await skill(join(source, ".agents", "skills"), "work 界", "workspace-skill", "COMMITTED-SKILL");
    const git = (...args: string[]) =>
      runGit(
        source,
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
        { signal: AbortSignal.timeout(5000) },
      );
    await git("init", "-q");
    await git("add", ".agents");
    await git("commit", "-qm", "Fixture skill");
    const project = await f.pal.projects.create("skills-modes", { name: "Versioned skills", folder: source });
    const chats = [];
    for (const mode of ["local", "read-only", "worktree"] as const) {
      const chat = await f.pal.chats.createChat(`skills-${mode}`, { projectId: project.id, workspace: mode }, context);
      const workspace = await f.pal.workspaces.provision(chat.id);
      expect(workspace.state).toBe("ready");
      chats.push({ chat, mode, root: workspace.root });
    }
    await skill(join(source, ".agents", "skills"), "work 界", "workspace-skill", "LIVE-UNCOMMITTED-SKILL");
    for (const { chat, mode, root } of chats) {
      const info = await f.pal.skills.inspect(chat.conversationId, context);
      expect(info.current.workspace).toBe(root);
      const item = info.current.catalog[0];
      if (item === undefined) throw new Error("missing workspace skill");
      const result = await f.pal.skills.read(chat.conversationId, { id: item.id, revision: item.revision }, context);
      expect(result.text).toContain(mode === "worktree" ? "COMMITTED-SKILL" : "LIVE-UNCOMMITTED-SKILL");
      expect(result.path.startsWith(`${root}/`)).toBe(true);
      const used = await f.run(
        [`return await tools.skills_read(${JSON.stringify({ id: item.id, revision: item.revision })});`],
        chat,
      );
      expect(used.results).toContain(mode === "worktree" ? "COMMITTED-SKILL" : "LIVE-UNCOMMITTED-SKILL");
    }
  });

  it("bounds a large catalog and reads metadata only until a skill is selected", async () => {
    const f = await setup();
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        skill(
          f.local,
          `p-${String(i).padStart(3, "0")}`,
          `skill-${i}`,
          `UNSELECTED-BODY-${i}`,
          "Useful task procedure " + "x".repeat(450),
        ),
      ),
    );
    const reads = vi.spyOn(GuidanceFiles.prototype, "read");
    const info = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(info.current.catalog).toHaveLength(100);
    expect(info.current.diagnostics).toEqual([]);
    expect(reads.mock.calls.every((args) => args[2].headerBytes === info.limits.metadataBytes)).toBe(true);
    const run = await f.run();
    const section = run.system[0]?.match(/<skills>\n([\s\S]*?)\n<\/skills>/)?.[1];
    if (section === undefined) throw new Error("missing bounded skill section");
    expect(Buffer.byteLength(section)).toBeLessThan(info.limits.metadataContextBytes + 2048);
    expect(section).not.toContain("UNSELECTED-BODY");
    expect(section).toContain("metadata context limited");
    expect(
      reads.mock.calls
        .filter((args) => args[1].endsWith("SKILL.md"))
        .every((args) => args[2].headerBytes !== undefined),
    ).toBe(true);
    const chosen = info.current.catalog.at(-1);
    if (chosen === undefined) throw new Error("missing last catalog entry");
    const selected = await f.run([
      'return await tools.skills_search({query:"skill-99"});',
      `return await tools.skills_read(${JSON.stringify({ id: chosen.id, revision: chosen.revision })});`,
    ]);
    expect(selected.results).toContain("UNSELECTED-BODY-99");
    expect(reads.mock.calls.some((args) => args[1].endsWith("SKILL.md") && args[2].headerBytes === undefined)).toBe(
      true,
    );
  });

  it("does not activate an arbitrary winner when discovery cannot rule out a hidden duplicate or override", async () => {
    const f = await setup();
    await Promise.all(
      Array.from({ length: 130 }, (_, i) => skill(f.global, `p-${String(i).padStart(3, "0")}`, `skill-${i}`)),
    );
    await skill(f.local, "override", "skill-0", "OVERRIDE-BEYOND-GLOBAL-LIMIT");
    const info = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(info.current.catalog).toHaveLength(info.limits.catalog);
    expect(info.current.catalog.every((item) => item.state !== "ready")).toBe(true);
    expect(info.current.diagnostics).toContain("Skill catalog limit reached; narrow the enabled roots.");
    expect((await f.run()).system[0]).not.toContain("OVERRIDE-BEYOND-GLOBAL-LIMIT");
  });

  it("deduplicates global root aliases and makes root disabling and name fallback explicit", async () => {
    const f = await setup();
    await skill(f.global, "base", "shared", "GLOBAL-DEFINITION");
    await skill(f.local, "override", "shared", "PROJECT-DEFINITION");
    const alias = join(f.guidanceHome, "Alias skills 界");
    await symlink(f.global, alias);
    let info = await f.pal.skills.inspect(f.chat.conversationId, context);
    await f.pal.skills.configure(f.chat.conversationId, {
      ...info.settings,
      global: [...info.settings.global, { path: alias, enabled: true }],
    });
    info = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(info.current.catalog).toHaveLength(2);
    expect(info.current.catalog.map((item) => item.state)).toEqual(["shadowed", "ready"]);
    await f.pal.skills.configure(f.chat.conversationId, {
      ...info.settings,
      project: info.settings.project.map((root) => ({ ...root, enabled: false })),
    });
    info = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(info.current.catalog).toHaveLength(1);
    expect(info.current.catalog[0]?.state).toBe("ready");
    expect(info.current.roots.at(-1)?.state).toBe("disabled");
    await f.pal.skills.configure(f.chat.conversationId, { ...info.settings, disabled: ["SHARED"] });
    info = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(info.current.catalog[0]?.state).toBe("disabled");
    await f.reopen();
    expect((await f.pal.skills.inspect(f.chat.conversationId, context)).current.catalog[0]?.state).toBe("disabled");
  });

  it("refreshes create/delete and rejects escaped roots, source links and wrong-case package files", async () => {
    const f = await setup();
    const path = await skill(f.local, "temporary", "temporary");
    const before = await f.pal.skills.inspect(f.chat.conversationId, context);
    for (const name of ["   ", "ﬃ".repeat(80)])
      await expect(
        f.pal.skills.configure(f.chat.conversationId, { ...before.settings, disabled: [name] }),
      ).rejects.toMatchObject({ code: "skill_name" });
    expect((await f.pal.skills.settings(f.project.id)).revision).toBe(0);
    const item = before.current.catalog[0];
    if (item === undefined) throw new Error("missing temporary skill");
    await rm(path, { recursive: true });
    expect((await f.pal.skills.inspect(f.chat.conversationId, context)).current.catalog).toEqual([]);
    await expect(
      f.pal.skills.read(f.chat.conversationId, { id: item.id, revision: item.revision }, context),
    ).rejects.toMatchObject({ code: "skill_unavailable" });
    const outside = join(f.root, "outside-skills");
    await skill(outside, "escape", "escape", "OUTSIDE-SKILL-BODY");
    await symlink(outside, join(f.project.root, "escaped-skills"));
    await expect(
      f.pal.skills.configure(f.chat.conversationId, {
        ...before.settings,
        project: [{ path: "../outside-skills", enabled: true }],
      }),
    ).rejects.toMatchObject({ code: "skill_path" });
    await f.pal.skills.configure(f.chat.conversationId, {
      ...before.settings,
      project: [{ path: "escaped-skills", enabled: true }],
      global: [{ path: f.options.dataRoot, enabled: true }],
    });
    const blocked = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(blocked.current.catalog).toEqual([]);
    expect(blocked.current.roots.map((root) => root.state)).toEqual(["unavailable", "unavailable"]);
    await f.pal.skills.configure(f.chat.conversationId, {
      ...blocked.settings,
      global: [],
      project: [{ path: ".agents/skills", enabled: true }],
    });
    await symlink(join(outside, "escape"), join(f.local, "package-link"));
    await mkdir(join(f.local, "wrong-case"));
    await writeFile(
      join(f.local, "wrong-case", "skill.md"),
      "---\nname: wrong\ndescription: Wrong spelling\n---\nbody\n",
    );
    const invalid = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(invalid.current.catalog).toHaveLength(2);
    expect(invalid.current.catalog.every((entry) => entry.state === "invalid")).toBe(true);
    expect((await f.run()).system[0]).not.toContain("OUTSIDE-SKILL-BODY");
  });

  it("atomically fences settings and selection races and never reinjects disabled or removed choices", async () => {
    const f = await setup();
    const path = await skill(f.local, "choice", "choice", "CHOSEN-BODY");
    const initial = await f.pal.skills.inspect(f.chat.conversationId, context);
    const item = initial.current.catalog[0];
    if (item === undefined) throw new Error("missing choice");
    const selection = { revision: 0, skills: [{ id: item.id, revision: item.revision }] };
    const choices = await Promise.allSettled([
      f.pal.skills.select(f.chat.conversationId, selection, context),
      f.pal.skills.select(f.chat.conversationId, selection, context),
    ]);
    expect(choices.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(choices.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "skill_selection_stale" },
    });
    expect((await f.run()).system[0]).toContain("CHOSEN-BODY");
    const settings = await Promise.allSettled([
      f.pal.skills.configure(f.chat.conversationId, { ...initial.settings, disabled: ["choice"] }),
      f.pal.skills.configure(f.chat.conversationId, { ...initial.settings, disabled: ["choice"] }),
    ]);
    expect(settings.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settings.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "skills_stale" } });
    expect((await f.run()).system[0]).not.toContain("CHOSEN-BODY");
    const disabled = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(disabled.current.selected[0]).toMatchObject({ state: "unavailable", text: null });
    await f.pal.skills.select(f.chat.conversationId, { revision: 1, skills: [] }, context);
    await rm(path, { recursive: true });
    await f.reopen();
    const removed = await f.pal.skills.inspect(f.chat.conversationId, context);
    expect(removed.selection.items).toEqual([]);
    expect(removed.current.catalog).toEqual([]);
    expect((await f.run()).system[0]).not.toContain("CHOSEN-BODY");
  });

  it.each(["edit", "delete"] as const)(
    "replays exact journaled skill bytes after SIGKILL and a source %s",
    async (change) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "pal-skills-replay-")));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const data = join(root, "data"),
        home = join(root, "Host user 界");
      const path = await skill(join(home, ".agents", "skills"), "replay 界", "replay", "ORIGINAL-REPLAY-BODY");
      const seen = Promise.withResolvers<undefined>();
      const requests: string[] = [];
      const server = createServer((request) => {
        requests.push(`${request.method} ${request.url}`);
        seen.resolve(undefined);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const fixture = join(import.meta.dirname, "fixtures", "skills-child.ts");
      const child = spawn(process.execPath, [fixture, "start", data, home, url], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let errors = "";
      child.stderr.on("data", (chunk) => {
        errors = (errors + String(chunk)).slice(-65536);
      });
      const exited = once(child, "exit");
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      });
      await Promise.race([
        seen.promise,
        exited.then(([code]) => {
          throw new Error(`Replay fixture exited ${code}: ${errors}`);
        }),
      ]);
      expect(requests).toEqual(["POST /?bodyReads=1"]);
      child.kill("SIGKILL");
      await exited;
      if (change === "edit") await skill(join(home, ".agents", "skills"), "replay 界", "replay", "CHANGED-REPLAY-BODY");
      else await rm(path, { recursive: true });
      const resumed = await promisify(execFile)(process.execPath, [fixture, "resume", data, home, url], {
        timeout: 10000,
        maxBuffer: 65536,
      });
      let result: unknown;
      try {
        result = JSON.parse(resumed.stdout);
      } catch (error) {
        throw new Error(`Invalid replay fixture output: ${resumed.stdout}`, { cause: error });
      }
      expect(result).toMatchObject({
        bodyReads: 0,
        results: [{ isError: false, text: expect.stringContaining("ORIGINAL-REPLAY-BODY") }],
      });
      expect(JSON.stringify(result)).not.toContain("CHANGED-REPLAY-BODY");
      expect(requests).toEqual(["POST /?bodyReads=1"]);
    },
  );

  it("lets Code Mode page a complete large skill without raising its output cap", async () => {
    const f = await setup();
    const text = "LARGE-SKILL-START " + "x".repeat(29000) + " LARGE-SKILL-END";
    await skill(f.local, "large", "large", text);
    const item = (await f.pal.skills.inspect(f.chat.conversationId, context)).current.catalog[0];
    if (item === undefined) throw new Error("missing large skill");
    const result = await f.run([
      `const value = JSON.parse(await tools.skills_read(${JSON.stringify({ id: item.id, revision: item.revision })})); store("largeSkill", value); return value.text.slice(0, 10000);`,
      'return load("largeSkill").text.slice(10000, 20000);',
      'return load("largeSkill").text.slice(20000);',
    ]);
    expect(result.system[0]).not.toContain("LARGE-SKILL-START");
    expect(result.results).toContain("LARGE-SKILL-START");
    expect(result.results).toContain("LARGE-SKILL-END");
    expect(result.results).not.toContain('"isError":true');
  });

  it("bounds selected bodies and references while retaining a recoverable prior selection", async () => {
    const f = await setup();
    for (const name of ["one", "two"]) await skill(f.local, name, name, "x".repeat(20000));
    const info = await f.pal.skills.inspect(f.chat.conversationId, context);
    await expect(
      f.pal.skills.select(
        f.chat.conversationId,
        { revision: 0, skills: info.current.catalog.map(({ id, revision }) => ({ id, revision })) },
        context,
      ),
    ).rejects.toMatchObject({ code: "skill_limit" });
    expect((await f.pal.skills.inspect(f.chat.conversationId, context)).selection.revision).toBe(0);
    const item = info.current.catalog[0];
    if (item === undefined) throw new Error("missing choice");
    const reference = join(f.local, "one", "huge.txt");
    await writeFile(reference, "x".repeat(40000));
    await expect(
      f.pal.skills.read(
        f.chat.conversationId,
        { id: item.id, revision: item.revision, reference: "huge.txt" },
        context,
      ),
    ).rejects.toBeDefined();
    await writeFile(reference, Buffer.from([0xff, 0x00]));
    await expect(
      f.pal.skills.read(
        f.chat.conversationId,
        { id: item.id, revision: item.revision, reference: "huge.txt" },
        context,
      ),
    ).rejects.toBeDefined();
  });
});
