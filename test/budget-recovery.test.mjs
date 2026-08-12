import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmRouter } from "../src/router.mjs";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { provider } from "./execution-provider-test-adapter.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, {
  sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, interruptThresholdTokens: 20, usesWorktree: false
}]));

class UsageFakeAppServer extends EventEmitter {
  constructor({ usage = null, exit = false, resolvedTurnId = null, completeAfterUsage = false, failSetGoal = false } = {}) { super(); this.usage = usage; this.exit = exit; this.resolvedTurnId = resolvedTurnId; this.completeAfterUsage = completeAfterUsage; this.failSetGoal = failSetGoal; this.next = 1; this.interrupts = []; this.closed = false; this.treeCleanupRequested = 0; this.waiters = new Map(); this.turnAliases = new Map(); }
  async connect() {}
  shutdown() { this.closed = true; this.treeCleanupRequested += 1; return Promise.resolve({ attempted: true, command: "taskkill" }); }
  diagnostics() { return { protocolEvents: [], stderrTail: "", process: { alive: !this.closed, exited: this.closed, code: null, signal: null } }; }
  async request(method) { if (method === "account/read") return { account: {} }; if (method === "account/usage/read") return { dailyUsageBuckets: [] }; if (method === "account/rateLimits/read") return { rateLimits: null }; return {}; }
  async startThread() { return { thread: { id: `thread-${this.next++}` } }; }
  async setGoal() { if (this.failSetGoal) throw new Error("simulated worker setup failure"); }
  async startTurn({ threadId }) {
    const turnId = `turn-${threadId}`;
    const resolvedTurnId = this.resolvedTurnId ?? turnId;
    this.turnAliases.set(resolvedTurnId, turnId);
    setTimeout(() => {
      if (this.exit) { this.emit("exit", { code: 1, signal: null }); this.waiters.get(`${threadId}:${turnId}`)?.reject(new Error("fake App Server exited")); return; }
      if (resolvedTurnId !== turnId) this.emit("protocol", { method: "turn-id-alias", threadId, requestedTurnId: turnId, resolvedTurnId });
      if (this.usage !== null) this.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId, turnId: resolvedTurnId, tokenUsage: { last: { totalTokens: this.usage }, total: { totalTokens: 9_999_999 } } } });
      if (this.usage !== null && (this.usage < 20 || this.completeAfterUsage)) this.waiters.get(`${threadId}:${turnId}`)?.resolve({ id: turnId, status: "completed" });
    }, 0);
    return { turn: { id: turnId } };
  }
  async interruptTurn({ threadId, turnId }) {
    this.interrupts.push({ threadId, turnId });
    this.waiters.get(`${threadId}:${this.turnAliases.get(turnId) ?? turnId}`)?.resolve({ id: turnId, status: "interrupted" });
    return {};
  }
  waitForTurn(threadId, turnId, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(`${threadId}:${turnId}`); reject(new Error("fake turn timeout")); }, timeoutMs);
      this.waiters.set(`${threadId}:${turnId}`, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
  }
  async readThread({ threadId }) { return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text: "```json\n{\"summary\":\"ok\",\"assumptions\":[],\"risks\":[],\"humanGates\":[]}\n```" }] }] } }; }
}

