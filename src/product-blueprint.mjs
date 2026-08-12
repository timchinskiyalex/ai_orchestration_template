import { createHash } from "node:crypto";

const types = new Set(["functional", "nfr", "data", "integration", "constraint"]);
const priorities = new Set(["must", "should", "could"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const fail = (message) => { throw new Error(`Invalid ProductBlueprint: ${message}`); };
const id = (value, label) => {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(value)) fail(`${label} must be a stable kebab-case id`);
};

export function documentIdForPath(path) { return `doc-${sha256(path).slice(0, 20)}`; }

export function documentSetDigest(sourceDocuments) {
  return sha256(canonical([...sourceDocuments].sort((left, right) => left.path.localeCompare(right.path))));
}
export const PRODUCT_BLUEPRINT_SCHEMA_VERSION = 3;
export const SPECIFICATION_RESOLUTION_AUTHORITY_VERSION = 1;

export function policyDigest(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const { digest, ...unsigned } = policy;
  return sha256(canonical(unsigned));
}

export function policyRegistryDigest(policyRegistry) {
  if (!policyRegistry || typeof policyRegistry !== "object" || Array.isArray(policyRegistry)) return null;
  return sha256(canonical({ schemaVersion: policyRegistry.schemaVersion, policies: policyRegistry.policies }));
}

function policyRegistryStatus(policyRegistry) {
  if (!policyRegistry || typeof policyRegistry !== "object" || Array.isArray(policyRegistry)) return { valid: false, reason: "policy_registry_missing", policies: [] };
  if (policyRegistry.schemaVersion !== 1 || !Array.isArray(policyRegistry.policies)) return { valid: false, reason: "policy_registry_invalid", policies: [] };
  const policyIds = new Set();
  for (const policy of policyRegistry.policies) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy) || typeof policy.policyId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(policy.policyId) || policyIds.has(policy.policyId) || typeof policy.version !== "string" || !policy.version.trim() || typeof policy.digest !== "string" || !/^[a-f0-9]{64}$/.test(policy.digest) || policy.digest !== policyDigest(policy) || typeof policy.resolvedValue !== "string" || !policy.resolvedValue.trim()) return { valid: false, reason: "policy_registry_invalid", policies: [] };
    const scope = policy.scope;
    const questionScope = scope?.kind === "unresolved_question" && Array.isArray(scope.questionIds) && scope.questionIds.length && scope.questionIds.every((item) => typeof item === "string" && /^[a-z][a-z0-9-]{0,95}$/.test(item)) && new Set(scope.questionIds).size === scope.questionIds.length;
    const auditScope = scope?.kind === "source_claim_audit" && Array.isArray(scope.claimIds) && scope.claimIds.length && scope.claimIds.every((item) => typeof item === "string" && /^[a-z][a-z0-9-]{0,95}$/.test(item)) && new Set(scope.claimIds).size === scope.claimIds.length;
    const affected = Array.isArray(policy.affectedRequirementIds) && policy.affectedRequirementIds.every((item) => typeof item === "string" && /^[a-z][a-z0-9-]{0,95}$/.test(item)) && new Set(policy.affectedRequirementIds).size === policy.affectedRequirementIds.length;
    if ((!questionScope && !auditScope) || !affected || (questionScope && (!policy.affectedRequirementIds.length || scope.claimIds !== undefined && (!Array.isArray(scope.claimIds) || !scope.claimIds.length || scope.claimIds.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(item)) || new Set(scope.claimIds).size !== scope.claimIds.length)))) return { valid: false, reason: "policy_registry_invalid", policies: [] };
    policyIds.add(policy.policyId);
  }
  return { valid: true, reason: null, policies: policyRegistry.policies, digest: policyRegistryDigest(policyRegistry) };
}

export function validateTrustedPolicyRegistry(policyRegistry) {
  const status = policyRegistryStatus(policyRegistry);
  if (!status.valid) throw new Error(`Invalid trusted policy registry: ${status.reason}`);
  return structuredClone(policyRegistry);
}

const sameIds = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && [...left].sort().every((item, index) => item === [...right].sort()[index]);
const policyAdrId = (questionId) => `adr-policy-${sha256(questionId).slice(0, 20)}`;

