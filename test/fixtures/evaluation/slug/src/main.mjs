import { readFileSync } from "node:fs";
import { slug } from "./slug.mjs";

const { text } = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(slug(text)));
