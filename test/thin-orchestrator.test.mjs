import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runThinOrchestrator } from "../src/thin/orchestrator.mjs";
import { validateThinPlanCandidate } from "../src/thin/planner.mjs";
import { finalizeWorkerArtifact } from "../src/thin/finalizer.mjs";
import { runThinRepair } from "../src/thin/repair.mjs";

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

test("runs exactly one controller-bounded repair after final verification failure and returns its verified candidate", async (t) => {
  const { root, runtime } = fixture(t); const events = []; let verificationCalls = 0; let repairWorkerCalls = 0;
  const result = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "x", onEvent: (event) => events.push(event),
    planner: plan([task("A", ["src"])]),
    workerExecutor: async ({ worktree }) => { mkdirSync(join(worktree, "src")); writeFileSync(join(worktree, "src", "a.txt"), "a"); },
    verifyIntegration: async ({ worktree }) => {
      verificationCalls += 1;
      return { ok: existsSync(join(worktree, "src", "repair.txt")), output: "expected repair.txt" };
    },
    repair: async ({ verificationFailure, candidateSha, worktree, artifacts, attempts }) => {
      const repair = await runThinRepair({
        verificationFailure, candidateSha, attempts, repairSurface: ["src"],
        previousWaveTaskScopes: artifacts.map((artifact) => ({ taskId: artifact.taskKey, allowedPaths: artifact.changedPaths })),
        planRepair: async () => ({ title: "Repair", prompt: "add repair file", allowedPaths: ["src"] }),
        executeRepair: async ({ candidateSha: repairBaseSha, repairPlan }) => {
          repairWorkerCalls += 1;
          writeFileSync(join(worktree, "src", "repair.txt"), "repaired");
          return finalizeWorkerArtifact({ taskId: "repair-1", worktree, baseSha: repairBaseSha, allowedPaths: repairPlan.allowedPaths });
        },
      });
      return repair.ok ? { ok: true, candidateSha: repair.artifact.commitSha, artifact: repair.artifact, attempts: repair.attempts } : repair;
    },
  });
  assert.equal(result.ok, true); assert.equal(verificationCalls, 2); assert.equal(repairWorkerCalls, 1);
  assert.equal(result.artifacts.filter((artifact) => artifact.repair).length, 1);
  assert.ok(events.some((event) => event.type === "repair_started"));
  assert.ok(events.some((event) => event.type === "repair_committed"));
  assert.ok(events.some((event) => event.type === "repair_test_passed"));
});

test("rejects an unsafe repair plan before any repair worker starts", async (t) => {
  const { root, runtime } = fixture(t); let repairWorkerCalls = 0;
  const result = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "x", planner: plan([task("A", ["src"])]),
    workerExecutor: async ({ worktree }) => { mkdirSync(join(worktree, "src")); writeFileSync(join(worktree, "src", "a.txt"), "a"); },
    verifyIntegration: async () => ({ ok: false, output: "test failure" }),
    repair: ({ verificationFailure, candidateSha, artifacts, attempts }) => runThinRepair({
      verificationFailure, candidateSha, attempts, repairSurface: ["src"],
      previousWaveTaskScopes: artifacts.map((artifact) => ({ taskId: artifact.taskKey, allowedPaths: artifact.changedPaths })),
      planRepair: async () => ({ title: "Unsafe", prompt: "edit package", allowedPaths: ["package.json"] }),
      executeRepair: async () => { repairWorkerCalls += 1; },
    }),
  });
  assert.equal(result.ok, false); assert.equal(result.stage, "repair"); assert.equal(result.code, "repair_plan_rejected");
  assert.equal(repairWorkerCalls, 0); assert.ok(existsSync(result.recoveryWorktree));
});

test("does not attempt a second repair when the single repair retry still fails verification", async (t) => {
  const { root, runtime } = fixture(t); let verificationCalls = 0; let repairCalls = 0;
  const result = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "x", planner: plan([task("A", ["src"])]),
    workerExecutor: async ({ worktree }) => { mkdirSync(join(worktree, "src")); writeFileSync(join(worktree, "src", "a.txt"), "a"); },
    verifyIntegration: async () => { verificationCalls += 1; return { ok: false, output: "still failing" }; },
    repair: async ({ verificationFailure, candidateSha, worktree, artifacts, attempts }) => {
      repairCalls += 1;
      const repair = await runThinRepair({
        verificationFailure, candidateSha, attempts, repairSurface: ["src"],
        previousWaveTaskScopes: artifacts.map((artifact) => ({ taskId: artifact.taskKey, allowedPaths: artifact.changedPaths })),
        planRepair: async () => ({ title: "Repair", prompt: "write repair", allowedPaths: ["src"] }),
        executeRepair: async ({ candidateSha: repairBaseSha, repairPlan }) => {
          writeFileSync(join(worktree, "src", "repair.txt"), "repaired");
          return finalizeWorkerArtifact({ taskId: "repair-1", worktree, baseSha: repairBaseSha, allowedPaths: repairPlan.allowedPaths });
        },
      });
      return { ok: true, candidateSha: repair.artifact.commitSha, artifact: repair.artifact, attempts: repair.attempts };
    },
  });
  assert.equal(result.ok, false); assert.equal(result.code, "verification_failed_after_repair");
  assert.equal(verificationCalls, 2); assert.equal(repairCalls, 1); assert.ok(existsSync(result.recoveryWorktree));
});