function proposalFor(question) {
  return {
    policyId: question.proposedPolicyId ?? null,
    version: question.proposedPolicyVersion ?? null,
    digest: question.proposedPolicyDigest ?? null,
    value: question.proposedResolution ?? null
  };
}

function authorizationForQuestion(question, registry, strictClaims = false) {
  const proposal = proposalFor(question);
  const base = { evidenceId: `evidence-policy-${sha256(question.questionId).slice(0, 20)}`, targetKind: "unresolved_question", targetId: question.questionId, affectedRequirementIds: [...question.requiredForRequirementIds].sort() };
  if (!registry.valid) return { ...base, state: "unresolved", reason: registry.reason, proposedPolicyId: proposal.policyId };
  const scopeMatches = (policy) => policy.scope.questionIds.includes(question.questionId) && sameIds(policy.affectedRequirementIds, question.requiredForRequirementIds) && (!strictClaims || sameIds(policy.scope.claimIds, question.sourceClaimIds));
  const hasProposal = Boolean(proposal.policyId || proposal.version || proposal.digest || proposal.value);
  const matches = registry.policies.filter(scopeMatches);
  const policy = hasProposal ? registry.policies.find((item) => item.policyId === proposal.policyId) : matches.length === 1 ? matches[0] : null;
  if (!policy) return { ...base, state: "unresolved", reason: hasProposal ? "policy_not_found" : matches.length ? "policy_scope_ambiguous" : "no_trusted_policy_match", proposedPolicyId: proposal.policyId };
  if (hasProposal && (policy.version !== proposal.version || policy.digest !== proposal.digest || policy.resolvedValue !== proposal.value)) return { ...base, state: "unresolved", reason: "policy_claim_mismatch", proposedPolicyId: proposal.policyId };
  if (!scopeMatches(policy)) return { ...base, state: "unresolved", reason: "policy_scope_mismatch", proposedPolicyId: proposal.policyId };
  return { ...base, state: "resolved_by_policy", reason: "trusted_policy_match", policyId: policy.policyId, policyVersion: policy.version, policyDigest: policy.digest, claimIds: question.sourceClaimIds ?? [], resolvedValue: policy.resolvedValue, registryDigest: registry.digest };
}
export function validateProductBlueprint(value, { sourceDocuments = null, sourceResolver = null, sourceClaimManifest = null } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object");
  for (const key of ["schemaVersion", "kind", "blueprintId", "createdAt", "documentSetDigest", "sourceDocuments", "requirements", "nfrs", "modules", "integrations", "dataModel", "constraints", "assumptions", "decisions", "unresolvedQuestions", "contradictions"]) if (!(key in value)) fail(`missing '${key}'`);
  if (![1, 2, PRODUCT_BLUEPRINT_SCHEMA_VERSION].includes(value.schemaVersion) || value.kind !== "ProductBlueprint") fail("schemaVersion must be 1, 2, or 3 and kind must be ProductBlueprint");
  const strictClaims = Boolean(sourceClaimManifest);
  if (strictClaims && (value.schemaVersion !== PRODUCT_BLUEPRINT_SCHEMA_VERSION || !value.sourceClaimManifest || value.sourceClaimManifest.manifestId !== sourceClaimManifest.manifestId || value.sourceClaimManifest.digest !== sourceClaimManifest.digest || value.sourceClaimManifest.documentSetDigest !== sourceClaimManifest.documentSetDigest)) fail("source claim manifest identity is missing or does not match controller intake");
  id(value.blueprintId, "blueprintId");
  if (Number.isNaN(Date.parse(value.createdAt))) fail("createdAt must be an ISO timestamp");
  if (!Array.isArray(value.sourceDocuments) || !Array.isArray(value.requirements)) fail("sourceDocuments and requirements must be arrays");
  if (![value.nfrs, value.modules, value.integrations, value.constraints, value.assumptions, value.decisions, value.unresolvedQuestions, value.contradictions].every(Array.isArray) || !value.dataModel || typeof value.dataModel !== "object") fail("collection fields have invalid types");
  const documents = new Map();
  for (const document of value.sourceDocuments) {
    if (!document || typeof document !== "object") fail("every source document must be an object");
    id(document.documentId, "documentId");
    if (typeof document.path !== "string" || !document.path || !/^[a-f0-9]{64}$/.test(document.sha256 ?? "")) fail(`source document '${document.documentId}' is invalid`);
    if (documents.has(document.documentId)) fail(`source document '${document.documentId}' is duplicated`);
    documents.set(document.documentId, document);
  }
  if (!documents.size) fail("must contain at least one source document");
  const authoritativeDocuments = sourceResolver?.sourceDocuments ?? sourceDocuments;
  if (authoritativeDocuments) {
    const expected = new Map(authoritativeDocuments.map((document) => [document.documentId, document]));
    if (expected.size !== documents.size || [...documents].some(([key, document]) => canonical(document) !== canonical(expected.get(key)))) fail("sourceDocuments must exactly match the imported document inventory");
  }
  if (value.documentSetDigest !== documentSetDigest(value.sourceDocuments)) fail("documentSetDigest does not match sourceDocuments");
  const requirementIds = new Set();
  for (const requirement of value.requirements) {
    if (!requirement || typeof requirement !== "object") fail("every requirement must be an object");
    for (const key of ["requirementId", "type", "priority", "mandatory", "description", "sourceRefs", "acceptanceCriteria", "constraints", ...(strictClaims ? ["sourceClaimIds"] : [])]) if (!(key in requirement)) fail(`requirement is missing '${key}'`);
    id(requirement.requirementId, "requirementId");
    if (requirementIds.has(requirement.requirementId)) fail(`requirement '${requirement.requirementId}' is duplicated`);
    requirementIds.add(requirement.requirementId);
    if (!types.has(requirement.type) || !priorities.has(requirement.priority) || typeof requirement.mandatory !== "boolean" || typeof requirement.description !== "string" || !requirement.description.trim()) fail(`requirement '${requirement.requirementId}' has invalid fields`);
    if (!Array.isArray(requirement.sourceRefs) || !requirement.sourceRefs.length || !Array.isArray(requirement.acceptanceCriteria) || !Array.isArray(requirement.constraints) || (requirement.mandatory && !requirement.acceptanceCriteria.length)) fail(`requirement '${requirement.requirementId}' needs valid non-empty mandatory acceptance criteria`);
    if (strictClaims) validateClaimMapping(requirement, sourceClaimManifest, `requirement '${requirement.requirementId}'`);
    const criteria = new Set();
    for (const criterion of requirement.acceptanceCriteria) {
      if (!criterion || typeof criterion !== "object") fail(`requirement '${requirement.requirementId}' has invalid acceptance criterion`);
      id(criterion.criterionId, "criterionId");
      if (criteria.has(criterion.criterionId) || typeof criterion.description !== "string" || !criterion.description.trim() || (criterion.verificationHint !== undefined && typeof criterion.verificationHint !== "string")) fail(`requirement '${requirement.requirementId}' has invalid acceptance criterion`);
      criteria.add(criterion.criterionId);
    }
    verifySourceRefs(requirement.sourceRefs, `requirement '${requirement.requirementId}'`, sourceResolver, documents);
  }
  for (const decision of value.decisions) {
    if (!decision || typeof decision !== "object") fail("invalid decision");
    id(decision.adrId, "adrId");
    if (typeof decision.decision !== "string" || typeof decision.rationale !== "string" || !Array.isArray(decision.sourceRefs)) fail("invalid decision");
    verifySourceRefs(decision.sourceRefs, `decision '${decision.adrId}'`, sourceResolver, documents);
  }
  for (const question of value.unresolvedQuestions) {
    if (!question || typeof question !== "object") fail("invalid unresolved question");
    id(question.questionId, "questionId");
    if (typeof question.description !== "string" || !question.description.trim() || !Array.isArray(question.requiredForRequirementIds) || !question.requiredForRequirementIds.every((requirementId) => requirementIds.has(requirementId)) || new Set(question.requiredForRequirementIds).size !== question.requiredForRequirementIds.length) fail(`invalid unresolved question '${question.questionId}'`);
    if (strictClaims && question.sourceClaimIds !== undefined) validateClaimIds(question.sourceClaimIds, sourceClaimManifest, `unresolved question '${question.questionId}'`);
    if (question.status !== undefined && !["resolved_by_policy", "unresolved"].includes(question.status)) fail(`invalid unresolved question '${question.questionId}'`);
    for (const key of ["proposedPolicyId", "proposedPolicyVersion", "proposedPolicyDigest", "proposedResolution", "policyDefault", "resolution"]) if (question[key] !== undefined && typeof question[key] !== "string") fail(`invalid proposal field '${key}' for '${question.questionId}'`);
    if (question.proposedPolicyDigest !== undefined && !/^[a-f0-9]{64}$/.test(question.proposedPolicyDigest)) fail(`invalid proposal digest for '${question.questionId}'`);
    if (question.sourceRefs !== undefined) verifySourceRefs(question.sourceRefs, `unresolved question '${question.questionId}'`, sourceResolver, documents);
  }
  for (const contradiction of value.contradictions) {
    if (!contradiction || typeof contradiction !== "object") fail("invalid contradiction");
    id(contradiction.contradictionId, "contradictionId");
    if (!Array.isArray(contradiction.requirementIds) || !contradiction.requirementIds.every((requirementId) => requirementIds.has(requirementId)) || !Array.isArray(contradiction.sourceRefs) || typeof contradiction.description !== "string" || !contradiction.description.trim() || (contradiction.status !== undefined && !["resolved", "unresolved"].includes(contradiction.status))) fail(`invalid contradiction '${contradiction.contradictionId}'`);
    if (strictClaims && contradiction.sourceClaimIds !== undefined) validateClaimIds(contradiction.sourceClaimIds, sourceClaimManifest, `contradiction '${contradiction.contradictionId}'`);
    if (contradiction.status === "resolved" && typeof contradiction.resolution !== "string") fail(`resolved contradiction '${contradiction.contradictionId}' needs resolution`);
    verifySourceRefs(contradiction.sourceRefs, `contradiction '${contradiction.contradictionId}'`, sourceResolver, documents);
  }
  if (value.schemaVersion === PRODUCT_BLUEPRINT_SCHEMA_VERSION && (!value.resolutionAuthority || typeof value.resolutionAuthority !== "object" || value.resolutionAuthority.schemaVersion !== SPECIFICATION_RESOLUTION_AUTHORITY_VERSION || !Array.isArray(value.resolutionAuthority.records))) fail("schemaVersion 3 requires controller resolutionAuthority records");
  return structuredClone(value);
}

