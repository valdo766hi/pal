import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { commentFeedback } from "../src/core/feedback.ts";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpFixture } from "./fixtures/mcp-server.ts";
import { STDIO_FIXTURE } from "./fixtures/stdio-server.ts";
import { createApi } from "../src/core/api.ts";
import { openPal } from "../src/core/app.ts";
import { startServer } from "../src/core/server.ts";
import { browse, startOpenAIFixture } from "./fixtures/openai-server.ts";
import { fakeReleaseControl } from "./fixtures/releases.ts";
import type { ReleaseRpc } from "../src/core/release-rpc.ts";
import { MIGRATIONS } from "../src/storage/migrations.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(publicOrigin?: string, releases?: Pick<ReleaseRpc, "call">) {
  const fixture = await startOpenAIFixture();
  cleanups.push(fixture.close);
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-api-test-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install", endpoints: fixture.endpoints }, context);
  cleanups.push(() => pal.close());
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    version: "test",
    publicOrigin,
    api: createApi(pal, publicOrigin, releases),
  });
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let session = "";
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}/api/${path}`, {
      method,
      headers: {
        origin: base,
        cookie: session,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie !== null) session = cookie.split(";")[0] ?? "";
    // Responses are checked by the assertions; typing every shape here would only repeat them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { fixture, dataRoot, pal, base, api, cookie: () => session };
}

/** A raw request, for headers fetch will not let a test forge. */
function raw(
  base: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}${path}`,
      { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers } },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, cookies: response.headers["set-cookie"] ?? [] });
      },
    );
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not reached");
}

async function signedIn(publicOrigin?: string) {
  const app = await start(publicOrigin);
  await app.api("POST", "setup", { token: app.pal.owner.setupToken, passphrase: "correct horse battery" });
  return app;
}

async function fakeChatModel(pal: Awaited<ReturnType<typeof openPal>>, chatId: string) {
  const faux = fauxProvider();
  (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("ok")]);
  const model = faux.getModel();
  await pal.chats.configure(
    chatId,
    { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" },
    context,
  );
}

