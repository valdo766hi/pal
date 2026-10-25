import assert from "node:assert/strict";
import { plan } from "./src/plan.mjs";

assert.deepEqual(plan({ roots: ["app"], modules: { app: { requires: ["base"] }, base: {} } }), {
  order: ["base", "app"],
  blocked: [],
});
assert.deepEqual(plan({ roots: ["app", "ok"], modules: { app: { requires: ["missing"] }, ok: {} } }), {
  order: ["ok"],
  blocked: ["app"],
});
