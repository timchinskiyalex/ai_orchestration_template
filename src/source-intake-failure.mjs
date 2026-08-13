const ROLE_NAMES = Object.freeze({ source_claim_extraction: "extraction", source_claim_audit: "audit" });
const PHASES = new Set(["terminal", "result_read", "parse", "canonicalize", "validate", "persist"]);
const CODE = /^[a-z][a-z0-9_]{0,95}$/;

export const SOURCE_INTAKE_FAILURE_SCHEMA_VERSION = 1;

export function sourceIntakeFailureRole(role) {
  return ROLE_NAMES[role] ?? null;
}

export function sourceIntakeFailure({ role, phase, code, receipt = null, errorClass = null, diagnostics = null }) {
  const failureRole = sourceIntakeFailureRole(role);
  if (!failureRole || !PHASES.has(phase) || !CODE.test(code)) throw new Error("source_intake_failure:invalid");
  const receiptIdentity = receipt && typeof receipt === "object" && ["threadId", "requestedTurnId", "resolvedTurnId"].every((key) => typeof receipt[key] === "string" && receipt[key])
    ? Object.freeze({ threadId: receipt.threadId, requestedTurnId: receipt.requestedTurnId, resolvedTurnId: receipt.resolvedTurnId })
    : null;
  const safeErrorClass = typeof errorClass === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(errorClass) ? errorClass : null;
  const failure = Object.freeze({ schemaVersion: SOURCE_INTAKE_FAILURE_SCHEMA_VERSION, role: failureRole, phase, code, receiptIdentity, diagnostics: diagnostics && typeof diagnostics === "object" ? { ...diagnostics, ...(safeErrorClass ? { errorClass: safeErrorClass } : {}) } : (safeErrorClass ? { errorClass: safeErrorClass } : null) });
  const error = new Error(`${role}:${phase}:${code}`);
  error.name = "SourceIntakeFailure";
  error.sourceIntakeFailure = failure;
  return error;
}

export function sourceIntakeFailureFrom(error) {
  return error?.sourceIntakeFailure?.schemaVersion === SOURCE_INTAKE_FAILURE_SCHEMA_VERSION ? error.sourceIntakeFailure : null;
}
