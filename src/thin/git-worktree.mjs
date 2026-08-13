import { mkdirSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd, args, options = {}) {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8", ...options });
  return String(result.stdout).trim();
}

function inside(root, target) {
  const value = relative(root, target);
  return Boolean(value) && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function safeTaskToken(taskId) {
  const token = String(taskId ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!token) throw new Error("taskId must contain a safe branch token");
  return token.slice(0, 80);
}

/**
 * Creates one disposable, exact-base worktree.  This module deliberately has
 * no scheduler/state-store dependency: the thin dispatcher owns lifecycle.
 */
export async function createIsolatedWorktree({ repository, runtimeDir, taskId, baseSha }) {
  const repositoryRoot = resolve(repository);
  const status = await git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer" });
  if (Buffer.isBuffer(status) ? status.length : status) throw new Error("Source repository is dirty; refusing to create worker worktree");

  const resolvedBase = await git(repositoryRoot, ["rev-parse", "--verify", `${baseSha}^{commit}`]);
  const root = resolve(runtimeDir, "thin-worktrees");
  if (!inside(repositoryRoot, root) && root === repositoryRoot) throw new Error("runtimeDir must not be the source repository");
  mkdirSync(root, { recursive: true });

  const token = safeTaskToken(taskId);
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const worktree = join(root, `${token}-${nonce}`);
  const branch = `thin/${token}-${nonce}`;
  await git(repositoryRoot, ["worktree", "add", "--detach", worktree, resolvedBase]);

  try {
    const [top, head] = await Promise.all([
      git(worktree, ["rev-parse", "--show-toplevel"]),
      git(worktree, ["rev-parse", "HEAD"])
    ]);
    if (resolve(top) !== resolve(worktree) || head !== resolvedBase) throw new Error("New worker worktree did not start at its exact base SHA");
    await git(worktree, ["switch", "-c", branch]);
    return { repository: repositoryRoot, worktree, branch, baseSha: resolvedBase };
  } catch (error) {
    await removeIsolatedWorktree({ repository: repositoryRoot, worktree });
    throw error;
  }
}

/** Cleanup must never invalidate a final artifact; callers record its result. */
export async function removeIsolatedWorktree({ repository, worktree }) {
  try {
    await git(resolve(repository), ["worktree", "remove", "--force", resolve(worktree)]);
    return { state: "completed" };
  } catch (error) {
    return { state: "preserved", reason: String(error.message).slice(0, 500), recovery: `git -C "${worktree}" status --short` };
  }
}

export const thinGit = { git, safeTaskToken, basename, normalize };
