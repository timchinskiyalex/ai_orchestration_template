import { createHash } from "node:crypto";

const RESULT_STATUSES = new Set(["pass", "gap", "unverified"]);
const MAX_CRITERIA = 80;
const MAX_REASON = 500;

/**
 * Controller-owned, deterministic acceptance units.  The model receives these
 * IDs but has no authority to create, omit, or rename them.
 */
export function snapshotThinAcceptanceSources(input) {
  const documents = normalizeAcceptanceDocuments(input);
  const sourceDigest = createHash("sha256").update(documents.map((document) => `${document.documentId}\0${document.sourceDigest}`).join("\n"), "utf8").digest("hex");
  return Object.freeze({ schemaVersion: 2, sourceDigest, lineCount: documents.reduce((total, document) => total + document.lineCount, 0), documents: Object.freeze(documents) });
}

function extractThinAcceptanceCriteriaLegacy(markdown) {
  const source = snapshotThinAcceptanceSources(markdown);
  const seen = new Set();
  const criteria = [];
  const candidateLines = source.normalized.split("\n").map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line && !line.startsWith("```"));
  const requirementLine = /(^#{2,6}\s)|(^[-*+]\s)|\b(must|shall|required|acceptance|criterion|should|має|повинен|потрібно|треба)\b/i;
  for (const { line, lineNumber } of candidateLines) {
    if (!requirementLine.test(line)) continue;
    const statement = line.replace(/^#{1,6}\s+|^[-*+]\s+|^\d+[.)]\s+/, "").slice(0, 1_000);
    if (!statement || seen.has(statement.toLocaleLowerCase())) continue;
    seen.add(statement.toLocaleLowerCase());
    const digest = createHash("sha256").update(`${lineNumber}\n${statement}`, "utf8").digest("hex");
    criteria.push(Object.freeze({ requirementId: `requirement-${digest.slice(0, 16)}`, criterionId: `criterion-${digest.slice(16, 32)}`, statement, sourceRef: Object.freeze({ startLine: lineNumber, endLine: lineNumber, fragmentDigest: digest }) }));
    if (criteria.length >= MAX_CRITERIA) break;
  }
  // Small briefs frequently have only an H1. It is still better to audit a
  // bounded explicit unit than to silently declare an empty specification done.
  if (!criteria.length) {
    const first = candidateLines.find(({ line }) => !line.startsWith("#")) ?? candidateLines[0];
    if (!first) throw new Error("Markdown contains no auditable acceptance text");
    const statement = first.line.slice(0, 1_000);
    const digest = createHash("sha256").update(`${first.lineNumber}\n${statement}`, "utf8").digest("hex");
    criteria.push(Object.freeze({ requirementId: `requirement-${digest.slice(0, 16)}`, criterionId: `criterion-${digest.slice(16, 32)}`, statement, sourceRef: Object.freeze({ startLine: first.lineNumber, endLine: first.lineNumber, fragmentDigest: digest }) }));
  }
  return Object.freeze(criteria);
}

function extractThinAcceptanceCriteriaNarrow(input) {
  const source = snapshotThinAcceptanceSources(input);
  const seen = new Set();
  const criteria = [];
  for (const document of source.documents) {
    const lines = document.normalized.split("\n").map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }));
    for (const { line, lineNumber } of lines) {
      if (!isProductAcceptanceStatement(line)) continue;
      const statement = line.replace(/^[-*+]\s+|^\d+[.)]\s+|^- \[[ xX]\]\s+/, "").slice(0, 1_000);
      const semanticKey = statement.toLocaleLowerCase();
      if (!statement || seen.has(semanticKey)) continue;
      seen.add(semanticKey);
      const digest = createHash("sha256").update(`${document.sourceDigest}\n${lineNumber}\n${statement}`, "utf8").digest("hex");
      criteria.push(Object.freeze({
        requirementId: `requirement-${digest.slice(0, 16)}`,
        criterionId: `criterion-${digest.slice(16, 32)}`,
        statement,
        sourceRef: Object.freeze({ documentId: document.documentId, sourceDigest: document.sourceDigest, startLine: lineNumber, endLine: lineNumber, fragmentDigest: digest })
      }));
      if (criteria.length >= MAX_CRITERIA) return Object.freeze(criteria);
    }
  }
  if (!criteria.length) throw new Error("No product acceptance requirements found in selected product documents");
  return Object.freeze(criteria);
}

