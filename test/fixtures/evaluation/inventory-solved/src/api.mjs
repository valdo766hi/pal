import { page } from "./db.mjs";

export function list(rows) {
  return { items: page(rows) };
}
