import { readFileSync } from "node:fs";
import { describe } from "./describe.mjs";
import { parse } from "./parse.mjs";

const { options } = JSON.parse(readFileSync(0, "utf8"));
const resolved = parse(options);
process.stdout.write(JSON.stringify({ resolved, text: describe(resolved) }));
