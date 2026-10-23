import { readFileSync } from "node:fs";
import { plan } from "./plan.mjs";

process.stdout.write(JSON.stringify(plan(JSON.parse(readFileSync(0, "utf8")))) + "\n");
