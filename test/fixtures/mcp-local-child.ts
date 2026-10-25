import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openPal } from "../../src/core/app.ts";
import type { ChatGPTEndpoints } from "../../src/pi/chatgpt.ts";
import { browse } from "./openai-server.ts";
import { STDIO_FIXTURE } from "./stdio-server.ts";

const root = process.argv[2] ?? "";
const endpoints = JSON.parse(process.argv[3] ?? "null") as ChatGPTEndpoints;
const cwd = join(root, "program-cwd");
await mkdir(cwd);
const pal = await openPal({ dataRoot: join(root, "data"), installRoot: "/nonexistent-install", endpoints }, context);
const announced = Promise.withResolvers<string>();
const login = pal.chatgpt.signIn({
  signal: AbortSignal.timeout(5000),
  notify: (event) => {
    if (event.type === "auth_url") announced.resolve(event.url);
  },
  prompt: () => Promise.withResolvers<string>().promise,
});
login.catch(() => {});
await browse(await announced.promise);
await login;
await pal.settings.setModel("gpt-5.5");
const code = `require("node:fs").appendFileSync("starts", "start\\n");\n${STDIO_FIXTURE}`;
const server = await pal.mcp.add({
  transport: "stdio",
  name: "Recovery fixture",
  command: process.execPath,
  args: ["-e", code],
  cwd,
  auth: { kind: "none" },
});
if (server.stdio === null) throw new Error("missing fixture configuration");
await pal.mcp.approveProgram(server.id, server.stdio.digest, true);
await pal.mcp.test(server.id);
await pal.mcp.approve(server.id, ["inspect"], (await pal.mcp.get(server.id)).catalog);
await pal.mcp.setEnabled(server.id, true);
const project = await pal.projects.create("recovery-project", { name: "Fixture" });
const chat = await pal.chats.createChat("recovery-chat", { projectId: project.id }, context);
const go = once(process, "message");
console.log(JSON.stringify({ cwd, serverId: server.id, chatId: chat.id }));
await go;
await pal.chats.submit(chat.id, "recovery-input", { text: "exercise the interrupted fixture" }, context);
setInterval(() => {}, 1000);
