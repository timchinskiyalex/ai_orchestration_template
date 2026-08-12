import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";
import { fakeBlueprint } from "./product-blueprint-fixture.mjs";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { provider } from "./execution-provider-test-adapter.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

class LineageClient extends EventEmitter {
  constructor(plan, { contextualFanIn = false } = {}) { super(); this.plan = plan; this.contextualFanIn = contextualFanIn; this.next = 0; this.threads = new Map(); this.writerBases = new Map(); }
  async connect() {}
  shutdown() {}
  diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.next}`; this.threads.set(id, { cwd, goal: "", turn: null }); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; }
  async startTurn({ threadId }) { const thread = this.threads.get(threadId); thread.turn = `${threadId}-turn`; return { turn: { id: thread.turn } }; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (this.contextualFanIn && /^Write A\n\nWrite A$/.test(thread.goal)) { this.writerBases.set("writer-a", git(thread.cwd, ["rev-parse", "HEAD"])); writeFileSync(join(thread.cwd, "src", "a.mjs"), "export const a = true;\n"); }
    if (this.contextualFanIn && /^Write C\n\nWrite C$/.test(thread.goal)) { this.writerBases.set("writer-c", git(thread.cwd, ["rev-parse", "HEAD"])); writeFileSync(join(thread.cwd, "src", "context.mjs"), "export const context = 'created-by-c';\n"); }
    if (this.contextualFanIn && /^Write B\n\nWrite B$/.test(thread.goal)) { this.writerBases.set("writer-b", git(thread.cwd, ["rev-parse", "HEAD"])); writeFileSync(join(thread.cwd, "src", "context.mjs"), "export const context = 'modified-by-b';\n"); }
    if (!this.contextualFanIn && /^Write A\n\nWrite A$/.test(thread.goal)) { this.writerBases.set("writer-a", git(thread.cwd, ["rev-parse", "HEAD"])); writeFileSync(join(thread.cwd, "src", "a.mjs"), "export const a = true;\n"); }
    if (!this.contextualFanIn && /^Write C\n\nWrite C$/.test(thread.goal)) { this.writerBases.set("writer-c", git(thread.cwd, ["rev-parse", "HEAD"])); writeFileSync(join(thread.cwd, "src", "c.mjs"), "export const c = true;\n"); }
    if (!this.contextualFanIn && /^Write B\n\nWrite B$/.test(thread.goal)) { this.writerBases.set("writer-b", git(thread.cwd, ["rev-parse", "HEAD"])); writeFileSync(join(thread.cwd, "src", "b.mjs"), "export const b = true;\n"); }
    const generic = thread.goal.match(/^Write ([A-Z])\n\nWrite \1$/);
    if (generic && !["A", "B", "C"].includes(generic[1])) { const name = generic[1].toLowerCase(); this.writerBases.set(`writer-${name}`, git(thread.cwd, ["rev-parse", "HEAD"])); writeFileSync(join(thread.cwd, "src", `${name}.mjs`), `export const ${name} = true;\n`); }
    return { id: turnId, status: "completed" };
  }
  async readThread({ threadId }) {
    const goal = this.threads.get(threadId).goal;
    const text = /^Bootstrap/.test(goal)
      ? `\`\`\`json\n${JSON.stringify(fakeBlueprint(this.threads.get(threadId).cwd))}\n\`\`\``
      : /^Plan /.test(goal)
        ? `\`\`\`json\n${JSON.stringify(this.plan)}\n\`\`\``
        : /^Security review:/.test(goal) || /^QA:/.test(goal)
          ? "```json\n{\"verdict\":\"pass\",\"summary\":\"ok\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```"
          : "writer complete";
    const thread = this.threads.get(threadId); return { thread: { turns: [{ id: thread.turn, items: [{ type: "agentMessage", text }] }] } };
  }
}

