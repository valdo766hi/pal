import { list } from "./api.mjs";
import { heading } from "./report.mjs";

process.stdout.write(`${heading("orders")}\n${JSON.stringify(list([]))}\n`);
