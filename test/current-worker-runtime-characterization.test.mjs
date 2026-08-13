import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmRouter } from "../src/router.mjs";
import { WorktreeFinalizer } from "../src/worktree-finalizer.mjs";
import { envelope, EXECUTION_PROVIDER_VERSION, REQUIRED_EXECUTION_CAPABILITIES } from "../src/execution-provider-contract.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const roles = (writer = true) => Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, {
  sandbox: role === "backend" && writer ? "workspace-write" : "read-only",
  approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "backend" && writer
}]));

class CharacterizationProvider extends EventEmitter {
  constructor({ mode = "completed", onStartTurn = null } = {}) {
    super();
    this.mode = mode;
    this.onStartTurn = onStartTurn;
    this.next = 1;
    this.thread = null;
    this.startThreadCalls = [];
  }

  #ok(operation, args, data) { return envelope({ operation, correlationId: args.correlationId, success: true, data }); }
  async handshake(args) { return this.#ok("handshake", args, { providerRunId: "characterization", capabilities: [...REQUIRED_EXECUTION_CAPABILITIES] }); }
  async accountRead(args) { return this.#ok("account_read", args, { account: {}, usage: {}, rateLimits: {} }); }
  async startThread(args) {
    this.thread = { id: `thread-${this.next++}`, cwd: args.data.cwd, turnId: null };
    this.startThreadCalls.push(args.data);
    return this.#ok("start_thread", args, { providerRunId: "characterization", threadId: this.thread.id });
  }
  async setGoal(args) { return this.#ok("set_goal", args, { providerRunId: "characterization", threadId: args.data.threadId }); }
  async startTurn(args) {
    const turnId = `turn-${this.thread.id}`;
    this.thread.turnId = turnId;
    await this.onStartTurn?.({ cwd: this.thread.cwd, threadId: this.thread.id, turnId });
    return this.#ok("start_turn", args, { providerRunId: "characterization", threadId: this.thread.id, turnId });
  }
  async observeTerminal(args) {
    if (this.mode === "timeout") return envelope({ operation: "observe_terminal", correlationId: args.correlationId, success: false, errorCode: "timeout", errorClass: "transport", diagnostics: "bounded timeout" });
    return this.#ok("observe_terminal", args, { providerRunId: "characterization", threadId: this.thread.id, turnId: this.thread.turnId, terminalClass: "completed" });
  }
  async reconcileTerminal(args) {
    return this.#ok("reconcile_terminal", args, {
      providerRunId: "characterization", threadId: this.thread.id, turnId: this.thread.turnId,
      terminalClass: "completed", requestedTurnId: args.data.turnId, resolvedTurnId: this.thread.turnId,
      reconciliationSource: "thread_read", verifiedEquivalence: "exact",
      terminalReceipt: {
        schemaVersion: 1, kind: "AppServerTerminalReceipt", source: "same_provider_thread_read",
        threadId: this.thread.id, requestedTurnId: args.data.turnId, resolvedTurnId: this.thread.turnId,
        terminalClass: "completed", correlationId: args.correlationId, providerConnectionId: "characterization",
        capturedAt: new Date().toISOString(), corroboration: { available: true, source: "same_provider_thread_read", terminalClass: "completed" }
      }
    });
  }
  async readFinalResult(args) { return this.#ok("read_final_result", args, { providerRunId: "characterization", threadId: args.data.threadId, turnId: args.data.turnId, resultText: "Worker-reported files: README.md (non-authoritative)." }); }
  async interruptTurn(args) { return this.#ok("interrupt_turn", args, { providerRunId: "characterization", threadId: args.data.threadId, turnId: args.data.turnId, terminalClass: "interrupted" }); }
  async approvalResponse(args) { return this.#ok("approval_response", args, { providerRunId: "characterization", requestId: args.data.requestId }); }
  async diagnostics(args) { return this.#ok("diagnostics", args, { diagnostics: "characterization provider" }); }
  async shutdown(args) { return this.#ok("shutdown", args, { providerRunId: "characterization", terminalClass: "shutdown" }); }
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "current-runtime-characterization-"));
  git(root, ["init", "-b", "main"]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", packageManager: "npm@10", scripts: { test: "node --test" } }));
  writeFileSync(join(root, "package-lock.json"), "{}");
  writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n");
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "authorized base"]);
  const authorizedBaseSha = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "README.md"), "controller branch moves after authorization\n");
  git(root, ["add", "README.md"]);
  git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "later controller commit"]);
  return { root, authorizedBaseSha };
}

function routerFor(root, baseRef, provider, { processRunner = async () => ({ pid: 7, stdout: "verified", stderr: "" }), writer = true, faultHooks = {} } = {}) {
  return new SwarmRouter({
    repository: root, runtimeDir: join(root, "runtime"), baseRef, model: "fake", processRunner, faultHooks,
    project: { name: "characterization", documentationDir: "docs/input", generatedDir: "docs/generated", productRoots: [] },
    router: { maxConcurrentTasks: 1, maxChildrenPerTask: 5, maxDelegationDepth: 4, maxPlanTasks: 5, defaultParentBudget: 1000, turnTimeoutMs: 25, approvalMode: "deny" },
    autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true },
    budget: { weeklyTokenLimit: 10_000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false },
    roles: roles(writer), executionProviderFactory: () => provider
  });
}

