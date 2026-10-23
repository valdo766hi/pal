import { closure } from "./graph.mjs";

export function plan({ roots, modules, excluded = [] }) {
  const selected = new Set();
  const blocked = [];
  const ignored = new Set(excluded);
  for (const root of new Set(roots)) {
    const found = ignored.has(root) ? undefined : closure(modules, root);
    if (found === undefined) blocked.push(root);
    else for (const id of found) selected.add(id);
  }
  const order = [];
  const done = new Set();
  while (done.size < selected.size) {
    const next = [...selected]
      .filter((id) => !done.has(id) && (modules[id].requires ?? []).every((dependency) => done.has(dependency)))
      .sort()[0];
    if (next === undefined) throw new Error("invalid dependency closure");
    order.push(next);
    done.add(next);
  }
  return { order, blocked: blocked.sort() };
}
