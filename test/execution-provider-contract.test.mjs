import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AppServerExecutionProvider } from "../src/app-server-execution-provider.mjs";
import { EXECUTION_PROVIDER_VERSION, REQUIRED_EXECUTION_CAPABILITIES, EXECUTION_OPERATION_METHODS, envelope, lifecycleEvent, assertCapabilities, validateEnvelope, validateLifecycleEvent } from "../src/execution-provider-contract.mjs";

class Transport extends EventEmitter {
  async connect() {} shutdown() { this.closed = true; } diagnostics() { return { stderrTail: "token=secret", process: { exited: false } }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread() { return { thread: { id: "thread-1" } }; } async setGoal() {}
  async startTurn() { return { turn: { id: "turn-1" } }; } async waitForTurn() { return { id: "turn-1", status: "completed" }; }
  async readThread() { return { thread: { turns: [{ id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "done" }] }] } }; } async interruptTurn() {} respond(id, response) { this.response = { id, response }; }
}
class DeterministicProvider {
  async handshake(args) { return envelope({ operation: "handshake", correlationId: args.correlationId, success: true, data: { capabilities: [...REQUIRED_EXECUTION_CAPABILITIES], providerRunId: "fake" } }); }
  async accountRead(args) { return envelope({ operation: "account_read", correlationId: args.correlationId, success: true, data: { account: {}, usage: {}, rateLimits: {} } }); }
  async startThread(args) { return envelope({ operation: "start_thread", correlationId: args.correlationId, success: true, data: { providerRunId: "fake", threadId: "thread-1" } }); }
  async setGoal(args) { return envelope({ operation: "set_goal", correlationId: args.correlationId, success: true, data: { providerRunId: "fake", threadId: "thread-1" } }); }
  async startTurn(args) { return envelope({ operation: "start_turn", correlationId: args.correlationId, success: true, data: { providerRunId: "fake", threadId: "thread-1", turnId: "turn-1" } }); }
  async observeTerminal(args) { return envelope({ operation: "observe_terminal", correlationId: args.correlationId, success: true, data: { providerRunId: "fake", threadId: "thread-1", turnId: "turn-1", terminalClass: "completed", usage: { totalTokens: 3 } } }); }
  async reconcileTerminal(args) { return envelope({ operation: "reconcile_terminal", correlationId: args.correlationId, success: true, data: { providerRunId: "fake", threadId: "thread-1", turnId: "turn-1", terminalClass: "completed", requestedTurnId: args.data.turnId, resolvedTurnId: "turn-1", reconciliationSource: "thread_read", verifiedEquivalence: "exact" } }); }
  async readFinalResult(args) { return envelope({ operation: "read_final_result", correlationId: args.correlationId, success: true, data: { providerRunId: "fake", threadId: "thread-1", turnId: "turn-1", resultText: "done" } }); }
  async interruptTurn(args) { return envelope({ operation: "interrupt_turn", correlationId: args.correlationId, success: true, data: { providerRunId: "fake", threadId: "thread-1", turnId: "turn-1", terminalClass: "interrupted" } }); }
  async approvalResponse(args) { return envelope({ operation: "approval_response", correlationId: args.correlationId, success: true, data: { providerRunId: "fake", requestId: args.data.requestId } }); }
  async shutdown(args) { return envelope({ operation: "shutdown", correlationId: args.correlationId, success: true, data: { providerRunId: "fake", terminalClass: "shutdown" } }); }
  async diagnostics(args) { return envelope({ operation: "diagnostics", correlationId: args.correlationId, success: true, data: { diagnostics: "safe" } }); }
}
const call = async (provider, operation, data = {}, ids = []) => {
  const correlationId = `c-${operation}`; const names = EXECUTION_OPERATION_METHODS;
  return validateEnvelope(await provider[names[operation]]({ contractVersion: EXECUTION_PROVIDER_VERSION, correlationId, data }), { operation, correlationId, requiredIds: ids });
};

