import { readFileSync } from "node:fs";
import { toCsv } from "./csv.mjs";

const { rows, locale } = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(toCsv(rows, locale)));
