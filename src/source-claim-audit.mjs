import { createHash, randomUUID } from "node:crypto";
import { AppServerExecutionProvider } from "./app-server-execution-provider.mjs";
import { EXECUTION_PROVIDER_VERSION, ExecutionProviderError, assertCapabilities, validateEnvelope } from "./execution-provider-contract.mjs";
import { policyDigest } from "./product-blueprint.mjs";
import { createImportedSourceResolver, sourceFragmentDigest } from "./source-evidence.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const decisions = new Set(["admitted", "rejected", "split-required", "contradiction", "unresolved"]);
const classifications = new Set(["mandatory", "non_mandatory", "ambiguous"]);
const reason = /^[a-z][a-z0-9_:-]{0,95}$/;
const methods = { handshake: "handshake", start_thread: "startThread", set_goal: "setGoal", start_turn: "startTurn", observe_terminal: "observeTerminal", read_final_result: "readFinalResult", shutdown: "shutdown" };

function fail(message) { throw new Error(`source_claim_audit:${message}`); }
function refsEqual(left, right) { return left.length === right.length && left.map((item) => `${item.documentId}:${item.startLine}:${item.endLine}:${item.excerptDigest}`).sort().every((item, index) => item === right.map((rightItem) => `${rightItem.documentId}:${rightItem.startLine}:${rightItem.endLine}:${rightItem.excerptDigest}`).sort()[index]); }

export function auditSubjectFromExtraction(extraction) {
  const claims = extraction.claims.map((claim) => ({ claimId: claim.claimId, sourceRefs: [claim.sourceQuote], fixedClassification: null, claimType: claim.claimType, normalizedStatement: claim.normalizedStatement }));
  return Object.freeze({ kind: "SourceClaimExtraction", candidateId: extraction.extractionId, candidateDigest: extraction.digest, documentSetDigest: extraction.documentSetDigest, sourceDocuments: extraction.sourceDocuments, claims });
}

export function auditSubjectFromManifest(manifest) {
  return Object.freeze({ kind: "SuppliedSourceClaimManifest", candidateId: manifest.manifestId, candidateDigest: manifest.digest, documentSetDigest: manifest.documentSetDigest, sourceDocuments: manifest.sourceDocuments, claims: manifest.claims.map((claim) => ({ claimId: claim.claimId, sourceRefs: claim.sourceRefs, fixedClassification: claim.classification })) });
}

