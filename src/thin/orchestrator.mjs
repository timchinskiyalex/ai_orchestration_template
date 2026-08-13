import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createIsolatedWorktree, removeIsolatedWorktree } from "./git-worktree.mjs";
import { finalizeWorkerArtifact } from "./finalizer.mjs";
import { validateThinPlanCandidate } from "./planner.mjs";

const exec = promisify(execFile);
const INTEGRATION_IDENTITY = { name: "Thin Orchestrator", email: "thin-orchestrator@local" };
const MAX_WORKERS_PER_WAVE = 2;

async function git(cwd, args) {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return String(result.stdout).trim();
}

function safeErrorCode(error, fallback) {
  const message = String(error?.message ?? error);
  if (/overlapping (allowed|ownership) paths/i.test(message)) return "overlapping_paths";
  if (/unknown task/i.test(message)) return "unknown_dependency";
  if (/cycle/i.test(message)) return "dependency_cycle";
  if (/dependency/i.test(message)) return "invalid_dependency";
  return fallback;
}

function fail({ emit, stage, code, taskKey = null, recoveryWorktree = null, error = null, details = {} }) {
  const result = { ok: false, stage, code, taskKey, recoveryWorktree, ...details };
  emit({ type: "failure", ...result, message: error ? String(error.message ?? error).slice(0, 500) : undefined });
  return result;
}

function normalizeVerification(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError("worker executor verification must be an array");
  return value;
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertWavePathsDoNotOverlap(tasks) {
  for (let left = 0; left < tasks.length; left += 1) {
    for (let right = left + 1; right < tasks.length; right += 1) {
      for (const leftPath of tasks[left].allowedPaths) for (const rightPath of tasks[right].allowedPaths) {
        if (pathsOverlap(leftPath, rightPath)) {
          throw new Error(`same wave tasks '${tasks[left].title}' and '${tasks[right].title}' have overlapping allowed paths '${leftPath}' and '${rightPath}'`);
        }
      }
    }
  }
}

/**
 * Returns the next deterministic topological batch. The planner owns only
 * semantic edges; the controller owns task IDs, readiness and worker limits.
 */
export function selectThinWave({ tasks, completedTaskKeys, limit = MAX_WORKERS_PER_WAVE }) {
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array");
  if (!(completedTaskKeys instanceof Set)) throw new TypeError("completedTaskKeys must be a Set");
  const pending = tasks.filter((task) => !completedTaskKeys.has(task.id));
  const ready = pending.filter((task) => task.dependsOn.every((dependency) => completedTaskKeys.has(dependency)));
  const wave = ready.slice(0, limit);
  assertWavePathsDoNotOverlap(wave);
  return { pending, ready, wave };
}

async function runWorkerWave({ repository, runtimeDir, baseSha, waveNumber, tasks, workerExecutor, emit }) {
  const workers = [];
  try {
    for (const task of tasks) {
      const isolated = await createIsolatedWorktree({ repository, runtimeDir, taskId: task.id, baseSha });
      workers.push({ task, isolated });
    }
  } catch (error) {
    return { ok: false, stage: "worktree", code: "worktree_creation_failed", error };
  }

  let pending = workers.length;
  emit({ type: "heartbeat", pendingWorkers: pending, waveNumber });
  const outcomes = await Promise.all(workers.map(async ({ task, isolated }) => {
    const taskKey = task.id;
    emit({ type: "worker_started", taskKey, worktree: isolated.worktree, baseSha, waveNumber });
    try {
      const workerResult = await workerExecutor({ task, taskKey, worktree: isolated.worktree, baseSha, waveNumber });
      const artifact = await finalizeWorkerArtifact({
        taskId: taskKey,
        worktree: isolated.worktree,
        baseSha,
        allowedPaths: task.allowedPaths,
        verification: normalizeVerification(workerResult?.verification),
        processRunner: workerResult?.processRunner,
      });
      emit({ type: "commit", taskKey, commitSha: artifact.commitSha, changedPaths: artifact.changedPaths, waveNumber });
      return { ok: true, taskKey, task, isolated, artifact };
    } catch (error) {
      return { ok: false, taskKey, task, isolated, error };
    } finally {
      pending -= 1;
      emit({ type: "heartbeat", pendingWorkers: pending, waveNumber });
    }
  }));
  return { ok: true, outcomes };
}

async function integrateWave({ repository, runtimeDir, baseSha, outcomes, waveNumber, emit }) {
  let integration;
  try {
    integration = await createIsolatedWorktree({ repository, runtimeDir, taskId: `wave-${waveNumber}-integration`, baseSha });
    for (const outcome of [...outcomes].sort((left, right) => left.taskKey.localeCompare(right.taskKey))) {
      await git(integration.worktree, [
        "-c", `user.name=${INTEGRATION_IDENTITY.name}`,
        "-c", `user.email=${INTEGRATION_IDENTITY.email}`,
        "cherry-pick", outcome.artifact.commitSha,
      ]);
    }
    const candidateSha = await git(integration.worktree, ["rev-parse", "HEAD"]);
    emit({ type: "wave_candidate", waveNumber, candidateSha, baseSha, taskKeys: outcomes.map((outcome) => outcome.taskKey) });
    for (const outcome of outcomes) await removeIsolatedWorktree(outcome.isolated);
    await removeIsolatedWorktree(integration);
    return { ok: true, candidateSha };
  } catch (error) {
    return { ok: false, code: "integration_failed", error, recoveryWorktree: integration?.worktree ?? null };
  }
}

function descendantTaskKeys(tasks, failedTaskKey) {
  const blocked = new Set([failedTaskKey]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (!blocked.has(task.id) && task.dependsOn.some((dependency) => blocked.has(dependency))) {
        blocked.add(task.id);
        changed = true;
      }
    }
  }
  blocked.delete(failedTaskKey);
  return [...blocked].sort();
}