const writer = (id, title, dependsOn = []) => ({ id, title, prompt: title, primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 20, dependsOn, allowedPaths: [`src/${id.replace("writer-", "")}.mjs`], acceptanceChecks: [], requirementIds: ["fix-value"] });
function config(root, client) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "backend" }]));
  return { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "lineage", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", productRoots: [] }, router: { maxConcurrentTasks: 1, maxChildrenPerTask: 10, maxDelegationDepth: 5, maxPlanTasks: 10, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, roles, executionProviderFactory: () => provider(client) };
}
function setup(client) {
  const root = mkdtempSync(join(tmpdir(), "planner-lineage-"));
  git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "docs", "orchestration-input"), { recursive: true }); const path = "requirements.md"; const file = { documentId: documentIdForPath(path), path, sha256: createHash("sha256").update("Fix value.\n").digest("hex") }; writeFileSync(join(root, "docs", "orchestration-input", path), "Fix value.\n"); writeFileSync(join(root, "docs", "orchestration-input", "inventory.json"), JSON.stringify({ files: [file], documentSetDigest: documentSetDigest([file]) })); writeFileSync(join(root, "src", "base.mjs"), "export const base = true;\n"); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: {} })); writeFileSync(join(root, "package-lock.json"), "{}"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]); return root;
}

