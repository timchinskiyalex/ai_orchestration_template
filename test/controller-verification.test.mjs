import test from "node:test";
import assert from "node:assert/strict";
import { deriveParallelReadinessEvidence, validateControllerExecutionReference } from "../src/controller-verification.mjs";
import { validateProductAcceptanceReport } from "../src/final-acceptance.mjs";

const candidateSha = "a".repeat(40);
const reference = () => ({ schemaVersion: 1, source: "controller", kind: "controller_execution", capabilityId: "parallel-readiness", capabilityVersion: 1, requirements: ["no_writer_predecessor", "same_wave_eligibility", "overlapping_active_turns", "checkpoint_lineage"], writerRequirementIds: ["alpha", "beta"], minimumConcurrentActiveTurns: 2 });
function store({ serial = false, missingLifecycle = false, alteredLineage = false } = {}) {
  const writers = [
    { id: "task-alpha", deliveryRunId: "run-1", executionIsWriter: true, requirementIds: ["alpha"], planBatchId: "batch-1", wave: 1, dependencies: [], executionDependencies: [] },
    { id: "task-beta", deliveryRunId: "run-1", executionIsWriter: true, requirementIds: ["beta"], planBatchId: "batch-1", wave: 1, dependencies: serial ? ["task-alpha"] : [], executionDependencies: [] }
  ];
  const event = (taskId, type, timestamp) => ({ taskId, type: `lifecycle/${type}`, payload: { timestamp }, createdAt: timestamp });
  const events = missingLifecycle ? [] : [
    event("task-alpha", "turn started", "2026-01-01T00:00:00.000Z"), event("task-beta", "turn started", serial ? "2026-01-01T00:00:02.000Z" : "2026-01-01T00:00:01.000Z"),
    event("task-alpha", "turn terminal candidate", "2026-01-01T00:00:03.000Z"), event("task-beta", "turn terminal candidate", "2026-01-01T00:00:04.000Z")
  ];
  return {
    deliveryRun: (id) => id === "run-1" ? { id, blueprintId: "pb-1" } : null,
    productBlueprint: (id) => id === "pb-1" ? { blueprintId: id } : null,
    listTasks: () => writers,
    planBatch: (id) => id === "batch-1" ? { id, deliveryRunId: "run-1", blueprintId: "pb-1", wave: 1 } : null,
    events: () => events,
    globalWaveCheckpoint: () => ({ id: "checkpoint-1", blueprintId: "pb-1", outputSha: alteredLineage ? "b".repeat(40) : candidateSha })
  };
}
function evidence(options) { return deriveParallelReadinessEvidence({ store: store(options), deliveryRunId: "run-1", blueprintId: "pb-1", requirementId: "independent", criterionId: "concurrent-start", reference: reference(), candidateSha }); }

test("parallel-readiness/v1 derives exact persisted DAG, lifecycle, and checkpoint evidence", () => {
  const result = evidence();
  assert.equal(result.status, "pass");
  assert.deepEqual(result.controllerExecution.taskIds, ["task-alpha", "task-beta"]);
  assert.equal(result.controllerExecution.checkpointSha, candidateSha);
});

test("controller verification fails closed for unknown capabilities, identities, serial turns, lifecycle gaps, and altered lineage", () => {
  assert.throws(() => validateControllerExecutionReference({ ...reference(), capabilityId: "unknown" }), /unavailable/);
  assert.equal(evidence({ serial: true }).status, "not_verified");
  assert.equal(evidence({ missingLifecycle: true }).status, "not_verified");
  assert.equal(evidence({ alteredLineage: true }).status, "not_verified");
  const fakeTask = reference(); fakeTask.writerRequirementIds = ["alpha", "missing"];
  assert.equal(deriveParallelReadinessEvidence({ store: store(), deliveryRunId: "run-1", blueprintId: "pb-1", requirementId: "independent", criterionId: "concurrent-start", reference: fakeTask, candidateSha }).status, "not_verified");
});

test("final acceptance admits controller evidence only with exact candidate and checkpoint binding", () => {
  const blueprint = { blueprintId: "pb-1", documentSetDigest: "d".repeat(64), unresolvedQuestions: [], contradictions: [], requirements: [{ requirementId: "independent", mandatory: true, acceptanceCriteria: [{ criterionId: "concurrent-start", controllerExecution: reference() }] }] };
  const criterion = evidence(); const basic = (kind) => ({ kind, reference: kind, status: "pass", candidateSha });
  const report = { schemaVersion: 1, kind: "ProductAcceptanceReport", deliveryRunId: "run-1", blueprintId: "pb-1", blueprintDigest: "c".repeat(64), documentSetDigest: blueprint.documentSetDigest, integrationManifestPath: "out/manifest.json", integrationManifestId: "manifest-1", candidateSha, generatedAt: "2026-01-01T00:00:00.000Z", evidence: { integration: basic("integration"), qa: basic("qa"), security: basic("security"), productE2e: basic("product"), ci: basic("ci") }, results: [{ requirementId: "independent", criterionId: null, status: "pass", evidence: [basic("lineage")] }, { requirementId: "independent", criterionId: "concurrent-start", status: "pass", evidence: [basic("lineage"), { kind: "controller-execution", ...criterion }] }] };
  assert.doesNotThrow(() => validateProductAcceptanceReport(report, { blueprint, blueprintDigest: "c".repeat(64), manifest: { id: "manifest-1", candidateSha }, manifestPath: "out/manifest.json" }));
  report.results[1].evidence[1].controllerExecution.checkpointSha = "b".repeat(40);
  assert.throws(() => validateProductAcceptanceReport(report, { blueprint, blueprintDigest: "c".repeat(64), manifest: { id: "manifest-1", candidateSha }, manifestPath: "out/manifest.json" }), /controller evidence identity/);
});
