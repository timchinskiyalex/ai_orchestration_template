import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { AppServerExecutionProvider } from "../src/app-server-execution-provider.mjs";
import {
  CODEX_RUNTIME_OBSERVATION_KINDS, CodexAppServerRuntime
} from "../src/codex-app-server-runtime.mjs";
import { EXECUTION_PROVIDER_VERSION, validateEnvelope } from "../src/execution-provider-contract.mjs";

class FakeAppServerClient extends EventEmitter {
  constructor({ alias = false, disconnect = false, timeout = false, threadReadError = null } = {}) {
    super();
    this.alias = alias; this.disconnect = disconnect; this.timeout = timeout; this.threadReadError = threadReadError; this.calls = []; this.closed = false;
    this.threadId = "thread-controller-cwd"; this.requestedTurnId = "turn-requested";
    this.resolvedTurnId = alias ? "turn-resolved" : this.requestedTurnId;
  }
  async connect() { this.calls.push(["connect"]); if (this.disconnect) throw new Error("transport closed"); }
  async startThread(data) { this.calls.push(["thread/start", data]); return { thread: { id: this.threadId } }; }
  async setGoal(data) { this.calls.push(["goal/set", data]); }
  async startTurn(data) { this.calls.push(["turn/start", data]); return { turn: { id: this.requestedTurnId } }; }
  async waitForTurn() { this.calls.push(["turn/wait"]); if (this.timeout) throw new Error("timed out"); return { id: this.requestedTurnId, status: "completed" }; }
  async readTerminalTurn(threadId, turnId, timeoutMs) {
    this.calls.push(["thread/read-terminal", { threadId, turnId, timeoutMs }]);
    if (this.threadReadError) throw new Error(this.threadReadError);
    if (this.alias) this.emit("protocol", { method: "turn-id-alias", threadId, requestedTurnId: turnId, resolvedTurnId: this.resolvedTurnId });
    return { terminal: { id: this.resolvedTurnId, status: "completed", items: [{ type: "agentMessage", text: "final result" }] } };
  }
  async readThread({ threadId }) { this.calls.push(["thread/read", { threadId }]); return { thread: { turns: [{ id: this.resolvedTurnId, status: "completed", items: [{ type: "agentMessage", text: "final result" }] }] } }; }
  async interruptTurn(data) { this.calls.push(["turn/interrupt", data]); }
  async shutdown() { this.closed = true; this.calls.push(["shutdown"]); }
  diagnostics() { return { process: { exited: this.disconnect }, stderrTail: this.disconnect ? "transport closed" : "healthy" }; }
}

const legacyCall = async (provider, operation, data, requiredIds = []) => {
  const correlationId = `legacy-${operation}`;
  const methods = { handshake: "handshake", start_thread: "startThread", set_goal: "setGoal", start_turn: "startTurn", observe_terminal: "observeTerminal", reconcile_terminal: "reconcileTerminal", read_final_result: "readFinalResult", interrupt_turn: "interruptTurn" };
  return validateEnvelope(await provider[methods[operation]]({ contractVersion: EXECUTION_PROVIDER_VERSION, correlationId, data }), { operation, correlationId, requiredIds });
};

async function runLegacy(client, cwd) {
  const provider = new AppServerExecutionProvider({ cwd, client });
  await legacyCall(provider, "handshake", {}, ["providerRunId"]);
  const thread = await legacyCall(provider, "start_thread", { cwd, model: "fake" }, ["threadId"]);
  await legacyCall(provider, "set_goal", { threadId: thread.threadId, objective: "goal" }, ["threadId"]);
  const turn = await legacyCall(provider, "start_turn", { threadId: thread.threadId, input: [{ type: "text", text: "turn" }] }, ["threadId", "turnId"]);
  await legacyCall(provider, "observe_terminal", { threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 }, ["threadId", "turnId", "terminalClass"]);
  const durable = await legacyCall(provider, "reconcile_terminal", { threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 }, ["threadId", "turnId", "terminalClass"]);
  const result = await legacyCall(provider, "read_final_result", { threadId: thread.threadId, turnId: durable.turnId }, ["resultText"]);
  return { thread, turn, durable, result, calls: client.calls };
}