/**
 * Thin controller for a bounded topological delivery. It owns Git bases and
 * integration candidates; workers own only their isolated worktree diffs.
 */
export async function runThinOrchestrator({
  repository,
  runtimeDir,
  markdown,
  planner,
  workerExecutor,
  verifyIntegration = async () => ({ ok: true }),
  repair = null,
  onEvent = () => {},
  heartbeatMs = 5_000,
}) {
  if (typeof planner !== "function") throw new TypeError("planner must be a function");
  if (typeof workerExecutor !== "function") throw new TypeError("workerExecutor must be a function");
  if (typeof verifyIntegration !== "function") throw new TypeError("verifyIntegration must be a function");
  if (repair != null && typeof repair !== "function") throw new TypeError("repair must be a function when provided");
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 10_000) {
    throw new RangeError("heartbeatMs must be an integer from 1 through 10000");
  }
  const emit = (event) => onEvent({ at: new Date().toISOString(), ...event });

  let rawPlan;
  try { rawPlan = await planner({ markdown }); }
  catch (error) { return fail({ emit, stage: "plan", code: "planner_failed", error }); }

  let plan;
  try { plan = validateThinPlanCandidate(rawPlan); }
  catch (error) { return fail({ emit, stage: "plan", code: safeErrorCode(error, "invalid_plan"), error }); }

  let initialBaseSha;
  try { initialBaseSha = await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"]); }
  catch (error) { return fail({ emit, stage: "admission", code: "repository_unavailable", error }); }
  emit({ type: "plan_accepted", taskCount: plan.tasks.length, baseSha: initialBaseSha });

  const completedTaskKeys = new Set();
  const artifacts = [];
  const waves = [];
  let candidateSha = initialBaseSha;
  let waveNumber = 0;

  while (completedTaskKeys.size < plan.tasks.length) {
    let selection;
    try { selection = selectThinWave({ tasks: plan.tasks, completedTaskKeys }); }
    catch (error) { return fail({ emit, stage: "plan", code: safeErrorCode(error, "same_wave_path_overlap"), error }); }
    if (!selection.wave.length) {
      return fail({
        emit,
        stage: "dispatch",
        code: "dependency_deadlock",
        details: { pendingTaskKeys: selection.pending.map((task) => task.id) },
      });
    }

    waveNumber += 1;
    const waveBaseSha = candidateSha;
    emit({ type: "wave_started", waveNumber, baseSha: waveBaseSha, taskKeys: selection.wave.map((task) => task.id) });
    const workerWave = await runWorkerWave({
      repository, runtimeDir, baseSha: waveBaseSha, waveNumber,
      tasks: selection.wave, workerExecutor, emit,
    });
    if (!workerWave.ok) return fail({ emit, stage: workerWave.stage, code: workerWave.code, error: workerWave.error });

    const failed = workerWave.outcomes.find((outcome) => !outcome.ok);
    if (failed) {
      return fail({
        emit,
        stage: "worker",
        code: "worker_failed",
        taskKey: failed.taskKey,
        recoveryWorktree: failed.isolated.worktree,
        error: failed.error,
        details: {
          completedTaskKeys: workerWave.outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.taskKey).sort(),
          blockedTaskKeys: descendantTaskKeys(plan.tasks, failed.taskKey),
        },
      });
    }

    const integrated = await integrateWave({
      repository, runtimeDir, baseSha: waveBaseSha, outcomes: workerWave.outcomes, waveNumber, emit,
    });
    if (!integrated.ok) {
      return fail({ emit, stage: "integration", code: integrated.code, recoveryWorktree: integrated.recoveryWorktree, error: integrated.error });
    }
    candidateSha = integrated.candidateSha;
    for (const outcome of workerWave.outcomes) {
      completedTaskKeys.add(outcome.taskKey);
      artifacts.push({ ...outcome.artifact, taskKey: outcome.taskKey, waveNumber });
    }
    waves.push({ waveNumber, baseSha: waveBaseSha, candidateSha, taskKeys: workerWave.outcomes.map((outcome) => outcome.taskKey).sort() });
  }

  let verification;
  try {
    verification = await createIsolatedWorktree({ repository, runtimeDir, taskId: "final-verification", baseSha: candidateSha });
    emit({ type: "integration_started", worktree: verification.worktree, baseSha: candidateSha });
  } catch (error) {
    return fail({ emit, stage: "integration", code: "integration_failed", recoveryWorktree: verification?.worktree ?? null, error });
  }

  let verificationFailure;
  try {
    const result = await verifyIntegration({ worktree: verification.worktree, baseSha: initialBaseSha, candidateSha, artifacts, waves });
    if (result === false || result?.ok === false) verificationFailure = result ?? { ok: false };
  } catch (error) {
    verificationFailure = error;
  }

  if (verificationFailure) {
    if (verificationFailure?.noRepair) {
      return fail({ emit, stage: "integration", code: "verification_environment_failed", recoveryWorktree: verification.worktree, error: verificationFailure });
    }
    if (!repair) {
      return fail({ emit, stage: "integration", code: "verification_failed", recoveryWorktree: verification.worktree, error: verificationFailure });
    }
    emit({ type: "repair_started", candidateSha, worktree: verification.worktree });
    let repaired;
    try {
      repaired = await repair({
        verificationFailure,
        candidateSha,
        baseSha: initialBaseSha,
        worktree: verification.worktree,
        artifacts,
        waves,
        attempts: 0,
      });
    } catch (error) {
      return fail({ emit, stage: "repair", code: "repair_failed", recoveryWorktree: verification.worktree, error });
    }
    if (repaired?.ok !== true || typeof repaired.candidateSha !== "string") {
      return fail({
        emit,
        stage: "repair",
        code: repaired?.reasonCode ?? "repair_failed",
        recoveryWorktree: verification.worktree,
        error: repaired?.detail ? new Error(repaired.detail) : null,
        details: { repairAttempts: repaired?.attempts ?? 0 },
      });
    }
    candidateSha = repaired.candidateSha;
    if (repaired.artifact) artifacts.push({ ...repaired.artifact, taskKey: "repair-1", waveNumber: waveNumber + 1, repair: true });
    emit({ type: "repair_committed", candidateSha, attempts: repaired.attempts ?? 1 });

    try {
      const retry = await verifyIntegration({ worktree: verification.worktree, baseSha: initialBaseSha, candidateSha, artifacts, waves });
      if (retry === false || retry?.ok === false) {
        return fail({ emit, stage: "integration", code: "verification_failed_after_repair", recoveryWorktree: verification.worktree });
      }
    } catch (error) {
      return fail({ emit, stage: "integration", code: "verification_failed_after_repair", recoveryWorktree: verification.worktree, error });
    }
    emit({ type: "repair_test_passed", candidateSha });
  }

  emit({ type: "integration_test_passed", candidateSha });
  emit({ type: "completed", candidateSha, artifactCount: artifacts.length, waveCount: waves.length });
  try { await removeIsolatedWorktree(verification); }
  catch (error) { return fail({ emit, stage: "integration", code: "verification_cleanup_failed", recoveryWorktree: verification.worktree, error }); }
  return { ok: true, candidateSha, artifacts, waves };
}
