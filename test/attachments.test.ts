import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { openPal, type PalOptions } from "../src/core/app.ts";
import type { Chat } from "../src/core/chats.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const script = (code: string) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
const read = (args: object) => script(`return (await tools.files_attachment(${JSON.stringify(args)})).text;`);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

async function setup(admissionBarrier?: PalOptions["admissionBarrier"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-attachments-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pal = await openPal(
    {
      dataRoot: join(root, "data"),
      installRoot: "/nonexistent-install",
      guidanceHome: join(root, "home"),
      ...(admissionBarrier === undefined ? {} : { admissionBarrier }),
    },
    context,
  );
  cleanups.push(() => pal.close());
  const project = await pal.projects.create("attachments-project", { name: "Attachments" });
  const faux = fauxProvider({ models: [{ id: "attachments-fixture", input: ["text", "image"] }] });
  (pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
  const model = faux.getModel();
  let sequence = 0;
  const chat = async (projectId = project.id) => {
    const created = await pal.chats.createChat(`attachments-chat-${++sequence}`, { projectId }, context);
    await (
      await pal.harness.conversation(created.conversationId, context)
    )?.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    return created;
  };
  return {
    pal,
    project,
    chat,
    async upload(name: string, type: string, bytes: Buffer, projectId = project.id) {
      const admitted = await pal.uploads.admit(projectId, { name, size: bytes.length, type });
      return pal.uploads.receive(admitted.id, Readable.from([bytes]));
    },
    /** Send one input with the model turns that answer it; the tool results' texts, once the run is idle. */
    async send(target: Chat, turns: ReturnType<typeof fauxAssistantMessage>[], attachments: string[] = []) {
      faux.setResponses([...turns, fauxAssistantMessage("done")]);
      await pal.chats.submit(target.id, `attachments-input-${++sequence}`, { text: "use it", attachments }, context);
      const conversation = await pal.harness.conversation(target.conversationId, context);
      await conversation?.waitForIdle(context);
      const history = await conversation?.context(context);
      return {
        entries: history?.entries ?? [],
        user: JSON.stringify(history?.messages.filter((message) => message.role === "user").at(-1)),
        results: (history?.messages ?? []).flatMap((message) =>
          message.role === "toolResult"
            ? [message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")]
            : [],
        ),
      };
    },
  };
}

describe("attachments the agent reads", () => {
  it("reads text past the inline slice by line, and records what the message included", async () => {
    const f = await setup();
    const text = Array.from({ length: 6000 }, (_, i) => `line ${String(i + 1).padStart(5, "0")} ${"x".repeat(40)}`);
    const notes = await f.upload("notes.txt", "text/plain", Buffer.from(`${text.join("\n")}\n`));
    const chat = await f.chat();
    const sent = await f.send(
      chat,
      [read({ id: notes.id, offset: 5000, limit: 3 }), read({ id: notes.id, offset: 5999 })],
      [notes.id],
    );
    expect(sent.user).toContain(`id=\\"${notes.id}\\"`);
    expect(sent.user).toContain("[only the first 102400 bytes are shown; files_attachment reads the rest]");
    expect(sent.user).not.toContain("line 05000");
    expect(sent.results[0]).toContain(`5000\t${text[4999]}\n5001\t${text[5000]}\n5002\t${text[5001]}`);
    expect(sent.results[0]).toContain("[more follows; continue at offset 5003]");
    expect(sent.results[1]).toContain(`6000\t${text[5999]}\n[end of attachment: 6000 lines]`);
    const entry = sent.entries.find((item) => item.kind === "pal.user");
    expect(entry?.data).toEqual({
      attachments: [
        {
          id: notes.id,
          name: "notes.txt",
          size: notes.size,
          mediaType: "text/plain",
          received: { kind: "text", bytes: 102400 },
        },
      ],
    });
  });

  it("describes binary files, returns images whole, and reads only what this chat sent", async () => {
    const f = await setup();
    const binary = await f.upload("data.bin", "application/octet-stream", Buffer.from([1, 0, 2, 3]));
    const image = await f.upload("pixel.png", "image/png", PNG);
    const chat = await f.chat();
    const sent = await f.send(
      chat,
      [
        read({ id: binary.id }),
        script(`const image = await tools.files_attachment({ id: "${image.id}" });
return [image.type, image.mimeType, image.data === "${PNG.toString("base64")}"].join(":");`),
      ],
      [binary.id, image.id],
    );
    expect(sent.results[0]).toContain("data.bin (application/octet-stream, 4 bytes) is a binary file");
    expect(sent.results[1]).toContain("image:image/png:true");
    expect(sent.entries.find((item) => item.kind === "pal.user")?.data).toMatchObject({
      attachments: [{ received: { kind: "binary" } }, { received: { kind: "image" } }],
    });
    // Another chat of the project and a chat of another project cannot reach it by its ID.
    const other = await f.pal.projects.create("attachments-other", { name: "Other" });
    for (const stranger of [await f.chat(), await f.chat(other.id)]) {
      const refused = await f.send(stranger, [read({ id: image.id })]);
      expect(refused.results[0]).toContain(`this chat sent no attachment ${image.id}`);
    }
  });

  it("reads an input's own attachment while Pal's acknowledgement still trails Pi's commit", async () => {
    // Pi runs the whole turn before Pal records that it admitted the input; the barrier runs only after setup returns.
    const f: Awaited<ReturnType<typeof setup>> = await setup(async (point) => {
      if (point === "input-submitted") await f.pal.harness.waitForIdle(context);
    });
    const notes = await f.upload("late.txt", "text/plain", Buffer.from("first line\nsecond line\n"));
    const other = await f.upload("unsent.txt", "text/plain", Buffer.from("never sent\n"));
    const sent = await f.send(await f.chat(), [read({ id: notes.id, offset: 2 }), read({ id: other.id })], [notes.id]);
    expect(sent.results[0]).toContain("2\tsecond line");
    expect(sent.results[1]).toContain(`this chat sent no attachment ${other.id}`);
  });

  it("fails only the read for a missing or damaged payload", async () => {
    const f = await setup();
    const chat = await f.chat();
    for (const damage of ["missing", "damaged"]) {
      const notes = await f.upload(`${damage}.txt`, "text/plain", Buffer.from("intact\n"));
      await f.send(chat, [], [notes.id]);
      const data = join(f.pal.store.path, "..", "uploads", f.project.id, notes.id, "data");
      if (damage === "missing") await rm(data);
      else await writeFile(data, "broken\n");
      const failed = await f.send(chat, [read({ id: notes.id })]);
      expect(failed.results.at(-1)).toContain(`${damage}.txt is missing or damaged on this device.`);
    }
    expect(f.pal.chats.stopped).toBe(false);
    expect((await f.send(chat, [])).results).toHaveLength(2);
  });

  it("cuts a line longer than a page without stalling the next read", async () => {
    const f = await setup();
    const long = await f.upload("long.txt", "text/plain", Buffer.from(`${"y".repeat(300_000)}\nafter\n`));
    const chat = await f.chat();
    // A script's own output is capped, so the script compares the page.
    const sent = await f.send(
      chat,
      [
        script(`const page = (await tools.files_attachment({ id: "${long.id}" })).text;
return page === "1\\t" + "y".repeat(262144) + " [line cut at 262144 characters]\\n[more follows; continue at offset 2]";`),
        read({ id: long.id, offset: 2 }),
      ],
      [long.id],
    );
    expect(sent.results[0]).toContain("true");
    expect(sent.results[1]).toContain("2\tafter\n[end of attachment: 2 lines]");
  });
});
