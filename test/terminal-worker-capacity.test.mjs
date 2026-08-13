import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmRouter } from "../src/router.mjs";
import { EXECUTION_PROVIDER_VERSION, REQUIRED_EXECUTION_CAPABILITIES, envelope, lifecycleEvent } from "../src/execution-provider-contract.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = async (predicate, label) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: false }]));

class DeferredProvider extends EventEmitter {
  constructor({ badStart = false } = {}) { super(); this.badStart = badStart; this.next = 0; this.turns = new Map(); this.durable = new Map(); this.aliases = new Map(); this.starts = []; this.maximumActive = 0; this.reconciliationGate = null; }
  #ok(operation, args, data) { return envelope({ operation, correlationId: args.correlationId, success: true, data }); }
  async handshake(args) { return this.#ok("handshake", args, { providerRunId: "deferred", capabilities: [...REQUIRED_EXECUTION_CAPABILITIES] }); }
  async accountRead(args) { return this.#ok("account_read", args, { account: {}, usage: {}, rateLimits: {} }); }
  async startThread(args) { return this.#ok("start_thread", args, { providerRunId: "deferred", threadId: `thread-${++this.next}` }); }
  async setGoal(args) { return this.#ok("set_goal", args, { providerRunId: "deferred", threadId: args.data.threadId }); }
  async startTurn(args) {
    if (this.badStart) return envelope({ operation: "start_turn", correlationId: "wrong-correlation", success: true, data: { providerRunId: "deferred", threadId: args.data.threadId, turnId: "bad-turn" } });
    const turnId = `turn-${args.data.threadId}`;
    this.starts.push({ threadId: args.data.threadId, turnId, correlationId: args.correlationId });
    this.maximumActive = Math.max(this.maximumActive, this.turns.size + 1);
    return this.#ok("start_turn", args, { providerRunId: "deferred", threadId: args.data.threadId, turnId });
  }
  async observeTerminal(args) { return await new Promise((resolve) => this.turns.set(args.data.turnId, { args, resolve })); }
  async reconcileTerminal(args) {
    if (this.reconciliationGate) await this.reconciliationGate;
    const terminal = this.durable.get(args.data.turnId);
    if (!terminal) return envelope({ operation: "reconcile_terminal", correlationId: args.correlationId, success: false, errorCode: "terminal_reconciliation_unavailable", errorClass: "transport", diagnostics: "no durable terminal" });
    return this.#ok("reconcile_terminal", args, { providerRunId: "deferred", threadId: args.data.threadId, turnId: terminal.turnId, terminalClass: terminal.status, requestedTurnId: args.data.turnId, resolvedTurnId: terminal.turnId, reconciliationSource: "thread_read", verifiedEquivalence: terminal.turnId === args.data.turnId ? "exact" : "observed_alias" });
  }
  async readFinalResult(args) { return this.#ok("read_final_result", args, { providerRunId: "deferred", threadId: args.data.threadId, turnId: args.data.turnId, resultText: "safe" }); }
  async interruptTurn(args) { this.complete(args.data.turnId, "interrupted"); return this.#ok("interrupt_turn", args, { providerRunId: "deferred", threadId: args.data.threadId, turnId: args.data.turnId, terminalClass: "interrupted" }); }
  async approvalResponse(args) { return this.#ok("approval_response", args, { providerRunId: "deferred", requestId: args.data.requestId }); }
  async shutdown(args) { return this.#ok("shutdown", args, { providerRunId: "deferred", terminalClass: "shutdown" }); }
  async diagnostics(args) { return this.#ok("diagnostics", args, { diagnostics: { process: { alive: true, exited: false, code: null, signal: null }, stderrTail: "token=secret", protocolEvents: [] } }); }
  alias(turnId, resolvedTurnId = `alias-${turnId}`) {
    const turn = this.turns.get(turnId); assert.ok(turn, "turn must be observed before emitting an alias");
    this.aliases.set(turnId, resolvedTurnId);
    this.emit("lifecycle", lifecycleEvent({ kind: "turn_alias", correlationId: turn.args.correlationId, data: { threadId: turn.args.data.threadId, turnId: resolvedTurnId, requestedTurnId: turnId, resolvedTurnId } }));
  }
  complete(turnId, terminalClass = "completed") {
    const turn = this.turns.get(turnId); if (!turn) return;
    this.turns.delete(turnId);
    const resolvedTurnId = this.aliases.get(turnId) ?? turnId;
    this.durable.set(resolvedTurnId, { turnId: resolvedTurnId, status: terminalClass });
    turn.resolve(this.#ok("observe_terminal", turn.args, { providerRunId: "deferred", threadId: turn.args.data.threadId, turnId, terminalClass }));
  }
}

function fixture(provider, workers) {
  const root = mkdtempSync(join(tmpdir(), "terminal-capacity-"));
  git(root, ["init", "-b", "main"]); writeFileSync(join(root, "README.md"), "# test\n"); writeFileSync(join(root, "package.json"), JSON.stringify({ name: "terminal-capacity", packageManager: "npm@10" })); writeFileSync(join(root, "package-lock.json"), "{}"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/in", generatedDir: "docs/out", productRoots: [] }, router: { maxConcurrentTasks: workers, maxChildrenPerTask: 5, maxDelegationDepth: 3, maxPlanTasks: 5, defaultParentBudget: 1000, turnTimeoutMs: 500, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true }, budget: { weeklyTokenLimit: 10_000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { shutdownGraceMs: 50 }, roles, executionProviderFactory: () => provider });
  return { router, dispose() { router.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("workers=1 retains capacity through an alias until authoritative terminal persistence", async () => {
  const provider = new DeferredProvider(); const subject = fixture(provider, 1);
  try {
    await subject.router.ensureProjectOverlay();
    const frontend = subject.router.enqueue({ role: "frontend", title: "frontend QA", prompt: "safe" });
    const backend = subject.router.enqueue({ role: "backend", title: "backend writer", prompt: "safe" });
    const running = subject.router.runUntilIdle();
    await eventually(() => provider.starts.length === 1, "first provider turn");
    const first = provider.starts[0]; provider.alias(first.turnId);
    await delay(25);
    assert.equal(provider.starts.length, 1, "an alias is not terminal completion and cannot free the only slot");
    assert.equal(subject.router.activeTurnSnapshot().length, 1);
    provider.complete(first.turnId);
    await eventually(() => provider.starts.length === 2, "second provider turn after persisted terminal");
    assert.equal(subject.router.store.getTask(frontend.id).status, "done");
    provider.complete(provider.starts[1].turnId);
    await running;
    assert.equal(subject.router.store.getTask(backend.id).status, "done");
  } finally { subject.dispose(); }
});

test("workers=2 never starts more than two unresolved provider turns", async () => {
  const provider = new DeferredProvider(); const subject = fixture(provider, 2);
  try {
    await subject.router.ensureProjectOverlay();
    for (const title of ["one", "two", "three"]) subject.router.enqueue({ role: "backend", title, prompt: "safe" });
    const running = subject.router.runUntilIdle();
    await eventually(() => provider.starts.length === 2, "two provider turns");
    await delay(25);
    assert.equal(provider.starts.length, 2);
    assert.equal(provider.maximumActive <= 2, true);
    provider.complete(provider.starts[0].turnId);
    await eventually(() => provider.starts.length === 3, "third provider turn after one terminal completion");
    assert.equal(provider.maximumActive <= 2, true);
    for (const turnId of [...provider.turns.keys()]) provider.complete(turnId);
    await running;
  } finally { subject.dispose(); }
});

test("workers=1 retains capacity while controller-owned durable reconciliation is pending", async () => {
  const provider = new DeferredProvider(); const subject = fixture(provider, 1);
  try {
    await subject.router.ensureProjectOverlay();
    subject.router.enqueue({ role: "frontend", title: "first", prompt: "safe" });
    subject.router.enqueue({ role: "backend", title: "second", prompt: "safe" });
    const running = subject.router.runUntilIdle();
    await eventually(() => provider.starts.length === 1, "first provider turn");
    let release; provider.reconciliationGate = new Promise((resolve) => { release = resolve; });
    provider.complete(provider.starts[0].turnId);
    await delay(25);
    assert.equal(provider.starts.length, 1, "durable reconciliation retains the only scheduler slot");
    release();
    await eventually(() => provider.starts.length === 2, "second provider turn after reconciliation persistence");
    provider.complete(provider.starts[1].turnId);
    await running;
  } finally { subject.dispose(); }
});

test("provider protocol failure remains the delivery primary failure and does not create a dependency deadlock", async () => {
  const provider = new DeferredProvider({ badStart: true }); const subject = fixture(provider, 1);
  try {
    await subject.router.ensureProjectOverlay();
    const run = subject.router.createDeliveryRun({ id: "protocol-failure", bootstrapTaskId: null });
    const predecessor = subject.router.enqueue({ role: "backend", title: "writer", prompt: "safe", deliveryRunId: run.id });
    subject.router.enqueue({ role: "backend", title: "successor", prompt: "safe", dependencies: [predecessor.id], deliveryRunId: run.id });
    const execution = await subject.router.runUntilIdle({ deliveryRunId: run.id });
    const persisted = subject.router.store.deliveryRun(run.id);
    assert.equal(execution.dependencyDeadlock, null);
    assert.equal(persisted.recovery.primaryFailure.taxonomy, "execution_provider_correlation_mismatch");
    assert.equal(subject.router.store.db.prepare("SELECT count(*) AS count FROM dependency_deadlocks WHERE delivery_run_id = ?").get(run.id).count, 0);
    const event = subject.router.lifecycleEvents().find((item) => item.type === "execution provider protocol violation");
    assert.equal(event.errorCode, "correlation_mismatch");
    assert.equal(event.method, "start_turn");
    assert.equal(event.direction, "provider_response");
    assert.match(event.reason, /correlation/i);
  } finally { subject.dispose(); }
});