async function putBytes(base: string, cookie: string, id: string, bytes: Uint8Array) {
  const response = await fetch(`${base}/api/uploads/${id}`, {
    method: "PUT",
    headers: { origin: base, cookie, "content-type": "application/octet-stream" },
    body: new Uint8Array(bytes),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("API", () => {
  it("keeps release observation and exact-digest consent owner-only and validates before forwarding private IPC", async () => {
    const control = fakeReleaseControl();
    const { api, pal, base, cookie } = await start(undefined, control.access);
    const path = `releases/${control.digest}`;
    expect((await fetch(`${base}/api/releases`)).status).toBe(401);
    expect((await api("POST", `${path}/approve`, { acceptCodeTrust: true })).status).toBe(401);
    expect(control.calls).toEqual([]);
    await api("POST", "setup", { token: pal.owner.setupToken, passphrase: "correct horse battery" });
    expect((await api("GET", "releases")).body).toEqual({ available: false });
    control.enable();
    expect((await api("GET", "releases")).body.available).toBe(true);
    control.calls.length = 0;
    expect(
      (
        await fetch(`${base}/api/${path}/approve`, {
          method: "POST",
          headers: { cookie: cookie(), origin: "https://attacker.example", "content-type": "application/json" },
          body: JSON.stringify({ acceptCodeTrust: true }),
        })
      ).status,
    ).toBe(403);
    expect((await api("POST", `${path}/approve`, { acceptCodeTrust: false })).status).toBe(400);
    expect((await api("POST", `${path}/approve`, { acceptCodeTrust: true, digest: "0".repeat(64) })).status).toBe(400);
    expect((await api("POST", `${path}/activate`, { package: "/tmp/untrusted" })).status).toBe(400);
    expect((await api("POST", "releases/invalid/activate", {})).status).toBe(400);
    expect((await api("GET", `${path}/review`)).status).toBe(400);
    expect(control.calls).toEqual([]);
    const preview = await api("GET", `${path}/review?path=web%2Fsrc%2Fapp.css`);
    expect(preview.status).toBe(200);
    expect(preview.body.after.text).toContain("<img src=x");
    expect((await api("POST", `${path}/approve`, { acceptCodeTrust: true })).body.approved).toBe(control.digest);
    expect(control.calls.at(-1)).toEqual({ op: "approve", args: { digest: control.digest, acceptCodeTrust: true } });
    expect((await api("POST", `${path}/activate`, {})).status).toBe(202);
    expect(control.calls.at(-1)).toEqual({ op: "activate", args: { digest: control.digest } });
    expect((await api("POST", `releases/${control.previous}/rollback`, {})).status).toBe(202);
    expect(control.calls.at(-1)).toEqual({ op: "rollback", args: { digest: control.previous } });
  });

  it("does not offer activation authority from plain serve", async () => {
    const { api } = await signedIn();
    expect((await api("GET", "releases")).body).toEqual({ available: false });
    expect((await api("POST", `releases/${"0".repeat(64)}/activate`, {})).status).toBe(409);
  });

  it("protects pinned instructions and read-only prompt inspection with owner, origin, revision and budget checks", async () => {
    const { api, base, cookie, pal, fixture } = await signedIn();
    const project = await pal.projects.create("api-context-project", { name: "Context fixture" });
    const chat = await pal.chats.createChat("api-context-chat", { projectId: project.id }, context);
    const path = `chats/${chat.id}/context`;
    const input = { revision: 0, text: "Prefer concise source-linked answers." };
    expect((await fetch(`${base}/api/${path}/prompt`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/${path}/instructions`, {
          method: "PUT",
          headers: { origin: base, "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/${path}/instructions`, {
          method: "PUT",
          headers: { cookie: cookie(), origin: "https://attacker.example", "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(403);
    expect((await api("GET", `${path}/prompt`)).body.error).toBe("context_missing");
    expect((await api("GET", `${path}/prompt?offset=invalid`)).status).toBe(400);
    expect((await api("GET", `${path}/prompt?request=invalid`)).status).toBe(400);
    expect((await api("PUT", `${path}/instructions`, { ...input, trust: true })).status).toBe(400);
    expect((await api("PUT", `${path}/instructions`, { ...input, text: "x".repeat(5251) })).body.error).toBe(
      "context_budget",
    );
    const before = (await api("GET", path)).body;
    expect(before.pinned).toMatchObject({ revision: 0, text: "", bytes: 0 });
    expect((await api("PUT", `${path}/instructions`, input)).status).toBe(200);
    expect((await api("PUT", `${path}/instructions`, input)).status).toBe(409);
    const after = (await api("GET", path)).body;
    expect(after.pinned).toMatchObject({ revision: 1, text: input.text });
    expect(after.instructions).toBe(before.instructions);
    expect(after.prepared).toBeNull();
    expect(fixture.apiRequests).toEqual([]);
    await pal.projects.remove(project.id);
    expect((await api("GET", `${path}/prompt`)).status).toBe(404);
    expect((await api("PUT", `${path}/instructions`, { revision: 1, text: "" })).status).toBe(404);
  });

  it("manages source-linked memory and a bounded Context inspector with owner/origin/revision checks", async () => {
    const { api, base, cookie, pal } = await signedIn();
    const project = (await api("POST", "projects", { requestId: "api-memory-project", name: "Context" })).body.project;
    const chat = (await api("POST", "chats", { requestId: "api-memory-chat", projectId: project.id })).body.chat;
    const path = `projects/${project.id}/memory`;
    const input = {
      title: "Journal",
      body: "Keep durable state in SQLite",
      source: { kind: "owner" },
      requestId: "api-memory-note",
    };
    expect((await fetch(`${base}/api/${path}`)).status).toBe(401);
    expect((await fetch(`${base}/api/chats/${chat.id}/context`)).status).toBe(401);
    expect(
      (await raw(base, `/api/${path}`, { cookie: cookie(), origin: "https://attacker.example" }, input)).status,
    ).toBe(403);
    const saved = await api("POST", path, input);
    expect(saved.status).toBe(200);
    expect((await api("POST", path, input)).body.id).toBe(saved.body.id);
    const item = `${path}/${saved.body.id}`;
    const listing = await api("GET", path);
    expect(listing.body.items).toMatchObject([{ revision: 1, body: input.body, state: "current" }]);
    expect((await api("GET", `${item}/source`)).body).toMatchObject({
      label: "Owner note",
      text: input.body,
      current: true,
    });
    const info = await api("GET", `chats/${chat.id}/context`);
    expect(info.body.instructions).toContain("You are Pal");
    expect(info.body).toMatchObject({ sources: [], lookups: [], head: null });
    const correction = { title: input.title, body: "Corrected SQLite decision", source: input.source, revision: 1 };
    expect((await api("PUT", item, correction)).status).toBe(200);
    expect((await api("PUT", item, correction)).status).toBe(409);
    expect(
      (await api("PUT", item, { ...correction, revision: 2, source: { kind: "owner", trusted: true } })).status,
    ).toBe(400);
    const other = (await api("POST", "projects", { requestId: "api-foreign-memory", name: "Foreign" })).body.project;
    expect((await api("GET", `projects/${other.id}/memory/${saved.body.id}/source`)).status).toBe(403);
    expect((await api("GET", `projects/${other.id}/memory`)).body.items).toEqual([]);
    expect((await api("GET", `${path}?workspace=`)).status).toBe(400);
    expect((await api("POST", `projects/${project.id}/memory-index`)).status).toBe(200);
    expect((await api("DELETE", item, { revision: 1 })).status).toBe(409);
    expect((await api("DELETE", item, { revision: 2 })).status).toBe(200);
    expect((await api("GET", path)).body.items).toEqual([]);
    expect((await api("GET", `${item}/source`)).status).toBe(403);
    await pal.projects.remove(project.id);
    expect((await api("GET", path)).status).toBe(403);
    expect((await api("GET", `chats/${chat.id}/context`)).status).toBe(404);
  });

  it("requires owner/origin and exact local-program consent without executing on save, approval or missing key", async () => {
    const { api, base, cookie } = await signedIn();
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pal-api-program-")));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const marker = join(cwd, "starts");
    const code = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "start\\n");\n${STDIO_FIXTURE}`;
    const input = {
      transport: "stdio",
      name: "Local API fixture",
      command: process.execPath,
      args: ["-e", code],
      cwd,
      auth: { kind: "env", variable: "LOCAL_API_TOKEN" },
    };
    expect((await api("POST", "mcp/servers", { ...input, approved: true })).status).toBe(400);
    const saved = await api("POST", "mcp/servers", input);
    expect(saved.status).toBe(200);
    expect(saved.body.server).toMatchObject({ enabled: false, state: "approval_required" });
    const server = saved.body.server;
    const path = `mcp/servers/${server.id}`;
    expect((await api("POST", `${path}/test`)).body.server.state).toBe("approval_required");
    expect((await api("PUT", `${path}/enabled`, { enabled: true })).status).toBe(400);
    await expect(readFile(marker)).rejects.toThrow();
    expect((await api("PUT", `${path}/program`, { digest: "0".repeat(64), approved: true })).status).toBe(409);
    const approval = { digest: server.stdio.digest, approved: true };
    expect(
      (
        await fetch(`${base}/api/${path}/program`, {
          method: "PUT",
          headers: { origin: base, "content-type": "application/json" },
          body: JSON.stringify(approval),
        })
      ).status,
    ).toBe(401);
    expect(
      (await raw(base, `/api/${path}/program`, { cookie: cookie(), origin: "https://attacker.example" }, approval))
        .status,
    ).toBe(403);
    expect((await api("PUT", `${path}/program`, approval)).body.server.state).toBe("key_required");
    expect((await api("POST", `${path}/test`)).body.server.state).toBe("key_required");
    await expect(readFile(marker)).rejects.toThrow();
    const key = "fixture-local-api-key";
    expect((await api("PUT", `${path}/key`, { key })).status).toBe(200);
    const tested = await api("POST", `${path}/test`);
    expect(tested.body.server).toMatchObject({ state: "ready", tools: [{ name: "inspect", approved: false }] });
    expect(await readFile(marker, "utf8")).toBe("start\n");
    expect(JSON.stringify((await api("GET", "mcp")).body)).not.toContain(key);
    expect(
      (await api("PUT", `${path}/tools`, { tools: ["inspect"], catalog: tested.body.server.catalog })).status,
    ).toBe(200);
    expect((await api("PUT", `${path}/enabled`, { enabled: true })).status).toBe(200);
    const revoked = await api("PUT", `${path}/program`, { ...approval, approved: false });
    expect(revoked.body.server).toMatchObject({ enabled: false, state: "approval_required", tools: [] });
    expect((await api("DELETE", path)).status).toBe(200);
    expect((await api("PUT", `${path}/program`, approval)).status).toBe(400);
    expect(await readFile(marker, "utf8")).toBe("start\n");
  });

  it("creates immutable worktree/read-only chats and scopes every owner panel to the authenticated working directory", async () => {
    const { api, pal, base, cookie } = await signedIn();
    const project = (await api("POST", "projects", { requestId: "worktree-project", name: "Worktrees" })).body.project;
    const git = (...args: string[]) =>
      promisify(execFile)(
        "git",
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
        { cwd: project.root },
      );
    await git("init", "-q");
    await writeFile(join(project.root, "base.txt"), "committed needle\n");
    await git("add", "base.txt");
    await git("commit", "-qm", "base");
    expect(
      (await api("POST", "chats", { requestId: "bad-workspace", projectId: project.id, workspace: "yolo" })).status,
    ).toBe(400);
    const body = { requestId: "worktree-chat", projectId: project.id, workspace: "worktree" };
    const created = await api("POST", "chats", body);
    expect(created.status).toBe(200);
    const chat = created.body.chat;
    expect(chat.workspace, JSON.stringify(chat.workspace)).toMatchObject({
      mode: "worktree",
      state: "ready",
      source: project.root,
    });
    expect(chat.workspace.root).not.toBe(project.root);
    expect((await api("POST", "chats", body)).body.chat).toEqual(chat);
    expect((await api("POST", "chats", { ...body, workspace: "local" })).status).toBe(409);
    expect((await api("GET", `chats/${chat.id}`)).body.chat).toEqual(chat);
    expect((await api("GET", "projects")).body.projects[0].chats[0].workspace).toEqual(chat.workspace);
    const path = `projects/${project.id}`;
    const query = `workspace=${chat.workspace.id}`;
    await writeFile(join(project.root, "base.txt"), "source-only needle\n");
    expect((await api("GET", `${path}/file?path=base.txt&${query}`)).body.text).toBe("committed needle\n");
    expect((await api("GET", `${path}/file?path=base.txt`)).body.text).toBe("source-only needle\n");
    expect(
      (await api("GET", `${path}/files?${query}`)).body.entries.map((entry: { name: string }) => entry.name),
    ).toEqual([".git", "base.txt"]);
    expect((await api("GET", `${path}/folders?${query}`)).body.folders[0].root).toBe(chat.workspace.root);
    expect((await api("GET", `${path}/search?q=source-only&${query}`)).body.hits).toEqual([]);
    await writeFile(join(chat.workspace.root, "base.txt"), "worktree-only needle\n");
    const changes = (await api("GET", `${path}/changes?${query}`)).body;
    expect(changes.base).toBe(chat.workspace.base);
    const file = changes.files[0];
    const review = { path: "base.txt", revision: file.revision, workspace: chat.workspace.id };
    expect((await api("PUT", `${path}/review`, { ...review, reviewed: true })).status).toBe(200);
    const comment = (await api("POST", `${path}/comments`, { ...review, line: 1, body: "Isolated review" })).body
      .comment;
    expect(
      (await api("POST", `${path}/comments/sent`, { ids: [comment.id], workspace: chat.workspace.id })).status,
    ).toBe(404);
    expect((await api("GET", `${path}/changes?${query}`)).body.comments[0].sent).toBe(false);
    await fakeChatModel(pal, chat.id);
    expect(
      (
        await api("POST", `chats/${chat.id}/inputs`, {
          requestId: "worktree-feedback-input",
          text: commentFeedback(comment),
          feedback: { ids: [comment.id], scope: "normal" },
        })
      ).status,
    ).toBe(200);
    await pal.harness.waitForIdle(context);
    expect((await api("GET", `${path}/changes`)).body.comments).toEqual([]);
    expect((await api("GET", `${path}/changes?${query}`)).body.comments[0].sent).toBe(true);
    expect((await api("POST", `${path}/discard`, review)).status).toBe(200);
    expect(await readFile(join(project.root, "base.txt"), "utf8")).toBe("source-only needle\n");
    expect(await readFile(join(chat.workspace.root, "base.txt"), "utf8")).toBe("committed needle\n");
    expect((await api("GET", `${path}/changes?workspace=`)).status).toBe(400);
    const other = (await api("POST", "projects", { requestId: "other-workspace-project", name: "Other" })).body.project;
    for (const suffix of [
      `file?path=base.txt&${query}`,
      `files?${query}`,
      `folders?${query}`,
      `search?q=needle&${query}`,
      `changes?${query}`,
    ])
      expect((await api("GET", `projects/${other.id}/${suffix}`)).status).toBe(403);
    expect((await api("PUT", `projects/${other.id}/review`, { ...review, reviewed: true })).status).toBe(403);
    expect(
      (
        await api("POST", `projects/${other.id}/terminals`, {
          cols: 80,
          rows: 24,
          trust: true,
          workspace: chat.workspace.id,
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${base}/api/${path}/files?${query}`)).status).toBe(401);
    expect(
      (await raw(base, `/api/chats/${chat.id}/workspace`, { cookie: cookie(), origin: "https://attacker.example" }, {}))
        .status,
    ).toBe(403);
    const readonly = (
      await api("POST", "chats", { requestId: "readonly-workspace", projectId: project.id, workspace: "read-only" })
    ).body.chat;
    expect(readonly.workspace).toMatchObject({ mode: "read-only", root: project.root, state: "ready" });
    expect((await api("GET", `${path}/folders?workspace=${readonly.workspace.id}`)).body.folders[0].access).toBe(
      "read",
    );
    const terminal = await api("POST", `${path}/terminals`, {
      cols: 80,
      rows: 24,
      trust: true,
      workspace: chat.workspace.id,
    });
    expect(terminal.body.terminal.cwd).toBe(chat.workspace.root);
    await api("DELETE", `${path}/terminals/${terminal.body.terminal.id}`);
    await api("DELETE", `chats/${chat.id}`);
    expect((await api("GET", `${path}/files?${query}`)).status).toBe(403);
    expect((await api("POST", `chats/${chat.id}/workspace`, {})).status).toBe(404);
    expect(await readFile(join(chat.workspace.root, "base.txt"), "utf8")).toBe("committed needle\n");
    expect(pal.chats.stopped).toBe(false);
  });

  it("requires explicit owner opt-in to review ignored files and hides their retained comment excerpts by default", async () => {
    const { api, pal, base, cookie } = await signedIn();
    const project = (await api("POST", "projects", { requestId: "ignored-project", name: "Ignored review" })).body
      .project;
    await promisify(execFile)("git", ["init", "-q"], { cwd: project.root });
    await writeFile(join(project.root, ".gitignore"), "*.secret\n");
    await writeFile(join(project.root, "local.secret"), "private fixture line\n");
    const path = `projects/${project.id}`;
    expect(JSON.stringify((await api("GET", `${path}/changes`)).body)).not.toContain("private fixture line");
    const included = await api("GET", `${path}/changes?scope=include-ignored`);
    const file = included.body.files.find((file: { path: string }) => file.path === "local.secret");
    expect(file).toMatchObject({ ignored: true, patch: expect.stringContaining("private fixture line") });
    expect((await api("GET", `${path}/changes?scope=all`)).status).toBe(400);
    const review = { path: file.path, revision: file.revision, reviewed: true };
    expect((await api("PUT", `${path}/review`, review)).status).toBe(403);
    expect((await api("POST", `${path}/discard`, { path: file.path, revision: file.revision })).status).toBe(403);
    const comment = { path: file.path, revision: file.revision, line: 1, body: "Check fixture" };
    expect((await api("POST", `${path}/comments`, comment)).status).toBe(403);
    expect((await api("PUT", `${path}/review`, { ...review, scope: "include-ignored" })).status).toBe(200);
    const added = await api("POST", `${path}/comments`, { ...comment, scope: "include-ignored" });
    expect(added.status).toBe(200);
    expect((await api("GET", `${path}/changes`)).body.comments).toEqual([]);
    expect((await api("GET", `${path}/changes?scope=include-ignored`)).body.comments).toHaveLength(1);
    expect((await api("POST", `${path}/comments/sent`, { ids: [added.body.comment.id] })).status).toBe(404);
    const chat = (await api("POST", "chats", { requestId: "ignored-feedback-chat", projectId: project.id })).body.chat;
    await fakeChatModel(pal, chat.id);
    const input = { requestId: "ignored-feedback-input", text: commentFeedback(added.body.comment) };
    expect(
      (
        await api("POST", `chats/${chat.id}/inputs`, {
          ...input,
          feedback: { ids: [added.body.comment.id], scope: "normal" },
        })
      ).status,
    ).toBe(403);
    expect((await api("GET", `${path}/changes?scope=include-ignored`)).body.comments[0].sent).toBe(false);
    expect(await pal.store.database.get("SELECT count(*) AS n FROM pal_admissions WHERE chat_id = ?", chat.id)).toEqual(
      { n: 0 },
    );
    expect(
      (
        await api("POST", `chats/${chat.id}/inputs`, {
          ...input,
          feedback: { ids: [added.body.comment.id], scope: "include-ignored" },
        })
      ).status,
    ).toBe(200);
    await pal.harness.waitForIdle(context);
    expect((await api("GET", `${path}/changes?scope=include-ignored`)).body.comments[0].sent).toBe(true);
    expect((await fetch(`${base}/api/${path}/changes?scope=include-ignored`)).status).toBe(401);
    expect(
      (
        await raw(
          base,
          `/api/${path}/comments`,
          { cookie: cookie(), origin: "https://attacker.example" },
          { ...comment, scope: "include-ignored" },
        )
      ).status,
    ).toBe(403);
    await writeFile(join(project.root, "local.secret"), "newer private fixture\n");
    expect(
      (await api("POST", `${path}/discard`, { path: file.path, revision: file.revision, scope: "include-ignored" }))
        .status,
    ).toBe(409);
    expect(await readFile(join(project.root, "local.secret"), "utf8")).toBe("newer private fixture\n");
    expect(pal.chats.stopped).toBe(false);
  });

  it("requires owner/origin authority for reference grants and keeps access/indexing/project scopes separate", async () => {
    const { api, pal, base, cookie, dataRoot } = await signedIn();
    const external = await realpath(await mkdtemp(join(tmpdir(), "pal-reference-api-")));
    cleanups.push(() => rm(external, { recursive: true, force: true }));
    await writeFile(join(external, "guide.txt"), "reference needle");
    const project = (await api("POST", "projects", { requestId: "folders-project", name: "References" })).body.project;
    const other = (await api("POST", "projects", { requestId: "other-project", name: "Other" })).body.project;
    const path = `projects/${project.id}/folders`;
    const body = { requestId: "reference-request", folder: external, indexed: false };
    expect((await fetch(`${base}/api/${path}`)).status).toBe(401);
    expect(
      (await raw(base, `/api/${path}`, { cookie: cookie(), origin: "https://attacker.example" }, body)).status,
    ).toBe(403);
    for (const invalid of [
      { ...body, indexed: undefined },
      { ...body, access: "write" },
      { ...body, trust: true },
    ])
      expect((await api("POST", path, invalid)).status).toBe(400);
    expect((await api("POST", path, { ...body, folder: dataRoot })).status).toBe(422);
    const added = await api("POST", path, body);
    expect(added.status).toBe(200);
    const granted = added.body.folder;
    expect((await api("POST", path, body)).body.folder).toEqual(granted);
    expect((await api("GET", path)).body.folders).toHaveLength(2);
    const selected = `folder=${granted.id}`;
    expect((await api("GET", `projects/${project.id}/file?path=guide.txt&${selected}`)).body.text).toBe(
      "reference needle",
    );
    expect((await api("GET", `projects/${other.id}/file?path=guide.txt&${selected}`)).status).toBe(403);
    expect((await api("GET", `projects/${project.id}/file?path=../outside&${selected}`)).status).toBe(403);
    expect((await api("GET", `projects/${project.id}/search?q=needle&${selected}`)).status).toBe(403);
    expect(pal.search.size).toBe(0);
    expect((await api("DELETE", `${path}/${granted.id}`)).status).toBe(200);
    expect((await api("GET", `projects/${project.id}/file?path=guide.txt&${selected}`)).status).toBe(403);
    const indexed = (await api("POST", path, { ...body, requestId: "indexed-reference", indexed: true })).body.folder;
    expect(indexed.id).not.toBe(granted.id);
    const found = await api("GET", `projects/${project.id}/search?q=needle&folder=${indexed.id}`);
    expect(found.status).toBe(200);
    expect(found.body.hits).toMatchObject([{ path: "guide.txt" }]);
    expect(pal.search.size).toBe(1);
    await api("DELETE", `projects/${project.id}`);
    expect(pal.search.size).toBe(0);
    expect((await api("GET", path)).status).toBe(403);
    expect(await readFile(join(external, "guide.txt"), "utf8")).toBe("reference needle");
    await api("POST", "sign-out");
    expect((await api("POST", path, body)).status).toBe(401);
  });

  it("requires a separate owner-authorized request to delete a removed managed workspace", async () => {
    const { api, base, cookie, pal, dataRoot } = await signedIn();
    const project = (await api("POST", "projects", { requestId: "purge-project-api", name: "Cleanup" })).body.project;
    const chat = await pal.chats.createChat("purge-history-chat", { projectId: project.id }, context);
    const upload = (
      await api("POST", `projects/${project.id}/uploads`, { name: "note.txt", size: 4, type: "text/plain" })
    ).body.upload;
    expect((await putBytes(base, cookie(), upload.id, Buffer.from("kept"))).status).toBe(200);
    await writeFile(join(project.root, "keep-until-confirmed.txt"), "retained");
    expect((await api("GET", "removed-workspaces")).body.workspaces).toEqual([]);
    expect((await api("DELETE", `projects/${project.id}`)).status).toBe(200);
    expect(await readFile(join(project.root, "keep-until-confirmed.txt"), "utf8")).toBe("retained");
    const item = (await api("GET", "removed-workspaces")).body.workspaces[0];
    const body = { root: item.root, identity: item.identity };
    const path = `removed-workspaces/${project.id}/purge`;
    expect((await api("POST", path, {})).status).toBe(400);
    expect((await api("POST", path, { ...body, identity: "0:0:0:0" })).status).toBe(409);
    expect((await fetch(`${base}/api/removed-workspaces`)).status).toBe(401);
    expect((await fetch(`${base}/api/${path}`, { method: "POST", headers: { origin: base } })).status).toBe(401);
    expect(
      (await raw(base, `/api/${path}`, { cookie: cookie(), origin: "https://attacker.example" }, body)).status,
    ).toBe(403);
    expect(await readFile(join(project.root, "keep-until-confirmed.txt"), "utf8")).toBe("retained");
    expect((await api("POST", path, body)).status).toBe(200);
    expect(await stat(project.root).catch(() => undefined)).toBeUndefined();
    expect((await api("POST", path, body)).status).toBe(200);
    expect((await api("GET", "removed-workspaces")).body.workspaces).toEqual([]);
    expect(await pal.harness.conversation(chat.conversationId, context)).toBeDefined();
    expect(await readFile(join(dataRoot, "uploads", project.id, upload.id, "data"), "utf8")).toBe("kept");
  });

  it("renames only the title snapshot shown, preserving chat identity and enforcing owner authorization", async () => {
    const { api, pal, base, cookie } = await signedIn();
    const project = (await api("POST", "projects", { requestId: "rename-project-api", name: "Notes" })).body.project;
    const chat = (await api("POST", "chats", { requestId: "rename-chat-api", projectId: project.id })).body.chat;
    const path = `chats/${chat.id}/title`;
    const renamed = await api("PUT", path, { title: "  Renamed chat  ", expectedTitle: null });
    expect(renamed.status).toBe(200);
    expect(renamed.body.chat).toMatchObject({
      id: chat.id,
      conversationId: chat.conversationId,
      projectId: project.id,
      title: "Renamed chat",
    });
    expect((await api("PUT", path, { title: "Stale update", expectedTitle: null })).status).toBe(409);
    expect((await api("GET", `chats/${chat.id}`)).body.chat.title).toBe("Renamed chat");
    for (const title of ["", " ", "x".repeat(201)])
      expect((await api("PUT", path, { title, expectedTitle: "Renamed chat" })).status).toBe(400);
    expect(pal.chats.stopped).toBe(false);
    const crossOrigin = await fetch(`${base}/api/${path}`, {
      method: "PUT",
      headers: { origin: "https://attacker.example", cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ title: "Unapproved update", expectedTitle: "Renamed chat" }),
    });
    expect(crossOrigin.status).toBe(403);
    await api("DELETE", `projects/${project.id}`);
    expect((await api("PUT", path, { title: "Removed", expectedTitle: "Renamed chat" })).status).toBe(404);
    await api("POST", "sign-out");
    expect((await api("PUT", path, { title: "Signed out", expectedTitle: "Renamed chat" })).status).toBe(401);
  });

  it("bounds review comments and scopes their updates to an authenticated ready project", async () => {
    const { pal, api, base, cookie } = await signedIn();
    const project = (await api("POST", "projects", { requestId: "review-comments-api", name: "Review" })).body.project;
    await promisify(execFile)("git", ["init", "-q"], { cwd: project.root });
    await writeFile(join(project.root, "review.txt"), "line\n");
    const revision = (await api("GET", `projects/${project.id}/changes`)).body.files[0].revision;
    const body = { path: "review.txt", revision, line: 1, body: "Keep this line." };
    const created = await api("POST", `projects/${project.id}/comments`, body);
    expect(created.status).toBe(200);
    const id = created.body.comment.id;
    for (const invalid of [
      { ...body, line: 0 },
      { ...body, body: " " },
      { ...body, body: "x".repeat(4001) },
    ])
      expect((await api("POST", `projects/${project.id}/comments`, invalid)).status).toBe(400);
    expect((await api("POST", `projects/${project.id}/comments`, { ...body, path: "../outside" })).status).toBe(403);
    expect((await api("POST", `projects/${project.id}/comments`, { ...body, revision: "0".repeat(64) })).status).toBe(
      409,
    );
    const other = (await api("POST", "projects", { requestId: "other-comments-api", name: "Other" })).body.project;
    expect((await api("POST", `projects/${other.id}/comments/sent`, { ids: [id] })).status).toBe(404);
    await api("DELETE", `projects/${other.id}/comments/${id}`);
    expect((await api("GET", `projects/${project.id}/changes`)).body.comments).toHaveLength(1);
    expect((await api("GET", `projects/${project.id}/changes`)).body.comments[0].sent).toBe(false);
    const crossOrigin = await fetch(`${base}/api/projects/${project.id}/comments/sent`, {
      method: "POST",
      headers: { origin: "https://attacker.example", cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    });
    expect(crossOrigin.status).toBe(403);
    await api("DELETE", `projects/${project.id}`);
    expect((await api("POST", `projects/${project.id}/comments/sent`, { ids: [id] })).status).toBe(404);
    expect((await api("DELETE", `projects/${project.id}/comments/${id}`)).status).toBe(404);
    expect(await pal.store.database.get("SELECT sent_at FROM pal_change_comments WHERE id = ?", id)).toEqual({
      sent_at: null,
    });
    await api("POST", "sign-out");
    expect((await api("POST", `projects/${other.id}/comments`, body)).status).toBe(401);
  });

  it("persists per-project MCP narrowing and rejects stale or widening permission changes", async () => {
    const { api } = await signedIn();
    const a = (await api("POST", "projects", { requestId: "grant-project-a", name: "A" })).body.project;
    const b = (await api("POST", "projects", { requestId: "grant-project-b", name: "B" })).body.project;
    const first = await api("GET", `projects/${a.id}/mcp`);
    expect(first.status).toBe(200);
    const exa = first.body.servers.find((server: { id: string }) => server.id === "exa");
    expect(exa.mode).toBe("inherit");
    expect(
      (await api("PUT", `projects/${a.id}/mcp/exa`, { revision: exa.revision, mode: "subset", tools: [] })).status,
    ).toBe(200);
    expect(
      (await api("PUT", `projects/${a.id}/mcp/exa`, { revision: exa.revision, mode: "inherit", tools: [] })).status,
    ).toBe(409);
    expect(
      (await api("GET", `projects/${a.id}/mcp`)).body.servers.find((server: { id: string }) => server.id === "exa")
        .mode,
    ).toBe("subset");
    const other = (await api("GET", `projects/${b.id}/mcp`)).body.servers.find(
      (server: { id: string }) => server.id === "exa",
    );
    expect(other.mode).toBe("inherit");
    expect(
      (await api("PUT", `projects/${b.id}/mcp/exa`, { revision: other.revision, mode: "subset", tools: ["agent_run"] }))
        .status,
    ).toBe(400);
    await api("DELETE", `projects/${a.id}`);
    expect((await api("GET", `projects/${a.id}/mcp`)).status).toBe(404);
    await api("POST", "sign-out");
    expect((await api("GET", `projects/${b.id}/mcp`)).status).toBe(401);
  });
  it("answers only its own host and accepts writes only from its own origin", async () => {
    const { base, api } = await start();
    const port = new URL(base).port;
    expect((await raw(base, "/api/health", { host: `attacker.example:${port}` })).status).toBe(421);
    expect((await raw(base, "/api/health", { host: `localhost:${port}` })).status).toBe(200);
    const response = await fetch(`${base}/api/sign-in`, {
      method: "POST",
      headers: { origin: "http://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "x" }),
    });
    expect(response.status).toBe(403);
    expect((await api("GET", "projects")).status).toBe(401);
  });

  it.each(["description", "input", "output", "removed", "added"])(
    "rejects stale MCP catalog consent after a %s change without altering approvals",
    async (change) => {
      const { pal, api } = await signedIn();
      const fixture = await startMcpFixture();
      cleanups.push(fixture.close);
      const { server } = (
        await api("POST", "mcp/servers", {
          name: "Reviewed catalog",
          url: fixture.url,
          auth: { kind: "none" },
          private: true,
        })
      ).body;
      const path = `mcp/servers/${server.id}`;
      const a = (await api("POST", `${path}/test`)).body.server;
      expect((await api("PUT", `${path}/tools`, { tools: ["fetch"], catalog: a.catalog })).status).toBe(200);
      const before = await pal.store.database.get("SELECT approved FROM pal_mcp_servers WHERE id = ?", server.id);
      const search = fixture.state.tools[0];
      if (search === undefined) throw new Error("missing fixture tool");
      if (change === "description") search.description = "A changed search definition";
      if (change === "input") search.inputSchema.required = ["query", "scope"];
      if (change === "output" && search.outputSchema !== undefined)
        search.outputSchema.required = ["results", "source"];
      if (change === "removed") fixture.state.tools = fixture.state.tools.filter((tool) => tool.name !== "search");
      if (change === "added") fixture.state.tools.push({ ...search, name: "another_search" });
      const b = (await api("POST", `${path}/test`)).body.server;
      const stale = await api("PUT", `${path}/tools`, { tools: ["search"], catalog: a.catalog });
      expect(stale.status).toBe(409);
      expect(stale.body.message).toMatch(/catalog.*changed/);
      expect(await pal.store.database.get("SELECT approved FROM pal_mcp_servers WHERE id = ?", server.id)).toEqual(
        before,
      );
      expect(b.catalog).toMatch(/^[a-f0-9]{64}$/);
      expect(b.catalog).not.toBe(a.catalog);
      expect((await api("PUT", `${path}/tools`, { tools: ["fetch"], catalog: b.catalog })).status).toBe(200);
      expect((await api("PUT", `${path}/tools`, { tools: [], catalog: b.catalog })).status).toBe(200);
      expect((await pal.mcp.get(server.id)).tools.every((tool) => !tool.approved)).toBe(true);
      expect(fixture.calls).toEqual([]);
    },
  );

  it("requires a reviewed MCP catalog and accepts unchanged rediscovery without widening consent", async () => {
    const { api } = await signedIn();
    const fixture = await startMcpFixture();
    cleanups.push(fixture.close);
    const { server } = (
      await api("POST", "mcp/servers", {
        name: "Same catalog",
        url: fixture.url,
        auth: { kind: "none" },
        private: true,
      })
    ).body;
    const path = `mcp/servers/${server.id}`;
    const a = (await api("POST", `${path}/test`)).body.server;
    expect((await api("PUT", `${path}/tools`, { tools: ["search"] })).status).toBe(400);
    fixture.state.tools.reverse();
    const b = (await api("POST", `${path}/test`)).body.server;
    expect(b.catalog).toBe(a.catalog);
    expect((await api("PUT", `${path}/tools`, { tools: ["search"], catalog: a.catalog })).status).toBe(200);
    expect((await api("PUT", `${path}/tools`, { tools: ["missing"], catalog: a.catalog })).status).toBe(400);
    expect(fixture.calls).toEqual([]);
  });

  it("keeps MCP discovery and execution scoped to actual durable conversations", async () => {
    const { pal, api, fixture: openai } = await signedIn();
    const started = await api("POST", "chatgpt/sign-in");
    await browse(started.body.attempt.authUrl);
    await eventually(
      () => api("GET", "chatgpt"),
      (state) => state.body.model !== null,
    );
    const fixture = await startMcpFixture();
    cleanups.push(fixture.close);
    const server = await pal.mcp.add({ name: "Scoped", url: fixture.url, auth: { kind: "none" }, private: true });
    await pal.mcp.test(server.id);
    await pal.mcp.approve(server.id, ["search", "fetch"], (await pal.mcp.get(server.id)).catalog);
    await pal.mcp.setEnabled(server.id, true);
    const a = (await api("POST", "projects", { requestId: "scoped-project-a", name: "A" })).body.project;
    const b = (await api("POST", "projects", { requestId: "scoped-project-b", name: "B" })).body.project;
    const grant = (await pal.mcp.grants.view(a.id)).servers.find((candidate) => candidate.id === server.id);
    if (grant === undefined) throw new Error("missing grant");
    await pal.mcp.grants.set(a.id, server.id, { revision: grant.revision, mode: "subset", tools: ["search"] });
    async function conversation(projectId: string, key: string) {
      const chat = await pal.chats.createChat(key, { projectId }, context);
      const handle = await pal.harness.conversation(chat.conversationId, context);
      if (handle === undefined) throw new Error("missing conversation");
      return handle;
    }
    async function run(handle: Awaited<ReturnType<typeof conversation>>, code: string) {
      openai.behavior.responses = "script";
      openai.behavior.script = code;
      await (await handle.submit({ type: "input", content: "go" }, context)).wait(context);
      const result = (await handle.context(context)).messages.findLast((message) => message.role === "toolResult");
      return result?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
    }
    const one = await conversation(a.id, "scoped-chat-one"),
      two = await conversation(b.id, "scoped-chat-two");
    const catalog = await run(one, "return ALL_TOOLS.map(tool => tool.name);");
    expect(catalog).toContain(`mcp__${server.id}__search`);
    expect(catalog).not.toContain(`mcp__${server.id}__fetch`);
    expect(
      await run(
        one,
        `try { await tools.mcp__${server.id}__fetch({ url: "https://fixture.invalid/durable" }); return "leaked"; } catch { return "blocked"; }`,
      ),
    ).toContain("blocked");
    expect(fixture.calls).toEqual([]);
    expect(
      await run(two, `return await tools.mcp__${server.id}__fetch({ url: "https://fixture.invalid/durable" });`),
    ).toContain("Durable agents");
    expect(fixture.calls.map((call) => call.name)).toEqual(["fetch"]);
    const chat = (await pal.chats.list(b.id))[0];
    if (chat === undefined) throw new Error("missing chat");
    const events = await watchEvents(pal.harness, chat.conversationId, context);
    try {
      const receipts = events.snapshot.entries.filter((entry) => entry.kind === "pal.mcp");
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        data: {
          mcp: {
            server: server.id,
            serverName: "Scoped",
            tool: "fetch",
            isError: false,
            sources: [{ url: "https://fixture.invalid/durable", kind: "requested" }],
          },
        },
      });
      expect(receipts[0]?.model ?? []).toEqual([]);
    } finally {
      await events.stop();
    }
  });

  it.each(["https://pal.example", "http://100.64.0.10:7337"])(
    "accepts only the exact configured public Host/Origin %s, retaining loopback access",
    async (origin) => {
      const { base, api } = await signedIn(origin);
      const host = new URL(origin).host;
      expect((await raw(base, "/api/health", { host })).status).toBe(200);
      expect((await raw(base, "/api/health", { host: `${host}.evil`, "x-forwarded-host": host })).status).toBe(421);
      const body = { passphrase: "correct horse battery" };
      for (const wrong of [
        "null",
        `${origin}/`,
        "https://attacker.example",
        origin.replace(/^https?:/, origin.startsWith("https:") ? "http:" : "https:"),
      ]) {
        expect(
          (await raw(base, "/api/sign-in", { host, origin: wrong, "x-forwarded-proto": "https" }, body)).status,
        ).toBe(403);
      }
      expect((await raw(base, "/api/sign-in", { host, origin: base }, body)).status).toBe(403);
      expect((await raw(base, "/api/sign-in", { host: new URL(base).host, origin }, body)).status).toBe(403);
      const accepted = await raw(base, "/api/sign-in", { host, origin }, body);
      expect(accepted.status).toBe(200);
      expect(accepted.cookies[0]?.includes("; Secure")).toBe(origin.startsWith("https:"));
      expect((await api("GET", "projects")).status).toBe(200);
    },
  );

  it("sets up the owner once with the terminal's token, then signs in with the passphrase", async () => {
    const { pal, api, cookie } = await start();
    expect((await api("GET", "session")).body).toEqual({ owner: false, signedIn: false });
    expect((await api("POST", "setup", { token: "guess", passphrase: "correct horse battery" })).status).toBe(403);
    expect((await api("POST", "setup", { token: pal.owner.setupToken, passphrase: "short" })).body.error).toBe(
      "weak_passphrase",
    );
    expect(
      (await api("POST", "setup", { token: pal.owner.setupToken, passphrase: "correct horse battery" })).status,
    ).toBe(200);
    expect(cookie()).toMatch(/^pal_session=/);
    expect((await api("GET", "session")).body).toEqual({ owner: true, signedIn: true });
    expect((await api("POST", "setup", { token: pal.owner.setupToken, passphrase: "another passphrase" })).status).toBe(
      409,
    );

    await api("POST", "sign-out");
    expect((await api("GET", "projects")).status).toBe(401);
    expect((await api("POST", "sign-in", { passphrase: "wrong passphrase!" })).status).toBe(401);
    expect((await api("POST", "sign-in", { passphrase: "correct horse battery" })).status).toBe(200);
    expect((await api("GET", "projects")).status).toBe(200);
  });

  it("browses and previews a project's folder read-only, within the shared path policy", async () => {
    const { base, api, cookie } = await signedIn();
    const folder = await realpath(await mkdtemp(join(tmpdir(), "pal-api-files-")));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "pal-api-outside-")));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await mkdir(join(folder, "src"));
    await writeFile(join(folder, "src", "main.ts"), "export const answer = 42;\n");
    await writeFile(join(folder, "big.log"), "é".repeat(200_000));
    await writeFile(join(folder, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await writeFile(join(outside, "secret.txt"), "not for the panel");
    await symlink(join(outside, "secret.txt"), join(folder, "escape.txt"));
    const project = (await api("POST", "projects", { requestId: "files-project-1", name: "Repo", folder })).body
      .project;
    const files = (path: string) => api("GET", `projects/${project.id}/files?path=${encodeURIComponent(path)}`);
    const file = (path: string) => api("GET", `projects/${project.id}/file?path=${encodeURIComponent(path)}`);

    const root = (await files("")).body;
    expect(root.path).toBe("");
    expect(root.entries.map((entry: { name: string; kind: string }) => [entry.name, entry.kind])).toEqual([
      ["src", "folder"],
      ["big.log", "file"],
      ["escape.txt", "link"],
      ["image.bin", "file"],
    ]);
    expect((await files("src")).body).toMatchObject({
      path: "src",
      parent: "",
      entries: [{ name: "main.ts", path: "src/main.ts", size: 26 }],
    });
    expect((await file("src/main.ts")).body).toMatchObject({
      kind: "text",
      text: "export const answer = 42;\n",
      truncated: false,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const big = (await file("big.log")).body;
    expect(big).toMatchObject({ kind: "text", size: 400_000, truncated: true, sha256: null });
    expect(Buffer.byteLength(big.text)).toBeLessThanOrEqual(256 * 1024);
    expect((await file("image.bin")).body).toEqual({ path: "image.bin", kind: "binary", size: 4 });
    for (const path of ["escape.txt", "../", "/etc/hosts", "src/../../"]) {
      expect((await file(path)).body.error, path).toBe("file_access");
    }
    expect((await files("src/main.ts")).body.error).toBe("file_access");

    const search = (query: string, mode: string) =>
      api("GET", `projects/${project.id}/search?q=${encodeURIComponent(query)}&mode=${mode}`);
    expect((await search("answer = 42", "text")).body.hits).toEqual([
      { path: "src/main.ts", line: 1, text: "export const answer = 42;", ranges: [[13, 24]] },
    ]);
    expect((await search("answer", "bogus")).status).toBe(400);

    // Read-only and owner-only.
    const write = await fetch(`${base}/api/projects/${project.id}/file?path=src/main.ts`, {
      method: "POST",
      headers: { origin: base, cookie: cookie(), "content-type": "application/json" },
      body: "{}",
    });
    expect(write.status).toBe(405);
    expect((await fetch(`${base}/api/projects/${project.id}/files?path=`)).status).toBe(401);

    // Removing the project revokes the view at once; the folder itself stays.
    await api("DELETE", `projects/${project.id}`);
    expect((await files("")).body.error).toBe("file_access");
    expect((await search("answer", "text")).body.error).toBe("file_access");
    expect((await stat(join(folder, "src", "main.ts"))).isFile()).toBe(true);
  });

  it("creates managed and existing-folder projects, refusing unusable folders", async () => {
    const { dataRoot, api } = await signedIn();
    const managed = await api("POST", "projects", { requestId: "project-request-1", name: "Notes" });
    expect(managed.body.project).toMatchObject({ name: "Notes", mode: "managed", state: "ready" });
    expect(managed.body.project.root).toBe(join(dataRoot, "projects", managed.body.project.id, "workspace"));
    expect((await stat(managed.body.project.root)).isDirectory()).toBe(true);
    expect((await api("POST", "projects", { requestId: "project-request-1", name: "Notes" })).body).toEqual(
      managed.body,
    );
    expect((await api("POST", "projects", { requestId: "project-request-1", name: "Other" })).status).toBe(409);

    const folder = await realpath(await mkdtemp(join(tmpdir(), "pal-api-folder-")));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    await mkdir(join(folder, "repo", ".git"), { recursive: true });
    const existing = await api("POST", "projects", { requestId: "project-request-2", name: "Repo", folder });
    expect(existing.body.project).toMatchObject({ mode: "existing", state: "ready", root: folder });

    for (const [path, error] of [
      [join(folder, "missing"), "folder_missing"],
      [join(dataRoot, "projects"), "folder_forbidden"],
      ["relative/path", "invalid_request"],
    ]) {
      expect(
        (await api("POST", "projects", { requestId: `bad-${error}-1`, name: "Bad", folder: path })).body.error,
      ).toBe(error);
    }
    const listing = await api("GET", `folders?path=${encodeURIComponent(folder)}`);
    expect(listing.body.entries).toEqual([{ name: "repo", path: join(folder, "repo"), git: true }]);
    expect((await api("GET", `folders?path=${encodeURIComponent(join(folder, "nope"))}`)).body.problem).toBe("missing");
  });

  it("signs in to ChatGPT, then chats in a project with a live event stream", async () => {
    const { base, api, cookie } = await signedIn();
    const started = await api("POST", "chatgpt/sign-in");
    expect(started.body.attempt.state).toBe("waiting");
    await browse(started.body.attempt.authUrl);
    const connected = await eventually(
      () => api("GET", "chatgpt"),
      (state) => state.body.attempt.state === "connected" && state.body.models.length > 0,
    );
    expect(connected.body).toMatchObject({ account: { accountId: "user-1" }, model: "gpt-5.5" });
    // No token ever reaches the browser.
    expect(JSON.stringify(connected.body)).not.toMatch(/access-|refresh-|eyJ/);

    const project = (await api("POST", "projects", { requestId: "project-request-1", name: "Notes" })).body.project;
    const chat = (await api("POST", "chats", { requestId: "chat-request-1", projectId: project.id })).body.chat;
    expect((await api("GET", `chats/${chat.id}`)).body.model).toBe("gpt-5.5");

    const events = await fetch(`${base}/api/chats/${chat.id}/events`, { headers: { cookie: cookie() } });
    expect(events.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = events.body?.getReader();
    if (reader === undefined) throw new Error("no event stream");
    let text = "";
    const first = await reader.read();
    text += new TextDecoder().decode(first.value);
    expect(text).toMatch(/^event: snapshot/);

    const admitted = await api("POST", `chats/${chat.id}/inputs`, { requestId: "input-request-1", text: "hi" });
    expect(admitted.status).toBe(200);
    while (!text.includes('"type":"run_end"')) {
      const { value, done } = await reader.read();
      if (done) throw new Error("event stream ended early");
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain('"text":"Hello"');
    await reader.cancel();

    const projects = (await api("GET", "projects")).body.projects;
    expect(projects[0].chats).toEqual([expect.objectContaining({ id: chat.id, title: "hi" })]);
  });

  it("persists per-chat reasoning effort, clamps model switches, and rejects invalid choices", async () => {
    const { api, pal, dataRoot, fixture } = await signedIn();
    const project = (await api("POST", "projects", { requestId: "effort-project", name: "Notes" })).body.project;
    const chat = (await api("POST", "chats", { requestId: "effort-chat", projectId: project.id })).body.chat;
    expect((await api("PUT", `chats/${chat.id}/model`, { model: "gpt-5.5", effort: "high" })).body).toMatchObject({
      model: "gpt-5.5",
      effort: "high",
    });
    expect((await api("GET", `chats/${chat.id}`)).body.effort).toBe("high");
    // Levels beyond high are accepted where the model supports them, and clamped where it does not.
    expect((await api("PUT", `chats/${chat.id}/model`, { model: "gpt-5.5", effort: "xhigh" })).body.effort).toBe(
      "xhigh",
    );
    expect((await api("PUT", `chats/${chat.id}/model`, { model: "gpt-5.5", effort: "max" })).body.effort).toBe("xhigh");
    expect((await api("PUT", `chats/${chat.id}/model`, { model: "gpt-5.5", effort: "minimal" })).body.effort).toBe(
      "low",
    );
    await api("PUT", `chats/${chat.id}/model`, { model: "gpt-5.5", effort: "high" });
    expect((await api("PUT", `chats/${chat.id}/model`, { model: "gpt-4.1" })).body.effort).toBe("off");
    expect((await api("PUT", `chats/${chat.id}/model`, { model: "gpt-4.1", effort: "high" })).body.effort).toBe("off");
    for (const body of [
      { model: "missing", effort: "high" },
      { model: "gpt-5.5", effort: "unbounded" },
    ]) {
      expect((await api("PUT", `chats/${chat.id}/model`, body)).status).toBe(400);
    }
    await api("PUT", `chats/${chat.id}/model`, { model: "gpt-5.5", effort: "medium" });
    await pal.close();
    const reopened = await openPal(
      { dataRoot, installRoot: "/nonexistent-install", endpoints: fixture.endpoints },
      context,
    );
    cleanups.push(() => reopened.close());
    const agent = await (await reopened.harness.conversation(chat.conversationId, context))?.agent(context);
    expect(agent).toMatchObject({ model: { modelId: "gpt-5.5" }, thinkingLevel: "medium" });
  });

  it("deletes chats and removes projects without deleting files or Pi history", async () => {
    const { api, pal, fixture, dataRoot } = await signedIn();
    const started = await api("POST", "chatgpt/sign-in");
    await browse(started.body.attempt.authUrl);
    await eventually(
      () => api("GET", "chatgpt"),
      (state) => state.body.model !== null,
    );
    const folder = await realpath(await mkdtemp(join(tmpdir(), "pal-keep-files-")));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    await writeFile(join(folder, "keep.txt"), "owner work");
    const external = (await api("POST", "projects", { requestId: "remove-external", name: "External", folder })).body
      .project;
    const managed = (await api("POST", "projects", { requestId: "remove-managed", name: "Managed" })).body.project;
    await writeFile(join(managed.root, "keep.txt"), "managed work");
    const chat = (await api("POST", "chats", { requestId: "remove-chat-1", projectId: external.id })).body.chat;
    const other = (await api("POST", "chats", { requestId: "remove-chat-2", projectId: external.id })).body.chat;
    fixture.behavior.responses = "script";
    fixture.behavior.script = "while (true) {}";
    await api("POST", `chats/${chat.id}/inputs`, { requestId: "remove-input-1", text: "start" });
    await eventually(
      async () => fixture.apiRequests,
      (calls) => calls.some((call) => call.path === "/v1/responses"),
    );
    expect((await api("DELETE", `chats/${chat.id}`)).status).toBe(200);
    await pal.harness.waitForIdle(context);
    expect((await api("GET", `chats/${chat.id}`)).status).toBe(404);
    expect((await api("POST", `chats/${chat.id}/inputs`, { requestId: "remove-input-2", text: "again" })).status).toBe(
      404,
    );
    expect(await pal.chats.projectOf(chat.conversationId)).toBeUndefined();
    expect((await pal.chats.list(external.id)).map((row) => row.id)).toEqual([other.id]);
    const history = await (await pal.harness.conversation(chat.conversationId, context))?.context(context);
    expect(history?.messages.some((message) => message.role === "user")).toBe(true);
    expect((await api("DELETE", `projects/${external.id}`)).status).toBe(200);
    expect((await api("GET", `chats/${other.id}`)).status).toBe(404);
    expect((await api("POST", "chats", { requestId: "removed-project-chat", projectId: external.id })).status).toBe(
      409,
    );
    expect((await api("POST", "projects", { requestId: "remove-external", name: "External", folder })).status).toBe(
      409,
    );
    expect((await api("DELETE", `projects/${managed.id}`)).status).toBe(200);
    expect((await api("GET", "projects")).body.projects).toEqual([]);
    expect(await readFile(join(folder, "keep.txt"), "utf8")).toBe("owner work");
    expect(await readFile(join(managed.root, "keep.txt"), "utf8")).toBe("managed work");
    await pal.close();
    const reopened = await openPal(
      { dataRoot, installRoot: "/nonexistent-install", endpoints: fixture.endpoints },
      context,
    );
    cleanups.push(() => reopened.close());
    expect(await reopened.projects.list()).toEqual([]);
    expect(await reopened.chats.get(chat.id)).toBeUndefined();
    expect(await reopened.chats.get(other.id)).toBeUndefined();
    expect(await reopened.harness.conversation(chat.conversationId, context)).toBeDefined();
  });

  it("receives device uploads exactly, then attaches them to a message", async () => {
    const { base, api, cookie, fixture, pal } = await signedIn();
    const started = await api("POST", "chatgpt/sign-in");
    await browse(started.body.attempt.authUrl);
    await eventually(
      () => api("GET", "chatgpt"),
      (state) => state.body.model !== null,
    );
    const project = (await api("POST", "projects", { requestId: "project-request-1", name: "Notes" })).body.project;
    const other = (await api("POST", "projects", { requestId: "project-request-2", name: "Other" })).body.project;
    const text = new TextEncoder().encode("The launch is on Tuesday.");

    const tooBig = await api("POST", `projects/${project.id}/uploads`, { name: "x", size: 26 * 1024 * 1024, type: "" });
    expect(tooBig.body.error).toBe("invalid_request");
    const short = (await api("POST", `projects/${project.id}/uploads`, { name: "a.txt", size: 3, type: "text/plain" }))
      .body.upload;
    expect((await putBytes(base, cookie(), short.id, text)).body.error).toBe("upload_size_mismatch");

    const admitted = (
      await api("POST", `projects/${project.id}/uploads`, { name: "plan.txt", size: text.length, type: "text/plain" })
    ).body.upload;
    const received = await putBytes(base, cookie(), admitted.id, text);
    expect(received.body.upload).toMatchObject({
      state: "ready",
      size: text.length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect((await putBytes(base, cookie(), admitted.id, text)).body.error).toBe("upload_not_receiving");

    const chat = (await api("POST", "chats", { requestId: "chat-request-1", projectId: project.id })).body.chat;
    const foreign = (await api("POST", "chats", { requestId: "chat-request-2", projectId: other.id })).body.chat;
    expect(
      (
        await api("POST", `chats/${foreign.id}/inputs`, {
          requestId: "input-foreign",
          text: "x",
          attachments: [admitted.id],
        })
      ).body.error,
    ).toBe("upload_not_found");
    const sent = await api("POST", `chats/${chat.id}/inputs`, {
      requestId: "input-request-1",
      text: "When is the launch?",
      attachments: [admitted.id],
    });
    expect(sent.status).toBe(200);
    const request = await eventually(
      async () => fixture.apiRequests.filter((call) => call.path === "/v1/responses").at(-1),
      (call) => call !== undefined,
    );
    expect(JSON.stringify(request?.body.input)).toContain("The launch is on Tuesday.");
    expect(JSON.stringify(request?.body.input)).toContain('name=\\"plan.txt\\"');

    // An upload left unfinished is dropped when Pal next opens.
    const pending = (
      await api("POST", `projects/${project.id}/uploads`, { name: "b.txt", size: 5, type: "text/plain" })
    ).body.upload;
    await pal.close();
    const reopened = await openPal(
      {
        dataRoot: pal.store.path.replace(/\/pal\.sqlite$/, ""),
        installRoot: "/nonexistent-install",
        endpoints: fixture.endpoints,
      },
      context,
    );
    cleanups.push(() => reopened.close());
    expect(await reopened.uploads.get(pending.id)).toBeUndefined();
    expect(await reopened.uploads.get(admitted.id)).toMatchObject({ state: "ready" });
  });

  it("exports owner-only diagnostics that link inputs and effect outcomes without secrets or contents", async () => {
    const { api, pal, base, cookie } = await signedIn();
    const key = "key-for-fixture-42";
    await pal.providers.setKey("openrouter", key);
    const project = await pal.projects.create("diagnostics-project", { name: "Diagnostics" });
    const chat = await pal.chats.createChat("diagnostics-chat", { projectId: project.id }, context);
    await fakeChatModel(pal, chat.id);
    await pal.chats.submit(chat.id, "diagnostics-input", { text: "SECRET_CHAT_TEXT" }, context);
    await pal.harness.waitForIdle(context);
    const conversation = await pal.harness.conversation(chat.conversationId, context);
    const shell = { command: "echo SECRET_COMMAND", cwd: project.root };
    const failures = [
      "Incorrect API key provided: sk-proj-abcdef1234567890; Bearer abc.def; request req_42",
      `Incorrect API key provided: ${key}`,
      `Rate limit exceeded for SECRET_CHAT_TEXT in ${project.root}`,
      "Maximum context length exceeded: SECRET_FILE_CONTENT",
      "Request failed: https://private.example/?token=small-secret; correct horse battery",
    ];
    for (const entry of [
      { kind: "pal.shell", data: { shell: { ...shell, callId: "lost-call", status: "started" } } },
      { kind: "pal.shell", data: { shell: { ...shell, callId: "done-call", status: "started" } } },
      {
        kind: "pal.shell",
        data: { shell: { ...shell, callId: "done-call", status: "finished", output: "SECRET_OUTPUT", exitCode: 3 } },
      },
      ...failures.map((errorMessage) => ({
        kind: "pi.assistant",
        model: [fauxAssistantMessage("", { stopReason: "error", errorMessage })],
      })),
    ])
      await conversation?.submit({ type: "write", entry }, context);
    await pal.store.database.run(
      "UPDATE pal_workspaces SET state = 'failed', error = ? WHERE chat_id = ?",
      `Workspace failure in ${project.root}: SECRET_FILE_CONTENT`,
      chat.id,
    );

    expect((await fetch(`${base}/api/chats/${chat.id}/diagnostics`)).status).toBe(401);
    expect((await fetch(`${base}/api/diagnostics`)).status).toBe(401);
    const { status, body } = await api("GET", `chats/${chat.id}/diagnostics`);
    expect(status).toBe(200);
    expect(body.installation).toMatchObject({
      format: 1,
      pal: { status: "ready", schema: MIGRATIONS.at(-1)?.version },
      providers: expect.arrayContaining([{ id: "openrouter", enabled: false, hasKey: true }]),
      chatgpt: { connected: false },
      unfinished: { tasks: 0, approvals: 0 },
    });
    expect(body.chat).toMatchObject({
      chat: chat.id,
      workspace: { mode: "local", state: "failed" },
      running: false,
      inputs: [{ requestId: "diagnostics-input", state: "admitted", submissionId: expect.any(Number) }],
      commands: [{ callId: "done-call", exitCode: 3 }],
      unknownEffects: [{ callId: "lost-call" }],
      modelFailures: [
        { cause: "credentials-rejected" },
        { cause: "credentials-rejected" },
        { cause: "rate-limit" },
        { cause: "context-limit" },
        { cause: "model-request-failed" },
      ],
    });
    const exported = JSON.stringify(body);
    for (const secret of [
      key,
      "correct horse battery",
      cookie().split("=")[1] ?? "missing",
      "SECRET_CHAT_TEXT",
      "SECRET_COMMAND",
      "SECRET_OUTPUT",
      "SECRET_FILE_CONTENT",
      "private.example",
      "small-secret",
      "sk-proj-",
      "abc.def",
      project.root,
    ])
      expect(exported).not.toContain(secret);
    expect((await api("GET", "diagnostics")).body).toMatchObject({
      format: 1,
      pal: { release: body.installation.pal.release },
    });
  });
});