function unitKind(line) {
  const text = line.trim();
  if (/^#{1,6}\s+(?:overview|introduction|requirements?|scope|contents?|table of contents)$/i.test(text)) return "structural_header";
  if (/^(?:copyright|©|confidential|internal use only|draft)\b/i.test(text)) return "boilerplate";
  return "meaningful";
}

// Source facts are accounted for in normalized non-blank line units.  Common
// structural headings and explicit boilerplate are excluded by controller
// policy; prose, lists, tables, code, and non-generic headings remain facts.
export function normalizedSourceUnits(sourceResolver) {
  const units = [];
  for (const document of sourceResolver.controlledDocuments()) {
    const lines = document.text.replace(/\r\n?/g, "\n").split("\n");
    const count = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    for (let line = 1; line <= count; line += 1) {
      if (!lines[line - 1].trim()) continue;
      units.push(Object.freeze({ documentId: document.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(document.text, line, line), kind: unitKind(lines[line - 1]) }));
    }
  }
  return Object.freeze(units);
}

export function deterministicSuppliedSourceClaimAudit(subject, sourceResolver) {
  const decisions = subject.claims.map((claim) => ({ claimId: claim.claimId, decision: "admitted", classification: claim.fixedClassification, reasonCodes: ["supplied_high_assurance_validated"], sourceRefs: claim.sourceRefs }));
  const coverage = normalizedSourceUnits(sourceResolver).map((unit) => {
    if (unit.kind !== "meaningful") return { ...unit, disposition: "excluded", reasonCodes: [unit.kind], candidateClaimIds: [] };
    const ids = subject.claims.filter((claim) => claim.sourceRefs.some((ref) => ref.documentId === unit.documentId && ref.startLine <= unit.startLine && ref.endLine >= unit.endLine)).map((claim) => claim.claimId);
    return { ...unit, disposition: ids.length ? "covered" : "blocked", reasonCodes: [ids.length ? "supplied_claim_coverage" : "missing_supplied_claim_coverage"], candidateClaimIds: ids };
  });
  return validateSourceClaimAudit({ schemaVersion: 1, kind: "SourceClaimAudit", documentSetDigest: subject.documentSetDigest, candidateId: subject.candidateId, candidateDigest: subject.candidateDigest, decisions, coverage }, { subject, sourceResolver });
}

function trustedAuditPolicy(policyRegistry, claimId, policy) {
  if (!policy) return false;
  const match = policyRegistry?.policies?.find((item) => item.policyId === policy.policyId);
  return Boolean(
    match
    && match.scope?.kind === "source_claim_audit"
    && Array.isArray(match.scope.claimIds)
    && match.scope.claimIds.length === 1
    && match.scope.claimIds[0] === claimId
    && match.version === policy.version
    && match.digest === policy.digest
    && match.digest === policyDigest(match)
    && match.resolvedValue === policy.resolvedValue
  );
}

export function validateSourceClaimAudit(value, { subject, sourceResolver, policyRegistry = null }) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || value.kind !== "SourceClaimAudit" || value.documentSetDigest !== subject.documentSetDigest || value.candidateId !== subject.candidateId || value.candidateDigest !== subject.candidateDigest || !Array.isArray(value.decisions) || !Array.isArray(value.coverage)) fail("schema_or_subject_invalid");
  const candidates = new Map(subject.claims.map((claim) => [claim.claimId, claim])); const seen = new Set();
  const parsedDecisions = value.decisions.map((item) => {
    const candidate = candidates.get(item?.claimId);
    if (!candidate || seen.has(item.claimId) || !decisions.has(item.decision) || !Array.isArray(item.reasonCodes) || !item.reasonCodes.length || item.reasonCodes.some((code) => typeof code !== "string" || !reason.test(code)) || !Array.isArray(item.sourceRefs) || !refsEqual(item.sourceRefs, candidate.sourceRefs)) fail("claim_decision_invalid");
    for (const ref of item.sourceRefs) sourceResolver.verify(ref, `audit claim '${item.claimId}'`);
    if (item.decision === "admitted") {
      if (!classifications.has(item.classification)) fail("admitted_classification_invalid");
      if (candidate.fixedClassification && item.classification !== candidate.fixedClassification) fail("supplied_classification_changed");
      if (item.policy && !trustedAuditPolicy(policyRegistry, item.claimId, item.policy)) fail("untrusted_policy_binding");
    } else if (item.classification !== undefined || item.policy !== undefined) fail("nonadmitted_claim_has_admission_fields");
    seen.add(item.claimId); return Object.freeze({ claimId: item.claimId, decision: item.decision, classification: item.classification ?? null, reasonCodes: [...item.reasonCodes].sort(), sourceRefs: item.sourceRefs, policy: item.policy ?? null });
  });
  if (seen.size !== candidates.size) fail("candidate_decision_incomplete");
  const decisionById = new Map(parsedDecisions.map((item) => [item.claimId, item]));
  const expectedUnits = normalizedSourceUnits(sourceResolver); const unitKeys = new Set();
  const parsedCoverage = value.coverage.map((item) => {
    const key = `${item?.documentId}:${item?.startLine}:${item?.endLine}:${item?.excerptDigest}`;
    const unit = expectedUnits.find((candidate) => `${candidate.documentId}:${candidate.startLine}:${candidate.endLine}:${candidate.excerptDigest}` === key);
    if (!unit || unitKeys.has(key) || !Array.isArray(item.reasonCodes) || !item.reasonCodes.length || item.reasonCodes.some((code) => typeof code !== "string" || !reason.test(code))) fail("coverage_unit_invalid");
    sourceResolver.verify(item, "audit coverage");
    const ids = item.candidateClaimIds ?? [];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some((id) => !candidates.has(id))) fail("coverage_claim_ids_invalid");
    if (unit.kind === "meaningful") {
      const covers = (decision) => ids.some((id) => decisionById.get(id).decision === decision && candidates.get(id).sourceRefs.some((ref) => ref.documentId === unit.documentId && ref.startLine <= unit.startLine && ref.endLine >= unit.endLine));
      if (!ids.length || (item.disposition === "covered" && !covers("admitted")) || (item.disposition === "blocked" && !ids.some((id) => decisionById.get(id).decision !== "admitted")) || !["covered", "blocked"].includes(item.disposition)) fail("meaningful_source_material_unresolved");
    } else if (item.disposition !== "excluded" || ids.length || !item.reasonCodes.includes(unit.kind)) fail("excluded_source_policy_invalid");
    unitKeys.add(key); return Object.freeze({ documentId: unit.documentId, startLine: unit.startLine, endLine: unit.endLine, excerptDigest: unit.excerptDigest, kind: unit.kind, disposition: item.disposition, reasonCodes: [...item.reasonCodes].sort(), candidateClaimIds: [...ids].sort() });
  });
  if (unitKeys.size !== expectedUnits.length) fail("source_coverage_incomplete");
  const unsigned = { schemaVersion: 1, kind: "SourceClaimAudit", documentSetDigest: subject.documentSetDigest, candidateId: subject.candidateId, candidateDigest: subject.candidateDigest, decisions: [...parsedDecisions].sort((a, b) => a.claimId.localeCompare(b.claimId)), coverage: [...parsedCoverage].sort((a, b) => a.documentId.localeCompare(b.documentId) || a.startLine - b.startLine) };
  const digest = sha256(canonical(unsigned));
  return Object.freeze({ ...unsigned, auditId: `sca-${digest.slice(0, 24)}`, digest });
}