test("characterization: controller pins exact base, assigns cwd, and accepts only its finalized Git diff", async () => {
  const { root, authorizedBaseSha } = repository();
  let router;
  try {
    let finalizationObservation = null;
    const provider = new CharacterizationProvider({ onStartTurn: ({ cwd }) => writeFileSync(join(cwd, "src", "value.mjs"), "export const value = 2;\n") });
    router = routerFor(root, authorizedBaseSha, provider, { processRunner: async (command) => {
      const task = router.list().find((item) => item.role === "backend");
      finalizationObservation = { taskStatus: router.store.getTask(task.id).status, artifact: router.store.workerArtifact(task.id), cwd: command.cwd };
      return { pid: 7, stdout: "controller verification", stderr: "" };
    } });
    await router.ensureProjectOverlay();
    const task = router.enqueue({ role: "backend", title: "characterize writer", prompt: "write only the source file", allowedPaths: ["src"] });
    await router.runUntilIdle();
    const persisted = router.store.getTask(task.id);
    const artifact = router.store.workerArtifact(task.id);
    assert.equal(git(persisted.worktree, ["rev-parse", "HEAD^"]), authorizedBaseSha, "finalizer commit must descend directly from the authorized base");
    assert.equal(provider.startThreadCalls[0].cwd, persisted.worktree, "provider must receive controller-assigned worker cwd");
    assert.deepEqual(finalizationObservation, { taskStatus: "running", artifact: null, cwd: persisted.worktree }, "provider completion remains non-authoritative until controller finalization");
    assert.equal(persisted.status, "done");
    assert.deepEqual(artifact.changedPaths, ["src/value.mjs"], "WorkerArtifact must derive paths from actual Git state, not worker prose");
    assert.equal(artifact.baseSha, authorizedBaseSha);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: "forbidden path", write: (cwd) => writeFileSync(join(cwd, "README.md"), "forbidden worker edit\n"), expected: /outside TaskEnvelope allowedPaths/ },
  { name: "empty diff", write: () => {}, expected: /no diff/ }
]) test(`characterization: ${scenario.name} cannot create an accepted WorkerArtifact`, async () => {
  const { root, authorizedBaseSha } = repository();
  let router;
  try {
    const provider = new CharacterizationProvider({ onStartTurn: ({ cwd }) => scenario.write(cwd) });
    router = routerFor(root, authorizedBaseSha, provider);
    await router.ensureProjectOverlay();
    const task = router.enqueue({ role: "backend", title: scenario.name, prompt: "characterize rejection", allowedPaths: ["src"] });
    await router.runUntilIdle();
    const persisted = router.store.getTask(task.id);
    assert.equal(persisted.status, "failed");
    assert.match(persisted.error, scenario.expected);
    assert.equal(router.store.workerArtifact(task.id), null);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("characterization: provider timeout is typed execution failure and never a completed artifact", async () => {
  const { root, authorizedBaseSha } = repository();
  let router;
  try {
    const provider = new CharacterizationProvider({ mode: "timeout" });
    router = routerFor(root, authorizedBaseSha, provider);
    await router.ensureProjectOverlay();
    const task = router.enqueue({ role: "backend", title: "timeout", prompt: "must not finalize", allowedPaths: ["src"] });
    await router.runUntilIdle();
    const persisted = router.store.getTask(task.id);
    assert.equal(persisted.status, "failed");
    assert.match(persisted.error, /timeout/);
    assert.equal(router.store.workerArtifact(task.id), null);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("characterization: a pre-persistence crash cannot recover into a duplicate accepted artifact", async () => {
  const { root, authorizedBaseSha } = repository();
  let crashed;
  let restarted;
  try {
    const provider = new CharacterizationProvider({ onStartTurn: ({ cwd }) => writeFileSync(join(cwd, "src", "value.mjs"), "export const value = 2;\n") });
    crashed = routerFor(root, authorizedBaseSha, provider, { faultHooks: { artifact_file_before_db_persistence: async () => { throw new Error("injected artifact persistence crash"); } } });
    await crashed.ensureProjectOverlay();
    const task = crashed.enqueue({ role: "backend", title: "crash boundary", prompt: "write source", allowedPaths: ["src"] });
    await crashed.runUntilIdle();
    assert.equal(crashed.store.workerArtifact(task.id), null);
    assert.equal(existsSync(join(root, "docs", "generated", "worker-artifacts", `${task.id}.v1.json`)), true, "file evidence alone is not accepted");
    crashed.close(); crashed = null;
    restarted = routerFor(root, authorizedBaseSha, new CharacterizationProvider());
    await restarted.recoverStaleDeliveries();
    assert.equal(restarted.store.workerArtifact(task.id), null, "recovery must not promote or duplicate a file-only artifact");
  } finally { crashed?.close(); restarted?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("characterization: integration refuses writer artifact without controller-owned Security and QA reports", async () => {
  const { root, authorizedBaseSha } = repository();
  let router;
  try {
    router = routerFor(root, authorizedBaseSha, new CharacterizationProvider(), { writer: true });
    const { overlay, path } = await router.ensureProjectOverlay();
    const task = router.enqueue({ role: "backend", title: "unreviewed writer", prompt: "fixture", allowedPaths: ["src"] });
    router.store.transition(task.id, "preparing"); router.store.transition(task.id, "running");
    const worktree = join(root, "manual-writer");
    git(root, ["worktree", "add", "-b", "fixture/unreviewed", worktree, authorizedBaseSha]);
    writeFileSync(join(worktree, "src", "value.mjs"), "export const value = 2;\n");
    const finalized = await new WorktreeFinalizer({ repository: root, generatedDir: "docs/generated", processRunner: router.processRunner }).finalize({ task: { ...router.store.getTask(task.id), artifactBaseSha: authorizedBaseSha }, worktree, branch: "fixture/unreviewed", overlay, overlayPath: path });
    router.store.recordWorkerArtifact(task.id, finalized.path, finalized.artifact);
    router.store.transition(task.id, "done");
    assert.equal(router.store.securityReport(task.id), null);
    assert.equal(router.store.qualityReport(task.id), null);
    await assert.rejects(router.integrateFinalized([task.id]), /passed Security and QA review chain/);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
