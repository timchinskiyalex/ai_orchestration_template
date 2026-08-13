import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createIsolatedWorktree, removeIsolatedWorktree } from "../src/thin/git-worktree.mjs";
import { finalizeWorkerArtifact } from "../src/thin/finalizer.mjs";

function git(cwd, ...args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(); }
function fixture(label = "thin git worker ") {
  const root = mkdtempSync(join(tmpdir(), label)); mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.txt"), "base\n");
  git(root, "init"); git(root, "add", "--", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base");
  return { root, baseSha: git(root, "rev-parse", "HEAD"), runtime: join(root, "runtime with space") };
}
async function worker(setup) {
  const value = fixture(); const isolated = await createIsolatedWorktree({ repository: value.root, runtimeDir: value.runtime, taskId: "задача worker", baseSha: value.baseSha });
  try { await setup(value, isolated); } finally { await removeIsolatedWorktree(isolated); }
}

test("creates a Unicode/space exact-base isolated worktree", async () => {
  await worker(async ({ baseSha }, isolated) => {
    assert.equal(git(isolated.worktree, "rev-parse", "HEAD"), baseSha);
    assert.equal(git(isolated.worktree, "status", "--porcelain"), "");
  });
});

test("finalizes an allowed controller commit with injected argv verification", async () => {
  await worker(async ({ baseSha }, isolated) => {
    writeFileSync(join(isolated.worktree, "src", "base.txt"), "changed\n"); let observed;
    const artifact = await finalizeWorkerArtifact({ taskId: "writer-a", worktree: isolated.worktree, baseSha, allowedPaths: ["src"], verification: [{ id: "verify", executable: "ignored", args: ["--flag"] }], processRunner: async (command) => { observed = command; } });
    assert.deepEqual(artifact.changedPaths, ["src/base.txt"]); assert.equal(artifact.headSha, artifact.commitSha); assert.equal(observed.args[0], "--flag");
    assert.equal(git(isolated.worktree, "log", "-1", "--format=%an"), "Thin Orchestrator");
  });
});

test("rejects an empty worker diff", async () => {
  await worker(async ({ baseSha }, isolated) => assert.rejects(() => finalizeWorkerArtifact({ taskId: "empty", worktree: isolated.worktree, baseSha, allowedPaths: ["src"] }), /no diff/i));
});

test("rejects an out-of-scope diff", async () => {
  await worker(async ({ baseSha }, isolated) => {
    writeFileSync(join(isolated.worktree, "outside.txt"), "no\n");
    await assert.rejects(() => finalizeWorkerArtifact({ taskId: "outside", worktree: isolated.worktree, baseSha, allowedPaths: ["src"] }), /outside allowedPaths/i);
  });
});

test("rejects verification failure before committing", async () => {
  await worker(async ({ baseSha }, isolated) => {
    writeFileSync(join(isolated.worktree, "src", "base.txt"), "changed\n");
    await assert.rejects(() => finalizeWorkerArtifact({ taskId: "bad-test", worktree: isolated.worktree, baseSha, allowedPaths: ["src"], verification: [{ executable: "x", args: [] }], processRunner: async () => { throw new Error("expected failure"); } }), /Verification failed/);
    assert.equal(git(isolated.worktree, "rev-parse", "HEAD"), baseSha);
  });
});

test("cleanup preservation does not invalidate an already finalized artifact", async () => {
  const value = fixture(); const isolated = await createIsolatedWorktree({ repository: value.root, runtimeDir: value.runtime, taskId: "cleanup", baseSha: value.baseSha });
  writeFileSync(join(isolated.worktree, "src", "base.txt"), "changed\n");
  const artifact = await finalizeWorkerArtifact({ taskId: "cleanup", worktree: isolated.worktree, baseSha: value.baseSha, allowedPaths: ["src"] });
  const cleanup = await removeIsolatedWorktree({ repository: value.root, worktree: join(value.root, "does-not-exist") });
  assert.equal(artifact.commitSha.length, 40); assert.equal(cleanup.state, "preserved");
  await removeIsolatedWorktree(isolated);
});
