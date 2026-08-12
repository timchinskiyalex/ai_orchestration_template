import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { scaffoldWithAdapter } from "./stack-adapter.mjs";

const posix = (value) => value.replace(/\\/g, "/");

function rootPath(worktree, component) {
  const target = resolve(worktree, component.path);
  const relation = relative(resolve(worktree), target);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) throw new Error(`Unsafe scaffold root '${component.path}'`);
  return target;
}

// The controller invokes only an admitted adapter.  There are deliberately no
// stack conditionals here: adapter code, scaffolding surface, and version are
// selected from the ArchitectureBlueprint before this task is admitted.
export function provisionDeterministicScaffold({ worktree, productRoots }) {
  const provisioned = [];
  for (const component of productRoots ?? []) {
    const root = rootPath(worktree, component);
    const adapter = typeof component.adapter === "string" ? { id: component.adapter, version: component.adapterVersion ?? 1 } : component.adapter;
    scaffoldWithAdapter({ ...component, adapter }, root);
    provisioned.push({ id: component.id, root: posix(relative(worktree, root)), adapter: adapter.id, adapterVersion: adapter.version, existed: existsSync(root) });
  }
  return { provisioned };
}
