import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { documentIdForPath } from "./product-blueprint.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const claimIdPattern = /^[a-z][a-z0-9-]{0,95}$/;
const classifications = new Set(["mandatory", "non_mandatory", "ambiguous"]);
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
export const SOURCE_CLAIM_MANIFEST_SCHEMA_VERSION = 1;
export const SOURCE_CLAIM_EXTRACTION_SCHEMA_VERSION = 1;
const claimTypes = new Set(["functional", "non_functional", "constraint", "decision", "risk", "assumption", "scope"]);

export function normalizeSourceText(text) {
  return String(text).replace(/\r\n?/g, "\n");
}

export function sourceLines(text) {
  return normalizeSourceText(text).split("\n");
}

export function sourceFragmentDigest(text, startLine, endLine) {
  return sha256(sourceLines(text).slice(startLine - 1, endLine).join("\n"));
}

function provenanceError(message) {
  throw new Error(`source_provenance: ${message}`);
}
function claimContractError(message) { throw new Error(`source_claim_contract: ${message}`); }

function isInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation && !relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation);
}

function safeInventoryPath(path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\")) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

function loadInventory({ repository, documentationDir }) {
  const repositoryRoot = resolve(repository);
  const documentationRoot = resolve(repositoryRoot, documentationDir);
  if (!isInside(repositoryRoot, documentationRoot)) provenanceError("documentation directory escapes the controller repository");
  const inventoryPath = join(documentationRoot, "inventory.json");
  if (!existsSync(inventoryPath)) provenanceError("controller documentation inventory is missing; re-import documentation before Bootstrap");
  let inventory;
  try { inventory = JSON.parse(readFileSync(inventoryPath, "utf8")); }
  catch { provenanceError("controller documentation inventory is unreadable; re-import documentation before Bootstrap"); }
  if (!Array.isArray(inventory.files) || !inventory.files.length) provenanceError("controller documentation inventory has no source files; re-import documentation before Bootstrap");
  const documents = new Map();
  for (const file of inventory.files) {
    if (!file || !safeInventoryPath(file.path) || typeof file.documentId !== "string" || !digestPattern.test(file.sha256 ?? "")) provenanceError("controller documentation inventory has an unsafe source entry; re-import documentation before Bootstrap");
    if (file.documentId !== documentIdForPath(file.path)) provenanceError(`inventory document identity is invalid for '${file.path}'`);
    if (documents.has(file.documentId)) provenanceError(`inventory duplicates document '${file.documentId}'`);
    const absolutePath = resolve(documentationRoot, file.path);
    if (!isInside(documentationRoot, absolutePath)) provenanceError(`inventory path escapes documentation root for '${file.documentId}'`);
    documents.set(file.documentId, { documentId: file.documentId, path: file.path, sha256: file.sha256, absolutePath });
  }
  return { documentationRoot, documents };
}

export function createImportedSourceResolver(context) {
  const { documentationRoot, documents } = loadInventory(context);
  const sourceDocuments = [...documents.values()].map(({ documentId, path, sha256 }) => ({ documentId, path, sha256 }));
  const realDocumentationRoot = realpathSync(documentationRoot);

  function readDocument(documentId) {
    const document = documents.get(documentId);
    if (!document) provenanceError(`document '${String(documentId)}' is absent from the controller inventory`);
    if (!existsSync(document.absolutePath) || lstatSync(document.absolutePath).isSymbolicLink()) provenanceError(`imported document '${documentId}' is unavailable or substituted; re-import documentation before Bootstrap`);
    const realDocumentPath = realpathSync(document.absolutePath);
    if (!isInside(realDocumentationRoot, realDocumentPath)) provenanceError(`imported document '${documentId}' escapes the controller intake root`);
    const text = readFileSync(document.absolutePath, "utf8");
    if (sha256(normalizeSourceText(text)) !== document.sha256) provenanceError(`imported document '${documentId}' no longer matches its controller inventory; re-import documentation before Bootstrap`);
    return text;
  }

  function verify(ref, label = "source reference") {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) provenanceError(`${label} is not an object`);
    if (typeof ref.documentId !== "string" || !documents.has(ref.documentId)) provenanceError(`${label} names a document absent from the controller inventory`);
    if (!Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine)) provenanceError(`${label} must use integer startLine and endLine`);
    if (ref.startLine < 1 || ref.endLine < ref.startLine) provenanceError(`${label} has an invalid line range`);
    if (!digestPattern.test(ref.excerptDigest ?? "")) provenanceError(`${label} has an invalid excerptDigest`);
    const lines = sourceLines(readDocument(ref.documentId));
    if (ref.endLine > lines.length) provenanceError(`${label} line range is outside imported document '${ref.documentId}'`);
    const actualDigest = sha256(lines.slice(ref.startLine - 1, ref.endLine).join("\n"));
    if (actualDigest !== ref.excerptDigest) provenanceError(`${label} digest does not match imported document '${ref.documentId}'`);
    return { documentId: ref.documentId, startLine: ref.startLine, endLine: ref.endLine, excerptDigest: actualDigest };
  }

  function canonicalRef(documentId, startLine, endLine, label = "source reference") {
    if (typeof documentId !== "string" || !documents.has(documentId)) provenanceError(`${label} names a document absent from the controller inventory`);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) provenanceError(`${label} has an invalid line range`);
    const lines = sourceLines(readDocument(documentId));
    if (endLine > lines.length) provenanceError(`${label} line range is outside imported document '${documentId}'`);
    return Object.freeze({ documentId, startLine, endLine, excerptDigest: sha256(lines.slice(startLine - 1, endLine).join("\n")) });
  }

  function lineCount(documentId) { const lines = sourceLines(readDocument(documentId)); return lines.at(-1) === "" ? lines.length - 1 : lines.length; }
  function controlledDocuments() {
    return Object.freeze(sourceDocuments.map((document) => Object.freeze({
      ...document,
      lineCount: lineCount(document.documentId),
      text: readDocument(document.documentId)
    })));
  }
  return Object.freeze({ sourceDocuments: Object.freeze(sourceDocuments), verify, canonicalRef, lineCount, controlledDocuments });
}