function refsEqual(left, right) { return left.length === right.length && left.map((ref) => `${ref.documentId}:${ref.startLine}:${ref.endLine}:${ref.excerptDigest}`).sort().every((item, index) => item === right.map((ref) => `${ref.documentId}:${ref.startLine}:${ref.endLine}:${ref.excerptDigest}`).sort()[index]); }
function validateClaimIds(ids, manifest, label) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((item) => typeof item !== "string" || !manifest.claims.some((claim) => claim.claimId === item))) fail(`${label} has invalid sourceClaimIds`);
}
function validateClaimMapping(requirement, manifest, label) {
  validateClaimIds(requirement.sourceClaimIds, manifest, label);
  const refs = requirement.sourceClaimIds.flatMap((claimId) => manifest.claims.find((claim) => claim.claimId === claimId).sourceRefs);
  if (!refsEqual(requirement.sourceRefs, refs)) fail(`${label} sourceClaimIds do not exactly agree with sourceRefs`);
}

function verifySourceRefs(refs, label, sourceResolver, documents) {
  if (!sourceResolver || typeof sourceResolver.verify !== "function") fail(`${label} requires a controller source resolver`);
  for (const ref of refs) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref) || !documents.has(ref.documentId)) fail(`${label} has invalid source reference`);
    try { sourceResolver.verify(ref, label); }
    catch (error) { fail(error.message); }
  }
}

