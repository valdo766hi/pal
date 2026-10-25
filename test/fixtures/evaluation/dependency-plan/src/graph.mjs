export function closure(modules, root) {
  if (!Object.hasOwn(modules, root)) return undefined;
  return new Set([root, ...(modules[root].requires ?? [])]);
}
