import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";
import { provider } from "./execution-provider-test-adapter.mjs";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { sourceFragmentDigest } from "../src/source-evidence.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

function blueprint(root) {
  const path = "requirements.md"; const sourceText = "Scoped recovery A.\nScoped recovery B.\nScoped recovery C.\n";
  const source = { documentId: documentIdForPath(path), path, sha256: digest(sourceText) };
  const requirement = (id, line) => ({ requirementId: id, type: "functional", priority: "must", mandatory: true, description: id, sourceClaimIds: [`scoped-recovery-claim-${line}`], sourceRefs: [{ documentId: source.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(sourceText, line, line) }], acceptanceCriteria: [{ criterionId: `${id}-check`, description: `${id} works`, verificationHint: "npm test" }], constraints: [] });
  return { schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "pb-scoped", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest([source]), sourceDocuments: [source], requirements: [requirement("req-a", 1), requirement("req-b", 2), requirement("req-c", 3)], nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: [], contradictions: [] };
}

const task = (id, title, requirementIds, dependsOn = []) => ({ id, title, prompt: title, primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 20, dependsOn, allowedPaths: [`src/${id}.mjs`], acceptanceChecks: [], requirementIds });
const initialPlan = () => ({ blueprintId: "pb-scoped", tasks: [task("writer-a", "Write A", ["req-a"]), task("writer-b", "Write B", ["req-b"], ["writer-a"]), task("writer-c", "Write C", ["req-c"], ["writer-a", "writer-b"])] });
const recoveryPlan = () => ({ blueprintId: "pb-scoped", tasks: [task("recover-b", "Recover B", ["req-b"]), task("recover-c", "Recover C", ["req-c"], ["recover-b"])] });

class ScopedRecoveryClient extends EventEmitter {
  constructor({ specificationGap = false } = {}) { super(); this.sequence = 0; this.threads = new Map(); this.goals = []; this.plannerReads = 0; this.specificationGap = specificationGap; }
  async connect() {}
  shutdown() {}
  diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.sequence}`; this.threads.set(id, { cwd, goal: "", turn: null }); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.goals.push(objective); this.threads.get(threadId).goal = objective; }
  async startTurn({ threadId }) { const thread = this.threads.get(threadId); thread.turn = `${threadId}-turn`; return { turn: { id: thread.turn } }; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (/^Write B\n\nWrite B$/.test(thread.goal)) return { id: turnId, status: "failed", error: { message: "implementation failure: deterministic B" } };
    if (/^Scoped recovery plan /.test(thread.goal) && !this.specificationGap) await new Promise((resolve) => setTimeout(resolve, 750));
    if (/^(Write A|Recover B|Recover C)\n\n/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", `${/^Write A/.test(thread.goal) ? "writer-a" : /^Recover B/.test(thread.goal) ? "recover-b" : "recover-c"}.mjs`), "export const recovered = true;\n");
    return { id: turnId, status: "completed" };
  }
  async readThread({ threadId }) {
    const thread = this.threads.get(threadId);
    let text = "worker complete";
    if (/^Bootstrap/.test(thread.goal)) text = `\`\`\`json\n${JSON.stringify(blueprint(thread.cwd))}\n\`\`\``;
    else if (/^Plan /.test(thread.goal)) { this.plannerReads += 1; text = `\`\`\`json\n${JSON.stringify(initialPlan())}\n\`\`\``; }
    else if (/^Scoped recovery plan /.test(thread.goal)) {
      this.plannerReads += 1;
      text = this.specificationGap
        ? "```json\n{\"outcome\":\"specification_gap\",\"reason\":\"missing immutable source fact\"}\n```"
        : `\`\`\`json\n${JSON.stringify(recoveryPlan())}\n\`\`\``;
    } else if (/^(Security review:|QA:)/.test(thread.goal)) text = "```json\n{\"verdict\":\"pass\",\"summary\":\"verified\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```";
    return { thread: { turns: [{ id: thread.turn, items: [{ type: "agentMessage", text }] }] } };
  }
}

function setup(client) {
  const root = mkdtempSync(join(tmpdir(), "scoped-replan-"));
  git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "docs", "orchestration-input"), { recursive: true });
  const source = { documentId: documentIdForPath("requirements.md"), path: "requirements.md", sha256: digest("Scoped recovery A.\nScoped recovery B.\nScoped recovery C.\n") };
  const sourceText = "Scoped recovery A.\nScoped recovery B.\nScoped recovery C.\n";
  writeFileSync(join(root, "docs", "orchestration-input", "requirements.md"), sourceText);
  writeFileSync(join(root, "docs", "orchestration-input", "inventory.json"), JSON.stringify({ files: [source], documentSetDigest: documentSetDigest([source]) }));
  const sourceRefs = [1, 2, 3].map((line) => ({ documentId: source.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(sourceText, line, line) }));
  writeFileSync(join(root, "docs", "orchestration-input", "source-claims.json"), JSON.stringify({ schemaVersion: 1, kind: "SourceClaimsDeclaration", documentSetDigest: documentSetDigest([source]), documents: [{ ...source, coverage: sourceRefs.map((sourceRef, index) => ({ claimId: `scoped-recovery-claim-${index + 1}`, ...sourceRef })) }], claims: sourceRefs.map((sourceRef, index) => ({ claimId: `scoped-recovery-claim-${index + 1}`, classification: "mandatory", sourceRefs: [sourceRef] })) }));
  writeFileSync(join(root, "src", "base.mjs"), "export const base = true;\n"); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: {} })); writeFileSync(join(root, "package-lock.json"), "{}");
  git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "backend" }]));
  const config = { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "scoped", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", productRoots: [] }, router: { maxConcurrentTasks: 1, maxChildrenPerTask: 30, maxDelegationDepth: 6, maxPlanTasks: 8, defaultParentBudget: 10_000, turnTimeoutMs: 1_000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true }, budget: { weeklyTokenLimit: 10_000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxScopedReplanAttempts: 2 }, roles, executionProviderFactory: () => provider(client) };
  return { root, router: new SwarmRouter(config) };
}

