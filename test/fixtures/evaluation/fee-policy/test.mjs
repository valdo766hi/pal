import assert from "node:assert/strict";
import { fee } from "./src/fees.mjs";

assert.equal(fee({ amountCents: 1234, from: { owner: "ana" }, to: { owner: "ben" } }), 31);
