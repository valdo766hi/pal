import { isAbsolute, relative, sep } from "node:path";

/** Whether `path` is `root` or below it: a child named `..notes` is inside, while `..` and `../x` are not. */
export function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