function fixture({ usage = null, hardRunTokenLimit = 500, weeklyTokenLimit = 1000, maxConcurrentTasks = 1, exit = false, resolvedTurnId = null, enforceLocalLimits = true, completeAfterUsage = false, failSetGoal = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestration-budget-"));
  git(root, ["init", "-b", "main"]); writeFileSync(join(root, "README.md"), "# test\n"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const client = new UsageFakeAppServer({ usage, exit, resolvedTurnId, completeAfterUsage, failSetGoal });
  const router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/in", generatedDir: "docs/out", productRoots: [] }, router: { maxConcurrentTasks, maxChildrenPerTask: 10, maxDelegationDepth: 4, maxPlanTasks: 5, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 3 }, budget: { weeklyTokenLimit, weeklyWindowDays: 7, hardRunTokenLimit, interruptSafetyMarginTokens: 10, enforceLocalLimits }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 3, leaseHeartbeatMs: 250, staleLeaseMs: 250, shutdownGraceMs: 250 }, roles, executionProviderFactory: () => provider(client) });
  return { root, router, client, dispose: () => { router.close(); rmSync(root, { recursive: true, force: true }); } };
}

function createRun(router, task) {
  const run = router.createDeliveryRun({ id: `run-${task.id}`, bootstrapTaskId: task.id });
  router.store.linkTaskToDelivery(task.id, run.id);
  return run;
}

async function waitForTurnStart(client) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && client.next === 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.notEqual(client.next, 1, "fake turn did not start");
}

test("usage below threshold does not interrupt, while threshold usage interrupts exactly once and persists measured overshoot", async () => {
  const below = fixture({ usage: 19 });
  try {
    const task = below.router.enqueue({ role: "bootstrap", title: "below", prompt: "bounded" }); createRun(below.router, task);
    await below.router.runUntilIdle({ deliveryRunId: `run-${task.id}` });
    assert.equal(below.client.interrupts.length, 0); assert.equal(below.router.store.getTask(task.id).status, "done");
  } finally { below.dispose(); }

  const threshold = fixture({ usage: 35 });
  try {
    const task = threshold.router.enqueue({ role: "bootstrap", title: "threshold", prompt: "bounded" }); const run = createRun(threshold.router, task);
    const result = await threshold.router.runUntilIdle({ deliveryRunId: run.id });
    const persisted = threshold.router.store.budgetInterruption(task.id);
    assert.equal(result.blockedBudget, true); assert.deepEqual(threshold.client.interrupts, [{ threadId: "thread-1", turnId: "turn-thread-1" }]);
    assert.equal(threshold.router.store.getTask(task.id).status, "blocked_budget"); assert.equal(persisted.actualTokens, 35); assert.equal(persisted.interruptThresholdTokens, 20); assert.equal(persisted.configuredBudgetCap, 100); assert.equal(persisted.thresholdOvershootTokens, 15); assert.equal(persisted.capOvershootTokens, 0); assert.equal(threshold.router.store.deliveryRun(run.id).state, "blocked_budget");
    threshold.client.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-thread-1", tokenUsage: { last: { totalTokens: 999 }, total: { totalTokens: 9_999_999 } } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(threshold.router.store.getTask(task.id).tokenUsed, 35, "late telemetry cannot revive or mutate a terminal turn");
    assert.ok(threshold.router.lifecycleEvents().some((event) => event.type === "turn started")); assert.ok(threshold.router.lifecycleEvents().some((event) => event.type === "budget interrupt requested"));
  } finally { threshold.dispose(); }
});

test("budget watchdog adopts the canonical App Server turn ID before interrupting", async () => {
  const subject = fixture({ usage: 35, resolvedTurnId: "canonical-server-turn" });
  try {
    const task = subject.router.enqueue({ role: "bootstrap", title: "canonical turn", prompt: "bounded" }); const run = createRun(subject.router, task);
    await subject.router.runUntilIdle({ deliveryRunId: run.id });
    assert.deepEqual(subject.client.interrupts, [{ threadId: "thread-1", turnId: "canonical-server-turn" }]);
    assert.equal(subject.router.store.getTask(task.id).turnId, "canonical-server-turn");
    assert.equal(subject.router.store.budgetInterruption(task.id).turnId, "canonical-server-turn");
    assert.ok(subject.router.lifecycleEvents().some((event) => event.type === "turn id alias resolved" && event.resolvedTurnId === "canonical-server-turn"));
  } finally { subject.dispose(); }
});

test("tracking-only mode records actual usage without interrupting or blocking the delivery", async () => {
  const subject = fixture({ usage: 35, enforceLocalLimits: false, completeAfterUsage: true });
  try {
    const task = subject.router.enqueue({ role: "bootstrap", title: "tracking", prompt: "bounded" }); const run = createRun(subject.router, task);
    const result = await subject.router.runUntilIdle({ deliveryRunId: run.id });
    assert.equal(result.blockedBudget, false); assert.equal(subject.client.interrupts.length, 0);
    assert.equal(subject.router.store.getTask(task.id).status, "done"); assert.equal(subject.router.store.getTask(task.id).tokenUsed, 35);
    assert.equal(subject.router.statusSnapshot().localBudgetEnforcement, "tracking_only");
  } finally { subject.dispose(); }
});

test("an ordinary worker failure preserves independent scheduler progress", async () => {
  const subject = fixture({ failSetGoal: true, maxConcurrentTasks: 1 });
  try {
    const first = subject.router.enqueue({ role: "bootstrap", title: "fails", prompt: "bounded" }); const run = createRun(subject.router, first);
    const second = subject.router.enqueue({ role: "planner", title: "must not start", prompt: "bounded", deliveryRunId: run.id });
    const result = await subject.router.runUntilIdle({ deliveryRunId: run.id });
    assert.equal(result.failed, false); assert.equal(subject.router.store.getTask(first.id).status, "failed"); assert.equal(subject.router.store.getTask(second.id).status, "failed");
  } finally { subject.dispose(); }
});

test("budget interruption stops the scheduler before an independent next task starts", async () => {
  const subject = fixture({ usage: 25, maxConcurrentTasks: 1 });
  try {
    const first = subject.router.enqueue({ role: "bootstrap", title: "first", prompt: "bounded" }); const run = createRun(subject.router, first);
    const second = subject.router.enqueue({ role: "planner", title: "second", prompt: "bounded", deliveryRunId: run.id });
    await subject.router.runUntilIdle({ deliveryRunId: run.id });
    assert.equal(subject.router.store.getTask(first.id).status, "blocked_budget"); assert.equal(subject.router.store.getTask(second.id).status, "queued"); assert.equal(subject.client.interrupts.length, 1);
  } finally { subject.dispose(); }
});

test("run and rolling-week reservations block a turn before App Server start", async () => {
  const subject = fixture({ usage: null, hardRunTokenLimit: 100, weeklyTokenLimit: 100 });
  try {
    const completed = subject.router.enqueue({ role: "bootstrap", title: "used", prompt: "bounded" }); const run = createRun(subject.router, completed);
    subject.router.store.transition(completed.id, "preparing"); subject.router.store.transition(completed.id, "running"); subject.router.store.setTokenUsage(completed.id, 80); subject.router.store.transition(completed.id, "done");
    const next = subject.router.enqueue({ role: "planner", title: "reserved", prompt: "bounded", deliveryRunId: run.id });
    await subject.router.runUntilIdle({ deliveryRunId: run.id });
    assert.equal(subject.router.store.getTask(next.id).status, "blocked_budget"); assert.equal(subject.client.next, 1);
  } finally { subject.dispose(); }
});

test("SIGINT-equivalent shutdown and App Server exit persist interrupted delivery state and close the client", async () => {
  const sigint = fixture({ usage: null });
  try {
    const task = sigint.router.enqueue({ role: "bootstrap", title: "interrupt", prompt: "bounded" }); const run = createRun(sigint.router, task);
    const running = sigint.router.runUntilIdle({ deliveryRunId: run.id });
    await waitForTurnStart(sigint.client); await sigint.router.requestShutdown("interrupted_controller_exit: SIGINT received"); await running;
    assert.equal(sigint.client.interrupts.length, 1); assert.equal(sigint.client.closed, true); assert.equal(sigint.router.store.getTask(task.id).status, "interrupted"); assert.equal(sigint.router.store.deliveryRun(run.id).state, "interrupted");
  } finally { sigint.dispose(); }

  const crashed = fixture({ exit: true });
  try {
    const task = crashed.router.enqueue({ role: "bootstrap", title: "crash", prompt: "bounded" }); const run = createRun(crashed.router, task);
    await crashed.router.runUntilIdle({ deliveryRunId: run.id });
    assert.equal(crashed.router.store.getTask(task.id).status, "interrupted"); assert.equal(crashed.router.store.deliveryRun(run.id).state, "interrupted");
  } finally { crashed.dispose(); }
});

test("stale owner lease recovery marks the historical run interrupted without erasing token history", async () => {
  const subject = fixture();
  try {
    const task = subject.router.enqueue({ role: "bootstrap", title: "stale", prompt: "bounded" }); const run = createRun(subject.router, task);
    subject.router.store.db.prepare("UPDATE delivery_runs SET owner_pid = ?, owner_session_id = ?, heartbeat_at = ? WHERE id = ?").run(999999, "dead-session", "2000-01-01T00:00:00.000Z", run.id);
    subject.router.store.transition(task.id, "preparing"); subject.router.store.transition(task.id, "running", { threadId: "historic-thread", turnId: "historic-turn" }); subject.router.store.setTokenUsage(task.id, 120550);
    const recovered = await subject.router.recoverStaleDeliveries();
    assert.equal(recovered.length, 1); assert.equal(subject.router.store.deliveryRun(run.id).state, "interrupted");
    const historical = subject.router.store.getTask(task.id); assert.equal(historical.status, "interrupted"); assert.equal(historical.tokenUsed, 120550); assert.equal(historical.threadId, "historic-thread"); assert.equal(historical.turnId, "historic-turn");
  } finally { subject.dispose(); }
});

test("turn timeout preserves independent tasks for scoped recovery", async () => {
  const subject = fixture({ usage: null, maxConcurrentTasks: 1 });
  subject.router.config.router.turnTimeoutMs = 20;
  try {
    const first = subject.router.enqueue({ role: "bootstrap", title: "times out", prompt: "bounded" }); const run = createRun(subject.router, first);
    const second = subject.router.enqueue({ role: "planner", title: "must not start", prompt: "bounded", deliveryRunId: run.id });
    const result = await subject.router.runUntilIdle({ deliveryRunId: run.id });
    assert.equal(result.failed, false);
    assert.equal(subject.router.store.getTask(first.id).status, "failed");
    assert.equal(subject.router.store.getTask(second.id).status, "failed");
    assert.equal(subject.client.treeCleanupRequested, 1);
  } finally { subject.dispose(); }
});

test("a second coordinator cannot steal a fresh delivery lease before App Server startup", async () => {
  const first = fixture();
  let starts = 0;
  const second = new SwarmRouter({ ...first.router.config, executionProviderFactory: () => { starts += 1; return provider(new UsageFakeAppServer()); } });
  try {
    const task = first.router.enqueue({ role: "bootstrap", title: "owned", prompt: "bounded" }); const run = createRun(first.router, task);
    await assert.rejects(new DeliveryCoordinator(second).resume(), /Delivery already owned/);
    assert.equal(starts, 0);
    assert.equal(first.router.store.deliveryRun(run.id).ownerSessionId, first.router.activeDeliverySessionId);
  } finally { second.close(); first.dispose(); }
});

test("late App Server process-exit telemetry after router close cannot reopen SQLite", () => {
  const subject = fixture();
  try {
    subject.router.close();
    assert.doesNotThrow(() => subject.client.emit("protocol", { direction: "processExit", errorMessage: "code=0; signal=none" }));
  } finally { subject.dispose(); }
});
