export function closure(modules, root) {
  const active = new Set();
  const complete = new Set();
  function visit(id) {
    if (!Object.hasOwn(modules, id) || active.has(id)) return false;
    if (complete.has(id)) return true;
    active.add(id);
    for (const dependency of modules[id].requires ?? []) if (!visit(dependency)) return false;
    active.delete(id);
    complete.add(id);
    return true;
  }
  return visit(root) ? complete : undefined;
}