test("App Server adapter and complete deterministic provider share full v1 operation conformance", async () => {
  for (const provider of [new AppServerExecutionProvider({ client: new Transport() }), new DeterministicProvider()]) {
    const handshake = await call(provider, "handshake", { contractVersion: EXECUTION_PROVIDER_VERSION }, ["providerRunId"]); assertCapabilities(handshake);
    await call(provider, "account_read");
    const thread = await call(provider, "start_thread", {}, ["threadId"]); assert.equal(thread.threadId, "thread-1");
    await call(provider, "set_goal", { threadId: "thread-1" }, ["threadId"]);
    await call(provider, "start_turn", { threadId: "thread-1" }, ["threadId", "turnId"]);
    const terminal = await call(provider, "observe_terminal", { threadId: "thread-1", turnId: "turn-1", timeoutMs: 5 }, ["threadId", "turnId"]); assert.equal(terminal.terminalClass, "completed");
    const reconciled = await call(provider, "reconcile_terminal", { threadId: "thread-1", turnId: "turn-1", timeoutMs: 5 }, ["threadId", "turnId"]); assert.equal(reconciled.terminalClass, "completed");
    await call(provider, "read_final_result", { threadId: "thread-1", turnId: "turn-1" }, ["threadId", "turnId", "resultText"]);
    if (provider.client) provider.client.emit("serverRequest", { id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1" } });
    await call(provider, "approval_response", { requestId: provider.client ? "7" : "approval-1", response: { decision: "cancel" } }, ["requestId"]);
    await call(provider, "interrupt_turn", { threadId: "thread-1", turnId: "turn-1" }, ["threadId", "turnId"]);
    await call(provider, "diagnostics"); await call(provider, "shutdown");
  }
});

test("contract validation fails closed for malformed, wrong-operation, and correlation-mismatched envelopes", () => {
  assert.throws(() => validateEnvelope({}, { operation: "start_thread", correlationId: "c" }), /unsupported_contract_version/);
  assert.throws(() => validateEnvelope(envelope({ operation: "start_turn", correlationId: "c", success: true, data: {} }), { operation: "start_thread", correlationId: "c" }), /protocol_violation/);
  assert.throws(() => validateEnvelope(envelope({ operation: "start_thread", correlationId: "other", success: true, data: {} }), { operation: "start_thread", correlationId: "c" }), /correlation_mismatch/);
});

test("lifecycle envelopes fail closed without an exact task correlation and preserve global isolation", () => {
  assert.throws(() => validateLifecycleEvent({}), /invalid_lifecycle_event/);
  assert.throws(() => validateLifecycleEvent(lifecycleEvent({ kind: "usage_updated", data: { threadId: "t", turnId: "u" } })), /correlation_mismatch/);
  assert.throws(() => validateLifecycleEvent(lifecycleEvent({ kind: "process_exit", providerGlobal: true, data: { threadId: "t" } })), /correlation_mismatch/);
  assert.equal(validateLifecycleEvent(lifecycleEvent({ kind: "turn_alias", correlationId: "c", data: { threadId: "t", turnId: "canonical", requestedTurnId: "requested", resolvedTurnId: "canonical" } })).kind, "turn_alias");
});

test("preflight rejects a provider that advertises v1 capabilities but omits an operation", async () => {
  const incomplete = new DeterministicProvider(); delete incomplete.accountRead;
  // Prototype methods are intentionally masked to model a malformed injected
  // provider before Router can claim a task or create a worktree.
  incomplete.accountRead = null;
  const handshake = await call(incomplete, "handshake", { contractVersion: EXECUTION_PROVIDER_VERSION }, ["providerRunId"]);
  assert.throws(() => assertCapabilities(handshake, incomplete), /provider does not implement account_read/);
});

test("adapter shutdown and interrupt are idempotent and diagnostics are bounded/redacted", async () => {
  const transport = new Transport(); const provider = new AppServerExecutionProvider({ client: transport }); await call(provider, "handshake", { contractVersion: EXECUTION_PROVIDER_VERSION });
  const interrupt = { contractVersion: EXECUTION_PROVIDER_VERSION, correlationId: "i", data: { threadId: "thread-1", turnId: "turn-1" } };
  assert.equal((await provider.interruptTurn(interrupt)).success, true); assert.equal((await provider.interruptTurn({ ...interrupt, correlationId: "i2" })).success, true);
  const diagnostics = await provider.diagnostics({ contractVersion: EXECUTION_PROVIDER_VERSION, correlationId: "d", data: {} }); assert.match(diagnostics.data.diagnostics, /redacted/);
  await provider.shutdown({ contractVersion: EXECUTION_PROVIDER_VERSION, correlationId: "s", data: {} }); await provider.shutdown({ contractVersion: EXECUTION_PROVIDER_VERSION, correlationId: "s2", data: {} }); assert.equal(transport.closed, true);
});
