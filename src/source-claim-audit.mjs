import { createHash } from "node:crypto";
import { policyDigest } from "./product-blueprint.mjs";
import { createImportedSourceResolver, sourceFragmentDigest } from "./source-evidence.mjs";
import { runSourceIntakeTurn } from "./source-intake-runtime.mjs";
import { sourceIntakeFailure } from "./source-intake-failure.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const decisionKinds = new Set(["admitted", "rejected", "split-required", "contradiction", "unresolved"]);
const classifications = new Set(["mandatory", "non_mandatory", "ambiguous"]);
const reason = /^[a-z][a-z0-9_:-]{0,95}$/;

function fail(message) { throw new Error(`source_claim_audit:${message}`); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function coverageUnitId(unit) { return `scu-${sha256(canonical({ documentId: unit.documentId, startLine: unit.startLine, endLine: unit.endLine, excerptDigest: unit.excerptDigest })).slice(0, 24)}`; }
function sortedDocuments(documents) { return documents.map((document) => ({ ...document })).sort((left, right) => left.documentId.localeCompare(right.documentId)); }
function validReasonCodes(codes) { return Array.isArray(codes) && codes.length > 0 && codes.every((code) => typeof code === "string" && reason.test(code)); }

export function auditSubjectFromExtraction(extraction) {
  const claims = extraction.claims.map((claim) => ({ claimId: claim.claimId, sourceRefs: [claim.sourceQuote], fixedClassification: null, candidateClassification: claim.classification, claimType: claim.claimType, normalizedStatement: claim.normalizedStatement }));
  return deepFreeze({ kind: "SourceClaimExtraction", candidateId: extraction.extractionId, candidateDigest: extraction.digest, documentSetDigest: extraction.documentSetDigest, sourceDocuments: sortedDocuments(extraction.sourceDocuments), claims });
}

export function auditSubjectFromManifest(manifest) {
  return deepFreeze({ kind: "SuppliedSourceClaimManifest", candidateId: manifest.manifestId, candidateDigest: manifest.digest, documentSetDigest: manifest.documentSetDigest, sourceDocuments: sortedDocuments(manifest.sourceDocuments), claims: manifest.claims.map((claim) => ({ claimId: claim.claimId, sourceRefs: claim.sourceRefs, fixedClassification: claim.classification })) });
}

function unitKind(line) {
  const text = line.trim();
  if (/^#{1,6}\s+(?:overview|introduction|requirements?|scope|contents?|table of contents)$/i.test(text)) return "structural_header";
  if (/^(?:copyright|\u00a9|confidential|internal use only|draft)\b/i.test(text)) return "boilerplate";
  return "meaningful";
}

// Source facts are accounted for in normalized non-blank line units. Common
// structural headings and explicit boilerplate are excluded by controller policy.
export function normalizedSourceUnits(sourceResolver) {
  const units = [];
  for (const document of sourceResolver.controlledDocuments()) {
    const lines = document.text.replace(/\r\n?/g, "\n").split("\n");
    const count = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    for (let line = 1; line <= count; line += 1) {
      if (!lines[line - 1].trim()) continue;
      const unit = { documentId: document.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(document.text, line, line), kind: unitKind(lines[line - 1]) };
      units.push(deepFreeze({ ...unit, coverageUnitId: coverageUnitId(unit) }));
    }
  }
  return Object.freeze(units);
}

function controllerPolicy(policyRegistry, claimId) {
  const policy = policyRegistry?.policies?.find((item) => item.scope?.kind === "source_claim_audit" && Array.isArray(item.scope.claimIds) && item.scope.claimIds.length === 1 && item.scope.claimIds[0] === claimId && item.digest === policyDigest(item));
  return policy ? { policyId: policy.policyId, version: policy.version, digest: policy.digest, resolvedValue: policy.resolvedValue } : null;
}

function controllerCoverage(subject, sourceResolver, decisionsById) {
  return normalizedSourceUnits(sourceResolver).map((unit) => {
    if (unit.kind !== "meaningful") return { documentId: unit.documentId, startLine: unit.startLine, endLine: unit.endLine, excerptDigest: unit.excerptDigest, kind: unit.kind, coverageUnitId: unit.coverageUnitId, disposition: "excluded", reasonCodes: [unit.kind], candidateClaimIds: [] };
    const spanningClaimIds = subject.claims.filter((claim) => claim.sourceRefs.some((ref) => ref.documentId === unit.documentId && ref.startLine <= unit.startLine && ref.endLine >= unit.endLine)).map((claim) => claim.claimId).sort();
    const admittedClaimIds = spanningClaimIds.filter((claimId) => decisionsById.get(claimId)?.decision === "admitted");
    return {
      documentId: unit.documentId, startLine: unit.startLine, endLine: unit.endLine, excerptDigest: unit.excerptDigest, kind: unit.kind, coverageUnitId: unit.coverageUnitId,
      disposition: admittedClaimIds.length ? "covered" : "blocked",
      reasonCodes: [admittedClaimIds.length ? "admitted_claim_coverage" : "meaningful_source_material_unresolved"],
      candidateClaimIds: admittedClaimIds.length ? admittedClaimIds : spanningClaimIds
    };
  });
}

function buildAudit(candidate, { subject, sourceResolver, policyRegistry = null }) {
  if (!exactKeys(candidate, ["decisions"]) || !Array.isArray(candidate.decisions)) fail("candidate_schema_invalid");
  const candidates = new Map(subject.claims.map((claim) => [claim.claimId, claim]));
  const seenClaims = new Set();
  const parsedDecisions = candidate.decisions.map((item) => {
    if (!exactKeys(item, ["claimId", "decision", "classification", "reasonCodes"]) || !candidates.has(item.claimId) || seenClaims.has(item.claimId) || !decisionKinds.has(item.decision) || !validReasonCodes(item.reasonCodes)) fail("candidate_claim_decision_invalid");
    const claim = candidates.get(item.claimId);
    if (item.decision === "admitted") {
      if (!classifications.has(item.classification) || (claim.fixedClassification && item.classification !== claim.fixedClassification)) fail("candidate_admitted_classification_invalid");
    } else if (item.classification !== null) fail("candidate_nonadmitted_classification_invalid");
    seenClaims.add(item.claimId);
    const policy = item.decision === "admitted" ? controllerPolicy(policyRegistry, item.claimId) : null;
    return { claimId: item.claimId, decision: item.decision, classification: item.classification, reasonCodes: [...item.reasonCodes].sort(), sourceRefs: claim.sourceRefs, policy };
  });
  if (seenClaims.size !== candidates.size) fail("candidate_decision_incomplete");
  const decisionsById = new Map(parsedDecisions.map((item) => [item.claimId, item]));
  const coverage = controllerCoverage(subject, sourceResolver, decisionsById);
  const unsigned = { schemaVersion: 2, kind: "SourceClaimAudit", documentSetDigest: subject.documentSetDigest, sourceDocuments: sortedDocuments(subject.sourceDocuments), candidateId: subject.candidateId, candidateDigest: subject.candidateDigest, decisions: parsedDecisions.sort((a, b) => a.claimId.localeCompare(b.claimId)), coverage: coverage.sort((a, b) => a.documentId.localeCompare(b.documentId) || a.startLine - b.startLine) };
  const digest = sha256(canonical(unsigned));
  return deepFreeze({ ...unsigned, auditId: `sca-${digest.slice(0, 24)}`, digest });
}

export function canonicalizeSourceClaimAuditCandidate(candidate, options) { return buildAudit(candidate, options); }

export function validateSourceClaimAudit(value, options) {
  const finalKeys = ["schemaVersion", "kind", "documentSetDigest", "sourceDocuments", "candidateId", "candidateDigest", "decisions", "coverage", "auditId", "digest"];
  if (!exactKeys(value, finalKeys) || value.schemaVersion !== 2 || value.kind !== "SourceClaimAudit" || !Array.isArray(value.sourceDocuments)) fail("schema_or_subject_invalid");
  const candidate = {
    decisions: value.decisions?.map((item) => exactKeys(item, ["claimId", "decision", "classification", "reasonCodes", "sourceRefs", "policy"]) ? ({ claimId: item.claimId, decision: item.decision, classification: item.classification, reasonCodes: item.reasonCodes }) : item)
  };
  const expected = buildAudit(candidate, options);
  if (canonical(value) !== canonical(expected)) fail("final_audit_not_canonical");
  return expected;
}

export function deterministicSuppliedSourceClaimAudit(subject, sourceResolver) {
  return buildAudit({
    decisions: subject.claims.map((claim) => ({ claimId: claim.claimId, decision: "admitted", classification: claim.fixedClassification, reasonCodes: ["supplied_high_assurance_validated"] }))
  }, { subject, sourceResolver });
}

export function admitAuditedSourceClaims({ subject, audit }) {
  const blocked = audit.decisions.filter((item) => item.decision !== "admitted");
  const unresolvedUnits = audit.coverage.filter((item) => item.kind === "meaningful" && item.disposition !== "covered");
  if (blocked.length || unresolvedUnits.length) fail(`admission_blocked:${[...blocked.map((item) => `${item.decision}:${item.claimId}`), ...unresolvedUnits.map((item) => `meaningful_source_material_unresolved:${item.coverageUnitId}`)].join(",")}`);
  const decisionsById = new Map(audit.decisions.map((item) => [item.claimId, item]));
  const claims = subject.claims.map((claim) => ({ claimId: claim.claimId, classification: decisionsById.get(claim.claimId).classification, sourceRefs: claim.sourceRefs })).sort((a, b) => a.claimId.localeCompare(b.claimId));
  const unsigned = { schemaVersion: 1, kind: "SourceClaimManifest", documentSetDigest: subject.documentSetDigest, sourceDocuments: subject.sourceDocuments, claims, audit: { auditId: audit.auditId, digest: audit.digest, candidateId: subject.candidateId, candidateDigest: subject.candidateDigest } };
  const digest = sha256(canonical(unsigned));
  return deepFreeze({ ...unsigned, manifestId: `scm-${digest.slice(0, 24)}`, digest });
}

function parseResult(text) {
  const raw = String(text); const fences = [...raw.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/gi)];
  try {
    if (fences.length === 1) return JSON.parse(fences[0][1].trim());
    if (fences.length > 1 || raw.includes("```")) throw new Error("ambiguous_fence");
    const objects = [];
    for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
      let depth = 0; let quoted = false; let escaped = false; let end = -1;
      for (let index = start; index < raw.length; index += 1) {
        const char = raw[index];
        if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
        if (char === '"') quoted = true;
        else if (char === "{") depth += 1;
        else if (char === "}") { depth -= 1; if (depth === 0) { end = index; break; } }
      }
      if (end === -1 || quoted || escaped) throw new Error("unterminated_object");
      objects.push(raw.slice(start, end + 1)); start = end;
    }
    if (objects.length !== 1) throw new Error("object_count_invalid");
    return JSON.parse(objects[0]);
  } catch { throw sourceIntakeFailure({ role: "source_claim_audit", phase: "parse", code: "malformed_json" }); }
}

