import assert from "node:assert/strict";
import { describe } from "./src/describe.mjs";
import { parse } from "./src/parse.mjs";

assert.deepEqual(parse({}), { deadlineMs: 5000, retries: 2 });
assert.equal(describe(parse({ deadlineMs: 750 })), "deadline 750ms, 2 retries");
