import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmRouter } from "../src/router.mjs";
import { CodexAppServerRuntime } from "../src/codex-app-server-runtime.mjs";
import { AppServerExecutionProvider } from "../src/app-server-execution-provider.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const writerRoles = new Set(["frontend", "backend", "database", "devops"]);

class RuntimeClient extends EventEmitter {
  constructor({ onStart = null, resultText = "worker prose claims README.md changed", terminal = "completed", wait = null, timeout = false, disconnect = false, terminalNotification = null, readUnavailable = false, exitBeforeTerminal = false } = {}) {
    super(); this.onStart = onStart; this.resultText = resultText; this.terminal = terminal; this.wait = wait; this.timeout = timeout; this.disconnect = disconnect; this.terminalNotification = terminalNotification; this.readUnavailable = readUnavailable; this.exitBeforeTerminal = exitBeforeTerminal; this.sequence = 0; this.threads = new Map(); this.calls = [];
  }
  async connect() { this.calls.push("connect"); if (this.disconnect) throw new Error("transport closed"); }
  async request() { return {}; }
  async startThread(data) { const id = `thread-${++this.sequence}`; this.threads.set(id, { cwd: data.cwd, goal: "", turnId: null }); this.calls.push(["thread", data]); return { thread: { id } }; }
  async setGoal(data) { this.threads.get(data.threadId).goal = data.objective ?? ""; this.calls.push(["goal", data]); }
  async startTurn(data) { const thread = this.threads.get(data.threadId); const id = `turn-${data.threadId}-${++this.sequence}`; thread.turnId = id; this.calls.push(["turn", data]); await this.onStart?.({ cwd: thread.cwd, threadId: data.threadId, turnId: id, goal: thread.goal }); if (this.terminalNotification?.when === "before_start_result") this.#terminalNotification(data.threadId, id); return { turn: { id } }; }
  async waitForTurn(threadId, turnId) { this.calls.push("wait"); if (this.timeout) throw new Error("bounded timeout"); if (this.exitBeforeTerminal) { this.emit("exit", { code: 17, signal: "SIGTERM" }); throw new Error("App Server exited during turn"); } await this.wait?.promise; if (this.terminalNotification?.when === "wait") this.#terminalNotification(threadId, turnId); return { id: turnId, status: this.terminal }; }
  #terminalNotification(threadId, turnId) { const mode = this.terminalNotification?.mode ?? "valid"; const params = mode === "missing_status" ? { threadId, turn: { id: turnId } } : mode === "wrong_thread" ? { threadId: "other-thread", turn: { id: turnId, status: this.terminal } } : mode === "wrong_turn" || mode === "untrusted_alias" ? { threadId, turn: { id: "other-turn", status: this.terminal } } : { threadId, turn: { id: turnId, status: this.terminal } }; this.emit("notification", { method: "turn/completed", params }); }
  #resultText(thread) { return typeof this.resultText === "function" ? this.resultText(thread) : this.resultText; }
  async readTerminalTurn(threadId, turnId) { if (this.readUnavailable) throw new Error(`thread/read: thread not loaded: ${threadId}`); const thread = this.threads.get(threadId); return { terminal: { id: turnId, status: this.terminal, items: [{ type: "agentMessage", text: this.#resultText(thread) }] } }; }
  async readThread({ threadId }) { if (this.readUnavailable) throw new Error(`thread/read: thread not loaded: ${threadId}`); const thread = this.threads.get(threadId); return { thread: { turns: [{ id: thread.turnId, status: this.terminal, items: [{ type: "agentMessage", text: this.#resultText(thread) }] }] } }; }
  async interruptTurn() { this.terminal = "cancelled"; }
  async shutdown() { this.calls.push("shutdown"); }
  diagnostics() { return { process: { exited: this.disconnect } }; }
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "codex-writer-migration-"));
  git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", packageManager: "npm@10", scripts: { test: "node --test" } }));
  writeFileSync(join(root, "package-lock.json"), "{}"); writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n");
  git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  return { root, baseSha: git(root, ["rev-parse", "HEAD"]) };
}

function roles() {
  return Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, {
    sandbox: writerRoles.has(role) ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: writerRoles.has(role)
  }]));
}

function subject(root, { maxConcurrentTasks = 1, clients = [], clientOptions = {}, legacyClientOptions = {}, faultHooks = {}, processRunner = async () => ({ pid: 9, stdout: "verified", stderr: "" }) } = {}) {
  const legacyClients = [];
  const router = new SwarmRouter({
    repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", processRunner, faultHooks,
    project: { name: "phase2", documentationDir: "docs/input", generatedDir: "docs/generated", productRoots: [] },
    router: { maxConcurrentTasks, maxChildrenPerTask: 8, maxDelegationDepth: 4, maxPlanTasks: 8, defaultParentBudget: 1000, turnTimeoutMs: 50, approvalMode: "deny" },
    autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true }, budget: { weeklyTokenLimit: 10_000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, roles: roles(),
    codexAppServerRuntimeFactory: ({ cwd, task }) => {
      const options = typeof clientOptions === "function" ? clientOptions(task, cwd) : clientOptions;
      const client = new RuntimeClient(options); clients.push({ task, cwd, client });
      return new CodexAppServerRuntime({ cwd, client });
    },
    executionProviderFactory: () => { const client = new RuntimeClient(legacyClientOptions); legacyClients.push(client); return new AppServerExecutionProvider({ client }); }
  });
  return { router, clients, legacyClients };
}

async function writer(subject, role = "backend", extra = {}) {
  await subject.router.ensureProjectOverlay();
  return subject.router.enqueue({ role, title: `${role} writer`, prompt: "change the assigned source", allowedPaths: ["src"], ...extra });
}

test("Phase 2: migrated frontend and backend receive the exact controller worktree cwd", async () => {
  const { root } = repository(); const fx = subject(root, { clientOptions: { onStart: ({ cwd, threadId }) => writeFileSync(join(cwd, "src", `${threadId}.mjs`), "export const value = 2;\n") } });
  try {
    const backend = await writer(fx, "backend"); const frontend = await writer(fx, "frontend"); await fx.router.runUntilIdle();
    for (const task of [backend, frontend]) {
      const stored = fx.router.store.getTask(task.id); const runtime = fx.clients.find((item) => item.task.id === task.id);
      assert.equal(runtime.cwd, stored.worktree); assert.equal(runtime.client.calls.find((item) => Array.isArray(item) && item[0] === "thread")[1].cwd, stored.worktree);
    }
  } finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Phase 2: completion is non-authoritative; Git finalizer creates the artifact from the real diff", async () => {
  const { root } = repository(); let during; const fx = subject(root, { clientOptions: { onStart: ({ cwd }) => writeFileSync(join(cwd, "src", "value.mjs"), "export const value = 2;\n") }, processRunner: async (command) => { const task = fx.router.list().find((item) => item.role === "backend"); during = { status: fx.router.store.getTask(task.id).status, artifact: fx.router.store.workerArtifact(task.id), cwd: command.cwd }; return { pid: 9, stdout: "ok", stderr: "" }; } });
  try {
    const task = await writer(fx); await fx.router.runUntilIdle(); const artifact = fx.router.store.workerArtifact(task.id);
    assert.deepEqual(during, { status: "running", artifact: null, cwd: fx.router.store.getTask(task.id).worktree });
    assert.deepEqual(artifact.changedPaths, ["src/value.mjs"]); assert.equal(fx.router.store.getTask(task.id).status, "done");
  } finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Phase 2: verified turn/completed receipt survives thread/read loss and permits controller artifact finalization", async () => {
  const { root } = repository(); const fx = subject(root, { clientOptions: { terminalNotification: { when: "wait" }, readUnavailable: true, onStart: ({ cwd }) => writeFileSync(join(cwd, "src", "value.mjs"), "export const value = 2;\n") } });
  try {
    const task = await writer(fx); await fx.router.runUntilIdle();
    assert.equal(fx.router.store.getTask(task.id).status, "done"); assert.ok(fx.router.store.workerArtifact(task.id));
    const receipt = fx.router.store.events().find((event) => event.taskId === task.id && event.type === "app-server/terminal-receipt")?.payload;
    assert.equal(receipt?.source, "turn_completed"); assert.equal(receipt?.corroboration?.available, false); assert.match(receipt?.corroboration?.diagnostics ?? "", /thread\/read: thread not loaded/);
  } finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Phase 2: malformed, foreign, alias, or stale terminal events fail closed without an artifact", async () => {
  for (const terminalNotification of [
    { when: "wait", mode: "missing_status" }, { when: "wait", mode: "wrong_thread" }, { when: "wait", mode: "wrong_turn" }, { when: "wait", mode: "untrusted_alias" }, { when: "before_start_result", mode: "valid" }
  ]) {
    const { root } = repository(); const fx = subject(root, { clientOptions: { terminalNotification, readUnavailable: true, onStart: ({ cwd }) => writeFileSync(join(cwd, "src", "value.mjs"), "export const value = 2;\n") } });
    try { const task = await writer(fx); await fx.router.runUntilIdle(); const stored = fx.router.store.getTask(task.id); assert.equal(stored.status, "failed"); assert.match(stored.error, /transport_failure/); assert.equal(fx.router.store.workerArtifact(task.id), null); }
    finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("Phase 2: process exit before a verified terminal receipt is a typed failure without an artifact", async () => {
  const { root } = repository(); const fx = subject(root, { clientOptions: { exitBeforeTerminal: true, onStart: ({ cwd }) => writeFileSync(join(cwd, "src", "value.mjs"), "export const value = 2;\n") } });
  try { const task = await writer(fx); await fx.router.runUntilIdle(); const stored = fx.router.store.getTask(task.id); assert.equal(stored.status, "failed"); assert.match(stored.error, /process_exit/); assert.equal(fx.router.store.workerArtifact(task.id), null); }
  finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: "forbidden diff", onStart: ({ cwd }) => writeFileSync(join(cwd, "README.md"), "forbidden\n"), expected: /outside TaskEnvelope/ },
  { name: "empty diff", onStart: () => {}, expected: /no diff/ }
]) test(`Phase 2: ${scenario.name} blocks migrated acceptance`, async () => {
  const { root } = repository(); const fx = subject(root, { clientOptions: { onStart: scenario.onStart } });
  try { const task = await writer(fx); await fx.router.runUntilIdle(); assert.equal(fx.router.store.getTask(task.id).status, "failed"); assert.match(fx.router.store.getTask(task.id).error, scenario.expected); assert.equal(fx.router.store.workerArtifact(task.id), null); }
  finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: "timeout", options: { timeout: true }, expected: /timeout/ },
  { name: "disconnect", options: { disconnect: true }, expected: /shutdown|transport/ },
  { name: "cancelled turn", options: { terminal: "cancelled" }, expected: /worker_cancelled/ }
]) test(`Phase 2: migrated runtime ${scenario.name} is a typed controller failure without an artifact`, async () => {
  const { root } = repository(); const fx = subject(root, { clientOptions: scenario.options });
  try { const task = await writer(fx); await fx.router.runUntilIdle(); const stored = fx.router.store.getTask(task.id); assert.equal(stored.status, "failed"); assert.match(stored.error, scenario.expected); assert.equal(fx.router.store.workerArtifact(task.id), null); }
  finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Phase 2: controller capacity retains a first migrated writer through terminal persistence", async () => {
  const { root } = repository(); const release = deferred(); const started = deferred(); let starts = 0;
  const fx = subject(root, { maxConcurrentTasks: 1, clientOptions: (task) => ({ wait: starts++ === 0 ? release : null, onStart: ({ cwd }) => { writeFileSync(join(cwd, "src", `${task.id}.mjs`), "export const value = 2;\n"); started.resolve(); } }) });
  try { await writer(fx, "backend", { allowedPaths: ["src"] }); await writer(fx, "database", { allowedPaths: ["src"] }); const run = fx.router.runUntilIdle(); await started.promise; assert.equal(fx.clients.length, 1); release.resolve(); await run; assert.equal(fx.clients.length, 2); }
  finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Phase 2: two independent migrated writers are admitted at capacity two", async () => {
  const { root } = repository(); const release = deferred(); const both = deferred(); let started = 0;
  const fx = subject(root, { maxConcurrentTasks: 2, clientOptions: (task) => ({ wait: release, onStart: ({ cwd }) => { writeFileSync(join(cwd, "src", `${task.id}.mjs`), "export const value = 2;\n"); if (++started === 2) both.resolve(); } }) });
  try { await writer(fx, "backend"); await writer(fx, "frontend"); const run = fx.router.runUntilIdle(); await both.promise; assert.equal(fx.clients.length, 2); release.resolve(); await run; assert.ok(fx.router.list().filter((item) => writerRoles.has(item.role)).every((item) => item.status === "done")); }
  finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Phase 2: migrated successor uses its exact predecessor artifact SHA", async () => {
  const { root } = repository(); const fx = subject(root, { clientOptions: (task) => ({ onStart: ({ cwd }) => writeFileSync(join(cwd, "src", `${task.role}.mjs`), "export const value = 2;\n") }) });
  try {
    const first = await writer(fx, "backend"); await fx.router.runUntilIdle(); const firstArtifact = fx.router.store.workerArtifact(first.id);
    const second = await writer(fx, "database", { dependencies: [first.id], artifactBaseSha: firstArtifact.headSha, artifactDependencies: [first.id] }); await fx.router.runUntilIdle(); const secondArtifact = fx.router.store.workerArtifact(second.id);
    assert.ok(secondArtifact, JSON.stringify(fx.router.store.getTask(second.id))); assert.equal(fx.router.store.getTask(second.id).artifactBaseSha, firstArtifact.headSha); assert.equal(secondArtifact.baseSha, firstArtifact.headSha);
  } finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("G1: two isolated Codex writers retain alias-safe receipts through Security, QA, fan-in integration, and restart", async () => {
  const { root, baseSha } = repository(); let restarted;
  const gateResult = (thread) => /^Security review\b/.test(thread.goal) || /^QA\b/.test(thread.goal)
    ? "```json\n{\"verdict\":\"pass\",\"summary\":\"deterministic gate passed\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```"
    : "writer completed";
  const fx = subject(root, {
    maxConcurrentTasks: 2,
    clientOptions: (task) => ({
      terminalNotification: { when: "wait" }, readUnavailable: true,
      onStart: ({ cwd }) => writeFileSync(join(cwd, "src", `${task.role}.mjs`), `export const ${task.role} = true;\n`)
    }),
    legacyClientOptions: { resultText: gateResult }
  });
  try {
    const backend = await writer(fx, "backend", { allowedPaths: ["src/backend.mjs"] });
    const frontend = await writer(fx, "frontend", { allowedPaths: ["src/frontend.mjs"] });
    await fx.router.runUntilIdle();

    const writers = [backend, frontend].map((task) => fx.router.store.getTask(task.id));
    assert.equal(writers.every((task) => task.status === "done"), true, JSON.stringify(writers));
    assert.equal(fx.clients.length, 2, "configured capacity two admits both independent writers");
    for (const task of writers) {
      const runtime = fx.clients.find((item) => item.task.id === task.id);
      const artifact = fx.router.store.workerArtifact(task.id);
      const receipt = fx.router.store.events().find((event) => event.taskId === task.id && event.type === "app-server/terminal-receipt")?.payload;
      assert.equal(runtime.cwd, task.worktree);
      assert.equal(artifact.baseSha, baseSha);
      assert.equal(receipt?.source, "turn_completed");
      assert.equal(receipt?.corroboration?.available, false);
    }
    const securityReviews = writers.map((task) => fx.router.enqueue({ role: "security", title: "Security review", prompt: "Review the finalized writer artifact.", dependencies: [task.id], sourceWriterTaskId: task.id, allowedPaths: [] }));
    securityReviews.forEach((security, index) => fx.router.enqueue({ role: "qa", title: "QA", prompt: "Verify the finalized writer artifact.", dependencies: [security.id], sourceWriterTaskId: writers[index].id, allowedPaths: [] }));
    await fx.router.runUntilIdle();
    const reviews = fx.router.list().filter((task) => task.sourceWriterTaskId === backend.id || task.sourceWriterTaskId === frontend.id);
    assert.equal(reviews.filter((task) => task.role === "security" && task.status === "done").length, 2, JSON.stringify(reviews));
    assert.equal(reviews.filter((task) => task.role === "qa" && task.status === "done").length, 2);
    const integration = await fx.router.integrateFinalized([backend.id, frontend.id]);
    assert.equal(integration.manifest.status, "candidate_ready");

    fx.router.close();
    restarted = subject(root, { maxConcurrentTasks: 2, legacyClientOptions: { resultText: gateResult } });
    await restarted.router.recoverStaleDeliveries();
    await restarted.router.runUntilIdle();
    assert.equal(restarted.clients.length, 0, "restart does not create duplicate writer turns");
    assert.equal([backend.id, frontend.id].filter((id) => restarted.router.store.workerArtifact(id)).length, 2, "restart preserves exactly one artifact per writer");
  } finally { fx.router.close(); restarted?.router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Phase 2: legacy writer selection is retired", () => {
  const source = readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /writerRuntimePath|resolveTransitionalRuntimePath/);
});

test("Phase 2: Security and QA remain controller-owned gates for a migrated artifact", async () => {
  const { root } = repository(); const fx = subject(root, { clientOptions: { onStart: ({ cwd }) => writeFileSync(join(cwd, "src", "value.mjs"), "export const value = 2;\n") } });
  try { const task = await writer(fx); await fx.router.runUntilIdle(); assert.ok(fx.router.store.workerArtifact(task.id)); await assert.rejects(fx.router.integrateFinalized([task.id]), /passed Security and QA review chain/); }
  finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Phase 2: restart after pre-persistence failure cannot accept a duplicate migrated artifact", async () => {
  const { root } = repository(); let crashed; let restarted;
  try {
    crashed = subject(root, { clientOptions: { onStart: ({ cwd }) => writeFileSync(join(cwd, "src", "value.mjs"), "export const value = 2;\n") }, faultHooks: { artifact_file_before_db_persistence: async () => { throw new Error("injected persistence crash"); } } }); const task = await writer(crashed); await crashed.router.runUntilIdle(); assert.equal(crashed.router.store.workerArtifact(task.id), null); assert.equal(existsSync(join(root, "docs", "generated", "worker-artifacts", `${task.id}.v1.json`)), true); crashed.router.close();
    restarted = subject(root); await restarted.router.recoverStaleDeliveries(); assert.equal(restarted.router.store.workerArtifact(task.id), null);
  } finally { crashed?.router.close(); restarted?.router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Phase 2: non-writer bootstrap remains on the legacy execution path", async () => {
  const { root } = repository(); const fx = subject(root);
  try { const task = fx.router.enqueue({ role: "bootstrap", title: "legacy bootstrap", prompt: "report", allowedPaths: [] }); await fx.router.runUntilIdle(); assert.equal(fx.clients.length, 0); assert.equal(fx.legacyClients.length, 1); assert.equal(fx.router.store.getTask(task.id).status, "done"); }
  finally { fx.router.close(); rmSync(root, { recursive: true, force: true }); }
});