/**
 * A source becomes product scope only at CLI admission.  Once admitted, keep
 * its product facts complete: database columns, bounded values, stack rows,
 * and bullet continuations are not discarded merely because they omit words
 * such as "user" or "must".  Only an explicitly process/meta section is
 * excluded.  The acceptance model has no control over this boundary.
 */
export function extractThinAcceptanceCriteria(input) {
  const source = snapshotThinAcceptanceSources(input);
  const criteria = [];
  const seen = new Set();
  for (const document of source.documents) {
    const lines = document.normalized.split("\n");
    let inFence = false;
    let excludedSection = false;
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index]; const line = raw.trim(); const lineNumber = index + 1;
      if (line.startsWith("```")) { inFence = !inFence; continue; }
      if (inFence || !line) continue;
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) { excludedSection = isExplicitProcessMetaHeading(heading[2]); continue; }
      if (excludedSection || !isProductUnitLine(line)) continue;
      const group = collectProductUnit(lines, index);
      const statement = group.lines.map((item, offset) => offset === 0 ? stripProductUnitPrefix(item.trim()) : item.trim()).join("\n").slice(0, 2_000);
      const semanticKey = statement.toLocaleLowerCase();
      if (!statement || seen.has(semanticKey)) { index = group.endIndex; continue; }
      seen.add(semanticKey);
      const fragment = lines.slice(index, group.endIndex + 1).join("\n");
      const fragmentDigest = createHash("sha256").update(fragment, "utf8").digest("hex");
      const identity = createHash("sha256").update(`${document.sourceDigest}\n${lineNumber}\n${group.endIndex + 1}\n${fragmentDigest}`, "utf8").digest("hex");
      criteria.push(Object.freeze({
        requirementId: `requirement-${identity.slice(0, 16)}`,
        criterionId: `criterion-${identity.slice(16, 32)}`,
        statement,
        sourceRef: Object.freeze({ documentId: document.documentId, sourceDigest: document.sourceDigest, startLine: lineNumber, endLine: group.endIndex + 1, fragmentDigest })
      }));
      if (criteria.length >= MAX_CRITERIA) return Object.freeze(criteria);
      index = group.endIndex;
    }
  }
  if (!criteria.length) throw new Error("No product acceptance requirements found in selected product documents");
  return Object.freeze(criteria);
}

function isExplicitProcessMetaHeading(value) {
  return /\b(process|workflow|orchestration|agent instructions?|review(?:er| process)?|audit process|execution|operations?|tooling|shell commands?|git workflow|contribution|meta)\b|\b(процес|оркестрац|інструкц|рев[’']ю|аудит|виконан|інструмент|команд|мета)/i.test(String(value));
}

function isProductUnitLine(line) {
  if (/^([-*+]\s+|- \[[ xX]\]\s+|\d+[.)]\s+)/.test(line)) return !isStandaloneProcessInstruction(line);
  if (/^\|.*\|$/.test(line)) return !/^\|?\s*:?-{3,}/.test(line.replaceAll(" ", ""));
  return /\b(must|shall|required|should|can|supports?|allows?|shows?|displays?|creates?|stores?|returns?|provides?)\b|\b(має|повинен|повинна|може|потрібно|дозволяє|показує|створює|зберігає|повертає|надає)/i.test(line);
}

function stripProductUnitPrefix(line) {
  return line.replace(/^[-*+]\s+|^\d+[.)]\s+|^- \[[ xX]\]\s+/, "");
}