test("scoped implementation recovery preserves upstream evidence, materializes one replacement wave, and stays idempotent", async () => {
  const client = new ScopedRecoveryClient(); const { root, router } = setup(client);
  try {
    await router.ensureProjectOverlay(); const bootstrap = router.startProject(); const run = router.createDeliveryRun({ id: "run-scoped", bootstrapTaskId: bootstrap.id, sourceClaimManifestId: router.sourceClaimManifestIdentity() }); router.store.linkTaskToDelivery(bootstrap.id, run.id);
    const execution = router.runUntilIdle();
    await waitFor(() => router.store.activeScopedReplans(run.id).length === 1, "active scoped replan planner");
    const [replan] = router.store.scopedReplans(run.id); const tasks = router.list(); const a = tasks.find((item) => item.title === "Write A"); const b = tasks.find((item) => item.title === "Write B"); const c = tasks.find((item) => item.title === "Write C");
    const aArtifact = router.store.workerArtifact(a.id); const traceability = router.store.traceabilityForRequirement("req-a");
    assert.equal(replan.failureKind, "worker_failure"); assert.deepEqual(replan.preservedArtifacts, [{ taskId: a.id, headSha: aArtifact.headSha, baseSha: aArtifact.baseSha }]); assert.ok(traceability.some((item) => item.taskId === a.id && item.checkpoint === "artifact"));
    assert.equal(a.status, "done"); assert.equal(b.status, "failed"); assert.equal(c.status, "cancelled"); assert.match(c.integrationBarrierId, /^pending:/); assert.equal(router.store.workerArtifact(a.id).headSha, aArtifact.headSha);
    assert.deepEqual(replan.remainingRequirementIds.sort(), ["req-b", "req-c"]); assert.match(client.goals.find((goal) => /^Scoped recovery plan /.test(goal)), /"remainingRequirementIds":\["req-b","req-c"\]/); assert.equal(client.goals.find((goal) => /^Scoped recovery plan /.test(goal)).includes("req-a"), false);
    await assert.rejects(router.runToIntegration({ alreadyIdle: true, deliveryRunId: run.id }), /scoped replan recovery is active/);
    router.store.updateDeliveryRun(run.id, { state: "failed" }); router.resumeDeliveryRun(run.id);
    const activeCount = router.store.scopedReplans(run.id).length; await execution;
    const materialized = router.store.scopedReplans(run.id)[0]; assert.deepEqual(router.store.completeReadyScopedReplans(run.id), [materialized.id]); const completed = router.store.scopedReplans(run.id)[0]; const replacement = router.store.planBatch(completed.replacementPlanBatchId); const mappings = router.store.db.prepare("SELECT old_task_id AS oldTaskId, replacement_task_id AS replacementTaskId, kind FROM task_replacements WHERE replan_id = ? ORDER BY old_task_id").all(completed.id);
    assert.equal(completed.status, "completed"); assert.equal(activeCount, 1); assert.equal(replacement.wave, 2); assert.equal(replacement.basedOnCheckpointSha, git(root, ["rev-parse", "main"])); assert.ok(mappings.find((item) => item.oldTaskId === b.id && item.replacementTaskId && item.kind === "task")); assert.ok(mappings.find((item) => item.oldTaskId === c.id && item.replacementTaskId && item.kind === "barrier-consumer"));
    const counts = { replans: router.store.scopedReplans(run.id).length, batches: router.store.planBatches(run.id).length, replacementTasks: router.list().filter((item) => item.planBatchId === replacement.id).length, barriers: router.store.db.prepare("SELECT COUNT(*) AS count FROM integration_barriers WHERE delivery_run_id = ?").get(run.id).count };
    router.store.updateDeliveryRun(run.id, { state: "interrupted" }); router.resumeDeliveryRun(run.id); await router.runUntilIdle();
    assert.deepEqual({ replans: router.store.scopedReplans(run.id).length, batches: router.store.planBatches(run.id).length, replacementTasks: router.list().filter((item) => item.planBatchId === replacement.id).length, barriers: router.store.db.prepare("SELECT COUNT(*) AS count FROM integration_barriers WHERE delivery_run_id = ?").get(run.id).count }, counts);
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("scoped planner specification_gap blocks the replan without an unsafe automatic replacement", async () => {
  const client = new ScopedRecoveryClient({ specificationGap: true }); const { root, router } = setup(client);
  try {
    await router.ensureProjectOverlay(); const bootstrap = router.startProject(); const run = router.createDeliveryRun({ id: "run-spec-gap", bootstrapTaskId: bootstrap.id, sourceClaimManifestId: router.sourceClaimManifestIdentity() }); router.store.linkTaskToDelivery(bootstrap.id, run.id);
    await router.runUntilIdle();
    const [replan] = router.store.scopedReplans(run.id); const planner = router.store.getTask(replan.plannerTaskId);
    assert.equal(replan.failureKind, "worker_failure"); assert.equal(replan.status, "blocked_specification"); assert.equal(planner.status, "blocked_specification"); assert.match(planner.error, /specification_gap/); assert.equal(replan.replacementPlanBatchId, null); assert.equal(router.store.planBatches(run.id).length, 1); assert.equal(router.store.deliveryRun(run.id).state, "blocked_specification");
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});
