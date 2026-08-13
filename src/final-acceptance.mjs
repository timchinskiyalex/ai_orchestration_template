import { createHash } from "node:crypto";
import { specificationBlockers } from "./product-blueprint.mjs";

export const PRODUCT_ACCEPTANCE_SCHEMA_VERSION = 1;
export const PRODUCT_ACCEPTANCE_KIND = "ProductAcceptanceReport";
export const ACCEPTANCE_STATUSES = new Set(["pass", "failed", "partial", "missing", "not_verified", "blocked"]);
const sha = (value) => /^[a-f0-9]{40,64}$/i.test(value ?? "");
const fail = (message) => { throw new Error(`Invalid ProductAcceptanceReport: ${message}`); };
export const acceptanceDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stable = (value) => typeof value === "string" && value.trim().length > 0;

function validateEvidence(evidence, candidateSha, label) {
  if (!evidence || typeof evidence !== "object" || !ACCEPTANCE_STATUSES.has(evidence.status) || !stable(evidence.kind) || !stable(evidence.reference)) fail(`${label} must have a valid status, stable kind, and stable reference`);
  if (!sha(evidence.candidateSha) || evidence.candidateSha.toLowerCase() !== candidateSha.toLowerCase()) fail(`${label} candidateSha must exactly match the report candidate SHA`);
}

function validateResult(result, knownRequirements, knownCriteria, candidateSha) {
  if (!result || typeof result !== "object" || !ACCEPTANCE_STATUSES.has(result.status)) fail("result has invalid status");
  if (!knownRequirements.has(result.requirementId)) fail(`unknown requirement '${result.requirementId}'`);
  if (result.criterionId !== null && result.criterionId !== undefined && !knownCriteria.has(`${result.requirementId}:${result.criterionId}`)) fail(`unknown criterion '${result.criterionId}'`);
  if (!Array.isArray(result.evidence) || !result.evidence.length) fail(`result '${result.requirementId}' requires structured evidence`);
  for (const evidence of result.evidence) validateEvidence(evidence, candidateSha, "result evidence");
}

function validateCriterionResult(result, candidateSha, criterion = null, blueprintId = null, deliveryRunId = null) {
  const expectedKind = criterion?.controllerExecution ? "controller-execution" : "product-e2e";
  const productEvidence = result.evidence.filter((evidence) => evidence.kind === expectedKind);
  if (productEvidence.length !== 1) fail(`criterion '${result.criterionId}' requires exactly one ${expectedKind} evidence item`);
  const evidence = productEvidence[0];
  if (evidence.requirementId !== result.requirementId || evidence.criterionId !== result.criterionId) fail(`criterion '${result.criterionId}' product evidence does not match its requirement and criterion ids`);
  if (!stable(evidence.testId)) fail(`criterion '${result.criterionId}' product evidence requires a stable testId`);
  if (criterion?.controllerExecution) {
    const binding = evidence.controllerExecution;
    const ref = criterion.controllerExecution;
    const exactIds = (value) => Array.isArray(value) && value.length > 0 && value.every(stable) && new Set(value).size === value.length;
    const exactSet = (left, right) => JSON.stringify([...left ?? []].sort()) === JSON.stringify([...right ?? []].sort());
    const boundedIntervals = Array.isArray(binding?.lifecycleIntervals) && binding.lifecycleIntervals.length === binding.taskIds?.length && binding.lifecycleIntervals.every((interval) => stable(interval?.taskId) && stable(interval?.startedAt) && stable(interval?.terminalAt) && Date.parse(interval.startedAt) <= Date.parse(interval.terminalAt)) && exactSet(binding.lifecycleIntervals.map((interval) => interval.taskId), binding.taskIds);
    const requiresCheckpoint = ref.requirements.includes("checkpoint_lineage");
    const checkpointValid = !requiresCheckpoint || (stable(binding?.checkpointId) && sha(binding?.checkpointSha) && binding.checkpointSha.toLowerCase() === candidateSha.toLowerCase());
    if (evidence.verificationKind !== "controller_execution" || !binding || binding.schemaVersion !== 1 || binding.capabilityId !== ref.capabilityId || binding.capabilityVersion !== ref.capabilityVersion || binding.blueprintId !== blueprintId || binding.deliveryRunId !== deliveryRunId || !stable(binding.planBatchId) || !Number.isInteger(binding.wave) || !exactIds(binding.taskIds) || !exactIds(binding.planTaskIds) || binding.planTaskIds.length !== binding.taskIds.length || !exactSet(binding.writerRequirementIds, ref.writerRequirementIds) || !boundedIntervals || binding.minimumConcurrentActiveTurns !== ref.minimumConcurrentActiveTurns || !checkpointValid || binding.candidateSha?.toLowerCase() !== candidateSha.toLowerCase() || JSON.stringify([...binding.requirements ?? []].sort()) !== JSON.stringify([...ref.requirements].sort())) fail(`criterion '${result.criterionId}' controller evidence identity is invalid or stale`);
  } else if (criterion?.repositoryVerification && evidence.verificationKind !== undefined && evidence.verificationKind !== "repository_command") fail(`criterion '${result.criterionId}' repository verification evidence kind is invalid`);
  if (result.status === "pass" && evidence.status !== "pass") fail(`criterion '${result.criterionId}' cannot pass without passed product evidence`);
  validateEvidence(evidence, candidateSha, `criterion '${result.criterionId}' product evidence`);
}