test("planner writer edge propagates artifact worktree lineage and integration order", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), writer("writer-b", "Write B", ["writer-a"])] }; const client = new LineageClient(plan); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const a = router.list().find((task) => task.title === "Write A"); const b = router.list().find((task) => task.title === "Write B"); const aArtifact = router.store.workerArtifact(a.id); const bArtifact = router.store.workerArtifact(b.id); assert.ok(aArtifact && bArtifact, JSON.stringify(router.list().map((task) => ({ title: task.title, role: task.role, status: task.status, error: task.error }))));
    const lineage = JSON.stringify({ writerBase: client.writerBases.get("writer-b"), artifactBase: b.artifactBaseSha, artifactDependencies: b.artifactDependencies, a: aArtifact.headSha }); assert.equal(client.writerBases.get("writer-b"), aArtifact.headSha, lineage); assert.equal(b.artifactBaseSha, aArtifact.headSha, lineage); assert.deepEqual(b.artifactDependencies, [a.id]); assert.deepEqual(bArtifact.dependencies, [a.id]);
    const integration = await router.integrateFinalized([b.id, a.id]); assert.deepEqual(integration.manifest.appliedArtifacts, [a.id, b.id]);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("controller-owned barrier turns writer fan-in into a verified checkpoint baseline", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), writer("writer-c", "Write C"), writer("writer-b", "Write B", ["writer-a", "writer-c"])] }; const client = new LineageClient(plan); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const b = router.list().find((task) => task.title === "Write B"); const barrier = router.store.integrationBarrier(b.integrationBarrierId); const checkpoint = router.store.integrationCheckpoint(barrier.checkpointId); assert.equal(barrier.status, "passed"); assert.equal(checkpoint.status, "passed"); assert.equal(client.writerBases.get("writer-b"), checkpoint.outputSha); assert.equal(b.artifactBaseSha, checkpoint.outputSha);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("mixed logical and execution writer predecessors create one checkpoint barrier before the consumer runs", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), { ...writer("writer-c", "Write C"), allowedPaths: ["src"] }, { ...writer("writer-b", "Write B", ["writer-c"]), allowedPaths: ["src"] }] };
  const client = new LineageClient(plan, { contextualFanIn: true }); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const a = router.list().find((task) => task.title === "Write A"), c = router.list().find((task) => task.title === "Write C"), b = router.list().find((task) => task.title === "Write B");
    const barrier = router.store.integrationBarrier(b.integrationBarrierId), checkpoint = router.store.integrationCheckpoint(b.localCheckpointId);
    assert.deepEqual(b.dependencies.filter((id) => id !== b.parentTaskId), [c.id]); assert.deepEqual(b.executionDependencies, [a.id]);
    assert.equal(router.store.db.prepare("SELECT COUNT(*) AS count FROM integration_barriers").get().count, 1);
    assert.deepEqual(barrier.inputArtifacts.map((item) => item.artifactId), [c.id, a.id]); assert.equal(barrier.status, "passed"); assert.equal(client.writerBases.get("writer-b"), checkpoint.outputSha); assert.equal(b.artifactBaseSha, checkpoint.outputSha); assert.deepEqual(b.artifactDependencies, []);
    assert.equal((await router.runToIntegration({ alreadyIdle: true })).integration.manifest.status, "candidate_ready");
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("mixed-predecessor consumer resumes at its persisted barrier checkpoint boundary", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), { ...writer("writer-c", "Write C"), allowedPaths: ["src"] }, { ...writer("writer-b", "Write B", ["writer-c"]), allowedPaths: ["src"] }] };
  const paused = new LineageClient(plan, { contextualFanIn: true }); const root = setup(paused); let router;
  try {
    router = new SwarmRouter(config(root, paused)); await router.ensureProjectOverlay(); router.startProject();
    const claimNext = router.store.claimNext.bind(router.store); router.store.claimNext = () => router.store.listTasks().some((task) => task.title === "Write B" && task.status === "queued" && task.localCheckpointId) ? null : claimNext();
    await router.runUntilIdle();
    const b = router.list().find((task) => task.title === "Write B"), checkpoint = router.store.integrationCheckpoint(b.localCheckpointId); assert.equal(b.status, "queued"); assert.equal(b.artifactBaseSha, checkpoint.outputSha); router.close();
    const resumed = new LineageClient(plan, { contextualFanIn: true }); router = new SwarmRouter(config(root, resumed)); await router.runUntilIdle({ deliveryRunId: null });
    const resumedB = router.list().find((task) => task.title === "Write B"); assert.equal(resumed.writerBases.get("writer-b"), checkpoint.outputSha); assert.equal(resumedB.status, "done");
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("unreachable queued writer dependency returns a persisted bounded integrity-blocked deadlock", async () => {
  const client = new LineageClient({ blueprintId: "pb-test", tasks: [] }); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); const predecessor = router.enqueue({ role: "backend", title: "Historical writer", prompt: "Historical writer", allowedPaths: ["src"] }); const task = router.enqueue({ role: "backend", title: "Blocked writer", prompt: "Blocked writer", allowedPaths: ["src"], dependencies: [predecessor.id] }); router.store.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(predecessor.id); router.store.db.prepare("UPDATE tasks SET dependencies_json = ? WHERE id = ?").run(JSON.stringify(["missing-writer"]), task.id);
    const result = await router.runUntilIdle(); assert.equal(result.integrityBlocked, true); assert.equal(result.dependencyDeadlock.outcome, "dependency_deadlock"); assert.equal(result.dependencyDeadlock.classification, "integrity-blocked"); assert.deepEqual(result.dependencyDeadlock.taskIds, [task.id]); assert.deepEqual(result.dependencyDeadlock.reasons, [{ taskId: task.id, code: "missing_predecessor", predecessorId: "missing-writer" }]);
    const persisted = router.store.dependencyDeadlock(result.dependencyDeadlock.recordId); assert.deepEqual(persisted.outcome, { outcome: "dependency_deadlock", classification: "integrity-blocked", taskIds: [task.id], reasons: result.dependencyDeadlock.reasons });
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("local fan-in consumer reaches candidate_ready from its checkpoint lineage", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), writer("writer-c", "Write C"), writer("writer-b", "Write B", ["writer-a", "writer-c"])] }; const client = new LineageClient(plan); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const integration = await router.runToIntegration({ alreadyIdle: true });
    assert.equal(integration.integration.manifest.status, "candidate_ready");
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("checkpoint-derived lineage overrides adversarial caller order for a contextual local fan-in", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), { ...writer("writer-c", "Write C"), allowedPaths: ["src"] }, { ...writer("writer-b", "Write B", ["writer-a", "writer-c"]), allowedPaths: ["src"] }] };
  const client = new LineageClient(plan, { contextualFanIn: true }); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const a = router.list().find((task) => task.title === "Write A"), c = router.list().find((task) => task.title === "Write C"), b = router.list().find((task) => task.title === "Write B");
    const checkpoint = router.store.integrationCheckpoint(b.localCheckpointId);
    assert.equal(b.artifactBaseSha, checkpoint.outputSha); assert.deepEqual(b.artifactDependencies, []);
    const integration = await router.integrateFinalized([b.id, c.id, a.id]);
    assert.equal(integration.manifest.status, "candidate_ready");
    assert.deepEqual(integration.manifest.appliedArtifacts, [a.id, c.id, b.id]);
    assert.deepEqual(integration.manifest.effectiveLineage.map((item) => `${item.kind}:${item.id}`), [`artifact:${a.id}`, `artifact:${c.id}`, `checkpoint:${checkpoint.id}`, `artifact:${b.id}`]);
    assert.equal(git(integration.manifest.worktree, ["show", "HEAD:src/context.mjs"]), "export const context = 'modified-by-b';");
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("restart resumes a checkpoint consumer from its persisted exact checkpoint base", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), { ...writer("writer-c", "Write C"), allowedPaths: ["src"] }, { ...writer("writer-b", "Write B", ["writer-a", "writer-c"]), allowedPaths: ["src"] }] };
  const paused = new LineageClient(plan, { contextualFanIn: true }); const root = setup(paused); let router;
  try {
    router = new SwarmRouter(config(root, paused)); await router.ensureProjectOverlay(); router.startProject();
    const claimNext = router.store.claimNext.bind(router.store);
    router.store.claimNext = () => router.store.listTasks().some((task) => task.title === "Write B" && task.status === "queued" && task.localCheckpointId) ? null : claimNext();
    await router.runUntilIdle();
    const b = router.list().find((task) => task.title === "Write B"), checkpoint = router.store.integrationCheckpoint(b.localCheckpointId);
    assert.ok(checkpoint); assert.equal(b.status, "queued"); assert.equal(b.artifactBaseSha, checkpoint.outputSha); assert.deepEqual(b.artifactDependencies, []); assert.equal(router.store.workerArtifact(b.id), null); router.close();
    const resumed = new LineageClient(plan, { contextualFanIn: true }); router = new SwarmRouter(config(root, resumed)); await router.runUntilIdle({ deliveryRunId: null });
    const a = router.list().find((task) => task.title === "Write A"), c = router.list().find((task) => task.title === "Write C"), resumedB = router.list().find((task) => task.title === "Write B");
    const integration = await router.integrateFinalized([resumedB.id, c.id, a.id]);
    assert.equal(integration.manifest.status, "candidate_ready"); assert.deepEqual(integration.manifest.appliedArtifacts, [a.id, c.id, resumedB.id]);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("two independent local fan-ins in one wave reconcile without checkpoint collision", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), writer("writer-c", "Write C"), writer("writer-b", "Write B", ["writer-a", "writer-c"]), writer("writer-d", "Write D"), writer("writer-f", "Write F"), writer("writer-e", "Write E", ["writer-d", "writer-f"])] }; const client = new LineageClient(plan); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const locals = router.store.db.prepare("SELECT COUNT(*) AS count FROM integration_checkpoints WHERE checkpoint_type = 'LocalIntegrationCheckpoint'").get().count;
    assert.equal(locals, 2); assert.equal((await router.runToIntegration({ alreadyIdle: true })).integration.manifest.status, "candidate_ready");
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("nested fan-in resolves checkpoint ancestors exactly once", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), writer("writer-b", "Write B", ["writer-a"]), writer("writer-c", "Write C"), writer("writer-d", "Write D", ["writer-c"]), writer("writer-e", "Write E", ["writer-b", "writer-d"])] }; const client = new LineageClient(plan); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const integration = await router.runToIntegration({ alreadyIdle: true }); assert.equal(integration.integration.manifest.status, "candidate_ready");
    const artifacts = integration.integration.manifest.effectiveLineage.filter((item) => item.kind === "artifact").map((item) => item.id); assert.equal(new Set(artifacts).size, artifacts.length); assert.equal(artifacts.length, 5);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("a checkpoint can contribute to a later fan-in", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), writer("writer-c", "Write C"), writer("writer-b", "Write B", ["writer-a", "writer-c"]), writer("writer-d", "Write D"), writer("writer-e", "Write E", ["writer-b", "writer-d"])] }; const client = new LineageClient(plan); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    assert.equal((await router.runToIntegration({ alreadyIdle: true })).integration.manifest.status, "candidate_ready");
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("checkpoint proof tampering fails closed before a candidate is created", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), writer("writer-c", "Write C"), writer("writer-b", "Write B", ["writer-a", "writer-c"])] }; const client = new LineageClient(plan); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const b = router.list().find((task) => task.title === "Write B"), barrier = router.store.integrationBarrier(b.integrationBarrierId), checkpoint = router.store.integrationCheckpoint(barrier.checkpointId);
    const original = { output: checkpoint.outputSha, inputs: JSON.stringify(checkpoint.inputArtifacts), lineage: JSON.stringify(checkpoint.effectiveLineage), barrierCheckpoint: barrier.checkpointId };
    const mustReject = async () => { await assert.rejects(() => router.runToIntegration({ alreadyIdle: true }), /missing, legacy, invalid|incomplete local checkpoint lineage|mismatched barrier linkage|missing or tampered/); assert.equal(router.store.db.prepare("SELECT COUNT(*) AS count FROM integration_manifests").get().count, 0); };
    router.store.db.prepare("UPDATE integration_checkpoints SET output_sha = ? WHERE id = ?").run("a".repeat(40), checkpoint.id); await mustReject(); router.store.db.prepare("UPDATE integration_checkpoints SET output_sha = ? WHERE id = ?").run(original.output, checkpoint.id);
    router.store.db.prepare("UPDATE integration_checkpoints SET input_artifacts_json = ? WHERE id = ?").run(JSON.stringify([{ artifactId: "missing", headSha: "a".repeat(40) }]), checkpoint.id); await mustReject(); router.store.db.prepare("UPDATE integration_checkpoints SET input_artifacts_json = ? WHERE id = ?").run(original.inputs, checkpoint.id);
    router.store.db.prepare("UPDATE integration_checkpoints SET effective_lineage_json = ? WHERE id = ?").run(JSON.stringify([{ kind: "artifact", id: "duplicate", sha: "a".repeat(40) }, { kind: "artifact", id: "duplicate", sha: "a".repeat(40) }]), checkpoint.id); await mustReject(); router.store.db.prepare("UPDATE integration_checkpoints SET effective_lineage_json = ? WHERE id = ?").run(original.lineage, checkpoint.id);
    router.store.db.prepare("UPDATE integration_barriers SET checkpoint_id = ? WHERE id = ?").run("missing-checkpoint", barrier.id); await mustReject(); router.store.db.prepare("UPDATE integration_barriers SET checkpoint_id = ? WHERE id = ?").run(original.barrierCheckpoint, barrier.id);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
test("final manifest lineage is deterministic across repeated integration and restart", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), writer("writer-c", "Write C"), writer("writer-b", "Write B", ["writer-a", "writer-c"])] }; const client = new LineageClient(plan); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const first = await router.runToIntegration({ alreadyIdle: true }); router.close(); router = new SwarmRouter(config(root, client));
    const second = await router.runToIntegration({ alreadyIdle: true });
    assert.equal(first.integration.manifest.status, "candidate_ready"); assert.equal(second.integration.manifest.status, "candidate_ready"); assert.deepEqual(second.integration.manifest.effectiveLineage, first.integration.manifest.effectiveLineage);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
