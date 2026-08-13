import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createIsolatedWorktree, removeIsolatedWorktree } from "./git-worktree.mjs";
import { finalizeWorkerArtifact } from "./finalizer.mjs";
import { validateThinPlanCandidate } from "./planner.mjs";

const exec = promisify(execFile);
const INTEGRATION_IDENTITY = { name: "Thin Orchestrator", email: "thin-orchestrator@local" };

async function git(cwd, args) {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return String(result.stdout).trim();
}

function safeErrorCode(error, fallback) {
  const message = String(error?.message ?? error);
  if (/overlapping allowed paths/i.test(message)) return "overlapping_paths";
  if (/dependency/i.test(message)) return "unsupported_dependency";
  return fallback;
}

function fail({ emit, stage, code, taskKey = null, recoveryWorktree = null, error = null }) {
  const result = { ok: false, stage, code, taskKey, recoveryWorktree };
  emit({ type: "failure", ...result, message: error ? String(error.message ?? error).slice(0, 500) : undefined });
  return result;
}

function normalizeVerification(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError("worker executor verification must be an array");
  return value;
}

/**
 * Small, one-wave controller. It deliberately has no Router, StateStore, or
 * product-specification imports: it only owns Git isolation and integration.
 */
export async function runThinOrchestrator({
  repository,
  runtimeDir,
  markdown,
  planner,
  workerExecutor,
  verifyIntegration = async () => ({ ok: true }),
  onEvent = () => {},
  heartbeatMs = 5_000,
}) {
  if (typeof planner !== "function") throw new TypeError("planner must be a function");
  if (typeof workerExecutor !== "function") throw new TypeError("workerExecutor must be a function");
  if (typeof verifyIntegration !== "function") throw new TypeError("verifyIntegration must be a function");
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 10_000) {
    throw new RangeError("heartbeatMs must be an integer from 1 through 10000");
  }
  const emit = (event) => onEvent({ at: new Date().toISOString(), ...event });

  let rawPlan;
  try {
    rawPlan = await planner({ markdown });
  } catch (error) {
    return fail({ emit, stage: "plan", code: "planner_failed", error });
  }

  let plan;
  try {
    plan = validateThinPlanCandidate(rawPlan);
  } catch (error) {
    return fail({ emit, stage: "plan", code: safeErrorCode(error, "invalid_plan"), error });
  }
  if (plan.tasks.some((task) => task.dependsOn.length > 0)) {
    return fail({ emit, stage: "plan", code: "unsupported_dependency" });
  }
  if (plan.tasks.length > 2) {
    return fail({ emit, stage: "plan", code: "unsupported_task_count" });
  }

  let baseSha;
  try {
    baseSha = await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch (error) {
    return fail({ emit, stage: "admission", code: "repository_unavailable", error });
  }
  emit({ type: "plan_accepted", taskCount: plan.tasks.length, baseSha });

  const workers = [];
  try {
    for (const task of plan.tasks) {
      const isolated = await createIsolatedWorktree({ repository, runtimeDir, taskId: task.id, baseSha });
      workers.push({ task, isolated });
    }
  } catch (error) {
    return fail({ emit, stage: "worktree", code: "worktree_creation_failed", error });
  }

  let pending = workers.length;
  // Emit immediately as well as periodically: a caller never has to wait a
  // full interval before it can show that the dispatcher is alive.
  emit({ type: "heartbeat", pendingWorkers: pending });
  const heartbeat = setInterval(() => {
    if (pending > 0) emit({ type: "heartbeat", pendingWorkers: pending });
  }, heartbeatMs);
  try {
    const outcomes = await Promise.all(workers.map(async ({ task, isolated }) => {
      const taskKey = task.id;
      emit({ type: "worker_started", taskKey, worktree: isolated.worktree, baseSha });
      try {
        const workerResult = await workerExecutor({ task, taskKey, worktree: isolated.worktree, baseSha });
        const artifact = await finalizeWorkerArtifact({
          taskId: taskKey,
          worktree: isolated.worktree,
          baseSha,
          allowedPaths: task.allowedPaths,
          verification: normalizeVerification(workerResult?.verification),
          processRunner: workerResult?.processRunner,
        });
        emit({ type: "commit", taskKey, commitSha: artifact.commitSha, changedPaths: artifact.changedPaths });
        return { ok: true, taskKey, task, isolated, artifact };
      } catch (error) {
        return { ok: false, taskKey, task, isolated, error };
      } finally {
        pending -= 1;
      }
    }));
    const failed = outcomes.find((outcome) => !outcome.ok);
    if (failed) {
      return fail({
        emit,
        stage: "worker",
        code: "worker_failed",
        taskKey: failed.taskKey,
        recoveryWorktree: failed.isolated.worktree,
        error: failed.error,
      });
    }

    const artifacts = outcomes.map((outcome) => ({ ...outcome.artifact, taskKey: outcome.taskKey }));
    let integration;
    try {
      integration = await createIsolatedWorktree({ repository, runtimeDir, taskId: "integration", baseSha });
    } catch (error) {
      return fail({ emit, stage: "integration", code: "integration_worktree_failed", error });
    }
    emit({ type: "integration_started", worktree: integration.worktree, baseSha });
    try {
      for (const artifact of [...artifacts].sort((left, right) => left.taskKey.localeCompare(right.taskKey))) {
        await git(integration.worktree, [
          "-c", `user.name=${INTEGRATION_IDENTITY.name}`,
          "-c", `user.email=${INTEGRATION_IDENTITY.email}`,
          "cherry-pick", artifact.commitSha,
        ]);
      }
      const verification = await verifyIntegration({ worktree: integration.worktree, baseSha, artifacts });
      if (verification === false || verification?.ok === false) {
        return fail({ emit, stage: "integration", code: "verification_failed", recoveryWorktree: integration.worktree });
      }
      const candidateSha = await git(integration.worktree, ["rev-parse", "HEAD"]);
      emit({ type: "integration_test_passed", candidateSha });
      emit({ type: "completed", candidateSha, artifactCount: artifacts.length });
      for (const outcome of outcomes) await removeIsolatedWorktree(outcome.isolated);
      await removeIsolatedWorktree(integration);
      return { ok: true, candidateSha, artifacts };
    } catch (error) {
      return fail({ emit, stage: "integration", code: "integration_failed", recoveryWorktree: integration.worktree, error });
    }
  } finally {
    clearInterval(heartbeat);
  }
}
