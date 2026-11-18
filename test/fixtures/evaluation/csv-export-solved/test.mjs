import assert from "node:assert/strict";
import { toCsv } from "./src/csv.mjs";

assert.equal(
  toCsv([
    ["name", "city"],
    ["Ana", "Oslo"],
  ]),
  "name,city\r\nAna,Oslo\r\n",
);
assert.equal(toCsv([["Ana, Bo", 'say "hi"']]), '"Ana, Bo","say ""hi"""\r\n');