async function runRuntime(client, cwd) {
  const runtime = new CodexAppServerRuntime({ cwd, client }); const observations = [];
  runtime.on("observation", (observation) => observations.push(observation));
  await runtime.connect();
  const thread = await runtime.startThread({ model: "fake" });
  const turn = await runtime.startGoalTurn({ threadId: thread.threadId, goal: { objective: "goal" }, turn: { input: [{ type: "text", text: "turn" }] } });
  client.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: thread.threadId, turnId: turn.turnId, tokenUsage: { totalTokens: 3 } } });
  const candidate = await runtime.observeTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 });
  const durable = await runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 });
  const result = await runtime.readFinalResult({ threadId: thread.threadId, turnId: durable.turnId });
  return { runtime, thread, turn, candidate, durable, result, observations, calls: client.calls };
}

async function aliasRuntime({ threadReadError = "thread/read: thread not loaded" } = {}) {
  const client = new FakeAppServerClient({ alias: true, threadReadError });
  const runtime = new CodexAppServerRuntime({ cwd: "D:/controller-authorized/worktree", client }); const observations = [];
  runtime.on("observation", (observation) => observations.push(observation));
  await runtime.connect(); const thread = await runtime.startThread(); const turn = await runtime.startGoalTurn({ threadId: thread.threadId, goal: {}, turn: {} });
  return { client, runtime, observations, thread, turn };
}

test("thin runtime has parity with current App Server path for controller cwd, start, durable alias reconciliation, and result read", async () => {
  const cwd = "D:/controller-authorized/worktree";
  const legacy = await runLegacy(new FakeAppServerClient({ alias: true }), cwd);
  const modern = await runRuntime(new FakeAppServerClient({ alias: true }), cwd);
  assert.equal(legacy.calls.find(([name]) => name === "thread/start")[1].cwd, cwd);
  assert.equal(modern.calls.find(([name]) => name === "thread/start")[1].cwd, cwd);
  assert.deepEqual(modern.calls.filter(([name]) => ["thread/start", "goal/set", "turn/start"].includes(name)).map(([name]) => name), ["thread/start", "goal/set", "turn/start"]);
  assert.equal(legacy.durable.requestedTurnId, "turn-requested");
  assert.equal(legacy.durable.resolvedTurnId, "turn-resolved");
  assert.equal(modern.durable.requestedTurnId, "turn-requested");
  assert.equal(modern.durable.resolvedTurnId, "turn-resolved");
  assert.equal(modern.candidate.kind, "worker_terminal_candidate");
  assert.equal(modern.durable.kind, "worker_completed");
  assert.ok(modern.observations.some((item) => item.kind === "worker_activity" && item.activity === "usage_updated"));
  assert.equal(modern.result.resultText, legacy.result.resultText);
});

test("runtime completion is a turn observation and cannot complete a controller task", async () => {
  const modern = await runRuntime(new FakeAppServerClient(), "D:/controller-authorized/worktree");
  assert.equal(modern.durable.kind, "worker_completed");
  assert.equal("taskId" in modern.durable, false);
  assert.equal(typeof modern.runtime.finalize, "undefined");
  assert.equal(typeof modern.runtime.transition, "undefined");
  assert.equal(typeof modern.runtime.recordWorkerArtifact, "undefined");
});