// Bootstrap provides claims only.  This controller-owned derivation discards
// agent statuses, defaults, and free-text resolutions before it assigns state.
export function authorizeBootstrapClaims(blueprint, { sourceDocuments = null, sourceResolver = null, policyRegistry = null, sourceClaimManifest = null } = {}) {
  const claims = validateProductBlueprint(blueprint, { sourceDocuments, sourceResolver });
  const registry = policyRegistryStatus(policyRegistry);
  const copy = structuredClone(claims);
  copy.schemaVersion = PRODUCT_BLUEPRINT_SCHEMA_VERSION;
  if (sourceClaimManifest) copy.sourceClaimManifest = { manifestId: sourceClaimManifest.manifestId, digest: sourceClaimManifest.digest, documentSetDigest: sourceClaimManifest.documentSetDigest };
  const records = [];
  copy.unresolvedQuestions = copy.unresolvedQuestions.map((question) => {
    const { status, policyDefault, resolution, ...claim } = question;
    const evidence = authorizationForQuestion(claim, registry, Boolean(sourceClaimManifest));
    records.push(evidence);
    return { ...claim, status: evidence.state };
  });
  // P0 deliberately has no automatic contradiction resolver.  Agent-supplied
  // status or text is retained only as a non-authoritative claim and cannot
  // change the controller-derived unresolved state.
  copy.contradictions = copy.contradictions.map((contradiction) => {
    const { status, resolution, ...claim } = contradiction;
    return { ...claim, status: "unresolved" };
  });
  copy.resolutionAuthority = { schemaVersion: SPECIFICATION_RESOLUTION_AUTHORITY_VERSION, registryDigest: registry.valid ? registry.digest : null, records };
  for (const evidence of records.filter((item) => item.state === "resolved_by_policy")) {
    const adrId = policyAdrId(evidence.targetId);
    if (!copy.decisions.some((decision) => decision.adrId === adrId)) copy.decisions.push({ adrId, decision: evidence.resolvedValue, rationale: `Controller-authorized policy ${evidence.policyId}@${evidence.policyVersion}`, sourceRefs: [] });
  }
  if (sourceClaimManifest) {
    validateProductBlueprint(copy, { sourceDocuments, sourceResolver, sourceClaimManifest });
    assertSourceClaimCompleteness(copy, sourceClaimManifest);
  }
  return copy;
}

