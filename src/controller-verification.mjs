const SHA = /^[a-f0-9]{40,64}$/i;
const stable = (value) => typeof value === "string" && value.trim().length > 0;
const uniqueIds = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && /^[a-z][a-z0-9-]{0,95}$/.test(item)) && new Set(value).size === value.length;

export const CONTROLLER_VERIFICATION_CAPABILITIES = Object.freeze([{
  schemaVersion: 1,
  capabilityId: "parallel-readiness",
  capabilityVersion: 1,
  kind: "controller_execution",
  proves: ["no_writer_predecessor", "same_wave_eligibility", "overlapping_active_turns", "checkpoint_lineage"]
}]);

export function controllerVerificationCapabilitySnapshot() {
  return structuredClone(CONTROLLER_VERIFICATION_CAPABILITIES);
}

export function validateControllerExecutionReference(value, capabilities = CONTROLLER_VERIFICATION_CAPABILITIES) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || value.source !== "controller" || value.kind !== "controller_execution" || !stable(value.capabilityId) || !Number.isInteger(value.capabilityVersion) || !Array.isArray(value.requirements) || !value.requirements.length || new Set(value.requirements).size !== value.requirements.length || value.requirements.some((item) => typeof item !== "string") || !uniqueIds(value.writerRequirementIds) || !Number.isInteger(value.minimumConcurrentActiveTurns) || value.minimumConcurrentActiveTurns < 2 || value.minimumConcurrentActiveTurns > value.writerRequirementIds.length) throw new Error("controller execution reference is invalid");
  const capability = capabilities.find((item) => item?.schemaVersion === 1 && item.capabilityId === value.capabilityId && item.capabilityVersion === value.capabilityVersion && item.kind === "controller_execution");
  if (!capability) throw new Error(`controller verification capability '${value.capabilityId}/v${value.capabilityVersion}' is unavailable`);
  if (value.requirements.some((item) => !capability.proves.includes(item))) throw new Error(`controller verification capability '${value.capabilityId}/v${value.capabilityVersion}' cannot prove the requested requirement`);
  return structuredClone(value);
}

function eventTime(event) { const value = event?.payload?.timestamp ?? event?.createdAt; const time = Date.parse(value); return Number.isNaN(time) ? null : time; }
function hasPath(byId, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const task = byId.get(from);
  return (task?.dependencies ?? []).concat(task?.executionDependencies ?? []).some((next) => hasPath(byId, next, target, seen));
}

// This function only reads persisted PlanBatch/task/event/checkpoint records.
// It does not infer criteria, create tasks, or accept agent-provided evidence.
export function deriveParallelReadinessEvidence({ store, deliveryRunId, blueprintId, requirementId, criterionId, reference, candidateSha }) {
  const base = { requirementId, criterionId, candidateSha, verificationKind: "controller_execution", testId: `controller/parallel-readiness/v1/${requirementId}/${criterionId}`, status: "not_verified" };
  try {
    const ref = validateControllerExecutionReference(reference);
    if (ref.capabilityId !== "parallel-readiness" || ref.capabilityVersion !== 1 || !SHA.test(candidateSha)) return base;
    const run = store.deliveryRun(deliveryRunId); const blueprint = store.productBlueprint(blueprintId);
    if (!run || run.blueprintId !== blueprintId || !blueprint || blueprint.blueprintId !== blueprintId) return base;
    const all = store.listTasks().filter((task) => task.deliveryRunId === deliveryRunId && task.executionIsWriter);
    const writers = ref.writerRequirementIds.map((required) => {
      const matches = all.filter((task) => task.requirementIds.includes(required));
      return matches.length === 1 ? matches[0] : null;
    });
    if (writers.some((task) => !task) || new Set(writers.map((task) => task.id)).size !== writers.length) return base;
    const batchId = writers[0].planBatchId; const wave = writers[0].wave;
    if (!stable(batchId) || !Number.isInteger(wave) || writers.some((task) => task.planBatchId !== batchId || task.wave !== wave)) return base;
    const batch = store.planBatch(batchId);
    if (!batch || batch.deliveryRunId !== deliveryRunId || batch.blueprintId !== blueprintId || batch.wave !== wave) return base;
    const byId = new Map(store.listTasks().filter((task) => task.deliveryRunId === deliveryRunId).map((task) => [task.id, task]));
    const noPredecessor = writers.every((left, index) => writers.every((right, rightIndex) => index === rightIndex || (!hasPath(byId, left.id, right.id) && !hasPath(byId, right.id, left.id))));
    if (ref.requirements.includes("no_writer_predecessor") && !noPredecessor) return base;
    const events = store.events({ limit: 100000 });
    const interval = (taskId) => {
      const starts = events.filter((event) => event.taskId === taskId && ["lifecycle/turn started", "lifecycle/migrated writer turn started"].includes(event.type)).map(eventTime).filter((item) => item !== null);
      const ends = events.filter((event) => event.taskId === taskId && ["lifecycle/turn terminal candidate", "lifecycle/migrated writer finalized"].includes(event.type)).map(eventTime).filter((item) => item !== null);
      return starts.length === 1 && ends.length >= 1 ? { start: starts[0], end: ends.find((item) => item >= starts[0]) ?? null } : null;
    };
    const intervals = writers.map((task) => interval(task.id));
    const peerDependency = writers.some((task) => task.dependencies.some((dependency) => writers.some((other) => other.id === dependency)) || task.executionDependencies.some((dependency) => writers.some((other) => other.id === dependency)));
    if (ref.requirements.includes("same_wave_eligibility") && peerDependency) return base;
    if (ref.requirements.includes("overlapping_active_turns")) {
      if (intervals.some((item) => !item?.end)) return base;
      const points = intervals.flatMap((item) => [[item.start, 1], [item.end, -1]]).sort((left, right) => left[0] - right[0] || right[1] - left[1]);
      let active = 0; let maximum = 0;
      for (const [, delta] of points) { active += delta; maximum = Math.max(maximum, active); }
      if (maximum < ref.minimumConcurrentActiveTurns) return base;
    }
    const checkpoint = store.globalWaveCheckpoint(deliveryRunId, wave);
    if (ref.requirements.includes("checkpoint_lineage") && (!checkpoint || checkpoint.blueprintId !== blueprintId || checkpoint.outputSha?.toLowerCase() !== candidateSha.toLowerCase())) return base;
    const binding = { schemaVersion: 1, kind: "ControllerExecutionEvidence", capabilityId: ref.capabilityId, capabilityVersion: ref.capabilityVersion, blueprintId, deliveryRunId, planBatchId: batch.id, wave, taskIds: writers.map((task) => task.id).sort(), minimumConcurrentActiveTurns: ref.minimumConcurrentActiveTurns, checkpointId: checkpoint?.id ?? null, checkpointSha: checkpoint?.outputSha ?? null, candidateSha, requirements: [...ref.requirements].sort() };
    return { ...base, status: "pass", reference: `controller-execution:${binding.capabilityId}/v${binding.capabilityVersion}:${binding.planBatchId}:${binding.taskIds.join(",")}:${binding.checkpointId ?? "none"}`, controllerExecution: binding };
  } catch { return base; }
}