function validateBehaviorEvidence(report, repositoryBaseline, activeBehaviorIds = null) {
  if (!repositoryBaseline) return;
  if (report.repositoryBaselineDigest !== repositoryBaseline.digest || !Array.isArray(report.behaviorEvidence)) fail("repository baseline identity or behavior evidence is missing");
  const known = new Set(repositoryBaseline.behaviors.map((behavior) => behavior.behaviorId));
  const active = new Set(activeBehaviorIds ?? known);
  if ([...active].some((id) => !known.has(id))) fail("protected behavior activation is invalid");
  if (report.behaviorEvidence.length !== active.size) fail("protected behavior evidence must have exactly one proof per active behavior");
  const seen = new Set(); const commands = new Map(repositoryBaseline.behaviors.map((behavior) => [behavior.behaviorId, behavior.verificationCommandId]));
  for (const evidence of report.behaviorEvidence) {
    if (!evidence || !active.has(evidence.behaviorId) || seen.has(evidence.behaviorId) || evidence.commandId !== commands.get(evidence.behaviorId) || evidence.baselineDigest !== repositoryBaseline.digest || evidence.candidateSha?.toLowerCase() !== report.candidateSha.toLowerCase() || evidence.classification !== "pass" || !stable(evidence.safeReference) || !["passed", "failed", "not-run"].includes(evidence.exitClassification) || !Number.isInteger(evidence.durationMs) || evidence.durationMs < 0) fail("protected behavior evidence is invalid or stale");
    seen.add(evidence.behaviorId);
  }
}