export function sourceClaimCandidateId({ documentId, startLine, endLine, claimType, normalizedStatement }) {
  const identity = `${documentId}:${startLine}:${endLine}:${claimType}:${normalizedStatement}`;
  return `claim-${sha256(identity).slice(0, 24)}`;
}

// Raw extraction output is intentionally semantic only.  Every provenance
// digest and stable identifier is derived from the controller-owned inventory.
export function canonicalizeSourceClaimExtractionCandidate(value, { sourceResolver }) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== SOURCE_CLAIM_EXTRACTION_SCHEMA_VERSION || !["SourceClaimExtractionCandidate", "SourceClaimExtraction"].includes(value.kind) || !Array.isArray(value.claims) || !value.claims.length) claimContractError("source_claim_extraction_candidate_schema_invalid");
  const sourceDocuments = sourceResolver.sourceDocuments;
  const documentSetDigest = sha256(canonical([...sourceDocuments].sort((a, b) => a.path.localeCompare(b.path))));
  const documents = new Map(sourceDocuments.map((item) => [item.documentId, item]));
  const claims = value.claims.map((claim) => {
    const location = claim?.sourceLocation ?? claim;
    if (!claim || typeof claim !== "object" || Array.isArray(claim) || !claimTypes.has(claim.claimType) || !classifications.has(claim.classification) || typeof claim.normalizedStatement !== "string" || !claim.normalizedStatement.trim() || claim.normalizedStatement.length > 2000 || !location || typeof location !== "object" || typeof location.documentId !== "string" || !Number.isInteger(location.startLine) || !Number.isInteger(location.endLine)) claimContractError("source_claim_extraction_candidate_semantics_invalid");
    const normalizedStatement = claim.normalizedStatement.trim().replace(/\s+/g, " ");
    let sourceQuote;
    try { sourceQuote = sourceResolver.canonicalRef(location.documentId, location.startLine, location.endLine, "extracted candidate"); }
    catch (error) { claimContractError(`source_claim_extraction_canonicalization_failed:${error.message.replace(/^source_provenance: /, "")}`); }
    const source = documents.get(sourceQuote.documentId);
    const canonicalClaim = {
      claimId: sourceClaimCandidateId({ documentId: sourceQuote.documentId, startLine: sourceQuote.startLine, endLine: sourceQuote.endLine, claimType: claim.claimType, normalizedStatement }),
      documentId: sourceQuote.documentId, startLine: sourceQuote.startLine, endLine: sourceQuote.endLine,
      sourceDigest: source.sha256, claimType: claim.claimType, normalizedStatement, classification: claim.classification,
      sourceQuote
    };
    return Object.freeze(canonicalClaim);
  });
  const ids = new Set(claims.map((claim) => claim.claimId));
  if (ids.size !== claims.length) claimContractError("source_claim_extraction_canonicalization_duplicate_claim");
  return validateSourceClaimExtraction({ schemaVersion: SOURCE_CLAIM_EXTRACTION_SCHEMA_VERSION, kind: "SourceClaimExtraction", documentSetDigest, sourceDocuments, claims }, { sourceResolver });
}

