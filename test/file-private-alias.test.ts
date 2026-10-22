import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { openPal } from "../src/core/app.ts";
import { fileTools } from "../src/core/files.ts";
import { PrivateFiles } from "../src/core/file-policy.ts";
import { ProjectSearch } from "../src/core/search.ts";
import { runGit } from "../src/core/git.ts";
import { openStore } from "../src/storage/store.ts";

it.each(["private", "ordinary"])("enforces file-read policy for a %s hardlink", async (kind) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-file-alias-")));
  try {
    const data = join(root, "private");
    const project = join(root, "project");
    await mkdir(data);
    await mkdir(project);
    const source = kind === "private" ? join(data, "credentials.key") : join(project, "source.txt");
    const value = kind === "private" ? "fixture-only-key".padEnd(32, "!") : "ordinary workspace text";
    await writeFile(source, value, { mode: 0o600 });
    await link(source, join(project, "alias.txt"));
    const extension = fileTools({
      root: async () => project,
      deny: [data],
      privateFiles: await PrivateFiles.open([join(data, "credentials.key")]),
    });
    const read = extension.tools?.find((tool) => tool.name === "files_read") as ToolRegistration;
    const api = { conversationId: 1 as ConversationId } as ToolExecutionApi;
    const result = read.execute({ path: "alias.txt" } as never, api, context);
    if (kind === "private") await expect(result).rejects.toThrow(/protected|private|Pal/);
    else {
      const text = (await result).output?.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      expect(text).toContain(value);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["files_read", "files_search"])(
  "%s retains exclusive database ownership after an alias attempt",
  async (name) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-private-database-alias-")));
    const data = join(root, "data");
    const project = join(root, "project");
    await mkdir(project);
    const store = await openStore(data);
    const privateFiles = await PrivateFiles.open([store.path, `${store.path}-wal`, `${store.path}-shm`]);
    const search = new ProjectSearch([data], privateFiles);
    try {
      await link(store.path, join(project, "alias.txt"));
      const module = pathToFileURL(join(import.meta.dirname, "../src/storage/store.ts")).href;
      const stillOwned = () =>
        expect(
          promisify(execFile)(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              `import { openStore } from ${JSON.stringify(module)}; await (await openStore(${JSON.stringify(data)})).close();`,
            ],
            { timeout: 10_000 },
          ),
        ).rejects.toThrow(/DatabaseOwnedError/);
      await stillOwned();
      const tool = fileTools({ root: async () => project, deny: [data], privateFiles, search }).tools?.find(
        (tool) => tool.name === name,
      ) as ToolRegistration;
      const result = tool.execute(
        { path: "alias.txt", query: "private-database-fixture", mode: "text" } as never,
        { conversationId: 1 as ConversationId } as ToolExecutionApi,
        context,
      );
      if (name === "files_read") await expect(result).rejects.toThrow(/protected|private|Pal/);
      else await result;
      await stillOwned();
    } finally {
      await search.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("retains moved private identities and protects replacements from reads and mutations", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-private-identities-")));
  try {
    const data = join(root, "data");
    const project = join(root, "project");
    await mkdir(data);
    await mkdir(project);
    const key = join(data, "credentials.key");
    const saved = join(data, "saved-key");
    await writeFile(key, "startup fixture key");
    const privateFiles = await PrivateFiles.open([key]);
    await link(key, join(project, "old.txt"));
    await rename(key, saved);
    await writeFile(key, "replacement fixture key");
    await link(key, join(project, "new.txt"));
    const extension = fileTools({ root: async () => project, deny: [data], privateFiles });
    const api = { conversationId: 1 as ConversationId } as ToolExecutionApi;
    for (const [path, value] of [
      ["old.txt", "startup fixture key"],
      ["new.txt", "replacement fixture key"],
    ] as const) {
      for (const name of ["files_read", "files_write", "files_edit"]) {
        const tool = extension.tools?.find((tool) => tool.name === name) as ToolRegistration;
        await expect(
          tool.execute(
            {
              path,
              content: "must not write",
              edits: [{ oldText: value, newText: "must not edit" }],
              expectedHash: createHash("sha256").update(value).digest("hex"),
            } as never,
            api,
            context,
          ),
        ).rejects.toThrow(/protected|private|Pal/);
      }
    }
    expect(await readFile(saved, "utf8")).toBe("startup fixture key");
    expect(await readFile(key, "utf8")).toBe("replacement fixture key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ["files_read", "private"],
  ["files_search", "private"],
  ["files_read", "ordinary"],
  ["files_search", "ordinary"],
])("native %s enforces %s hardlink policy", async (tool, kind) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-private-alias-runtime-")));
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  await mkdir(data);
  await mkdir(workspace);
  const canary = "fixture-only-key".padEnd(32, "!");
  const ordinary = "fixture public text";
  await writeFile(join(data, "credentials.key"), canary, { mode: 0o600 });
  const source = kind === "private" ? join(data, "credentials.key") : join(workspace, "source.txt");
  if (kind === "ordinary") await writeFile(source, ordinary);
  await link(source, join(workspace, "alias.txt"));
  const pal = await openPal(
    { dataRoot: data, installRoot: join(root, "install"), guidanceHome: join(root, "guidance") },
    context,
  );
  try {
    const faux = fauxProvider();
    (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
    const model = faux.getModel();
    const project = await pal.projects.create("alias-project", { name: "Fixture", folder: workspace });
    const chat = await pal.chats.createChat("alias-chat", { projectId: project.id, title: "Fixture" }, context);
    await pal.chats.configure(
      chat.id,
      { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" },
      context,
    );
    let observed = "";
    const code =
      tool === "files_read"
        ? 'return await tools.files_read({path:"alias.txt"});'
        : 'return await tools.files_search({query:"fixture",mode:"text"});';
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
      (request) => {
        observed = JSON.stringify(request.messages);
        return fauxAssistantMessage("Done");
      },
    ]);
    await pal.chats.submit(chat.id, "alias-input", { text: "Read alias.txt." }, context);
    const conversation = await pal.harness.conversation(chat.conversationId, context);
    if (conversation === undefined) throw new Error("missing fixture conversation");
    await conversation.waitForIdle(context);
    expect(faux.state.callCount).toBe(2);
    expect(observed.includes(canary)).toBe(false);
    if (kind === "ordinary") expect(observed.includes(ordinary)).toBe(true);
  } finally {
    await pal.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["preview", "changes", "memory-save", "memory-source"])(
  "protects private aliases in %s observations",
  async (surface) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-private-observations-")));
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    await mkdir(data);
    await mkdir(workspace);
    const canary = "fixture-only-key".padEnd(32, "!");
    const key = join(data, "credentials.key");
    const alias = join(workspace, "alias.txt");
    await writeFile(key, canary, { mode: 0o600 });
    await runGit(workspace, ["init", "-q"], { signal: AbortSignal.timeout(10_000) });
    const pal = await openPal(
      { dataRoot: data, installRoot: join(root, "install"), guidanceHome: join(root, "guidance") },
      context,
    );
    try {
      const project = await pal.projects.create("observations-project", { name: "Fixture", folder: workspace });
      const source = (value: string) => ({
        kind: "file" as const,
        folder: "primary",
        path: "alias.txt",
        sha256: createHash("sha256").update(value).digest("hex"),
      });
      const note = { title: "Fixture", body: "Public fixture note", source: source(canary) };
      if (surface === "memory-source") {
        await writeFile(alias, "public fixture");
        const id = await pal.memory.save(
          project.id,
          "public-note",
          { ...note, source: source("public fixture") },
          context,
        );
        await unlink(alias);
        await link(key, alias);
        await expect(pal.memory.source(project.id, id, context)).rejects.toThrow(/protected|private|Pal/);
        expect(await pal.memory.list(project.id, context)).toEqual([]);
      } else {
        await link(key, alias);
        if (surface === "preview")
          await expect(pal.files.preview(project.id, "alias.txt")).rejects.toThrow(/protected|private|Pal/);
        else if (surface === "changes") {
          const result = await pal.changes.list(project.id);
          expect(JSON.stringify(result).includes(canary)).toBe(false);
          expect(result.files.find((file) => file.path === "alias.txt")).toMatchObject({
            patch: "",
            problem: expect.any(String),
          });
        } else await expect(pal.memory.save(project.id, "private-note", note, context)).rejects.toThrow();
      }
    } finally {
      await pal.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("does not expose private matches through search pagination", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-private-search-pages-")));
  let search: ProjectSearch | undefined;
  try {
    const data = join(root, "private");
    const project = join(root, "project");
    await mkdir(data);
    await mkdir(project);
    const paths: string[] = [];
    for (let i = 0; i < 75; i++) {
      const path = join(data, `key-${i}`);
      await writeFile(path, `fixture private object ${i}`, { mode: 0o600 });
      await link(path, join(project, `alias-${i}.txt`));
      paths.push(path);
    }
    await writeFile(join(project, "public.txt"), "fixture public text");
    search = new ProjectSearch([data], await PrivateFiles.open(paths));
    const result = await search.search(project, "fixture", "text");
    expect(result.hits).toMatchObject([{ path: "public.txt", line: 1, text: "fixture public text" }]);
    expect(result.hits).toHaveLength(1);
    expect(result.truncated).toBe(false);
  } finally {
    await search?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("validates native CRLF and long-line previews at their byte offsets", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-search-snippets-")));
  let search: ProjectSearch | undefined;
  try {
    await writeFile(join(root, "crlf.txt"), "head\r\nneedle 🌱 end\r\n");
    await writeFile(join(root, "long.txt"), `${"x".repeat(10000)} needle tail\r\n`);
    search = new ProjectSearch([], await PrivateFiles.open([]));
    const result = await search.search(root, "needle", "text");
    expect(result.hits.find((hit) => hit.path === "crlf.txt")).toMatchObject({
      line: 2,
      text: "needle 🌱 end",
      ranges: [[0, 6]],
    });
    expect(result.hits.find((hit) => hit.path === "long.txt")).toMatchObject({ line: 1, text: "x".repeat(300) });
    expect(result.truncated).toBe(false);
  } finally {
    await search?.close();
    await rm(root, { recursive: true, force: true });
  }
});