test("integrates a scaffold wave before two parallel dependent writers with exact candidate lineage", async (t) => {
  const { root, runtime } = fixture(t); const initialSha = git(root, "rev-parse", "HEAD"); const starts = []; const events = [];
  const result = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "x", onEvent: (event) => events.push(event),
    planner: plan([
      task("Scaffold", ["scaffold.txt"]),
      task("Frontend", ["apps/web"], ["Scaffold"]),
      task("Backend", ["apps/api"], ["Scaffold"]),
    ]),
    workerExecutor: async ({ task: current, worktree, baseSha, waveNumber }) => {
      starts.push({ title: current.title, baseSha, waveNumber });
      const file = current.title === "Scaffold" ? join(worktree, "scaffold.txt")
        : current.title === "Frontend" ? join(worktree, "apps", "web", "page.txt")
          : join(worktree, "apps", "api", "route.txt");
      mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, `${current.title}\n`);
    },
    verifyIntegration: async ({ worktree, candidateSha, waves }) => {
      assert.equal(git(worktree, "rev-parse", "HEAD"), candidateSha);
      for (const file of ["scaffold.txt", "apps/web/page.txt", "apps/api/route.txt"]) assert.ok(existsSync(join(worktree, file)));
      assert.equal(waves.length, 2);
      return { ok: true };
    },
  });
  assert.equal(result.ok, true); assert.equal(result.waves.length, 2); assert.equal(result.artifacts.length, 3);
  assert.deepEqual(result.waves.map((wave) => wave.taskKeys.length), [1, 2]);
  const scaffold = starts.find((entry) => entry.title === "Scaffold");
  const frontend = starts.find((entry) => entry.title === "Frontend"); const backend = starts.find((entry) => entry.title === "Backend");
  assert.equal(scaffold.baseSha, initialSha);
  assert.equal(frontend.baseSha, result.waves[0].candidateSha); assert.equal(backend.baseSha, result.waves[0].candidateSha);
  assert.ok(events.some((event) => event.type === "wave_started" && event.waveNumber === 1));
  assert.ok(events.some((event) => event.type === "wave_candidate" && event.waveNumber === 2 && event.candidateSha === result.candidateSha));
});

test("dispatches no more than two ready workers in a wave", async (t) => {
  const { root, runtime } = fixture(t); let active = 0; let maxActive = 0;
  const result = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "x",
    planner: plan([task("A", ["src/a"]), task("B", ["src/b"]), task("C", ["src/c"])]),
    workerExecutor: async ({ task: current, worktree }) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      const file = join(worktree, current.allowedPaths[0], "value.txt");
      mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, current.title);
      active -= 1;
    },
  });
  assert.equal(result.ok, true); assert.equal(maxActive, 2); assert.deepEqual(result.waves.map((wave) => wave.taskKeys.length), [2, 1]);
});

test("rejects invalid graph and same-wave overlaps before creating workers", async (t) => {
  const { root, runtime } = fixture(t); let calls = 0;
  const cycle = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "x",
    planner: plan([task("A", ["a"], ["B"]), task("B", ["b"], ["A"])]), workerExecutor: async () => { calls += 1; },
  });
  assert.equal(cycle.code, "dependency_cycle");
  const unknown = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "x",
    planner: plan([task("A", ["a"], ["Missing"])]), workerExecutor: async () => { calls += 1; },
  });
  assert.equal(unknown.code, "unknown_dependency");
  const overlap = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "x",
    planner: plan([task("A", ["apps"]), task("B", ["apps/web"])]), workerExecutor: async () => { calls += 1; },
  });
  assert.equal(overlap.code, "overlapping_paths"); assert.equal(calls, 0);
});

test("failed predecessor blocks its successors while independent wave work is allowed to finish", async (t) => {
  const { root, runtime } = fixture(t); const started = [];
  const tasks = [task("A", ["src/a"]), task("B", ["src/b"], ["A"]), task("C", ["src/c"])];
  const result = await runThinOrchestrator({
    repository: root, runtimeDir: runtime, markdown: "x",
    planner: plan(tasks),
    workerExecutor: async ({ task: current, worktree }) => {
      started.push(current.title);
      if (current.title === "A") throw new Error("intentional writer failure");
      const file = join(worktree, "src", "c", "value.txt"); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "C");
    },
  });
  assert.equal(result.ok, false); assert.equal(result.code, "worker_failed");
  assert.ok(started.includes("A")); assert.ok(started.includes("C")); assert.equal(started.includes("B"), false);
  const blocked = validateThinPlanCandidate({ tasks }).tasks.find((item) => item.title === "B").id;
  assert.deepEqual(result.blockedTaskKeys, [blocked]);
});
