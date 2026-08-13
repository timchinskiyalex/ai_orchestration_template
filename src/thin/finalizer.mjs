import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const RUNTIME_IDENTITY = { name: "Thin Orchestrator", email: "thin-orchestrator@local" };

async function git(cwd, args, options = {}) {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8", ...options });
  return String(result.stdout).trim();
}
async function gitBuffer(cwd, args) {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "buffer" });
  return result.stdout;
}
function toPosix(value) { return value.replace(/\\/g, "/"); }
function normalizePath(value) {
  const path = toPosix(String(value));
  if (!path || isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.split("/").includes("..")) throw new Error(`Unsafe changed path: ${value}`);
  return path.replace(/^\.\//, "");
}
function parseStatus(buffer) {
  const fields = buffer.toString("utf8").split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const row = fields[index];
    if (!row) continue;
    if (row.length < 4 || row[2] !== " ") throw new Error("Unexpected git status porcelain record");
    const state = row.slice(0, 2);
    paths.push(normalizePath(row.slice(3)));
    if (state.includes("R") || state.includes("C")) paths.push(normalizePath(fields[++index] ?? ""));
  }
  return [...new Set(paths)].sort();
}
function allowed(path, allowedPaths) {
  return allowedPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
function isGeneratedRuntimePath(path) {
  const segments = path.split("/");
  const file = segments.at(-1).toLowerCase();
  return segments.some((segment) => ["bin", "obj", "node_modules", ".next", "coverage"].includes(segment.toLowerCase()))
    || file.endsWith(".db") || file.endsWith(".db-shm") || file.endsWith(".db-wal");
}

/**
 * Controller-side only finalization. Worker code never receives Git identity.
 */
export async function finalizeWorkerArtifact({ taskId, worktree, baseSha, allowedPaths, verification = [], processRunner, runtimeIdentity = RUNTIME_IDENTITY }) {
  if (!taskId || !worktree || !baseSha) throw new Error("taskId, worktree, and baseSha are required");
  const normalizedAllowed = [...new Set((allowedPaths ?? []).map(normalizePath))];
  if (!normalizedAllowed.length) throw new Error("Task must declare at least one allowed path");
  if (!Array.isArray(verification)) throw new Error("verification must be an argv command list");
  const [head, mergeBase, status] = await Promise.all([
    git(worktree, ["rev-parse", "HEAD"]),
    git(worktree, ["merge-base", baseSha, "HEAD"]),
    gitBuffer(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  ]);
  if (head !== baseSha || mergeBase !== baseSha) throw new Error("Worker must not create commits before controller finalization");
  const observedPaths = parseStatus(status);
  const changedPaths = observedPaths.filter((path) => !isGeneratedRuntimePath(path));
  if (!changedPaths.length) throw new Error("Worker produced no diff after generated runtime output was excluded");
  const forbidden = changedPaths.filter((path) => !allowed(path, normalizedAllowed));
  if (forbidden.length) throw new Error(`Worker changed paths outside allowedPaths: ${forbidden.join(", ")}`);

  for (const command of verification) {
    if (!command || typeof command.executable !== "string" || !Array.isArray(command.args)) throw new Error("Verification commands must use executable plus argv");
    const runner = processRunner ?? (async ({ executable, args, cwd }) => exec(executable, args, { cwd, encoding: "utf8" }));
    try { await runner({ executable: command.executable, args: command.args, cwd: command.cwd ?? worktree }); }
    catch (error) { throw new Error(`Verification failed: ${command.id ?? command.executable}: ${String(error.message).slice(0, 500)}`); }
  }

  await git(worktree, ["add", "--", ...changedPaths]);
  const staged = (await gitBuffer(worktree, ["diff", "--cached", "--name-only", "-z"])).toString("utf8").split("\0").filter(Boolean).map(normalizePath).sort();
  if (!staged.length) throw new Error("No staged diff after controller finalization");
  const diff = await gitBuffer(worktree, ["diff", "--cached", "--binary", "--no-ext-diff", baseSha, "--"]);
  if (!diff.length) throw new Error("No staged diff after controller finalization");
  await git(worktree, ["-c", `user.name=${runtimeIdentity.name}`, "-c", `user.email=${runtimeIdentity.email}`, "commit", "-m", `thin: finalize ${taskId}`]);
  const commitSha = await git(worktree, ["rev-parse", "HEAD"]);
  return { taskId, baseSha, headSha: commitSha, changedPaths: staged, commitSha, diffChecksum: createHash("sha256").update(diff).digest("hex") };
}

export const thinFinalizer = { normalizePath, parseStatus, isGeneratedRuntimePath, RUNTIME_IDENTITY };