// This deliberately validates evidence only. It does not admit claims as
// facts, require document coverage, or create the authoritative manifest.
export function validateSourceClaimExtraction(value, { sourceResolver }) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== SOURCE_CLAIM_EXTRACTION_SCHEMA_VERSION || value.kind !== "SourceClaimExtraction") claimContractError("source_claim_extraction_schema_invalid");
  const sourceDocuments = sourceResolver.sourceDocuments;
  const documentSetDigest = sha256(canonical([...sourceDocuments].sort((a, b) => a.path.localeCompare(b.path))));
  if (value.documentSetDigest !== documentSetDigest || !Array.isArray(value.claims) || !value.claims.length) claimContractError("source_claim_extraction_document_set_or_claims_invalid");
  const documents = new Map(sourceDocuments.map((item) => [item.documentId, item]));
  const seen = new Set();
  const claims = value.claims.map((claim) => {
    if (!claim || typeof claim !== "object" || Array.isArray(claim) || !claimIdPattern.test(claim.claimId ?? "") || seen.has(claim.claimId) || !documents.has(claim.documentId) || !Number.isInteger(claim.startLine) || !Number.isInteger(claim.endLine) || claim.startLine < 1 || claim.endLine < claim.startLine || !digestPattern.test(claim.sourceDigest ?? "") || !claimTypes.has(claim.claimType) || !classifications.has(claim.classification) || typeof claim.normalizedStatement !== "string" || !claim.normalizedStatement.trim() || claim.normalizedStatement.length > 2000) claimContractError("source_claim_extraction_claim_invalid");
    const expected = documents.get(claim.documentId);
    if (claim.sourceDigest !== expected.sha256) claimContractError(`source_claim_extraction_source_digest_mismatch:${claim.claimId}`);
    let ref;
    try { ref = sourceResolver.verify({ documentId: claim.documentId, startLine: claim.startLine, endLine: claim.endLine, excerptDigest: claim.sourceQuote?.excerptDigest }, `extracted claim '${claim.claimId}'`); }
    catch (error) { claimContractError(error.message.replace(/^source_provenance: /, "")); }
    if (!claim.sourceQuote || claim.sourceQuote.documentId !== claim.documentId || claim.sourceQuote.startLine !== claim.startLine || claim.sourceQuote.endLine !== claim.endLine) claimContractError(`source_claim_extraction_quote_reference_invalid:${claim.claimId}`);
    const normalizedStatement = claim.normalizedStatement.trim().replace(/\s+/g, " ");
    const stableId = sourceClaimCandidateId({ ...claim, normalizedStatement });
    if (claim.claimId !== stableId) claimContractError(`source_claim_extraction_claim_id_unstable:${claim.claimId}`);
    seen.add(claim.claimId);
    return Object.freeze({ claimId: claim.claimId, documentId: claim.documentId, startLine: claim.startLine, endLine: claim.endLine, sourceDigest: claim.sourceDigest, claimType: claim.claimType, normalizedStatement, classification: claim.classification, sourceQuote: ref });
  });
  const unsigned = { schemaVersion: SOURCE_CLAIM_EXTRACTION_SCHEMA_VERSION, kind: "SourceClaimExtraction", documentSetDigest, sourceDocuments, claims: [...claims].sort((a, b) => a.claimId.localeCompare(b.claimId)) };
  const digest = sha256(canonical(unsigned));
  return Object.freeze({ ...unsigned, extractionId: `sce-${digest.slice(0, 24)}`, digest });
}