export function parseSourceClaimAuditCandidateResult(text) { return parseResult(text); }

function resultDiagnostics(result, primaryReason) { return { attemptedThreadId: result.threadId, requestedTurnId: result.requestedTurnId, resolvedTurnId: result.resolvedTurnId, runtimeStage: "result_read", primaryReason }; }

export class SourceClaimAuditExecutor {
  constructor(config) { this.config = config; }
  async audit(subject, { recordTerminalReceipt = null, recordAttempt = null, recordFailure = null } = {}) {
    const resolver = createImportedSourceResolver({ repository: this.config.repository, documentationDir: this.config.project.documentationDir });
    const skeleton = { decisions: subject.claims.map((claim) => ({ claimId: claim.claimId, decision: "admitted|rejected|split-required|contradiction|unresolved", classification: "mandatory|non_mandatory|ambiguous when admitted; otherwise null", reasonCodes: ["reason_code"] })) };
    const prompt = [
      "Return exactly one fenced JSON block containing a SourceClaimAuditCandidate. This is an independent audit turn, separate from extraction.",
      "Schema (and no other fields): { decisions: [{ claimId, decision, classification, reasonCodes }] }. Use null classification for non-admitted decisions.",
      "Use only exact controller claim IDs from the skeleton and decide every claim exactly once. Do not return coverage, coverage IDs, document identity, source documents, source refs, ranges, excerpts, digests, hashes, policies, schemaVersion, kind, auditId, or any extra fields. The controller alone binds verified source references and creates final coverage.",
      `Controller-derived skeleton to fill: ${JSON.stringify(skeleton)}`,
      `Controlled semantic subject: ${JSON.stringify({ claims: subject.claims.map(({ claimId, candidateClassification, claimType, normalizedStatement }) => ({ claimId, candidateClassification, claimType, normalizedStatement })) })}`
    ].join("\n\n");
    const result = await runSourceIntakeTurn({ config: this.config, role: "source_claim_audit", developerInstructions: "You are the independent Specification Auditor. Audit only controller-provided candidate claim semantics; the controller alone creates coverage. Do not plan engineering work or authorize invented product decisions.", objective: "Independently audit source claim decisions.", tokenBudget: this.config.delivery?.sourceClaimAuditTokenBudget ?? 6000, prompt, recordTerminalReceipt, recordAttempt, recordFailure });
    let candidate;
    try { candidate = parseResult(result.resultText); }
    catch {
      const failure = sourceIntakeFailure({ role: "source_claim_audit", phase: "parse", code: "malformed_json", receipt: result.terminalReceipt, diagnostics: resultDiagnostics(result, "malformed_json") });
      await recordFailure?.(failure.sourceIntakeFailure); throw failure;
    }
    try { return buildAudit(candidate, { subject, sourceResolver: resolver, policyRegistry: this.config.specificationResolution?.policyRegistry }); }
    catch (error) {
      const code = /^source_claim_audit:(candidate_schema_invalid|candidate_claim_decision_invalid|candidate_admitted_classification_invalid|candidate_nonadmitted_classification_invalid|candidate_decision_incomplete|meaningful_source_material_unresolved)$/.exec(String(error?.message ?? error))?.[1] ?? "audit_result_invalid";
      const failure = sourceIntakeFailure({ role: "source_claim_audit", phase: "validate", code, receipt: result.terminalReceipt, diagnostics: resultDiagnostics(result, code) });
      await recordFailure?.(failure.sourceIntakeFailure); throw failure;
    }
  }
}
