import { ChatService } from "../../src/core/chats.ts";

const open = ChatService.open;
ChatService.open = async (options, context) => {
  const chats = await open(options, context);
  process.once("message", () => {
    void (async () => {
      await options.database.exec("DROP TABLE pal_chats");
      await chats.list("fixture");
    })().catch(() => {});
  });
  return chats;
};
