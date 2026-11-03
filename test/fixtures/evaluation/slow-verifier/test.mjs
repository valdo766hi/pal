import assert from "node:assert/strict";
import { receipt } from "./src/receipt.mjs";

assert.deepEqual(receipt([{ price: "12.34", quantity: 2 }]), {
  unitCents: [1234],
  totalCents: 2468,
});
