import { closure } from "./graph.mjs";

export function plan({ roots, modules }) {
  const selected = new Set();
  const blocked = [];
  for (const root of new Set(roots)) {
    const found = closure(modules, root);
    if (found === undefined) blocked.push(root);
    else for (const id of found) selected.add(id);
  }
  return { order: [...selected].sort(), blocked: blocked.sort() };
}
