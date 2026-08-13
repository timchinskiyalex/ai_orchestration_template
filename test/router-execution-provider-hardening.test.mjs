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
const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, {
  sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: false
}]));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class ControlledProvider extends EventEmitter {
  constructor(mode = "normal") { super(); this.mode = mode; this.calls = { accountRead: 0, startThread: 0, startTurn: 0, interrupts: [], approvals: [] }; this.next = 1; this.terminals = []; this.turn = null; }
  #ok(operation, args, data) { return envelope({ operation, correlationId: args.correlationId, success: true, data }); }
  async handshake(args) {
    if (this.mode === "unowned") queueMicrotask(() => this.emit("lifecycle", lifecycleEvent({ kind: "approval_requested", correlationId: "orphan-correlation", data: { threadId: "orphan-thread", turnId: "orphan-turn", requestId: "orphan-request", approvalKind: "command" } })));
    return this.#ok("handshake", args, { providerRunId: "controlled", capabilities: [...REQUIRED_EXECUTION_CAPABILITIES] });
  }
  async accountRead(args) { this.calls.accountRead += 1; return this.#ok("account_read", args, { account: {}, usage: {}, rateLimits: {} }); }
  async startThread(args) { this.calls.startThread += 1; const threadId = `thread-${this.next++}`; this.threadId = threadId; return this.#ok("start_thread", args, { providerRunId: "controlled", threadId }); }
  async setGoal(args) { return this.#ok("set_goal", args, { providerRunId: "controlled", threadId: args.data.threadId }); }
  async startTurn(args) {
    this.calls.startTurn += 1; const turnId = `turn-${args.data.threadId}`; this.turn = { threadId: args.data.threadId, turnId, correlationId: args.correlationId };
    setTimeout(() => this.#emitScenario(), 0);
    return this.#ok("start_turn", args, { providerRunId: "controlled", threadId: args.data.threadId, turnId });
  }
  async observeTerminal(args) {
    return await new Promise((resolve, reject) => { this.terminals.push({ resolve, reject, args }); });
  }
  async readFinalResult(args) { return this.#ok("read_final_result", args, { providerRunId: "controlled", threadId: args.data.threadId, turnId: args.data.turnId, resultText: "safe result" }); }
  async interruptTurn(args) { this.calls.interrupts.push({ threadId: args.data.threadId, turnId: args.data.turnId }); this.#settleTerminal("interrupted"); return this.#ok("interrupt_turn", args, { providerRunId: "controlled", threadId: args.data.threadId, turnId: args.data.turnId, terminalClass: "interrupted" }); }
  async approvalResponse(args) { this.calls.approvals.push(args.data); return this.#ok("approval_response", args, { providerRunId: "controlled", requestId: args.data.requestId }); }
  async shutdown(args) { return this.#ok("shutdown", args, { providerRunId: "controlled", terminalClass: "shutdown" }); }
  async diagnostics(args) { return this.#ok("diagnostics", args, { diagnostics: "safe" }); }
  #settleTerminal(status = "completed", error = null) {
    for (const terminal of this.terminals.splice(0)) {
      if (error) terminal.reject(error);
      else terminal.resolve(this.#ok("observe_terminal", terminal.args, { providerRunId: "controlled", threadId: this.turn.threadId, turnId: this.turn.turnId, terminalClass: status, usage: { totalTokens: 7 } }));
    }
  }
  #event(kind, { correlationId = this.turn.correlationId, threadId = this.turn.threadId, turnId = this.turn.turnId, ...data } = {}) { this.emit("lifecycle", lifecycleEvent({ kind, correlationId, data: { threadId, turnId, ...data } })); }
  #emitScenario() {
    if (this.mode === "process-exit") {
      this.emit("lifecycle", lifecycleEvent({ kind: "process_exit", providerGlobal: true, success: false, errorCode: "process_exit", errorClass: "transport" }));
      return this.#settleTerminal("completed", new Error("App Server exited"));
    }
    if (this.mode === "wrong-correlation") return this.#event("turn_completed", { correlationId: "wrong-correlation" });
    if (this.mode === "wrong-thread") return this.#event("turn_completed", { threadId: "wrong-thread" });
    if (this.mode === "wrong-turn") return this.#event("turn_completed", { turnId: "wrong-turn" });
    if (this.mode === "stale") { this.#event("turn_completed", { correlationId: "stale-correlation", threadId: "stale-thread", turnId: "stale-turn" }); return this.#settleTerminal(); }
    if (this.mode === "approval") return this.#event("approval_requested", { requestId: "approval-1", approvalKind: "command" });
    if (this.mode === "permissions-approval") return this.#event("approval_requested", { requestId: "approval-1", approvalKind: "permissions" });
    if (this.mode === "alias-usage") { this.#event("turn_alias", { turnId: "canonical-turn", requestedTurnId: this.turn.turnId, resolvedTurnId: "canonical-turn" }); this.#event("usage_updated", { turnId: "canonical-turn", usage: { totalTokens: 7 } }); this.turn.turnId = "canonical-turn"; return this.#settleTerminal(); }
    if (this.mode === "duplicate-terminal") { this.#event("turn_completed"); this.#event("turn_completed"); return this.#settleTerminal(); }
    if (this.mode === "process-exit-after-terminal") { this.#settleTerminal(); return setTimeout(() => this.emit("lifecycle", lifecycleEvent({ kind: "process_exit", providerGlobal: true, success: false, errorCode: "process_exit", errorClass: "transport" })), 0); }
    this.#settleTerminal();
  }
}

function fixture(provider, { manual = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestration-provider-hardening-"));
  git(root, ["init", "-b", "main"]); writeFileSync(join(root, "README.md"), "# test\n"); writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/in", generatedDir: "docs/out", productRoots: [] }, router: { maxConcurrentTasks: 1, maxChildrenPerTask: 5, maxDelegationDepth: 4, maxPlanTasks: 5, defaultParentBudget: 1000, turnTimeoutMs: 250, approvalMode: "deny" }, autonomy: { mode: manual ? "manual" : "autonomous", autoApproveWorkflowGates: true, autoRemediate: true }, budget: { weeklyTokenLimit: 10_000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { shutdownGraceMs: 50 }, roles, executionProviderFactory: () => provider });
  return { root, router, ready: router.ensureProjectOverlay(), dispose: () => { router.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Router startup rejects an incomplete v1 provider before task claim, worktree, or turn side effects", async () => {
  const provider = new ControlledProvider(); provider.accountRead = null;
  const subject = fixture(provider);
  try {
    await subject.ready;
    const task = subject.router.enqueue({ role: "backend", title: "must not start", prompt: "no-op" });
    let claims = 0, creates = 0; const claimNext = subject.router.store.claimNext.bind(subject.router.store); const create = subject.router.worktrees.create.bind(subject.router.worktrees);
    subject.router.store.claimNext = () => { claims += 1; return claimNext(); }; subject.router.worktrees.create = async (...args) => { creates += 1; return await create(...args); };
    await assert.rejects(subject.router.runUntilIdle(), /provider does not implement account_read/);
    assert.equal(subject.router.store.getTask(task.id).status, "queued"); assert.equal(claims, 0); assert.equal(creates, 0); assert.equal(provider.calls.startThread, 0); assert.equal(provider.calls.startTurn, 0);
  } finally { subject.dispose(); }
});

test("manual malformed product scaffold enqueue fails closed before any execution-provider side effect", async () => {
  const provider = new ControlledProvider(); const subject = fixture(provider);
  try {
    await subject.ready;
    assert.throws(() => subject.router.enqueue({ role: "devops", title: "unsafe scaffold", prompt: "[[product-scaffold]] bypass delivery admission" }), /product_scaffold:controller_owned_greenfield_delivery_required/);
    assert.equal(subject.router.list().length, 0);
    assert.equal(provider.calls.startThread, 0); assert.equal(provider.calls.startTurn, 0);
  } finally { subject.dispose(); }
});

test("reconciliation barrier is awaited before a resumed scheduler can claim or start a worker", async () => {
  const provider = new ControlledProvider(); const subject = fixture(provider);
  try {
    await subject.ready;
    subject.router.enqueue({ role: "backend", title: "wait for recovery", prompt: "no-op" });
    let release; subject.router.worktrees.reconcile = async () => await new Promise((resolve) => { release = () => resolve({ records: [], observations: [], inventoryCount: 1, truncated: false }); });
    let claims = 0; const claimNext = subject.router.store.claimNext.bind(subject.router.store); subject.router.store.claimNext = () => { claims += 1; return claimNext(); };
    const running = subject.router.runUntilIdle(); await tick();
    assert.equal(claims, 0); assert.equal(provider.calls.startThread, 0); assert.equal(provider.calls.startTurn, 0);
    release(); await running;
    assert.ok(claims > 0); assert.equal(provider.calls.startThread, 1);
  } finally { subject.dispose(); }
});

for (const mode of ["wrong-correlation", "wrong-thread", "wrong-turn"]) test(`active ${mode} lifecycle event is interrupted exactly once and cannot finalize`, async () => {
  const provider = new ControlledProvider(mode); const subject = fixture(provider);
  try {
    await subject.ready;
    const task = subject.router.enqueue({ role: "backend", title: mode, prompt: "no-op" }); await subject.router.runUntilIdle();
    const current = subject.router.store.getTask(task.id);
    assert.equal(current.status, "interrupted"); assert.equal(current.tokenUsed, 0); assert.equal(subject.router.store.workerArtifact(task.id), null); assert.equal(provider.calls.interrupts.length, 1);
    assert.equal(subject.router.lifecycleEvents().filter((event) => event.type === "execution provider protocol violation" && event.taskId === task.id).length, 1);
    await assert.rejects(subject.router.integrateFinalized([task.id]), /must be done/);
  } finally { subject.dispose(); }
});

test("inactive stale lifecycle event is diagnostics-only and cannot mutate an unrelated active task", async () => {
  const provider = new ControlledProvider("stale"); const subject = fixture(provider);
  try {
    await subject.ready;
    const task = subject.router.enqueue({ role: "bootstrap", title: "stale", prompt: "no-op" }); await subject.router.runUntilIdle();
    assert.equal(subject.router.store.getTask(task.id).status, "done"); assert.equal(provider.calls.interrupts.length, 0); assert.equal(subject.router.store.getTask(task.id).tokenUsed, 0);
    assert.ok(subject.router.lifecycleEvents().some((event) => event.type === "execution provider protocol violation" && !event.taskId));
  } finally { subject.dispose(); }
});

test("duplicate valid terminal lifecycle events do not duplicate Router finalization", async () => {
  const provider = new ControlledProvider("duplicate-terminal"); const subject = fixture(provider);
  try {
    await subject.ready;
    const task = subject.router.enqueue({ role: "bootstrap", title: "duplicate", prompt: "no-op" }); let doneTransitions = 0; const transition = subject.router.store.transition.bind(subject.router.store);
    subject.router.store.transition = (id, state, patch) => { if (id === task.id && state === "done") doneTransitions += 1; return transition(id, state, patch); };
    await subject.router.runUntilIdle(); assert.equal(subject.router.store.getTask(task.id).status, "done"); assert.equal(doneTransitions, 1); assert.equal(subject.router.store.workerArtifact(task.id), null);
  } finally { subject.dispose(); }
});

test("owned approval is denied safely: autonomous fails, manual awaits then resumes", async () => {
  const autonomousProvider = new ControlledProvider("approval"); const autonomous = fixture(autonomousProvider);
  try {
    await autonomous.ready;
    const task = autonomous.router.enqueue({ role: "backend", title: "approval", prompt: "no-op" }); await autonomous.router.runUntilIdle();
    assert.equal(autonomous.router.store.getTask(task.id).status, "failed"); assert.deepEqual(autonomousProvider.calls.approvals, [{ requestId: "approval-1", response: { decision: "cancel" } }]); assert.equal(autonomousProvider.calls.interrupts.length, 1); assert.equal(autonomous.router.store.workerArtifact(task.id), null);
  } finally { autonomous.dispose(); }
  const manualProvider = new ControlledProvider("approval"); const manual = fixture(manualProvider, { manual: true });
  try {
    await manual.ready;
    const task = manual.router.enqueue({ role: "backend", title: "manual approval", prompt: "no-op" }); await manual.router.runUntilIdle();
    assert.equal(manual.router.store.getTask(task.id).status, "awaiting_approval"); assert.equal(manual.router.approveHumanGate(task.id).task.status, "queued"); manualProvider.mode = "normal"; await manual.router.runUntilIdle(); assert.equal(manual.router.store.getTask(task.id).status, "done");
  } finally { manual.dispose(); }
});

test("permissions and unowned approval requests are safely settled without raw durable payloads or task creation", async () => {
  const permissionsProvider = new ControlledProvider("permissions-approval"); const permissions = fixture(permissionsProvider);
  try {
    await permissions.ready;
    const task = permissions.router.enqueue({ role: "backend", title: "permissions", prompt: "no-op" }); await permissions.router.runUntilIdle();
    assert.deepEqual(permissionsProvider.calls.approvals, [{ requestId: "approval-1", response: { permissions: {}, scope: "turn" } }]); assert.equal(permissions.router.store.getTask(task.id).status, "failed");
  } finally { permissions.dispose(); }
  const orphanProvider = new ControlledProvider("unowned"); const orphan = fixture(orphanProvider);
  try {
    await orphan.ready;
    await orphan.router.runUntilIdle(); await tick();
    assert.equal(orphan.router.list().length, 0); assert.deepEqual(orphanProvider.calls.approvals, [{ requestId: "orphan-request", response: { decision: "cancel" } }]); assert.deepEqual(orphanProvider.calls.interrupts, [{ threadId: "orphan-thread", turnId: "orphan-turn" }]);
  } finally { orphan.dispose(); }
});

test("canonical alias and usage continue through the Router path", async () => {
  const provider = new ControlledProvider("alias-usage"); const subject = fixture(provider);
  try {
    await subject.ready;
    const task = subject.router.enqueue({ role: "bootstrap", title: "alias", prompt: "no-op" }); await subject.router.runUntilIdle();
    const current = subject.router.store.getTask(task.id); assert.equal(current.status, "done"); assert.equal(current.turnId, "canonical-turn"); assert.equal(current.tokenUsed, 7); assert.equal(provider.calls.interrupts.length, 0);
  } finally { subject.dispose(); }
});

test("provider process failure remains the persisted primary failure and is not relabelled as dependency_deadlock", async () => {
  const provider = new ControlledProvider("process-exit"); const subject = fixture(provider);
  try {
    await subject.ready;
    const run = subject.router.createDeliveryRun({ id: "provider-exit-run", bootstrapTaskId: null });
    const predecessor = subject.router.enqueue({ role: "backend", title: "provider exit predecessor", prompt: "no-op", deliveryRunId: run.id });
    subject.router.enqueue({ role: "backend", title: "blocked successor", prompt: "no-op", dependencies: [predecessor.id], deliveryRunId: run.id });
    const execution = await subject.router.runUntilIdle({ deliveryRunId: run.id });
    const persisted = subject.router.store.deliveryRun(run.id);
    assert.equal(execution.dependencyDeadlock, null);
    assert.equal(persisted.state, "interrupted");
    assert.equal(persisted.recovery.primaryFailure.taxonomy, "execution_provider_process_exit");
    assert.equal(persisted.recovery.primaryFailure.recoveryState, "resume_delivery_after_execution_provider_recovery");
    assert.equal(subject.router.store.getTask(predecessor.id).status, "interrupted");
    const diagnostics = await subject.router.collectTaskDiagnostics(predecessor.id);
    assert.equal(diagnostics.threadRead.source, "process_exit_terminal_thread_read");
    assert.equal(diagnostics.threadRead.available, false);
    assert.equal(subject.router.store.db.prepare("SELECT count(*) AS count FROM dependency_deadlocks WHERE delivery_run_id = ?").get(run.id).count, 0);
  } finally { subject.dispose(); }
});

test("provider process exit after a persisted terminal completion does not overwrite the completed task", async () => {
  const provider = new ControlledProvider("process-exit-after-terminal"); const subject = fixture(provider);
  try {
    await subject.ready;
    const run = subject.router.createDeliveryRun({ id: "provider-terminal-run", bootstrapTaskId: null });
    const task = subject.router.enqueue({ role: "backend", title: "completed before provider exit", prompt: "no-op", deliveryRunId: run.id });
    await subject.router.runUntilIdle({ deliveryRunId: run.id }); await tick();
    assert.equal(subject.router.store.getTask(task.id).status, "done");
    assert.notEqual(subject.router.store.deliveryRun(run.id).state, "interrupted");
    assert.equal(subject.router.store.deliveryRun(run.id).recovery?.primaryFailure?.taxonomy ?? null, null);
  } finally { subject.dispose(); }
});

test("persisted missing writer lineage still records a structured dependency_deadlock", async () => {
  const provider = new ControlledProvider(); const subject = fixture(provider);
  try {
    await subject.ready;
    subject.router.config.roles.backend.sandbox = "workspace-write"; subject.router.config.roles.backend.usesWorktree = true;
    const predecessor = subject.router.enqueue({ role: "backend", title: "unreachable predecessor", prompt: "no-op" });
    subject.router.store.transition(predecessor.id, "preparing"); subject.router.store.transition(predecessor.id, "running"); subject.router.store.transition(predecessor.id, "failed", { error: "persisted writer failure" });
    const successor = subject.router.enqueue({ role: "backend", title: "unreachable successor", prompt: "no-op", dependencies: [predecessor.id] });
    const execution = await subject.router.runUntilIdle();
    assert.equal(execution.integrityBlocked, true);
    assert.ok(execution.dependencyDeadlock.reasons.some((item) => item.taskId === successor.id && item.code === "unreachable_writer_predecessor" && item.predecessorId === predecessor.id));
    assert.equal(subject.router.store.db.prepare("SELECT count(*) AS count FROM dependency_deadlocks").get().count, 1);
  } finally { subject.dispose(); }
});