test("a correlated turn/completed receipt remains terminal authority when same-provider thread/read is unavailable", async () => {
  const client = new FakeAppServerClient({ threadReadError: "thread/read: thread not loaded: thread-controller-cwd" });
  const runtime = new CodexAppServerRuntime({ cwd: "D:/controller-authorized/worktree", client });
  await runtime.connect(); const thread = await runtime.startThread(); const turn = await runtime.startGoalTurn({ threadId: thread.threadId, goal: {}, turn: {} });
  client.emit("notification", { method: "turn/completed", params: { threadId: thread.threadId, turn: { id: turn.turnId, status: "completed" } } });
  const durable = await runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 });
  assert.equal(durable.terminalReceipt.schemaVersion, 1);
  assert.equal(durable.terminalReceipt.source, "turn_completed");
  assert.deepEqual(durable.terminalReceipt.corroboration.available, false);
  assert.match(durable.terminalReceipt.corroboration.diagnostics, /thread\/read: thread not loaded/);
  assert.equal(durable.reconciliationSource, "turn_completed_receipt");
});

test("a correlated terminal receipt records successful bounded same-provider corroboration", async () => {
  const client = new FakeAppServerClient(); const runtime = new CodexAppServerRuntime({ cwd: "D:/controller-authorized/worktree", client });
  await runtime.connect(); const thread = await runtime.startThread(); const turn = await runtime.startGoalTurn({ threadId: thread.threadId, goal: {}, turn: {} });
  client.emit("notification", { method: "turn/completed", params: { threadId: thread.threadId, turn: { id: turn.turnId, status: "completed" } } });
  const durable = await runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 });
  assert.deepEqual(durable.terminalReceipt.corroboration, { available: true, source: "same_provider_thread_read", terminalClass: "completed" });
});

test("missing status, foreign identities, and untrusted aliases cannot create a terminal receipt", async () => {
  for (const params of [
    { threadId: "thread-controller-cwd", turn: { id: "turn-requested" } },
    { threadId: "other-thread", turn: { id: "turn-requested", status: "completed" } },
    { threadId: "thread-controller-cwd", turn: { id: "other-turn", status: "completed" } }
  ]) {
    const client = new FakeAppServerClient({ threadReadError: "thread/read: thread not loaded" }); const runtime = new CodexAppServerRuntime({ cwd: "D:/controller-authorized/worktree", client });
    await runtime.connect(); const thread = await runtime.startThread(); const turn = await runtime.startGoalTurn({ threadId: thread.threadId, goal: {}, turn: {} });
    client.emit("notification", { method: "turn/completed", params });
    await assert.rejects(runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 }), (error) => error?.errorCode === "transport_failure");
  }
});

test("reconciliation preserves typed same-provider terminal failure reasons", async () => {
  for (const [name, configure, expected] of [
    ["receipt missing", (client) => { client.readTerminalTurn = async () => ({ terminal: null, summary: { turnStatus: null } }); }, "terminal_receipt_missing"],
    ["status missing", (client) => { client.readTerminalTurn = async (_threadId, turnId) => ({ terminal: { id: turnId, status: "in_progress" }, summary: { turnStatus: "in_progress" } }); }, "terminal_status_missing"],
    ["alias unresolved", (client) => { client.readTerminalTurn = async () => ({ terminal: { id: "unresolved-turn", status: "completed" }, summary: { turnStatus: "completed" } }); }, "terminal_alias_unresolved"],
    ["process exit", (client) => { client.disconnect = true; }, "process_exit"]
  ]) {
    const client = new FakeAppServerClient(); const runtime = new CodexAppServerRuntime({ cwd: "D:/controller-authorized/worktree", client });
    await runtime.connect(); const thread = await runtime.startThread(); const turn = await runtime.startGoalTurn({ threadId: thread.threadId, goal: {}, turn: {} });
    configure(client);
    await assert.rejects(runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 }), (error) => error?.errorCode === expected, name);
  }
});

