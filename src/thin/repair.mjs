import { normalizeRelativePath } from "./planner.mjs";

const REPAIR_PLAN_KEYS = new Set(["title", "prompt", "allowedPaths"]);
const MAX_FAILURE_OUTPUT = 4_000;

/**
 * Run exactly one controller-authorized repair attempt.
 *
 * This is deliberately an injected primitive: the caller owns persistence,
 * worktrees and the App Server worker executor.  The repair model can propose
 * semantics only; its write surface is bounded by controller-derived paths.
 */
export async function runThinRepair({
  verificationFailure,
  candidateSha,
  previousWaveTaskScopes,
  repairSurface,
  planRepair,
  executeRepair,
  attempts = 0,
  maxAttempts = 1,
} = {}) {
  const failureOutput = redactAndBoundFailureOutput(verificationFailure);
  if (maxAttempts !== 1) {
    throw new Error("thin repair supports exactly one maxAttempts value");
  }
  if (!Number.isInteger(attempts) || attempts < 0) throw new TypeError("attempts must be a non-negative integer");
  if (attempts >= maxAttempts) return failure("repair_attempt_limit_reached", { candidateSha, failureOutput, attempts });
  if (typeof candidateSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(candidateSha)) {
    throw new TypeError("candidateSha must be a Git SHA");
  }
  if (typeof planRepair !== "function" || typeof executeRepair !== "function") {
    throw new TypeError("planRepair and executeRepair must be functions");
  }

  const normalizedSurface = normalizeRepairSurface(repairSurface);
  const scopes = normalizePreviousScopes(previousWaveTaskScopes);
  let proposed;
  try {
    proposed = await planRepair({
      verificationFailure: failureOutput,
      candidateSha,
      previousWaveTaskScopes: scopes,
      repairSurface: normalizedSurface,
    });
  } catch (error) {
    return failure("repair_planning_failed", { candidateSha, failureOutput, attempts, detail: safeError(error) });
  }
  if (proposed == null) return failure("repair_plan_missing", { candidateSha, failureOutput, attempts });

  let plan;
  try {
    plan = validateRepairPlan(proposed, normalizedSurface);
  } catch (error) {
    return failure("repair_plan_rejected", { candidateSha, failureOutput, attempts, detail: safeError(error) });
  }

  try {
    const artifact = await executeRepair({
      candidateSha,
      repairPlan: plan,
      verificationFailure: failureOutput,
      previousWaveTaskScopes: scopes,
    });
    if (artifact == null) return failure("repair_worker_no_artifact", { candidateSha, failureOutput, attempts: attempts + 1 });
    return { ok: true, status: "repair_artifact_ready", candidateSha, attempts: attempts + 1, plan, artifact };
  } catch (error) {
    return failure("repair_worker_failed", { candidateSha, failureOutput, attempts: attempts + 1, detail: safeError(error) });
  }
}

export function validateRepairPlan(candidate, repairSurface) {
  if (!isPlainObject(candidate)) throw new TypeError("repair plan must be an object");
  assertExactKeys(candidate, REPAIR_PLAN_KEYS, "repair plan");
  const title = text(candidate.title, "repair title");
  const prompt = text(candidate.prompt, "repair prompt");
  if (!Array.isArray(candidate.allowedPaths) || candidate.allowedPaths.length === 0) {
    throw new Error("repair plan must declare at least one allowed path");
  }
  const allowedPaths = [...new Set(candidate.allowedPaths.map((path) => normalizeRelativePath(path)))];
  const surface = normalizeRepairSurface(repairSurface);
  for (const path of allowedPaths) {
    if (!surface.some((root) => isInsideSurface(path, root))) {
      throw new Error(`repair path '${path}' is outside the controller repair surface`);
    }
  }
  return { title, prompt, allowedPaths };
}

export function redactAndBoundFailureOutput(value) {
  const input = typeof value === "string" ? value : value?.output ?? value?.message ?? "";
  let safe = String(input)
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s]+/gi, "$1[REDACTED]");
  if (safe.length > MAX_FAILURE_OUTPUT) safe = `${safe.slice(0, MAX_FAILURE_OUTPUT)}…[truncated]`;
  return safe;
}

function normalizeRepairSurface(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("repairSurface must declare explicit allowed paths");
  return [...new Set(value.map((path) => normalizeRelativePath(path)))];
}

function normalizePreviousScopes(value) {
  if (!Array.isArray(value)) throw new TypeError("previousWaveTaskScopes must be an array");
  return value.map((scope, index) => {
    if (!isPlainObject(scope)) throw new TypeError(`previous wave scope ${index + 1} must be an object`);
    const taskId = text(scope.taskId, `previous wave scope ${index + 1} taskId`);
    if (!Array.isArray(scope.allowedPaths)) throw new TypeError(`previous wave scope ${index + 1} allowedPaths must be an array`);
    return { taskId, allowedPaths: [...new Set(scope.allowedPaths.map((path) => normalizeRelativePath(path)))] };
  });
}

function failure(reasonCode, fields) { return { ok: false, status: "repair_failed", reasonCode, ...fields }; }
function isInsideSurface(path, root) { return path === root || path.startsWith(`${root}/`); }
function safeError(error) { return String(error?.message ?? error).slice(0, 300); }
function text(value, label) { if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function assertExactKeys(value, keys, label) {
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`${label} contains forbidden field '${key}'`);
  for (const key of keys) if (!(key in value)) throw new Error(`${label} is missing required field '${key}'`);
}
