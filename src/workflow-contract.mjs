function fail(message) { throw new Error(`Invalid orchestration JSON: ${message}`); }
import { enforceRoutingInvariants } from "./routing-evaluator.mjs";
import { assertMandatoryRequirementCoverage, authorizeBootstrapClaims, validateRequirementIds } from "./product-blueprint.mjs";
import { isWriteSurfaceAncestorOrSame, normalizeAllowedPaths } from "./write-surface.mjs";
import { validateTaskBaselineBehaviorIds } from "./repository-baseline.mjs";
import { validateProjectMode } from "./project-mode.mjs";
const domains = new Set(["backend", "frontend", "database", "qa", "security", "devops"]);
const riskFlags = new Set(["public_api_change", "auth_or_authorization", "secret_handling", "sensitive_data", "destructive_data_change", "schema_change", "production_write", "network_exposure", "permission_change", "dependency_supply_chain", "irreversible_operation", "high_blast_radius"]);
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
const positive = (value) => Number.isInteger(value) && value > 0;

export function extractOrchestrationJson(text) {
  const match = String(text ?? "").match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (match?.[1] ?? text ?? "").trim();
  try { return JSON.parse(candidate); }
  catch { fail("agent response must contain one valid JSON object in a fenced block"); }
}

export function validateBootstrap(value, { sourceDocuments = null, sourceResolver = null, policyRegistry = null, sourceClaimManifest = null, projectOverlay = null, controllerVerificationCapabilities = null } = {}) {
  try { return authorizeBootstrapClaims(value, { sourceDocuments, sourceResolver, policyRegistry, sourceClaimManifest, projectOverlay, controllerVerificationCapabilities }); }
  catch (error) { fail(error.message.replace(/^Invalid ProductBlueprint: /, "")); }
}

