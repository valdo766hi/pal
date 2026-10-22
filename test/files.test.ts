import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { fileTools } from "../src/core/files.ts";
import { PrivateFiles } from "../src/core/file-policy.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A home-like folder holding Pal's data, a project inside it, and a secret outside the project. */
async function setup(root: "home" | "managed" = "home") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pal-files-test-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const dataRoot = join(home, ".local", "share", "pal");
  await mkdir(join(dataRoot, "projects", "p1", "workspace"), { recursive: true });
  await writeFile(join(dataRoot, "credentials.key"), "master key bytes");
  await writeFile(join(dataRoot, "projects", "p1", "workspace", "notes.md"), "managed notes\n");
  await mkdir(join(home, "repo", ".git"), { recursive: true });
  await mkdir(join(home, "repo", "src"), { recursive: true });
  await writeFile(join(home, "repo", "src", "main.ts"), "one\ntwo\nthree\nfour\n");
  await writeFile(join(home, "repo", "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await writeFile(join(home, "repo", ".git", "config"), "[core]\n");
  await writeFile(join(home, "secret.txt"), "not for the model");
  await symlink(join(home, "secret.txt"), join(home, "repo", "escape.txt"));
  const projectRoot = root === "home" ? home : join(dataRoot, "projects", "p1", "workspace");
  const privateFiles = await PrivateFiles.open([join(dataRoot, "credentials.key")]);
  const extension = fileTools({ root: async () => projectRoot, deny: [dataRoot], privateFiles });
  const tools = Object.fromEntries((extension.tools ?? []).map((tool) => [tool.name, tool]));
  const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools[name] as ToolRegistration;
    // The tools read only the calling conversation from their API.
    const api = { conversationId: 1 as ConversationId } as ToolExecutionApi;
    const result = await tool.execute(args as never, api, context);
    return result.output?.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
  };
  return { home, dataRoot, run };
}

describe("project file tools", () => {
  it("list, read by lines and find inside the project folder", async () => {
    const { run } = await setup();
    expect(await run("files_list", { path: "repo" })).toBe(".git/\nsrc/\nescape.txt\nimage.bin  4 bytes");
    expect(await run("files_read", { path: "repo/src/main.ts", offset: 2, limit: 2 })).toContain("2\ttwo\n3\tthree");
    expect(await run("files_read", { path: "repo/image.bin" })).toBe("repo/image.bin is a binary file of 4 bytes.");
    const found = await run("files_find", { query: "main" });
    expect(found).toBe("repo/src/main.ts");
    // Searches skip .git contents.
    expect(await run("files_find", { query: "config" })).toBe("No matches.");
  });

  it("refuses paths outside the folder, including through symlinks", async () => {
    const { run } = await setup("managed");
    expect(await run("files_read", { path: "notes.md" })).toContain("1\tmanaged notes\n2\t");
    await expect(run("files_read", { path: "../../../credentials.key" })).rejects.toThrow(/outside the project folder/);
    await expect(run("files_read", { path: "/etc/hosts" })).rejects.toThrow(/relative/);
  });

  it("follows a symlink only when its target stays inside the project", async () => {
    const { home, run } = await setup();
    // The home-folder project contains the link's target, so this read is inside it.
    expect(await run("files_read", { path: "repo/escape.txt" })).toContain("1\tnot for the model");
    const narrow = fileTools({
      root: async () => join(home, "repo"),
      deny: [],
      privateFiles: await PrivateFiles.open([]),
    });
    const read = (narrow.tools ?? []).find((tool) => tool.name === "files_read") as ToolRegistration;
    const api = { conversationId: 1 as ConversationId } as ToolExecutionApi;
    await expect(read.execute({ path: "escape.txt" } as never, api, context)).rejects.toThrow(
      /outside the project folder/,
    );
  });

  it("creates and edits text only against the expected original revision", async () => {
    const { home, run } = await setup();
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const original = "one\ntwo\nthree\nfour\n";
    expect(await run("files_read", { path: "repo/src/main.ts" })).toContain(`[sha256: ${digest(original)}]`);
    await run("files_edit", {
      path: "repo/src/main.ts",
      expectedHash: digest(original),
      edits: [
        { oldText: "one", newText: "ONE" },
        { oldText: "four", newText: "FOUR" },
      ],
    });
    expect(await readFile(join(home, "repo/src/main.ts"), "utf8")).toBe("ONE\ntwo\nthree\nFOUR\n");
    await expect(
      run("files_write", { path: "repo/src/main.ts", expectedHash: digest(original), content: "stale" }),
    ).rejects.toThrow(/changed/);
    await expect(
      run("files_write", { path: "repo/src/main.ts", expectedHash: null, content: "overwrite" }),
    ).rejects.toThrow(/changed/);
    await run("files_write", { path: "repo/new.txt", expectedHash: null, content: "new text" });
    expect(await readFile(join(home, "repo/new.txt"), "utf8")).toBe("new text");
    expect(await run("files_read", { path: "repo/new.txt" })).toContain(digest("new text"));
  });

  it("rejects ambiguous/overlapping edits and oversized writes without changing the file", async () => {
    const { home, run } = await setup();
    const original = "one\ntwo\nthree\nfour\n";
    const expectedHash = createHash("sha256").update(original).digest("hex");
    for (const edits of [
      [{ oldText: "o", newText: "x" }],
      [
        { oldText: "one", newText: "x" },
        { oldText: "one\ntwo", newText: "y" },
      ],
    ]) {
      await expect(run("files_edit", { path: "repo/src/main.ts", expectedHash, edits })).rejects.toThrow(
        /once|overlap/,
      );
    }
    await expect(
      run("files_write", { path: "repo/src/main.ts", expectedHash, content: "é".repeat(256 * 1024) }),
    ).rejects.toThrow(/256 KiB/);
    expect(await readFile(join(home, "repo/src/main.ts"), "utf8")).toBe(original);
  });

  it("denies writes through escaping links, to Pal data and to Git metadata", async () => {
    const { home, dataRoot, run } = await setup("managed");
    await expect(
      run("files_write", { path: "../../../credentials.key", expectedHash: null, content: "bad" }),
    ).rejects.toThrow(/outside/);
    expect(await readFile(join(dataRoot, "credentials.key"), "utf8")).toBe("master key bytes");
    const extension = fileTools({
      root: async () => join(home, "repo"),
      deny: [dataRoot],
      privateFiles: await PrivateFiles.open([join(dataRoot, "credentials.key")]),
    });
    const tool = extension.tools?.find((tool) => tool.name === "files_write") as ToolRegistration;
    const api = { conversationId: 1 as ConversationId } as ToolExecutionApi;
    await expect(
      tool.execute({ path: "escape.txt", expectedHash: null, content: "bad" } as never, api, context),
    ).rejects.toThrow(/outside/);
    await expect(
      tool.execute({ path: ".git/config", expectedHash: null, content: "bad" } as never, api, context),
    ).rejects.toThrow(/Git metadata/);
    expect(await readFile(join(home, "secret.txt"), "utf8")).toBe("not for the model");
  });

  it("hides and refuses Pal's own data inside a broader project folder", async () => {
    const { run } = await setup();
    expect(await run("files_list", { path: ".local/share" })).toBe("(empty folder)");
    await expect(run("files_read", { path: ".local/share/pal/credentials.key" })).rejects.toThrow(/Pal's own files/);
    expect(await run("files_find", { query: "credentials" })).toBe("No matches.");
  });
});