// This is deliberately a declaration compiler, not an extraction heuristic.
// Every normalized source line belongs to exactly one declared claim range.
export function compileImportedSourceClaimManifest(context) {
  const resolver = createImportedSourceResolver(context);
  const root = resolve(context.repository, context.documentationDir);
  const declarationPath = join(root, "source-claims.json");
  if (!existsSync(declarationPath) || lstatSync(declarationPath).isSymbolicLink()) claimContractError("missing_required_source_claims_declaration");
  let declaration;
  try { declaration = JSON.parse(readFileSync(declarationPath, "utf8")); }
  catch { claimContractError("source_claims_declaration_invalid_json"); }
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration) || declaration.schemaVersion !== SOURCE_CLAIM_MANIFEST_SCHEMA_VERSION || declaration.kind !== "SourceClaimsDeclaration") claimContractError("source_claims_declaration_schema_invalid");
  const sourceDocuments = resolver.sourceDocuments;
  const documentSetDigest = sha256(canonical([...sourceDocuments].sort((a, b) => a.path.localeCompare(b.path))));
  if (declaration.documentSetDigest !== documentSetDigest) claimContractError("source_claims_document_set_digest_mismatch");
  if (!Array.isArray(declaration.documents) || !Array.isArray(declaration.claims)) claimContractError("source_claims_declaration_collections_invalid");
  const inventory = new Map(sourceDocuments.map((document) => [document.documentId, document]));
  if (declaration.documents.length !== inventory.size) claimContractError("source_claims_document_coverage_incomplete");
  const claims = new Map();
  for (const claim of declaration.claims) {
    if (!claim || typeof claim !== "object" || Array.isArray(claim) || !claimIdPattern.test(claim.claimId ?? "") || claims.has(claim.claimId) || !classifications.has(claim.classification) || !Array.isArray(claim.sourceRefs) || !claim.sourceRefs.length) claimContractError("source_claim_invalid_or_duplicate_id");
    const refs = claim.sourceRefs.map((ref) => {
      try { return resolver.verify(ref, `source claim '${claim.claimId}'`); }
      catch (error) { claimContractError(error.message.replace(/^source_provenance: /, "")); }
    });
    const unique = new Set(refs.map((ref) => `${ref.documentId}:${ref.startLine}:${ref.endLine}:${ref.excerptDigest}`));
    if (unique.size !== refs.length) claimContractError(`source_claim_duplicate_range:${claim.claimId}`);
    claims.set(claim.claimId, { claimId: claim.claimId, classification: claim.classification, sourceRefs: refs });
  }
  if (!claims.size) claimContractError("source_claims_empty");
  const coveredRefs = new Set();
  const declaredDocuments = new Set();
  for (const document of declaration.documents) {
    if (!document || typeof document !== "object" || Array.isArray(document) || !inventory.has(document.documentId) || declaredDocuments.has(document.documentId)) claimContractError("source_claims_foreign_or_duplicate_document");
    const expected = inventory.get(document.documentId);
    if (document.path !== expected.path || document.sha256 !== expected.sha256 || !Array.isArray(document.coverage) || !document.coverage.length) claimContractError(`source_claims_document_identity_or_coverage_invalid:${document.documentId}`);
    declaredDocuments.add(document.documentId);
    const ranges = [];
    for (const item of document.coverage) {
      if (!item || typeof item !== "object" || !claims.has(item.claimId)) claimContractError(`source_claims_unknown_coverage_claim:${document.documentId}`);
      let ref;
      try { ref = resolver.verify({ documentId: document.documentId, startLine: item.startLine, endLine: item.endLine, excerptDigest: item.excerptDigest }, `coverage '${item.claimId}'`); }
      catch (error) { claimContractError(error.message.replace(/^source_provenance: /, "")); }
      const key = `${ref.documentId}:${ref.startLine}:${ref.endLine}:${ref.excerptDigest}`;
      if (!claims.get(item.claimId).sourceRefs.some((candidate) => `${candidate.documentId}:${candidate.startLine}:${candidate.endLine}:${candidate.excerptDigest}` === key) || coveredRefs.has(key)) claimContractError(`source_claims_coverage_not_exact:${item.claimId}`);
      coveredRefs.add(key); ranges.push(ref);
    }
    ranges.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
    const lineCount = resolver.lineCount(document.documentId);
    let next = 1;
    for (const range of ranges) {
      if (range.startLine !== next) claimContractError(`source_claims_coverage_gap_or_overlap:${document.documentId}`);
      next = range.endLine + 1;
    }
    if (next !== lineCount + 1) claimContractError(`source_claims_coverage_gap_or_overlap:${document.documentId}`);
  }
  if (declaredDocuments.size !== inventory.size) claimContractError("source_claims_document_coverage_incomplete");
  for (const claim of claims.values()) for (const ref of claim.sourceRefs) {
    const key = `${ref.documentId}:${ref.startLine}:${ref.endLine}:${ref.excerptDigest}`;
    if (!coveredRefs.has(key)) claimContractError(`source_claims_uncovered_claim_range:${claim.claimId}`);
  }
  const unsigned = { schemaVersion: SOURCE_CLAIM_MANIFEST_SCHEMA_VERSION, kind: "SourceClaimManifest", documentSetDigest, sourceDocuments, claims: [...claims.values()].sort((a, b) => a.claimId.localeCompare(b.claimId)) };
  const digest = sha256(canonical(unsigned));
  return Object.freeze({ ...unsigned, manifestId: `scm-${digest.slice(0, 24)}`, digest });
}
