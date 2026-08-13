import { CodexAppServerRuntime } from "./codex-app-server-runtime.mjs";
import { ExecutionProviderError } from "./execution-provider-contract.mjs";
import { sourceIntakeFailure } from "./source-intake-failure.mjs";

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const RECEIPT_SOURCES = new Set(["turn_completed", "same_provider_thread_read", "same_provider_thread_read_result_equivalence"]);
const REASONS = new Set(["timeout", "process_exit", "transport_failure", "terminal_receipt_missing", "terminal_alias_unresolved", "terminal_status_missing", "terminal_identity_mismatch", "final_result_unavailable"]);

const requiredRuntimeMethods = ["connect", "startThread", "startGoalTurn", "observeTerminal", "reconcileTerminal", "readFinalResult", "diagnostics", "shutdown"];

function runtimeFor(config, role) {
  const cwd = config.runtimeDir;
  if (typeof cwd !== "string" || !cwd.trim()) throw new ExecutionProviderError(`${role}_transport_failure`, "controller-assigned intake cwd is unavailable");
  const runtime = config.sourceIntakeRuntimeFactory?.({ cwd, role })
    ?? new CodexAppServerRuntime({ cwd, transport: config.executionProviderFactory?.({ cwd }) });
  if (!runtime || runtime.cwd !== cwd || requiredRuntimeMethods.some((method) => typeof runtime[method] !== "function")) {
    throw new ExecutionProviderError(`${role}_transport_failure`, "source intake requires the controller-owned Codex App Server runtime");
  }
  return { runtime, cwd };
}

function assertReceipt({ receipt, threadId, requestedTurnId, resolvedTurnId, role }) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== "AppServerTerminalReceipt" || !RECEIPT_SOURCES.has(receipt.source)
    || !TERMINAL.has(receipt.terminalClass) || receipt.threadId !== threadId || receipt.requestedTurnId !== requestedTurnId
    || receipt.resolvedTurnId !== resolvedTurnId || typeof receipt.correlationId !== "string" || !receipt.correlationId
    || typeof receipt.providerConnectionId !== "string" || !receipt.providerConnectionId || typeof receipt.capturedAt !== "string" || !receipt.capturedAt) {
    throw new ExecutionProviderError(`${role}_terminal_correlation_invalid`, `${role}: terminal receipt is not an exact correlated, versioned terminal fact`);
  }
}