export function validateProductAcceptanceReport(report, { blueprint, blueprintDigest, manifest, manifestPath = null, repositoryBaseline = null, activeBehaviorIds = null } = {}) {
  if (!report || typeof report !== "object") fail("must be an object");
  for (const key of ["schemaVersion", "kind", "deliveryRunId", "blueprintId", "blueprintDigest", "documentSetDigest", "integrationManifestPath", "integrationManifestId", "candidateSha", "generatedAt", "results", "evidence"]) if (!(key in report)) fail(`missing '${key}'`);
  if (report.schemaVersion !== PRODUCT_ACCEPTANCE_SCHEMA_VERSION || report.kind !== PRODUCT_ACCEPTANCE_KIND) fail("schema version or kind is invalid");
  if (!report.deliveryRunId || report.blueprintId !== blueprint?.blueprintId || report.blueprintDigest !== blueprintDigest || report.documentSetDigest !== blueprint?.documentSetDigest) fail("blueprint identity does not match persisted source-backed blueprint");
  if (!sha(report.candidateSha) || !manifest || report.candidateSha.toLowerCase() !== manifest.candidateSha?.toLowerCase()) fail("candidate SHA does not match integration manifest");
  if (report.integrationManifestId !== manifest.id || (manifestPath && report.integrationManifestPath !== manifestPath)) fail("integration manifest identity does not match");
  if (Number.isNaN(Date.parse(report.generatedAt)) || !Array.isArray(report.results) || !report.results.length || !report.evidence || typeof report.evidence !== "object") fail("timestamp, results, or evidence is invalid");
  const knownRequirements = new Set(blueprint.requirements.map((item) => item.requirementId));
  const knownCriteria = new Set(blueprint.requirements.flatMap((item) => item.acceptanceCriteria.map((criterion) => `${item.requirementId}:${criterion.criterionId}`)));
  const criteriaByKey = new Map(blueprint.requirements.flatMap((item) => item.acceptanceCriteria.map((criterion) => [`${item.requirementId}:${criterion.criterionId}`, criterion])));
  for (const category of ["integration", "qa", "security", "productE2e", "ci"]) validateEvidence(report.evidence[category], report.candidateSha, `${category} evidence`);
  const resultKeys = new Set();
  for (const result of report.results) {
    validateResult(result, knownRequirements, knownCriteria, report.candidateSha);
    const key = `${result.requirementId}:${result.criterionId ?? "@requirement"}`;
    if (resultKeys.has(key)) fail(`duplicate result mapping '${key}'`);
    resultKeys.add(key);
    if (result.criterionId !== null && result.criterionId !== undefined) validateCriterionResult(result, report.candidateSha, criteriaByKey.get(`${result.requirementId}:${result.criterionId}`), blueprint.blueprintId, report.deliveryRunId);
  }
  for (const requirement of blueprint.requirements) {
    const requirementResult = report.results.find((item) => item.requirementId === requirement.requirementId && (item.criterionId === null || item.criterionId === undefined));
    if (!requirementResult) fail(`missing requirement result '${requirement.requirementId}'`);
    const criterionResults = requirement.acceptanceCriteria.map((criterion) => {
      const result = report.results.find((item) => item.requirementId === requirement.requirementId && item.criterionId === criterion.criterionId);
      if (!result) fail(`missing criterion result '${criterion.criterionId}'`);
      return result;
    });
    if (requirement.mandatory && requirementResult.status === "pass" && criterionResults.some((result) => result.status !== "pass")) fail(`mandatory requirement '${requirement.requirementId}' cannot pass while a criterion is not pass`);
  }
  validateBehaviorEvidence(report, repositoryBaseline, activeBehaviorIds);
  return structuredClone(report);
}

export function productAcceptancePasses(report, { blueprint, repositoryBaseline = null, activeBehaviorIds = null }) {
  const blockers = specificationBlockers(blueprint);
  if (blockers.length || report.evidence.integration?.status !== "pass" || report.evidence.qa?.status !== "pass" || report.evidence.security?.status !== "pass" || report.evidence.productE2e?.status !== "pass" || report.evidence.ci?.status !== "pass") return false;
  if (repositoryBaseline && (!Array.isArray(report.behaviorEvidence) || report.behaviorEvidence.length !== new Set(activeBehaviorIds ?? repositoryBaseline.behaviors.map((item) => item.behaviorId)).size || report.behaviorEvidence.some((item) => item.classification !== "pass" || item.baselineDigest !== repositoryBaseline.digest))) return false;
  if (report.results.some((result) => result.criterionId !== null && result.criterionId !== undefined && ["failed", "not_verified"].includes(result.status))) return false;
  return blueprint.requirements.filter((item) => item.mandatory).every((requirement) => {
    const requirementResult = report.results.find((item) => item.requirementId === requirement.requirementId && (item.criterionId === null || item.criterionId === undefined));
    return requirementResult?.status === "pass" && requirement.acceptanceCriteria.every((criterion) => report.results.find((item) => item.requirementId === requirement.requirementId && item.criterionId === criterion.criterionId)?.status === "pass");
  });
}