test("resolved turn/completed pending before a confirmed alias produces one receipt and reconciles", async () => {
  const { client, runtime, observations, thread, turn } = await aliasRuntime();
  client.emit("notification", { method: "turn/completed", params: { threadId: thread.threadId, turn: { id: "turn-resolved", status: "completed" } } });
  assert.equal(observations.some((item) => item.kind === "worker_terminal_candidate"), false, "unconfirmed aliases are not controller observations");
  client.emit("protocol", { method: "turn-id-alias", threadId: thread.threadId, requestedTurnId: turn.turnId, resolvedTurnId: "turn-resolved" });
  const durable = await runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 });
  assert.equal(durable.terminalReceipt.source, "turn_completed");
  assert.deepEqual({ requestedTurnId: durable.requestedTurnId, resolvedTurnId: durable.resolvedTurnId, terminalClass: durable.terminalClass }, { requestedTurnId: "turn-requested", resolvedTurnId: "turn-resolved", terminalClass: "completed" });
  assert.equal(observations.filter((item) => item.kind === "worker_terminal_candidate").length, 1);
});

test("pending terminal candidates require an exact confirmed thread and resolved turn alias", async () => {
  for (const candidate of [
    { threadId: "other-thread", resolvedTurnId: "turn-resolved" },
    { threadId: "thread-controller-cwd", resolvedTurnId: "other-resolved" }
  ]) {
    const { client, runtime, thread, turn } = await aliasRuntime();
    client.emit("notification", { method: "turn/completed", params: { threadId: candidate.threadId, turn: { id: candidate.resolvedTurnId, status: "completed" } } });
    client.emit("protocol", { method: "turn-id-alias", threadId: thread.threadId, requestedTurnId: turn.turnId, resolvedTurnId: "turn-resolved" });
    await assert.rejects(runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 }), (error) => error?.errorCode === "transport_failure");
  }
});

test("missing terminal status never enters pending state", async () => {
  const { client, runtime, thread, turn } = await aliasRuntime();
  client.emit("notification", { method: "turn/completed", params: { threadId: thread.threadId, turn: { id: "turn-resolved" } } });
  client.emit("protocol", { method: "turn-id-alias", threadId: thread.threadId, requestedTurnId: turn.turnId, resolvedTurnId: "turn-resolved" });
  await assert.rejects(runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 }), (error) => error?.errorCode === "transport_failure");
});

test("stale or duplicate aliases and duplicate completion cannot create a second receipt", async () => {
  const { client, runtime, observations, thread, turn } = await aliasRuntime();
  client.emit("notification", { method: "turn/completed", params: { threadId: thread.threadId, turn: { id: "turn-resolved", status: "completed" } } });
  client.emit("protocol", { method: "turn-id-alias", threadId: thread.threadId, requestedTurnId: "stale-requested", resolvedTurnId: "turn-resolved" });
  client.emit("protocol", { method: "turn-id-alias", threadId: thread.threadId, requestedTurnId: turn.turnId, resolvedTurnId: "turn-resolved" });
  client.emit("protocol", { method: "turn-id-alias", threadId: thread.threadId, requestedTurnId: turn.turnId, resolvedTurnId: "turn-resolved" });
  client.emit("notification", { method: "turn/completed", params: { threadId: thread.threadId, turn: { id: "turn-resolved", status: "completed" } } });
  const durable = await runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 });
  assert.equal(durable.terminalReceipt.resolvedTurnId, "turn-resolved");
  assert.equal(observations.filter((item) => item.kind === "worker_terminal_candidate").length, 1);
});

test("shutdown or process exit clears pending terminal candidates", async () => {
  for (const action of ["shutdown", "exit"]) {
    const { client, runtime, thread, turn } = await aliasRuntime();
    client.emit("notification", { method: "turn/completed", params: { threadId: thread.threadId, turn: { id: "turn-resolved", status: "completed" } } });
    if (action === "shutdown") await runtime.shutdown(); else client.emit("exit", { code: 17, signal: "SIGTERM" });
    client.emit("protocol", { method: "turn-id-alias", threadId: thread.threadId, requestedTurnId: turn.turnId, resolvedTurnId: "turn-resolved" });
    await assert.rejects(runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 }), (error) => error?.errorCode === "transport_failure");
  }
});