export function validatePlan(value, { maxTasks, productRoots = [], blueprint = null, requirePlanBatch = false, allowPartialRequirementCoverage = false, recovery = false, repositoryBaseline = null, projectMode = null } = {}) {
  const mode = projectMode ? validateProjectMode(projectMode) : null;
  if (!value || typeof value !== "object" || !Array.isArray(value.tasks)) fail("PlanBatch must contain a tasks array");
  if (mode && (!value.projectMode || validateProjectMode(value.projectMode).mode !== mode.mode)) fail("PlanBatch ProjectMode must match the persisted delivery mode");
  const hasBatchFields = ["schemaVersion", "kind", "id", "deliveryRunId", "wave", "basedOnCheckpointSha", "createdAt"].some((key) => key in value);
  if (requirePlanBatch || hasBatchFields) {
    for (const key of ["schemaVersion", "kind", "id", "deliveryRunId", "blueprintId", "wave", "basedOnCheckpointSha", "tasks", "createdAt"]) if (!(key in value)) fail(`PlanBatch is missing '${key}'`);
    if (value.schemaVersion !== 1 || value.kind !== "PlanBatch") fail("PlanBatch has an invalid version or kind");
    if (typeof value.id !== "string" || !value.id || typeof value.deliveryRunId !== "string" || !value.deliveryRunId) fail("PlanBatch needs immutable id and deliveryRunId");
    if (!positive(value.wave)) fail("PlanBatch wave must be a positive integer");
    if (!sha(value.basedOnCheckpointSha)) fail("PlanBatch basedOnCheckpointSha must be a Git SHA");
  }
  if (blueprint && value.blueprintId !== blueprint.blueprintId) fail("plan blueprintId must match the persisted ProductBlueprint");
  if (!value.tasks.length) fail("plan must contain at least one task");
  if (value.tasks.length > maxTasks) fail(`plan exceeds configured maxPlanTasks (${maxTasks})`);
  const ids = new Set();
  for (const task of value.tasks) {
    if (!task || typeof task !== "object") fail("every task must be an object");
    for (const key of ["id", "title", "prompt", "primaryDomain", "supportingDomains", "riskFlags", "estimatedTokens", "dependsOn", "allowedPaths", "acceptanceChecks", "humanApprovalRequired", ...(blueprint ? ["requirementIds"] : []), ...(repositoryBaseline ? ["baselineBehaviorIds"] : [])]) {
      if (!(key in task)) fail(`task is missing '${key}'`);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(task.id)) fail(`task id '${task.id}' is unsafe`);
    if (ids.has(task.id)) fail(`task id '${task.id}' is duplicated`);
    ids.add(task.id);
    if (typeof task.title !== "string" || typeof task.prompt !== "string" || !task.title.trim() || !task.prompt.trim()) fail(`task '${task.id}' needs title and prompt`);
    if (![task.supportingDomains, task.riskFlags, task.dependsOn, task.allowedPaths, task.acceptanceChecks, ...(blueprint ? [task.requirementIds] : [])].every(Array.isArray)) fail(`task '${task.id}' array fields are invalid`);
    try { task.allowedPaths = normalizeAllowedPaths(task.allowedPaths); }
    catch (error) { fail(`task '${task.id}' ${error.message.replace(/^Invalid write surface: /, "")}`); }
    if (repositoryBaseline) {
      try { task.baselineBehaviorIds = validateTaskBaselineBehaviorIds(task, repositoryBaseline); }
      catch (error) { fail(`task '${task.id}' ${error.message.replace(/^repository_baseline:/, "")}`); }
    }
    if (blueprint) {
      try { validateRequirementIds(task.requirementIds, blueprint); }
      catch (error) { fail(`task '${task.id}' ${error.message.replace(/^Invalid ProductBlueprint: /, "")}`); }
    }
    if (!domains.has(task.primaryDomain) || task.supportingDomains.some((domain) => !domains.has(domain))) fail(`task '${task.id}' has an unknown domain`);
    if (task.riskFlags.some((flag) => !riskFlags.has(flag))) fail(`task '${task.id}' has an unknown risk flag`);
    if (!Number.isInteger(task.estimatedTokens) || task.estimatedTokens < 1) fail(`task '${task.id}' needs a positive token estimate`);
    if (typeof task.humanApprovalRequired !== "boolean") fail(`task '${task.id}' needs humanApprovalRequired boolean`);
  }
  for (const task of value.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency) || dependency === task.id) fail(`task '${task.id}' has an invalid dependency '${dependency}'`);
    }
  }
  if ((mode?.mode === "greenfield" || (!mode && productRoots.length)) && productRoots.length && !recovery) {
    const scaffold = value.tasks.find((task) => task.id === "scaffold-product");
    if (!scaffold) fail("greenfield multi-stack plan requires a scaffold-product task");
    if (scaffold.primaryDomain !== "devops") fail("scaffold-product must be a devops writer task");
    const roots = productRoots.map((item) => item.path);
    if (!roots.every((root) => scaffold.allowedPaths.includes(root))) fail("scaffold-product must be allowed to create every declared product root");
    for (const task of value.tasks) {
      if (task.id === scaffold.id) continue;
      const writesProduct = task.allowedPaths.some((path) => roots.some((root) => isWriteSurfaceAncestorOrSame(root, path)));
      if (writesProduct && !task.dependsOn.includes(scaffold.id)) fail(`product task '${task.id}' must directly depend on scaffold-product`);
    }
  }
  if (mode?.mode === "brownfield" && value.tasks.some((task) => task?.id === "scaffold-product")) fail("brownfield ProjectMode forbids generic scaffold-product");
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(value.tasks.map((task) => [task.id, task]));
  const visit = (id) => {
    if (visiting.has(id)) fail("plan dependency graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of value.tasks) visit(task.id);
  try {
    const plan = enforceRoutingInvariants(value);
    if (blueprint && !allowPartialRequirementCoverage) assertMandatoryRequirementCoverage(plan, blueprint);
    return plan;
  }
  catch (error) { fail(error.message.replace(/^Unsafe routing plan: /, "")); }
}

// Controller artifacts intentionally model a chain, never a graph.  Fan-in is
// represented by IntegrationBarrier/IntegrationCheckpoint instead.
export function validateWorkerArtifactContract(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== "WorkerArtifact") fail("WorkerArtifact has an invalid version or kind");
  const parents = value.parentArtifactId === undefined || value.parentArtifactId === null ? [] : [value.parentArtifactId];
  if (Array.isArray(value.parentArtifactIds) || (Array.isArray(value.dependencies) && value.dependencies.length > 1)) fail("WorkerArtifact may have exactly zero or one parent artifact ID");
  if (parents.length && (typeof parents[0] !== "string" || !parents[0])) fail("WorkerArtifact parentArtifactId must be a non-empty string");
  if (Array.isArray(value.dependencies) && value.dependencies.length && value.dependencies[0] !== parents[0]) fail("WorkerArtifact parentArtifactId must match its sole dependency");
  if (!sha(value.baseSha) || !sha(value.headSha)) fail("WorkerArtifact must contain Git baseSha and headSha");
  return value;
}

