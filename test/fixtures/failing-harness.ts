import { Harness } from "@earendil-works/pi-durable";

const open = Harness.open;
Harness.open = async (storage, options, context) => {
  const harness = await open(storage, options, context);
  process.once("message", () => {
    storage.commit = async () => {
      throw new Error("fixture terminal storage failure");
    };
    void harness.createConversation({ ownership: { kind: "ownerless" } }, context).catch(() => {});
  });
  return harness;
};