test("the quota-free Codex runtime probe fake path exercises alias-before-receipt reconciliation", async () => {
  const { client, runtime, thread, turn } = await aliasRuntime();
  client.emit("notification", { method: "turn/completed", params: { threadId: thread.threadId, turn: { id: "turn-resolved", status: "completed" } } });
  client.emit("protocol", { method: "turn-id-alias", threadId: thread.threadId, requestedTurnId: turn.turnId, resolvedTurnId: "turn-resolved" });
  const result = await runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 });
  assert.equal(result.kind, "worker_completed");
  assert.equal(result.terminalReceipt.resolvedTurnId, "turn-resolved");
});

test("existing exact-ID turn/completed receipt path remains unchanged", async () => {
  const { client, runtime, observations, thread, turn } = await aliasRuntime();
  client.emit("notification", { method: "turn/completed", params: { threadId: thread.threadId, turn: { id: turn.turnId, status: "completed" } } });
  const durable = await runtime.reconcileTerminal({ threadId: thread.threadId, turnId: turn.turnId, timeoutMs: 17 });
  assert.equal(durable.terminalReceipt.resolvedTurnId, turn.turnId);
  assert.equal(durable.verifiedEquivalence, "exact");
  assert.equal(observations.filter((item) => item.kind === "worker_terminal_candidate").length, 1);
});

test("thin runtime exposes only normalized progress, timeout/cancellation, and disconnect diagnostics", async () => {
  const runtime = new CodexAppServerRuntime({ cwd: "D:/controller-authorized/worktree", client: new FakeAppServerClient() });
  const observations = []; runtime.on("observation", (item) => observations.push(item));
  await runtime.connect(); const thread = await runtime.startThread(); const turn = await runtime.startGoalTurn({ threadId: thread.threadId, goal: {}, turn: {} });
  const cancelled = await runtime.cancel({ threadId: thread.threadId, turnId: turn.turnId });
  assert.equal(cancelled.kind, "worker_cancelled");
  assert.ok(observations.every((item) => CODEX_RUNTIME_OBSERVATION_KINDS.includes(item.kind)));
  const timingOut = new CodexAppServerRuntime({ cwd: "D:/controller-authorized/worktree", client: new FakeAppServerClient({ timeout: true }) });
  await timingOut.connect(); const timeoutThread = await timingOut.startThread(); const timeoutTurn = await timingOut.startGoalTurn({ threadId: timeoutThread.threadId, goal: {}, turn: {} });
  await assert.rejects(timingOut.observeTerminal({ threadId: timeoutThread.threadId, turnId: timeoutTurn.turnId, timeoutMs: 17 }), /timeout/);
  assert.equal((await timingOut.cancel({ threadId: timeoutThread.threadId, turnId: timeoutTurn.turnId })).kind, "worker_cancelled");
  const disconnected = new CodexAppServerRuntime({ cwd: "D:/controller-authorized/worktree", client: new FakeAppServerClient({ disconnect: true }) });
  await assert.rejects(disconnected.connect(), /shutdown/);
  const diagnostics = await disconnected.diagnostics();
  assert.equal(diagnostics.connected, false); assert.equal(diagnostics.closed, false);
  assert.equal(diagnostics.reconnectRequired, true);
  assert.match(diagnostics.diagnostics, /transport closed/);
});

test("runtime has no controller authority or alternate writer-runtime switch", () => {
  const source = readFileSync(new URL("../src/codex-app-server-runtime.mjs", import.meta.url), "utf8");
  const router = readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /state-store|StateStore|worktree-manager|WorktreeManager|worktree-finalizer|WorktreeFinalizer|integrator|Integrator|remote-adapters/i);
  assert.doesNotMatch(source, /\.transition\(|recordWorkerArtifact|finalize\(/);
  assert.doesNotMatch(source, /TRANSITIONAL_RUNTIME_PATHS|createTransitionalRuntime|resolveTransitionalRuntimePath/);
  assert.doesNotMatch(router, /writerRuntimePath|resolveTransitionalRuntimePath/);
});