export function validateIntegrationBarrier(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== "IntegrationBarrier") fail("IntegrationBarrier has an invalid version or kind");
  for (const key of ["id", "deliveryRunId", "blueprintId", "wave", "baseSha", "inputArtifacts", "status", "createdAt"]) if (!(key in value)) fail(`IntegrationBarrier is missing '${key}'`);
  if (!positive(value.wave) || !sha(value.baseSha) || !Array.isArray(value.inputArtifacts) || value.inputArtifacts.length < 2) fail("IntegrationBarrier has invalid wave, base SHA, or inputs");
  const identities = new Set();
  for (const item of value.inputArtifacts) {
    if (!item || typeof item.artifactId !== "string" || !item.artifactId || !sha(item.headSha)) fail("IntegrationBarrier input must identify a verified artifact and SHA");
    if (identities.has(item.artifactId)) fail("IntegrationBarrier inputs must be ordered and unique");
    identities.add(item.artifactId);
  }
  return value;
}

export function validateIntegrationCheckpoint(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== "IntegrationCheckpoint") fail("IntegrationCheckpoint has an invalid version or kind");
  for (const key of ["id", "deliveryRunId", "blueprintId", "wave", "baseSha", "inputArtifacts", "outputSha", "verificationResults", "status", "createdAt"]) if (!(key in value)) fail(`IntegrationCheckpoint is missing '${key}'`);
  if (!positive(value.wave) || !sha(value.baseSha) || !sha(value.outputSha) || value.status !== "passed" || !Array.isArray(value.inputArtifacts) || !value.inputArtifacts.length || !Array.isArray(value.verificationResults) || value.verificationResults.some((item) => item.status !== "passed")) fail("IntegrationCheckpoint is not a successful verified checkpoint");
  const identities = new Set();
  for (const item of value.inputArtifacts) {
    if (!item || typeof item.artifactId !== "string" || !item.artifactId || !sha(item.headSha) || identities.has(item.artifactId)) fail("IntegrationCheckpoint inputs must be ordered, unique artifact identities with SHAs");
    identities.add(item.artifactId);
  }
  return value;
}

function validateEffectiveLineage(value) {
  if (!Array.isArray(value) || !value.length) fail("Checkpoint requires a non-empty effective lineage");
  const identities = new Set();
  for (const item of value) {
    if (!item || !["artifact", "checkpoint"].includes(item.kind) || typeof item.id !== "string" || !item.id || !sha(item.sha)) fail("Checkpoint effective lineage has an invalid identity or SHA");
    const identity = `${item.kind}:${item.id}`;
    if (identities.has(identity)) fail("Checkpoint effective lineage must be ordered and duplicate-free");
    identities.add(identity);
  }
}

export function validateLocalIntegrationCheckpoint(value) {
  if (!value || value.schemaVersion !== 2 || value.kind !== "LocalIntegrationCheckpoint" || typeof value.barrierId !== "string" || !value.barrierId) fail("LocalIntegrationCheckpoint has an invalid identity");
  validateIntegrationCheckpoint({ ...value, schemaVersion: 1, kind: "IntegrationCheckpoint" });
  validateEffectiveLineage(value.effectiveLineage);
  if (!Array.isArray(value.consumerTaskIds) || !value.consumerTaskIds.length || new Set(value.consumerTaskIds).size !== value.consumerTaskIds.length || value.consumerTaskIds.some((id) => typeof id !== "string" || !id)) fail("LocalIntegrationCheckpoint must identify unique consumers");
  return value;
}

export function validateGlobalWaveCheckpoint(value) {
  if (!value || value.schemaVersion !== 2 || value.kind !== "GlobalWaveCheckpoint") fail("GlobalWaveCheckpoint has an invalid identity");
  validateIntegrationCheckpoint({ ...value, schemaVersion: 1, kind: "IntegrationCheckpoint" });
  validateEffectiveLineage(value.effectiveLineage);
  return value;
}