export function validateControllerAuthorizedBlueprint(blueprint, { sourceDocuments = null, sourceResolver = null, policyRegistry = null, persistedResolutionAuthority = undefined, sourceClaimManifest = null } = {}) {
  const stored = validateProductBlueprint(blueprint, { sourceDocuments, sourceResolver, sourceClaimManifest });
  if (stored.schemaVersion !== PRODUCT_BLUEPRINT_SCHEMA_VERSION) fail("legacy resolution authority cannot be proven for autonomous delivery");
  if (persistedResolutionAuthority !== undefined && canonical(stored.resolutionAuthority) !== canonical(persistedResolutionAuthority)) fail("persisted controller resolution authority evidence is missing or tampered");
  const rederived = authorizeBootstrapClaims(stored, { sourceDocuments, sourceResolver, policyRegistry, sourceClaimManifest });
  if (canonical(stored.unresolvedQuestions) !== canonical(rederived.unresolvedQuestions) || canonical(stored.contradictions) !== canonical(rederived.contradictions) || canonical(stored.resolutionAuthority) !== canonical(rederived.resolutionAuthority)) fail("controller resolution authority evidence is missing, tampered, or no longer trusted");
  for (const evidence of stored.resolutionAuthority.records.filter((item) => item.state === "resolved_by_policy")) {
    const adrId = policyAdrId(evidence.targetId);
    const decision = stored.decisions.find((item) => item.adrId === adrId);
    if (!decision || decision.decision !== evidence.resolvedValue || decision.rationale !== `Controller-authorized policy ${evidence.policyId}@${evidence.policyVersion}`) fail(`controller ADR evidence is missing for '${evidence.targetId}'`);
  }
  return stored;
}