function parsedDiagnostics(value) {
  let parsed = value;
  for (let index = 0; index < 2 && typeof parsed === "string"; index += 1) {
    try { parsed = JSON.parse(parsed); } catch { break; }
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

function reasonFor(cause, fallback) {
  const code = String(cause?.errorCode ?? "").toLowerCase();
  if (REASONS.has(code)) return code;
  if (code === "turn_failed") return "terminal_status_missing";
  if (code === "result_unavailable") return "final_result_unavailable";
  if (code === "execution_provider_terminal_unavailable" || code === "terminal_reconciliation_unavailable") return "terminal_receipt_missing";
  if (code.includes("alias")) return "terminal_alias_unresolved";
  if (code.includes("identity") || code.includes("correlation")) return "terminal_identity_mismatch";
  if (code === "transport_failure" || code === "shutdown") return "transport_failure";
  const text = String(cause?.message ?? cause ?? "").toLowerCase();
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("exited") || text.includes("process exit")) return "process_exit";
  if (text.includes("alias")) return "terminal_alias_unresolved";
  if (text.includes("status") || text.includes("turn_failed")) return "terminal_status_missing";
  if (text.includes("result") || text.includes("thread/read")) return "final_result_unavailable";
  return fallback;
}

function safeProtocolTail(events) {
  if (!Array.isArray(events)) return [];
  return events.slice(-20).map((event) => Object.fromEntries(["direction", "method", "threadId", "turnId", "requestedTurnId", "resolvedTurnId", "itemType", "itemStatus", "errorCode"]
    .filter((key) => typeof event?.[key] === "string" && event[key].length <= 512).map((key) => [key, event[key]])));
}

async function terminalDiagnostics(runtime, attempt, runtimeStage, primaryReason, cause) {
  let raw = {};
  try { raw = parsedDiagnostics(await runtime.diagnostics()); }
  catch { raw = parsedDiagnostics(cause?.diagnostics); }
  const details = parsedDiagnostics(raw.diagnostics);
  const process = details.process ?? raw.process ?? {};
  const stderr = details.stderrTail ?? raw.stderrTail ?? "";
  const protocol = details.protocolEvents ?? raw.protocolEvents ?? [];
  return {
    attemptedThreadId: attempt.threadId, requestedTurnId: attempt.requestedTurnId, resolvedTurnId: attempt.resolvedTurnId ?? null,
    runtimeStage, primaryReason, errorClass: typeof cause?.errorClass === "string" ? cause.errorClass.slice(0, 64) : "runtime",
    processState: { alive: process.alive === true, exited: process.exited === true || primaryReason === "process_exit", code: Number.isInteger(process.code) ? process.code : null, signal: typeof process.signal === "string" ? process.signal.slice(0, 64) : null },
    // Stderr is untrusted process output. Keep only presence, never a raw tail
    // that could carry a prompt, source Markdown, agent result, or secret.
    stderrTail: typeof stderr === "string" && stderr ? "[redacted:stderr_present]" : "",
    protocolTail: safeProtocolTail(protocol)
  };
}

async function failClosed(runtime, role, fallbackReason, { attempt = null, runtimeStage = "observe_terminal", cause = null } = {}) {
  const reason = reasonFor(cause, fallbackReason);
  const diagnostics = attempt ? await terminalDiagnostics(runtime, attempt, runtimeStage, reason, cause) : null;
  throw new ExecutionProviderError(`${role}_${reason}`, `${role}:${reason}`, { errorClass: cause?.errorClass ?? "runtime", diagnostics });
}

// The only structured-result channel used here is schema-supported
// `thread/read` with `includeTurns: true`, surfaced by readFinalResult(). A
// terminal lifecycle observation never substitutes for that result.
export async function runSourceIntakeTurn({ config, role, developerInstructions, objective, tokenBudget, prompt, recordTerminalReceipt, recordAttempt = null, recordFailure = null }) {
  const { runtime, cwd } = runtimeFor(config, role);
  let terminalReceipt = null;
  let attempt = null;
  let runtimeStage = "connect";
  const updateAttempt = async (stage, lifecycleState, resolvedTurnId = attempt?.resolvedTurnId ?? null) => {
    if (!attempt) return;
    runtimeStage = stage; attempt = { ...attempt, resolvedTurnId };
    await recordAttempt?.({ role: role === "source_claim_extraction" ? "extraction" : "audit", attemptedThreadId: attempt.threadId, requestedTurnId: attempt.requestedTurnId, resolvedTurnId, runtimeStage: stage, lifecycleState });
  };
  try {
    runtimeStage = "connect";
    await runtime.connect();
    runtimeStage = "start_thread";
    const thread = await runtime.startThread({ model: config.model, sandbox: "read-only", approvalPolicy: "never", developerInstructions, serviceName: "codex-source-intake" });
    if (thread?.threadId == null) await failClosed(runtime, role, "terminal_identity_mismatch", { runtimeStage });
    runtimeStage = "start_turn";
    const started = await runtime.startGoalTurn({
      threadId: thread.threadId,
      goal: { status: "active", tokenBudget, objective },
      turn: { input: [{ type: "text", text: prompt }], effort: "low" }
    });
    if (started?.threadId !== thread.threadId || typeof started?.turnId !== "string" || !started.turnId) await failClosed(runtime, role, "terminal_identity_mismatch", { runtimeStage });
    attempt = { threadId: thread.threadId, requestedTurnId: started.turnId, resolvedTurnId: null };
    await updateAttempt("observe_terminal", "awaiting_terminal");
    let candidate;
    try { candidate = await runtime.observeTerminal({ threadId: thread.threadId, turnId: started.turnId, timeoutMs: config.router.turnTimeoutMs }); }
    catch (error) { await failClosed(runtime, role, "transport_failure", { attempt, runtimeStage: "observe_terminal", cause: error }); }
    if (candidate?.threadId !== thread.threadId || typeof candidate?.turnId !== "string" || !candidate.turnId || !TERMINAL.has(candidate?.terminalClass)) {
      await failClosed(runtime, role, "terminal_identity_mismatch", { attempt, runtimeStage: "observe_terminal" });
    }
    await updateAttempt("reconcile_terminal", "terminal_candidate_observed", candidate.turnId);
    let durable;
    try {
      // Reconcile the original controller-requested ID. This preserves alias
      // lineage instead of silently promoting an observed resolved ID.
      durable = await runtime.reconcileTerminal({ threadId: thread.threadId, turnId: started.turnId, timeoutMs: Math.min(2_500, config.router.turnTimeoutMs ?? 2_500) });
    } catch (error) { await failClosed(runtime, role, "transport_failure", { attempt, runtimeStage: "reconcile_terminal", cause: error }); }
    if (candidate.turnId !== durable?.turnId) {
      await failClosed(runtime, role, "terminal_alias_unresolved", { attempt, runtimeStage: "reconcile_terminal" });
    }
    if (durable?.threadId !== thread.threadId || typeof durable?.turnId !== "string" || !durable.turnId || !TERMINAL.has(durable?.terminalClass)) {
      await failClosed(runtime, role, "terminal_status_missing", { attempt, runtimeStage: "reconcile_terminal" });
    }
    await updateAttempt("reconcile_terminal", "terminal_reconciled", durable.turnId);
    try { assertReceipt({ receipt: durable.terminalReceipt, threadId: thread.threadId, requestedTurnId: started.turnId, resolvedTurnId: durable.turnId, role }); }
    catch (error) { await failClosed(runtime, role, "terminal_receipt_missing", { attempt, runtimeStage: "reconcile_terminal", cause: error }); }
    // The receipt is persisted before final-result read/parse/validation and
    // therefore before any candidate or manifest admission decision.
    if (typeof recordTerminalReceipt !== "function") await failClosed(runtime, role, "terminal_receipt_missing", { attempt, runtimeStage: "reconcile_terminal" });
    try { await recordTerminalReceipt(durable.terminalReceipt); terminalReceipt = durable.terminalReceipt; }
    catch (error) { await failClosed(runtime, role, "terminal_receipt_missing", { attempt, runtimeStage: "reconcile_terminal", cause: error }); }
    if (durable.kind !== "worker_completed" || durable.terminalClass !== "completed") {
      await failClosed(runtime, role, "terminal_status_missing", { attempt, runtimeStage: "reconcile_terminal" });
    }
    await updateAttempt("result_read", "completed_receipt_persisted", durable.turnId);
    let result;
    try { result = await runtime.readFinalResult({ threadId: thread.threadId, turnId: durable.turnId }); }
    catch (error) { await failClosed(runtime, role, "final_result_unavailable", { attempt, runtimeStage: "result_read", cause: error }); }
    if (result?.threadId !== thread.threadId || result?.turnId !== durable.turnId || typeof result?.resultText !== "string" || !result.resultText.trim()) {
      await failClosed(runtime, role, "final_result_unavailable", { attempt, runtimeStage: "result_read" });
    }
    return Object.freeze({ resultText: result.resultText, cwd, threadId: thread.threadId, requestedTurnId: started.turnId, resolvedTurnId: durable.turnId, terminalReceipt: durable.terminalReceipt });
  } catch (error) {
    const failure = error instanceof ExecutionProviderError && error.errorCode.startsWith(`${role}_`)
      ? error
      : new ExecutionProviderError(`${role}_transport_failure`, `${role}:transport_failure`, { errorClass: error?.errorClass ?? "runtime", diagnostics: attempt ? await terminalDiagnostics(runtime, attempt, runtimeStage, "transport_failure", error) : null });
    const phase = runtimeStage === "result_read" ? "result_read" : "terminal";
    const code = failure.errorCode.replace(new RegExp(`^${role}_`), "").replace(/[^a-z0-9_]/gi, "_").slice(0, 96) || "transport_failure";
    const intakeFailure = sourceIntakeFailure({ role, phase, code, receipt: terminalReceipt, errorClass: failure.errorClass, diagnostics: failure.diagnostics });
    try { await recordFailure?.(intakeFailure.sourceIntakeFailure); } catch {}
    throw intakeFailure;
  } finally {
    try { await runtime.shutdown(); } catch {}
  }
}
