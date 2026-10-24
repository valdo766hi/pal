import { readFileSync } from "node:fs";
import { receipt } from "./receipt.mjs";

const lines = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(receipt(lines)));