export function admitAuditedSourceClaims({ subject, audit }) {
  const blocked = audit.decisions.filter((item) => item.decision !== "admitted");
  if (blocked.length) fail(`admission_blocked:${blocked.map((item) => `${item.decision}:${item.claimId}`).join(",")}`);
  const decisionsById = new Map(audit.decisions.map((item) => [item.claimId, item]));
  const claims = subject.claims.map((claim) => ({ claimId: claim.claimId, classification: decisionsById.get(claim.claimId).classification, sourceRefs: claim.sourceRefs })).sort((a, b) => a.claimId.localeCompare(b.claimId));
  const unsigned = { schemaVersion: 1, kind: "SourceClaimManifest", documentSetDigest: subject.documentSetDigest, sourceDocuments: subject.sourceDocuments, claims, audit: { auditId: audit.auditId, digest: audit.digest, candidateId: subject.candidateId, candidateDigest: subject.candidateDigest } };
  const digest = sha256(canonical(unsigned));
  return Object.freeze({ ...unsigned, manifestId: `scm-${digest.slice(0, 24)}`, digest });
}

async function call(provider, operation, data, requiredIds = []) {
  const correlationId = randomUUID(); const method = provider?.[methods[operation]];
  if (typeof method !== "function") throw new ExecutionProviderError("source_claim_audit_provider_unavailable", `provider does not implement ${operation}`);
  let result; try { result = await method.call(provider, { contractVersion: EXECUTION_PROVIDER_VERSION, correlationId, data }); } catch { throw new ExecutionProviderError("source_claim_audit_provider_unavailable", "provider invocation failed"); }
  return validateEnvelope(result, { operation, correlationId, requiredIds });
}
function parseResult(text) { const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i); try { return JSON.parse((fenced?.[1] ?? text).trim()); } catch { fail("malformed_json"); } }

export class SourceClaimAuditExecutor {
  constructor(config) { this.config = config; }
  async audit(subject) {
    const resolver = createImportedSourceResolver({ repository: this.config.repository, documentationDir: this.config.project.documentationDir });
    const provider = this.config.executionProviderFactory?.({ cwd: this.config.runtimeDir }) ?? new AppServerExecutionProvider({ cwd: this.config.runtimeDir });
    try {
      const handshake = await call(provider, "handshake", {}, ["providerRunId"]); assertCapabilities(handshake, provider);
      const thread = await call(provider, "start_thread", { model: this.config.model, cwd: this.config.runtimeDir, sandbox: "read-only", approvalPolicy: "never", developerInstructions: "You are the independent Specification Auditor. This is a separate operation from extraction. Audit only controller-provided source and candidate data; do not plan engineering work or authorize invented product decisions." }, ["threadId"]);
      await call(provider, "set_goal", { threadId: thread.threadId, status: "active", tokenBudget: this.config.delivery?.sourceClaimAuditTokenBudget ?? 6000, objective: "Independently audit source claims and source coverage." }, ["threadId"]);
      const payload = { subject, documents: resolver.controlledDocuments(), coverageUnits: normalizedSourceUnits(resolver), trustedPolicies: this.config.specificationResolution?.policyRegistry?.policies?.filter((policy) => policy.scope?.kind === "source_claim_audit") ?? [] };
      const prompt = `Return only one fenced JSON SourceClaimAudit. Decide every candidate claim as admitted, rejected, split-required, contradiction, or unresolved. Preserve all source refs exactly. Every controller coverage unit must be present. Meaningful units require an admitted claim; structural_header and boilerplate units must be excluded with their exact reason code. Contradictions and split-required claims may only be admitted when a supplied trusted source_claim_audit policy exactly binds the claim. Payload: ${JSON.stringify(payload)}`;
      const started = await call(provider, "start_turn", { threadId: thread.threadId, input: [{ type: "text", text: prompt }], effort: "low" }, ["threadId", "turnId"]);
      const terminal = await call(provider, "observe_terminal", { threadId: thread.threadId, turnId: started.turnId, timeoutMs: this.config.router.turnTimeoutMs }, ["threadId", "turnId", "terminalClass"]);
      if (terminal.terminalClass !== "completed") throw new Error("source_claim_audit_provider_unavailable");
      const result = await call(provider, "read_final_result", { threadId: thread.threadId, turnId: terminal.turnId }, ["threadId", "turnId", "resultText"]);
      return validateSourceClaimAudit(parseResult(result.resultText), { subject, sourceResolver: resolver, policyRegistry: this.config.specificationResolution?.policyRegistry });
    } finally { try { await call(provider, "shutdown", {}); } catch {} }
  }
}
