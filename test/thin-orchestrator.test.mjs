import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runThinOrchestrator } from "../src/thin/orchestrator.mjs";

function git(cwd, ...args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(); }
function plan(tasks) { return async () => ({ tasks }); }
function task(title, allowedPaths, dependsOn = []) { return { title, prompt: `Implement ${title}`, allowedPaths, dependsOn }; }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "thin-orchestrator-"));
  const runtime = mkdtempSync(join(tmpdir(), "thin-orchestrator-runtime-"));
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test", "smoke.mjs"), "import assert from 'node:assert/strict'; assert.ok(true);\n");
  git(root, "init"); git(root, "add", "--", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base");
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(runtime, { recursive: true, force: true }); });
  return { root, runtime };
}

test("integrates two concurrently-started isolated workers into a verified candidate", async (t) => {
  const { root, runtime } = fixture(t); const events = []; const started = [];
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const result = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "# brief",
    planner: plan([task("Frontend", ["apps/web"]), task("Backend", ["apps/api"])]),
    heartbeatMs: 5,
    onEvent: (event) => events.push(event),
    workerExecutor: async ({ task, worktree }) => {
      started.push(task.title);
      if (started.length === 2) release();
      await gate;
      const filename = task.title === "Frontend" ? join(worktree, "apps", "web", "page.txt") : join(worktree, "apps", "api", "route.txt");
      mkdirSync(join(filename, ".."), { recursive: true }); writeFileSync(filename, task.title);
    },
    verifyIntegration: async ({ worktree }) => {
      assert.ok(existsSync(join(worktree, "apps", "web", "page.txt")));
      assert.ok(existsSync(join(worktree, "apps", "api", "route.txt")));
      execFileSync(process.execPath, ["--test", "test/smoke.mjs"], { cwd: worktree, stdio: "pipe" });
      return { ok: true };
    },
  });
  assert.equal(result.ok, true); assert.equal(result.artifacts.length, 2); assert.equal(started.length, 2);
  assert.equal(new Set(result.artifacts.map((artifact) => artifact.commitSha)).size, 2);
  assert.ok(events.some((event) => event.type === "plan_accepted"));
  assert.equal(events.filter((event) => event.type === "worker_started").length, 2);
  assert.ok(events.some((event) => event.type === "heartbeat"));
  assert.equal(events.filter((event) => event.type === "commit").length, 2);
  assert.ok(events.some((event) => event.type === "integration_test_passed"));
  assert.ok(events.some((event) => event.type === "completed"));
});

test("rejects overlapping independent paths before creating workers", async (t) => {
  const { root, runtime } = fixture(t); let called = false;
  const result = await runThinOrchestrator({ repository: root, runtimeDir: runtime, markdown: "x", planner: plan([task("A", ["apps"]), task("B", ["apps/web"])]), workerExecutor: async () => { called = true; } });
  assert.deepEqual(result, { ok: false, stage: "plan", code: "overlapping_paths", taskKey: null, recoveryWorktree: null });
  assert.equal(called, false);
});

test("preserves failed worker worktree and does not integrate", async (t) => {
  const { root, runtime } = fixture(t); let integrated = false;
  const result = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "x", planner: plan([task("A", ["src"])]),
    workerExecutor: async () => { throw new Error("worker boom"); },
    verifyIntegration: async () => { integrated = true; return { ok: true }; },
  });
  assert.equal(result.ok, false); assert.equal(result.code, "worker_failed"); assert.equal(result.taskKey.startsWith("task-1-"), true);
  assert.equal(integrated, false); assert.equal(existsSync(result.recoveryWorktree), true);
});

test("reports integration verification failure without a candidate", async (t) => {
  const { root, runtime } = fixture(t);
  const result = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "x", planner: plan([task("A", ["src"])]),
    workerExecutor: async ({ worktree }) => { mkdirSync(join(worktree, "src")); writeFileSync(join(worktree, "src", "a.txt"), "a"); },
    verifyIntegration: async () => ({ ok: false }),
  });
  assert.equal(result.ok, false); assert.equal(result.stage, "integration"); assert.equal(result.code, "verification_failed");
  assert.equal("candidateSha" in result, false); assert.equal(existsSync(result.recoveryWorktree), true);
});

test("returns unsupported_dependency before worker execution", async (t) => {
  const { root, runtime } = fixture(t); let called = false;
  const result = await runThinOrchestrator({ repository: root, runtimeDir: runtime, markdown: "x", planner: plan([task("A", ["src"]), task("B", ["test"], ["A"])]), workerExecutor: async () => { called = true; } });
  assert.equal(result.code, "unsupported_dependency"); assert.equal(called, false);
});
