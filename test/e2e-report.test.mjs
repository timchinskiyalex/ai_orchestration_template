import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createE2eRunReporter, readLatestE2eReport } from "../src/e2e-report.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("live E2E launcher refuses to spend quota without the explicit confirmation flag", () => {
  const result = spawnSync(process.execPath, ["scripts/e2e-live.mjs"], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--confirm-spend-quota/);
});

test("live E2E workers propagate from CLI through environment to the deterministic fixture without spending quota", () => {
  const result = spawnSync(process.execPath, ["scripts/e2e-live.mjs", "--verify-worker-config", "--workers", "2"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("E2E reporter creates a safe run directory, updates latest, and finalizes failure", () => {
  const reportsRoot = mkdtempSync(join(tmpdir(), "e2e-reports-"));
  try {
    const reporter = createE2eRunReporter({ reportsRoot, runId: "run-1" });
    reporter.event("thread started", { taskId: "task-1", threadId: "thread-1", prompt: "SECRET PROMPT", rawPayload: { secret: "value" }, tokenUsage: { totalTokens: 12, text: "hidden" } });
    const error = new Error("integration token=top-secret failed");
    error.code = "INTEGRATION_FAILED";
    error.stdout = "stdout token=top-secret";
    error.stderr = "stderr secret=top-secret";
    reporter.finalize({
      status: "failed", task: { id: "task-1", status: "failed", threadId: "thread-1", turnId: "turn-1", prompt: "do not retain" }, error,
      artifact: { taskId: "task-1", headSha: "abc123", path: "docs/orchestration-generated/worker-artifacts/task-1.v1.json" },
      integration: { path: "docs/orchestration-generated/integration-manifests/blocked.json", manifest: { status: "CONFLICT_BLOCKED", blockedReason: "overlapping migration", worktree: "C:/temp/integration" } },
      diagnostics: { task: { id: "security-actual", status: "interrupted", threadId: "thread-actual", turnId: "turn-actual" }, threadRead: { available: false, threadId: "thread-actual", turnId: "turn-actual", reason: "token=top-secret" }, appServer: { process: { alive: false, exited: true, code: 17, signal: "SIGTERM" }, stderrTail: `secret=top-secret ${"x".repeat(5_000)}`, protocolEvents: [{ direction: "processExit", threadId: "thread-actual", turnId: "turn-actual", errorMessage: "token=top-secret" }] }, lifecycleEvents: [{ type: "execution provider lifecycle failure", taskId: "security-actual", threadId: "thread-actual", turnId: "turn-actual", taxonomy: "execution_provider_process_exit" }], primaryFailure: { taxonomy: "execution_provider_process_exit", providerErrorCode: "process_exit", recoveryState: "resume", activeTasks: [{ taskId: "security-actual", threadId: "thread-actual", turnId: "turn-actual", status: "running" }] } }
    });
    assert.equal(existsSync(join(reportsRoot, "run-1", "events.jsonl")), true);
    assert.equal(existsSync(join(reportsRoot, "run-1", "summary.json")), true);
    const output = `${readFileSync(join(reportsRoot, "run-1", "events.jsonl"), "utf8")}${readFileSync(join(reportsRoot, "run-1", "summary.json"), "utf8")}`;
    assert.doesNotMatch(output, /SECRET PROMPT|rawPayload|do not retain|top-secret/);
    assert.match(output, /"totalTokens":12/);
    const latest = readLatestE2eReport(reportsRoot);
    assert.equal(latest.status, "failed");
    assert.equal(latest.runId, "run-1");
    assert.equal(latest.resultPath.endsWith("summary.json"), true);
    assert.equal(latest.error.code, "INTEGRATION_FAILED");
    assert.match(latest.error.message, /token=\[redacted\]/);
    assert.equal(latest.integration.status, "CONFLICT_BLOCKED");
    assert.equal(latest.integration.blockedReason, "overlapping migration");
    assert.equal(latest.artifact.path, "docs/orchestration-generated/worker-artifacts/task-1.v1.json");
    assert.equal(latest.diagnostics.task.id, "security-actual");
    assert.deepEqual(latest.diagnostics.process, { alive: false, exited: true, code: 17, signal: "SIGTERM" });
    assert.equal(latest.diagnostics.stderrTail.length <= 4_000, true);
    assert.doesNotMatch(latest.diagnostics.stderrTail, /top-secret/);
    assert.equal(latest.diagnostics.primaryFailure.taxonomy, "execution_provider_process_exit");
    assert.deepEqual(latest.diagnostics.primaryFailure.activeTasks, [{ taskId: "security-actual", threadId: "thread-actual", turnId: "turn-actual", status: "running" }]);
  } finally { rmSync(reportsRoot, { recursive: true, force: true }); }
});

test("template .gitignore excludes persistent E2E reports", () => {
  execFileSync("git", ["-C", root, "check-ignore", "-q", "runtime/e2e-runs/example/summary.json"]);
});
