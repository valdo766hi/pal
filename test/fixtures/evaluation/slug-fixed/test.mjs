import assert from "node:assert/strict";
import { slug } from "./src/slug.mjs";

assert.equal(slug("Hello World"), "hello-world");
assert.equal(slug("Crème Brûlée!"), "creme-brulee");