export function assertSourceClaimCompleteness(blueprint, manifest) {
  const dispositions = new Map();
  const add = (claimId, kind, item) => { if (!dispositions.has(claimId)) dispositions.set(claimId, []); dispositions.get(claimId).push({ kind, item }); };
  for (const requirement of blueprint.requirements) for (const claimId of requirement.sourceClaimIds ?? []) add(claimId, "requirement", requirement);
  for (const question of blueprint.unresolvedQuestions) for (const claimId of question.sourceClaimIds ?? []) add(claimId, "question", question);
  for (const contradiction of blueprint.contradictions) for (const claimId of contradiction.sourceClaimIds ?? []) add(claimId, "contradiction", contradiction);
  const policyClaims = new Set((blueprint.resolutionAuthority?.records ?? []).filter((record) => record.state === "resolved_by_policy").flatMap((record) => record.claimIds ?? []));
  for (const claim of manifest.claims) {
    if (claim.classification === "non_mandatory") continue;
    const mapped = dispositions.get(claim.claimId) ?? [];
    if (mapped.length !== 1) fail(`mandatory source claim '${claim.claimId}' requires exactly one disposition`);
    const disposition = mapped[0];
    if (disposition.kind === "requirement" && (!disposition.item.acceptanceCriteria?.length || !disposition.item.mandatory && claim.classification === "mandatory")) fail(`mandatory source claim '${claim.claimId}' is not closed by a mandatory requirement with acceptance criteria`);
    if (disposition.kind === "question" && disposition.item.status === "resolved_by_policy" && !policyClaims.has(claim.claimId)) fail(`trusted policy evidence does not bind source claim '${claim.claimId}'`);
    if (claim.classification === "ambiguous" && !(disposition.kind === "question" && disposition.item.status === "resolved_by_policy" && policyClaims.has(claim.claimId))) fail(`ambiguous source claim '${claim.claimId}' remains blocked`);
  }
}

export function sourceClaimBlockers(blueprint, manifest) {
  const blockers = [];
  const requirements = new Set((blueprint.requirements ?? []).flatMap((requirement) => requirement.sourceClaimIds ?? []));
  const questions = new Map((blueprint.unresolvedQuestions ?? []).flatMap((question) => (question.sourceClaimIds ?? []).map((claimId) => [claimId, question])));
  const contradictions = new Map((blueprint.contradictions ?? []).flatMap((item) => (item.sourceClaimIds ?? []).map((claimId) => [claimId, item])));
  for (const claim of manifest.claims) {
    if (claim.classification === "non_mandatory") continue;
    if (requirements.has(claim.claimId)) continue;
    const question = questions.get(claim.claimId);
    const contradiction = contradictions.get(claim.claimId);
    if (contradiction) blockers.push(`unresolved_source_claim_contradiction:${claim.claimId}`);
    else if (question?.status !== "resolved_by_policy") blockers.push(`${claim.classification === "ambiguous" ? "ambiguous_source_claim" : "unresolved_mandatory_source_claim"}:${claim.claimId}`);
  }
  return blockers;
}

export function specificationBlockers(blueprint) {
  const blockers = [];
  const controllerAuthorized = blueprint?.schemaVersion === PRODUCT_BLUEPRINT_SCHEMA_VERSION && blueprint?.resolutionAuthority?.schemaVersion === SPECIFICATION_RESOLUTION_AUTHORITY_VERSION;
  for (const question of blueprint.unresolvedQuestions ?? []) if ((!controllerAuthorized || question.status !== "resolved_by_policy") && question.requiredForRequirementIds.length) blockers.push(`missing_mandatory_fact:${question.questionId}`);
  for (const contradiction of blueprint.contradictions ?? []) if (!controllerAuthorized || contradiction.status !== "resolved_by_controller") blockers.push(`unresolved_contradiction:${contradiction.contradictionId}`);
  return blockers;
}

export function validateRequirementIds(requirementIds, blueprint) {
  if (!Array.isArray(requirementIds) || !requirementIds.length || requirementIds.some((item) => typeof item !== "string")) fail("task requirementIds must be a non-empty array");
  const known = new Set(blueprint.requirements.map((item) => item.requirementId));
  for (const requirementId of requirementIds) if (!known.has(requirementId)) fail(`task references unknown requirement '${requirementId}'`);
}

export function assertMandatoryRequirementCoverage(plan, blueprint) {
  const covered = new Set(plan.tasks.flatMap((task) => task.requirementIds));
  const missing = blueprint.requirements.filter((requirement) => requirement.mandatory && !covered.has(requirement.requirementId)).map((requirement) => requirement.requirementId);
  if (missing.length) throw new Error(`Invalid orchestration JSON: mandatory ProductBlueprint requirements are not planned: ${missing.join(", ")}`);
}
