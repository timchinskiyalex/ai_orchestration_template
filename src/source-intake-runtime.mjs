import { CodexAppServerRuntime } from "./codex-app-server-runtime.mjs";
import { ExecutionProviderError, safeDiagnostics } from "./execution-provider-contract.mjs";
import { sourceIntakeFailure } from "./source-intake-failure.mjs";

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const RECEIPT_SOURCES = new Set(["turn_completed", "same_provider_thread_read", "same_provider_thread_read_result_equivalence"]);

const requiredRuntimeMethods = ["connect", "startThread", "startGoalTurn", "observeTerminal", "reconcileTerminal", "readFinalResult", "diagnostics", "shutdown"];

function runtimeFor(config, role) {
  const cwd = config.runtimeDir;
  if (typeof cwd !== "string" || !cwd.trim()) throw new ExecutionProviderError(`${role}_runtime_unavailable`, "controller-assigned intake cwd is unavailable");
  const runtime = config.sourceIntakeRuntimeFactory?.({ cwd, role })
    ?? new CodexAppServerRuntime({ cwd, transport: config.executionProviderFactory?.({ cwd }) });
  if (!runtime || runtime.cwd !== cwd || requiredRuntimeMethods.some((method) => typeof runtime[method] !== "function")) {
    throw new ExecutionProviderError(`${role}_runtime_unavailable`, "source intake requires the controller-owned Codex App Server runtime");
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

async function diagnosticsFor(runtime, cause) {
  try { return safeDiagnostics(await runtime.diagnostics()); }
  catch { return safeDiagnostics(cause?.diagnostics ?? cause?.message ?? cause); }
}

async function failClosed(runtime, role, code, cause) {
  throw new ExecutionProviderError(`${role}_${code}`, `${role}:${code}`, {
    errorClass: cause?.errorClass ?? "runtime", diagnostics: await diagnosticsFor(runtime, cause)
  });
}

// The only structured-result channel used here is schema-supported
// `thread/read` with `includeTurns: true`, surfaced by readFinalResult(). A
// terminal lifecycle observation never substitutes for that result.
export async function runSourceIntakeTurn({ config, role, developerInstructions, objective, tokenBudget, prompt, recordTerminalReceipt, recordFailure = null }) {
  const { runtime, cwd } = runtimeFor(config, role);
  let terminalReceipt = null;
  try {
    await runtime.connect();
    const thread = await runtime.startThread({ model: config.model, sandbox: "read-only", approvalPolicy: "never", developerInstructions, serviceName: "codex-source-intake" });
    if (thread?.threadId == null) await failClosed(runtime, role, "terminal_correlation_invalid");
    const started = await runtime.startGoalTurn({
      threadId: thread.threadId,
      goal: { status: "active", tokenBudget, objective },
      turn: { input: [{ type: "text", text: prompt }], effort: "low" }
    });
    if (started?.threadId !== thread.threadId || typeof started?.turnId !== "string" || !started.turnId) await failClosed(runtime, role, "terminal_correlation_invalid");
    let candidate;
    try { candidate = await runtime.observeTerminal({ threadId: thread.threadId, turnId: started.turnId, timeoutMs: config.router.turnTimeoutMs }); }
    catch (error) { await failClosed(runtime, role, "terminal_unavailable", error); }
    let durable;
    try {
      // Reconcile the original controller-requested ID. This preserves alias
      // lineage instead of silently promoting an observed resolved ID.
      durable = await runtime.reconcileTerminal({ threadId: thread.threadId, turnId: started.turnId, timeoutMs: Math.min(2_500, config.router.turnTimeoutMs ?? 2_500) });
    } catch (error) { await failClosed(runtime, role, "terminal_unavailable", error); }
    if (candidate?.threadId !== thread.threadId || candidate?.turnId !== durable?.turnId || durable?.threadId !== thread.threadId || !TERMINAL.has(durable?.terminalClass)) {
      await failClosed(runtime, role, "terminal_correlation_invalid");
    }
    try { assertReceipt({ receipt: durable.terminalReceipt, threadId: thread.threadId, requestedTurnId: started.turnId, resolvedTurnId: durable.turnId, role }); }
    catch (error) { await failClosed(runtime, role, "terminal_correlation_invalid", error); }
    // The receipt is persisted before final-result read/parse/validation and
    // therefore before any candidate or manifest admission decision.
    if (typeof recordTerminalReceipt !== "function") await failClosed(runtime, role, "terminal_receipt_persistence_failed");
    try { await recordTerminalReceipt(durable.terminalReceipt); terminalReceipt = durable.terminalReceipt; }
    catch (error) { await failClosed(runtime, role, "terminal_receipt_persistence_failed", error); }
    if (durable.kind !== "worker_completed" || durable.terminalClass !== "completed") {
      await failClosed(runtime, role, "terminal_not_completed");
    }
    let result;
    try { result = await runtime.readFinalResult({ threadId: thread.threadId, turnId: durable.turnId }); }
    catch (error) { await failClosed(runtime, role, "final_result_unavailable", error); }
    if (result?.threadId !== thread.threadId || result?.turnId !== durable.turnId || typeof result?.resultText !== "string" || !result.resultText.trim()) {
      await failClosed(runtime, role, "final_result_unavailable");
    }
    return Object.freeze({ resultText: result.resultText, cwd, threadId: thread.threadId, requestedTurnId: started.turnId, resolvedTurnId: durable.turnId, terminalReceipt: durable.terminalReceipt });
  } catch (error) {
    const failure = error instanceof ExecutionProviderError && error.errorCode.startsWith(`${role}_`)
      ? error
      : new ExecutionProviderError(`${role}_runtime_unavailable`, `${role}:runtime_unavailable`, { errorClass: error?.errorClass ?? "runtime", diagnostics: await diagnosticsFor(runtime, error) });
    const phase = /final_result_unavailable$/.test(failure.errorCode) ? "result_read" : "terminal";
    const code = failure.errorCode.replace(new RegExp(`^${role}_`), "").replace(/[^a-z0-9_]/gi, "_").slice(0, 96) || "runtime_unavailable";
    const intakeFailure = sourceIntakeFailure({ role, phase, code, receipt: terminalReceipt, errorClass: failure.errorClass });
    try { await recordFailure?.(intakeFailure.sourceIntakeFailure); } catch {}
    throw intakeFailure;
  } finally {
    try { await runtime.shutdown(); } catch {}
  }
}
