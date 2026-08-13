// Controller-owned, in-process execution boundary. App Server is the only
// production adapter; this is deliberately not a provider discovery API.
export const EXECUTION_PROVIDER_VERSION = "execution-provider/v1";

export const REQUIRED_EXECUTION_CAPABILITIES = Object.freeze([
  "lifecycle_completion", "final_result_read", "idempotent_interrupt",
  "usage_updates", "account_reads", "bounded_diagnostics", "approval_requests",
  "durable_terminal_reconciliation"
]);

export const EXECUTION_OPERATIONS = Object.freeze([
  "handshake", "account_read", "start_thread", "set_goal", "start_turn",
  "observe_terminal", "reconcile_terminal", "read_final_result", "interrupt_turn", "approval_response",
  "shutdown", "diagnostics"
]);

export const EXECUTION_OPERATION_METHODS = Object.freeze({
  handshake: "handshake", account_read: "accountRead", start_thread: "startThread",
  set_goal: "setGoal", start_turn: "startTurn", observe_terminal: "observeTerminal", reconcile_terminal: "reconcileTerminal",
  read_final_result: "readFinalResult", interrupt_turn: "interruptTurn",
  approval_response: "approvalResponse", shutdown: "shutdown", diagnostics: "diagnostics"
});

export const LIFECYCLE_EVENT_KINDS = Object.freeze([
  "usage_updated", "item_started", "item_completed", "turn_completed",
  "turn_alias", "approval_requested", "account_updated", "process_exit"
]);

export class ExecutionProviderError extends Error {
  constructor(errorCode, message = errorCode, details = {}) {
    super(`${errorCode}: ${message}`); this.name = "ExecutionProviderError"; this.errorCode = errorCode;
    this.errorClass = details.errorClass ?? "protocol"; this.diagnostics = details.diagnostics ?? null;
  }
}

export const safeDiagnostics = (value) => {
  if (value == null) return null;
  const text = JSON.stringify(value).replace(/((?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)\s*[:=]\s*)[^\s,;\"]+/gi, "$1[redacted]");
  return text.slice(0, 2000);
};

const opaque = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

export function envelope({ operation, correlationId, success, data = null, errorCode = null, errorClass = null, diagnostics = null }) {
  return { contractVersion: EXECUTION_PROVIDER_VERSION, operation, correlationId, success, ...(success ? { data } : { errorCode, errorClass }), diagnostics: safeDiagnostics(diagnostics) };
}

export function lifecycleEvent({ kind, correlationId = null, providerGlobal = false, success = true, data = null, errorCode = null, errorClass = null, diagnostics = null }) {
  return { contractVersion: EXECUTION_PROVIDER_VERSION, kind, providerGlobal, correlationId, success, ...(success ? { data } : { errorCode, errorClass }), diagnostics: safeDiagnostics(diagnostics) };
}

export function validateEnvelope(value, { operation, correlationId, requiredIds = [] } = {}) {
  if (!object(value)) throw new ExecutionProviderError("invalid_envelope", "provider returned no valid envelope");
  if (value.contractVersion !== EXECUTION_PROVIDER_VERSION) throw new ExecutionProviderError("unsupported_contract_version", "provider contract version is unsupported");
  if (!EXECUTION_OPERATIONS.includes(value.operation) || value.operation !== operation) throw new ExecutionProviderError("protocol_violation", `provider operation mismatch: expected ${operation}`);
  if (!opaque(value.correlationId) || value.correlationId !== correlationId) throw new ExecutionProviderError("correlation_mismatch", "provider did not echo controller correlation id");
  if (typeof value.success !== "boolean") throw new ExecutionProviderError("invalid_envelope", "provider envelope lacks success boolean");
  if (!value.success) {
    if (!opaque(value.errorCode) || !opaque(value.errorClass)) throw new ExecutionProviderError("invalid_envelope", "provider failure lacks typed error");
    throw new ExecutionProviderError(value.errorCode, value.errorCode, { errorClass: value.errorClass, diagnostics: safeDiagnostics(value.diagnostics) });
  }
  if (!object(value.data)) throw new ExecutionProviderError("invalid_envelope", "provider success lacks normalized data");
  for (const id of requiredIds) {
    const present = id === "resultText" ? typeof value.data[id] === "string" && value.data[id].trim().length > 0 : opaque(value.data[id]);
    if (!present) throw new ExecutionProviderError("invalid_envelope", `provider success lacks ${id}`);
  }
  return value.data;
}

export function validateLifecycleEvent(value) {
  if (!object(value) || value.contractVersion !== EXECUTION_PROVIDER_VERSION || !LIFECYCLE_EVENT_KINDS.includes(value.kind)) throw new ExecutionProviderError("invalid_lifecycle_event", "provider lifecycle event is invalid");
  if (typeof value.success !== "boolean" || typeof value.providerGlobal !== "boolean") throw new ExecutionProviderError("invalid_lifecycle_event", "provider lifecycle event lacks required form");
  if (value.diagnostics != null && (typeof value.diagnostics !== "string" || value.diagnostics.length > 2000)) throw new ExecutionProviderError("invalid_lifecycle_event", "provider lifecycle diagnostics are unsafe");
  if (value.providerGlobal) {
    if (value.correlationId != null || value.data?.threadId != null || value.data?.turnId != null) throw new ExecutionProviderError("correlation_mismatch", "provider-global event must not identify a task");
  } else {
    if (!opaque(value.correlationId) || !object(value.data) || !opaque(value.data.threadId) || !opaque(value.data.turnId)) throw new ExecutionProviderError("correlation_mismatch", "task lifecycle event lacks correlation or turn identity");
  }
  if (!value.success && (!opaque(value.errorCode) || !opaque(value.errorClass))) throw new ExecutionProviderError("invalid_lifecycle_event", "provider lifecycle failure lacks typed error");
  if (value.success && !object(value.data)) throw new ExecutionProviderError("invalid_lifecycle_event", "provider lifecycle success lacks data");
  if (value.kind === "turn_alias" && (!opaque(value.data.requestedTurnId) || !opaque(value.data.resolvedTurnId))) throw new ExecutionProviderError("invalid_lifecycle_event", "turn alias lacks lineage");
  if (value.kind === "approval_requested" && !opaque(value.data.requestId)) throw new ExecutionProviderError("invalid_lifecycle_event", "approval request lacks id");
  return value;
}

export function assertCapabilities(data, provider = null) {
  const capabilities = data?.capabilities;
  if (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string")) throw new ExecutionProviderError("invalid_envelope", "handshake lacks capabilities");
  if (new Set(capabilities).size !== REQUIRED_EXECUTION_CAPABILITIES.length || capabilities.length !== REQUIRED_EXECUTION_CAPABILITIES.length) throw new ExecutionProviderError("unsupported_capability", "provider capability set is not exact v1");
  for (const capability of REQUIRED_EXECUTION_CAPABILITIES) if (!capabilities.includes(capability)) throw new ExecutionProviderError("unsupported_capability", `provider lacks ${capability}`);
  const prohibited = ["workspace_management", "state_transition", "artifacts", "integration", "publication", "merge"];
  if (capabilities.some((capability) => prohibited.includes(capability))) throw new ExecutionProviderError("unsupported_capability", "provider advertises controller authority");
  if (provider) for (const operation of EXECUTION_OPERATIONS) if (typeof provider[EXECUTION_OPERATION_METHODS[operation]] !== "function") throw new ExecutionProviderError("unsupported_capability", `provider does not implement ${operation}`);
  return capabilities;
}