function isStandaloneProcessInstruction(line) {
  return /\b(agent|worker|orchestrator|controller|planner|reviewer|prompt|worktree|codex|app server|shell|terminal|npm|node(?:\.js)?|git|commit|push|pull request|pr|ci\/cd|documentation|markdown|token budget|quota)\b|\b(агент|воркер|оркестратор|контролер|планувальник|рев[’']юер|промпт|ворктрі|термінал|коміт|пуш|документац|токен|квот)/i.test(line);
}

function collectProductUnit(lines, startIndex) {
  const first = lines[startIndex];
  const isBullet = /^\s*(?:[-*+]\s+|- \[[ xX]\]\s+|\d+[.)]\s+)/.test(first);
  let endIndex = startIndex;
  if (isBullet) {
    for (let cursor = startIndex + 1; cursor < lines.length; cursor += 1) {
      const value = lines[cursor]; const trimmed = value.trim();
      if (!trimmed) break;
      if (/^\s*#/.test(value) || /^\s*(?:[-*+]\s+|- \[[ xX]\]\s+|\d+[.)]\s+)/.test(value) || /^\|.*\|$/.test(trimmed)) break;
      if (!/^\s+/.test(value)) break;
      endIndex = cursor;
    }
  }
  return { lines: lines.slice(startIndex, endIndex + 1), endIndex };
}

/** Controller-owned classification: audit output cannot promote process text. */
export function isProductAcceptanceStatement(value) {
  const line = String(value ?? "").trim();
  if (!/^([-*+]\s+|- \[[ xX]\]\s+|\d+[.)]\s+)/.test(line)) return false;
  const statement = line.replace(/^[-*+]\s+|^\d+[.)]\s+|^- \[[ xX]\]\s+/, "");
  const processOnly = /\b(agent|worker|orchestrator|controller|planner|reviewer|audit(?:or|ing)?|prompt|stage|task|worktree|codex|app server|shell|terminal|npm|node(?:\.js)?|git|commit|push|pull request|pr|ci\/cd|documentation|document(?:ation)?|markdown|folder|directory|file path|line number|token budget|quota|агент|воркер|оркестратор|контролер|планувальник|рев[’']юер|аудит|промпт|етап|таск|ворктрі|термінал|коміт|пуш|документац|папк|файл|шлях|рядок|токен|квот)\b/i;
  if (!statement || /^(note|example|rationale|implementation note)\s*:/i.test(statement) || processOnly.test(statement)) return false;
  const productSignal = /\b(users?|visitors?|customers?|travelers?|members?|admins?|application|app|website|web|api|service|system|screen|page|guides?|cities|city|trip|account|profile|favorites?|ratings?|payment|purchase|search|map|data|content|booking|route|notification|dashboard|report)\b|\b(користувач|відвідувач|клієнт|мандрівник|адмін|додаток|застосунок|сайт|сервіс|система|екран|сторінка|гід|місто|подорож|акаунт|профіль|обран|рейтинг|оплат|покупк|пошук|мапа|дані|контент|бронюван|маршрут|сповіщен|панел|звіт)/i;
  const requirementSignal = /\b(must|shall|required|can|should|supports?|allows?|shows?|displays?|creates?|stores?|returns?|provides?)\b|\b(має|повинен|повинна|може|потрібно|дозволяє|показує|створює|зберігає|повертає|надає)/i;
  return productSignal.test(statement) && requirementSignal.test(statement);
}

function normalizeAcceptanceDocuments(input) {
  const supplied = typeof input === "string" ? [{ documentId: "inline-product-document", markdown: input }] : input;
  if (!Array.isArray(supplied) || !supplied.length) throw new TypeError("at least one product document is required");
  const seen = new Set();
  return supplied.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.markdown !== "string" || !item.markdown.trim()) throw new TypeError("product document markdown must be non-empty");
    const documentId = typeof item.documentId === "string" && item.documentId.trim() ? item.documentId.trim() : `product-document-${index + 1}`;
    if (seen.has(documentId)) throw new Error(`duplicate product document ID: ${documentId}`);
    seen.add(documentId);
    const normalized = item.markdown.replace(/\r\n?/g, "\n");
    return Object.freeze({ documentId, sourceDigest: createHash("sha256").update(normalized, "utf8").digest("hex"), lineCount: normalized.split("\n").length, normalized });
  }).sort((left, right) => left.documentId.localeCompare(right.documentId));
}

export function buildThinAcceptancePrompt({ criteria, candidateSha }) {
  if (!Array.isArray(criteria) || !criteria.length) throw new TypeError("criteria must be a non-empty array");
  if (typeof candidateSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(candidateSha)) throw new TypeError("candidateSha must be a Git SHA");
  return [
    "You are an independent product acceptance auditor.",
    "Inspect the controller-assigned candidate repository at its current exact Git commit.",
    "Do not edit files, run Git mutations, create commits, push, create PRs, or claim controller authority.",
    "For every controller-issued criterion below, decide whether the current candidate demonstrably satisfies it.",
    "Return exactly JSON, with no Markdown fences or commentary.",
    'Exact schema: {"results":[{"criterionId":"criterion-id","status":"pass|gap|unverified","reason":"bounded explanation"}]}.',
    "Return exactly one result for every supplied criterion ID. Do not add fields or IDs.",
    `Candidate SHA (context only; do not return it): ${candidateSha}`,
    "\n--- CONTROLLER CRITERIA ---",
    JSON.stringify(criteria.map(({ criterionId, statement }) => ({ criterionId, statement }))),
    "--- END CONTROLLER CRITERIA ---",
  ].join("\n");
}

