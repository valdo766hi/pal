import { readFileSync } from "node:fs";
import { fee } from "./fees.mjs";

const transfer = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(fee(transfer)));
