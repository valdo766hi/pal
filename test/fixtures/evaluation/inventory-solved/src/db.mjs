import { config } from "./config.mjs";

export function page(rows) {
  return rows.slice(0, config.pageSize);
}