/** Strictly maps a semantic LLM response onto controller-issued criteria. */
export function validateThinAcceptanceCandidate(candidate, criteria) {
  if (!isPlainObject(candidate) || Object.keys(candidate).length !== 1 || !Array.isArray(candidate.results)) {
    throw new Error("acceptance audit must contain exactly a results array");
  }
  const expected = new Set(criteria.map((criterion) => criterion.criterionId));
  if (candidate.results.length !== expected.size) throw new Error("acceptance audit must return exactly one result per criterion");
  const mapped = new Map();
  for (const row of candidate.results) {
    if (!isPlainObject(row) || !sameKeys(row, ["criterionId", "status", "reason"])) throw new Error("acceptance result has unsupported fields");
    if (typeof row.criterionId !== "string" || !expected.has(row.criterionId) || mapped.has(row.criterionId)) {
      throw new Error("acceptance result has an unknown or duplicate criterion ID");
    }
    if (!RESULT_STATUSES.has(row.status)) throw new Error("acceptance result has invalid status");
    if (typeof row.reason !== "string" || !row.reason.trim()) throw new Error("acceptance result must have a reason");
    mapped.set(row.criterionId, Object.freeze({ criterionId: row.criterionId, status: row.status, reason: row.reason.trim().replace(/[\r\n]+/g, " ").slice(0, MAX_REASON) }));
  }
  const results = criteria.map((criterion) => mapped.get(criterion.criterionId));
  return Object.freeze({ results, passing: results.every((row) => row.status === "pass") });
}

/**
 * Performs one audit, optionally one controller-authorized repair, and a
 * mandatory second audit/verification. Every incomplete result fails closed.
 */
export async function runThinAcceptance({ markdown, sources = null, candidateSha, audit, verify, repair = null, onEvent = () => {} } = {}) {
  if (typeof audit !== "function" || typeof verify !== "function") throw new TypeError("audit and verify must be functions");
  if (repair != null && typeof repair !== "function") throw new TypeError("repair must be a function when provided");
  const sourceInput = sources ?? markdown;
  const sourceSnapshot = snapshotThinAcceptanceSources(sourceInput);
  const criteria = extractThinAcceptanceCriteria(sourceInput);
  const events = [];
  const emit = (type, details = {}) => { const event = { type, ...details }; events.push(event); onEvent(event); };
  let currentSha = candidateSha;

  const auditOnce = async (phase) => {
    emit("audit_started", { phase, candidateSha: currentSha });
    let parsed;
    try { parsed = await audit({ criteria, candidateSha: currentSha, prompt: buildThinAcceptancePrompt({ criteria, candidateSha: currentSha }), phase }); }
    catch (error) { return { ok: false, code: "audit_execution_failed", detail: safeError(error), auditRuntime: safeAuditRuntime(error?.acceptanceAuditDiagnostic) }; }
    try {
      const report = validateThinAcceptanceCandidate(typeof parsed === "string" ? JSON.parse(parsed) : parsed, criteria);
      emit("audit_completed", { phase, passing: report.passing });
      return { ok: true, report };
    } catch (error) { return { ok: false, code: "audit_result_invalid", detail: safeError(error) }; }
  };
  const verifyOnce = async (phase) => {
    emit("verification_started", { phase, candidateSha: currentSha });
    const verificationId = createHash("sha256").update(`thin-acceptance/v1\n${currentSha}`, "utf8").digest("hex").slice(0, 24);
    try {
      const result = await verify({ candidateSha: currentSha, phase, verificationId });
      if (result === false || result?.ok === false) return { ok: false, verificationId, detail: bounded(result?.output ?? result?.reason ?? "verification failed") };
    }
    catch (error) { return { ok: false, detail: bounded(error?.output ?? error?.message ?? error) }; }
    emit("verification_completed", { phase, candidateSha: currentSha, verificationId });
    return { ok: true, verificationId, candidateSha: currentSha };
  };

  let audited = await auditOnce("initial");
  if (!audited.ok) return blocked(audited.code, { candidateSha: currentSha, sourceSnapshot, criteria, events, detail: audited.detail, auditRuntime: audited.auditRuntime });
  let verified = await verifyOnce("initial");
  if (audited.report.passing && verified.ok) return accepted({ candidateSha: currentSha, sourceSnapshot, criteria, report: audited.report, verification: verified, repaired: false, events });
  if (!repair) return blocked("acceptance_unverified", { candidateSha: currentSha, sourceSnapshot, criteria, report: audited.report, verification: verified, events });

  emit("repair_started", { candidateSha: currentSha });
  let repaired;
  try {
    repaired = await repair({
      candidateSha: currentSha,
      criteria,
      audit: audited.report,
      verification: verified,
      failureOutput: repairContext(audited.report, verified),
      attempts: 0,
    });
  } catch (error) { return blocked("repair_execution_failed", { candidateSha: currentSha, sourceSnapshot, criteria, report: audited.report, events, detail: safeError(error) }); }
  if (repaired?.ok !== true || typeof repaired.candidateSha !== "string") {
    return blocked(repaired?.reasonCode ?? "repair_failed", { candidateSha: currentSha, sourceSnapshot, criteria, report: audited.report, events, detail: bounded(repaired?.detail) });
  }
  currentSha = repaired.candidateSha;
  emit("repair_completed", { candidateSha: currentSha, attempts: repaired.attempts ?? 1 });

  audited = await auditOnce("after_repair");
  if (!audited.ok) return blocked(audited.code, { candidateSha: currentSha, sourceSnapshot, criteria, events, detail: audited.detail, auditRuntime: audited.auditRuntime });
  verified = await verifyOnce("after_repair");
  if (!audited.report.passing || !verified.ok) return blocked("acceptance_unverified_after_repair", { candidateSha: currentSha, sourceSnapshot, criteria, report: audited.report, verification: verified, events });
  return accepted({ candidateSha: currentSha, sourceSnapshot, criteria, report: audited.report, verification: verified, repaired: true, events });
}

function accepted({ candidateSha, sourceSnapshot, criteria, report, verification, repaired, events }) {
  return Object.freeze({ ok: true, state: "completed_spec_verified", candidateSha, repaired, report: boundedReport({ state: "completed_spec_verified", candidateSha, sourceSnapshot, criteria, results: report.results, verification }), events });
}
function blocked(code, { candidateSha, sourceSnapshot = null, criteria, report = null, verification = null, events, detail = null, auditRuntime = null }) {
  return Object.freeze({ ok: false, state: "blocked", code, candidateSha, report: boundedReport({ state: "blocked", code, candidateSha, sourceSnapshot, criteria, results: report?.results ?? [], verification, detail, auditRuntime }), events });
}
function boundedReport({ state, code = null, candidateSha, sourceSnapshot, criteria, results, verification, detail = null, auditRuntime = null }) {
  return Object.freeze({ schemaVersion: 2, kind: "ThinAcceptanceReport", state, code, candidateSha, sourceSnapshot: sourceSnapshot ? { sourceDigest: sourceSnapshot.sourceDigest, lineCount: sourceSnapshot.lineCount, documents: sourceSnapshot.documents.map((document) => ({ documentId: document.documentId, sourceDigest: document.sourceDigest, lineCount: document.lineCount })) } : null, criterionCount: criteria.length, criteria: criteria.map((criterion) => ({ requirementId: criterion.requirementId, criterionId: criterion.criterionId, sourceRef: criterion.sourceRef })), results: results.map((row) => ({ criterionId: row.criterionId, status: row.status, reason: bounded(row.reason) })), verification: verification?.ok ? { verificationId: verification.verificationId, candidateSha: verification.candidateSha, status: "pass" } : { verificationId: verification?.verificationId ?? null, candidateSha, status: "failed" }, detail: detail ? bounded(detail) : null, auditRuntime: safeAuditRuntime(auditRuntime) });
}
function repairContext(report, verification) {
  const gaps = report.results.filter((row) => row.status !== "pass").map((row) => `${row.criterionId}: ${row.status}: ${row.reason}`);
  if (!verification.ok) gaps.push(`verification: ${verification.detail ?? "failed"}`);
  return bounded(gaps.join("\n"));
}
function bounded(value) { return String(value ?? "").replace(/(?:authorization|bearer|token|password)\s*[:=]\s*\S+/ig, "$1=[REDACTED]").replace(/[\r\n]+/g, " ").slice(0, 2_000); }
function safeError(error) { return bounded(error?.message ?? error); }
function safeAuditRuntime(value) {
  if (!value || typeof value !== "object") return null;
  const safeId = (item) => typeof item === "string" && item.length <= 512 ? item : null;
  return Object.freeze({
    threadId: safeId(value.threadId), requestedTurnId: safeId(value.requestedTurnId), resolvedTurnId: safeId(value.resolvedTurnId),
    runtimeStage: safeId(value.runtimeStage), code: safeId(value.code), errorClass: safeId(value.errorClass),
    process: typeof value.process === "string" ? bounded(value.process) : null,
    reconnectRequired: value.reconnectRequired === true
  });
}
function isPlainObject(value) { return value != null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function sameKeys(value, keys) { const actual = Object.keys(value).sort(); return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]); }
