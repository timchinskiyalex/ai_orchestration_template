import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { SwarmRouter } from "../src/router.mjs";
import { fakeBlueprint, fakePlan } from "./product-blueprint-fixture.mjs";
import { createHash } from "node:crypto";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { sourceFragmentDigest } from "../src/source-evidence.mjs";
import { provider } from "./execution-provider-test-adapter.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
class DeliveryClient extends EventEmitter {
  constructor() { super(); this.id = 0; this.threads = new Map(); this.goals = []; }
  async connect() {} shutdown() {} diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.id}`; this.threads.set(id, { cwd, goal: "", turns: 0, turnId: null }); return { thread: { id } }; }
  async setGoal(goal) { this.goals.push(goal); this.threads.get(goal.threadId).goal = goal.objective; }
  async startTurn({ threadId }) { const thread = this.threads.get(threadId); thread.turnId = `turn-${threadId}-${++thread.turns}`; return { turn: { id: thread.turnId } }; }
  async waitForTurn(threadId, turnId) { const thread = this.threads.get(threadId); if (/Writer/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "value.mjs"), "export const value = 2;\n"); return { id: turnId, status: "completed" }; }
  async readThread({ threadId }) { const thread = this.threads.get(threadId); const text = /^Bootstrap/.test(thread.goal) ? `\`\`\`json\n${JSON.stringify(fakeBlueprint(thread.cwd))}\n\`\`\`` : /^Plan /.test(thread.goal) ? `\`\`\`json\n${JSON.stringify(fakePlan())}\n\`\`\`` : /^Security review:/.test(thread.goal) ? "```json\n{\"verdict\":\"pass\",\"summary\":\"secure\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```" : /^QA:/.test(thread.goal) ? "```json\n{\"verdict\":\"pass\",\"summary\":\"quality verified\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```" : "writer complete"; return { thread: { turns: [{ id: thread.turnId, status: "completed", items: [{ type: "agentMessage", text }] }] } }; }
}
class CorrectingPlannerClient extends DeliveryClient {
  constructor() { super(); this.plannerReads = 0; }
  async readThread({ threadId }) {
    const thread = this.threads.get(threadId);
    if (/^Plan /.test(thread.goal)) {
      this.plannerReads += 1;
      const text = this.plannerReads === 1
        ? "```json\n{\"tasks\":[{\"id\":\"writer\",\"title\":\"Writer\",\"prompt\":\"Writer\",\"primaryDomain\":\"backend\",\"supportingDomains\":[],\"riskFlags\":[\"invented_flag\"],\"humanApprovalRequired\":false,\"estimatedTokens\":20,\"dependsOn\":[],\"allowedPaths\":[\"src/value.mjs\"],\"acceptanceChecks\":[\"npm test\"]}]}\n```"
        : `\`\`\`json\n${JSON.stringify(fakePlan())}\n\`\`\``;
      return { thread: { turns: [{ id: thread.turnId, status: "completed", items: [{ type: "agentMessage", text }] }] } };
    }
    return super.readThread({ threadId });
  }
}
class RepairingWriterClient extends DeliveryClient {
  constructor() { super(); this.writerTurns = 0; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (/^Writer/.test(thread.goal)) {
      this.writerTurns += 1;
      writeFileSync(join(thread.cwd, "src", "value.mjs"), `export const value = ${this.writerTurns === 1 ? 1 : 2};\n`);
    }
    return { id: turnId, status: "completed" };
  }
}
class SourceBlockedClient extends DeliveryClient {
  async readThread({ threadId }) {
    const thread = this.threads.get(threadId);
    if (/^Bootstrap/.test(thread.goal)) {
      const blueprint = fakeBlueprint(thread.cwd, { question: { questionId: "missing-source-fact", description: "A source fact is missing.", requiredForRequirementIds: ["fix-value"], status: "unresolved" } });
      return { thread: { turns: [{ id: thread.turnId, status: "completed", items: [{ type: "agentMessage", text: `\`\`\`json\n${JSON.stringify(blueprint)}\n\`\`\`` }] }] } };
    }
    return super.readThread({ threadId });
  }
}
class SelfAuthorizedPolicyClient extends DeliveryClient {
  constructor() { super(); this.plannerReads = 0; }
  async readThread({ threadId }) {
    const thread = this.threads.get(threadId);
    if (/^Bootstrap/.test(thread.goal)) {
      const blueprint = fakeBlueprint(thread.cwd, { question: { questionId: "claimed-policy", description: "A required source fact is missing.", requiredForRequirementIds: ["fix-value"], status: "resolved_by_policy", policyDefault: "untrusted", resolution: "untrusted" } });
      return { thread: { turns: [{ id: thread.turnId, status: "completed", items: [{ type: "agentMessage", text: `\`\`\`json\n${JSON.stringify(blueprint)}\n\`\`\`` }] }] } };
    }
    if (/^Plan /.test(thread.goal)) this.plannerReads += 1;
    return super.readThread({ threadId });
  }
}
class LegacySourceRefClient extends DeliveryClient {
  async readThread({ threadId }) {
    const thread = this.threads.get(threadId);
    if (/^Bootstrap/.test(thread.goal)) {
      const blueprint = fakeBlueprint(thread.cwd); blueprint.requirements[0].sourceRefs = [{ documentId: blueprint.sourceDocuments[0].documentId, locator: "# Requirement", excerptDigest: "a".repeat(64) }];
      return { thread: { turns: [{ id: thread.turnId, status: "completed", items: [{ type: "agentMessage", text: `\`\`\`json\n${JSON.stringify(blueprint)}\n\`\`\`` }] }] } };
    }
    return super.readThread({ threadId });
  }
}
function setup(remote = true) {
  const root = mkdtempSync(join(tmpdir(), "delivery-coordinator-")); git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "test")); const source = join(root, "requirements"); mkdirSync(source); const text = "# Requirement\nFix value.\n"; const file = { documentId: documentIdForPath("requirements.md"), path: "requirements.md", sha256: createHash("sha256").update(text).digest("hex") }; const ref = (line) => ({ documentId: file.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(text, line, line) }); writeFileSync(join(source, "requirements.md"), text); writeFileSync(join(source, "source-claims.json"), JSON.stringify({ schemaVersion: 1, kind: "SourceClaimsDeclaration", documentSetDigest: documentSetDigest([file]), documents: [{ ...file, coverage: [{ claimId: "fix-value-claim", ...ref(1) }, { claimId: "context-claim", ...ref(2) }] }], claims: [{ claimId: "fix-value-claim", classification: "mandatory", sourceRefs: [ref(1)] }, { claimId: "context-claim", classification: "non_mandatory", sourceRefs: [ref(2)] }] })); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n"); writeFileSync(join(root, "test", "value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value',()=>assert.equal(value,2));\n"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 200, usesWorktree: role === "backend" }]));
  const config = { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" }, router: { maxConcurrentTasks: 10, maxChildrenPerTask: 20, maxDelegationDepth: 5, maxPlanTasks: 12, defaultParentBudget: 10000, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 3 }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 3 }, remote: { enabled: remote, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: true, mergeMethod: "merge" }, roles, executionProviderFactory: () => provider(new DeliveryClient()) };
  return { root, source, config };
}

const criterionEvidence = (candidate, results = [{ requirementId: "fix-value", criterionId: "value-test", status: "pass", testId: "e2e/value-test", reference: "deterministic-product-check" }]) => ({ candidateSha: candidate.sha, results: results.map((result) => ({ ...result, candidateSha: result.candidateSha ?? candidate.sha })) });

function fakeRemote(calls, product = null) {
  return {
    remoteGitAdapter: { async pushCandidate({ sha }) { calls.push += 1; return { status: "pushed", verifiedSha: sha }; } },
    pullRequestAdapter: { async ensurePullRequest({ sha }) { calls.pr += 1; return { status: "open", number: 1, url: "https://example.test/pr/1", headSha: sha }; } },
    remoteCiAdapter: { async waitForChecks() { calls.ci += 1; return { status: "passed", checkRuns: [{ name: "test", status: "completed", conclusion: "success" }] }; } },
    productEvidenceAdapter: { async verify({ candidate }) { return typeof product === "function" ? product(candidate) : product ?? criterionEvidence(candidate); } },
    mergeAdapter: { async merge() { calls.merge += 1; return { status: "merged", mainSha: "b".repeat(40), mergeSha: "b".repeat(40), targetVerified: true }; } }
  };
}

test("autonomous Bootstrap, Planner, DAG, gates, candidate publication, and merge complete without a human gate", async () => {
  const fixture = setup(); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const final = await coordinator.begin({ source: fixture.source, ...fakeRemote(calls) });
    assert.equal(final.state, "completed_merged"); assert.ok(final.integrationPath); assert.equal(router.statusSnapshot().securityReports[0].verdict, "pass"); assert.equal(router.statusSnapshot().qualityReports[0].verdict, "pass"); assert.deepEqual(calls, { push: 1, pr: 1, ci: 1, merge: 1 });
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});
test("completed autonomous delivery is restart-idempotent", async () => {
  const fixture = setup(true); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const ready = await coordinator.begin({ source: fixture.source, ...fakeRemote(calls) }); assert.equal(ready.state, "completed_merged");
    const restarted = await coordinator.resume(fakeRemote(calls)); assert.equal(restarted.state, "completed_merged"); assert.deepEqual(calls, { push: 1, pr: 1, ci: 1, merge: 1 });
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("interrupted legacy Bootstrap without a manifest is blocked before an App Server turn and remains blocked after restart", async () => {
  const fixture = setup(); const client = new DeliveryClient(); fixture.config.executionProviderFactory = () => provider(client); let router = new SwarmRouter(fixture.config);
  try {
    const bootstrap = router.enqueue({ role: "bootstrap", title: "Legacy Bootstrap", prompt: "legacy", estimatedTokens: 20 });
    const run = router.createDeliveryRun({ id: "legacy-bootstrap", source: "legacy", bootstrapTaskId: bootstrap.id }); router.store.linkTaskToDelivery(bootstrap.id, run.id);
    router.store.transition(bootstrap.id, "interrupted", { error: "legacy interruption" }); router.store.interruptDeliveryRun(run.id, { reason: "legacy interruption" });
    const blocked = await new DeliveryCoordinator(router).resume();
    assert.equal(blocked.state, "blocked_specification"); assert.equal(router.store.getTask(bootstrap.id).status, "blocked_specification"); assert.equal(blocked.publish.reason, "source_claim_contract:persisted_run_manifest_missing"); assert.deepEqual(client.goals, []);
    router.close(); router = new SwarmRouter(fixture.config);
    const restarted = await new DeliveryCoordinator(router).resume();
    assert.equal(restarted.state, "blocked_specification"); assert.equal(restarted.publish.reason, "source_claim_contract:persisted_run_manifest_missing"); assert.deepEqual(client.goals, []);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("legacy Blueprint and scoped replan without a manifest cannot start Planner work or materialize a replacement", async () => {
  const fixture = setup(); const client = new DeliveryClient(); fixture.config.executionProviderFactory = () => provider(client); const router = new SwarmRouter(fixture.config);
  try {
    const run = router.createDeliveryRun({ id: "legacy-planner", bootstrapTaskId: null });
    const blueprint = { schemaVersion: 1, blueprintId: "legacy-blueprint", documentSetDigest: "d".repeat(64), requirements: [{ requirementId: "legacy-requirement" }] };
    router.store.recordProductBlueprint({ blueprint, artifactPath: "docs/orchestration-generated/legacy.json", digest: "e".repeat(64), deliveryRunId: run.id }); router.store.linkBlueprintToDelivery(run.id, blueprint.blueprintId);
    const planner = router.enqueue({ role: "planner", title: "Legacy Planner", prompt: "legacy", estimatedTokens: 20, blueprintId: blueprint.blueprintId, requirementIds: [], deliveryRunId: run.id });
    router.store.recordScopedReplan({ id: "legacy-replan", idempotencyKey: "legacy-replan", deliveryRunId: run.id, blueprintId: blueprint.blueprintId, failedTaskId: planner.id, failureKind: "worker_failure", failureDetail: "legacy", affectedTaskIds: [planner.id], invalidatedTaskIds: [], remainingRequirementIds: ["legacy-requirement"] });
    const execution = await router.runUntilIdle({ deliveryRunId: run.id });
    assert.equal(execution.sourceBlocked, true); assert.equal(router.store.getTask(planner.id).status, "blocked_specification"); assert.equal(router.store.scopedReplan("legacy-replan").status, "blocked_specification"); assert.equal(router.store.scopedReplan("legacy-replan").plannerTaskId, null); assert.equal(router.store.planBatches(run.id).length, 0); assert.deepEqual(client.goals, []);
    const status = router.store.deliveryRun(run.id); assert.equal(status.publish.reason, "source_claim_contract:persisted_run_manifest_missing"); assert.deepEqual(status.publish.codes, ["source_claim_contract:persisted_run_manifest_missing"]);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("production manifest-backed product evidence is wired automatically and gates publication", async () => {
  const fixture = setup(true); const executed = []; fixture.config.processRunner = async (command) => { executed.push(command); return { pid: 91, stdout: "bounded output SECRET_SHOULD_NOT_PERSIST", stderr: "" }; }; const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const adapters = fakeRemote(calls); delete adapters.productEvidenceAdapter;
    const final = await coordinator.begin({ source: fixture.source, ...adapters });
    assert.equal(final.state, "completed_merged"); assert.deepEqual(calls, { push: 1, pr: 1, ci: 1, merge: 1 }); assert.ok(executed.length >= 3);
    const report = router.store.productAcceptanceForRun(final.id);
    assert.equal(report.passing, true); assert.equal(report.report.evidence.productE2e.status, "pass");
    const persisted = router.store.db.prepare("SELECT execution_json FROM product_evidence_executions").get();
    assert.ok(persisted); assert.doesNotMatch(persisted.execution_json, /SECRET_SHOULD_NOT_PERSIST/); assert.match(persisted.execution_json, /outputDigest/);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("missing product VerificationManifest blocks before any remote publication", async () => {
  const fixture = setup(true); const executed = []; let removed = false; fixture.config.processRunner = async (command) => { executed.push(command); if (!removed && String(command.cwd).replace(/\\/g, "/").includes("/integrations/")) { const path = join(fixture.root, "docs", "orchestration-generated", "project-overlay.v1.json"); const overlay = JSON.parse(readFileSync(path, "utf8")); overlay.verificationCommands = []; writeFileSync(path, JSON.stringify(overlay)); removed = true; } return { pid: 1, stdout: "", stderr: "" }; }; const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const adapters = fakeRemote(calls); delete adapters.productEvidenceAdapter;
    const final = await coordinator.begin({ source: fixture.source, ...adapters });
    assert.equal(final.state, "blocked_acceptance"); assert.deepEqual(calls, { push: 0, pr: 0, ci: 0, merge: 0 }); assert.equal(executed.filter((command) => String(command.cwd).replace(/\\/g, "/").includes("/integrations/")).length, 1, "only integration verification ran; product command did not");
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("failed production verification blocks before publication", async () => {
  const fixture = setup(true); let count = 0; let candidateCommands = 0; fixture.config.processRunner = async (command) => { count += 1; if (String(command.cwd).replace(/\\/g, "/").includes("/integrations/")) { candidateCommands += 1; if (candidateCommands >= 2) throw Object.assign(new Error("failed product command"), { code: 1, stdout: "secret", stderr: "failure" }); } return { pid: 1, stdout: "ok", stderr: "" }; }; const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const adapters = fakeRemote(calls); delete adapters.productEvidenceAdapter;
    const final = await coordinator.begin({ source: fixture.source, ...adapters });
    assert.equal(final.state, "blocked_acceptance"); assert.deepEqual(calls, { push: 0, pr: 0, ci: 0, merge: 0 }); assert.ok(count >= 2); assert.equal(candidateCommands, 2);
    const record = router.store.db.prepare("SELECT execution_json FROM product_evidence_executions").get(); assert.match(record.execution_json, /\"result\":\"failed\"/); assert.doesNotMatch(record.execution_json, /secret/);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("production evidence reuse is restart-safe only for the exact immutable candidate identity", async () => {
  const fixture = setup(true); let executions = 0; fixture.config.processRunner = async () => { executions += 1; return { pid: 1, stdout: "ok", stderr: "" }; }; const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const adapters = fakeRemote(calls); delete adapters.productEvidenceAdapter;
    const final = await coordinator.begin({ source: fixture.source, ...adapters }); assert.equal(final.state, "completed_merged");
    const integration = router.store.integrationManifest(final.integrationPath); const candidate = { branch: integration.branch, sha: integration.candidateSha };
    const beforeReuse = executions;
    const reused = await coordinator.productEvidenceExecutor.verify({ candidate, manifest: integration, deliveryRunId: final.id });
    assert.equal(reused.results[0].status, "pass"); assert.equal(executions, beforeReuse, "exact persisted proof is reused without another command");
    const stale = await coordinator.productEvidenceExecutor.verify({ candidate: { ...candidate, sha: "c".repeat(40) }, manifest: integration, deliveryRunId: final.id });
    assert.deepEqual(stale.results, []); assert.equal(executions, beforeReuse, "a stale candidate cannot reuse proof or run a command");
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a global product pass without criterion results closes no mandatory criterion", async () => {
  const fixture = setup(true); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const final = await coordinator.begin({ source: fixture.source, ...fakeRemote(calls, (candidate) => ({ status: "pass", candidateSha: candidate.sha, reference: "global-pass-only" })) });
    const acceptance = router.store.productAcceptanceForRun(final.id);
    assert.equal(final.state, "blocked_acceptance"); assert.equal(calls.merge, 0);
    assert.equal(acceptance.report.results.find((result) => result.criterionId === "value-test").status, "not_verified");
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("missing, wrong-SHA, malformed, or failed criterion evidence blocks publication", async () => {
  const cases = [
    ["missing", (candidate) => ({ candidateSha: candidate.sha, results: [] })],
    ["other SHA", (candidate) => criterionEvidence({ ...candidate, sha: "c".repeat(40) })],
    ["unknown criterion", (candidate) => criterionEvidence(candidate, [{ requirementId: "unknown", criterionId: "value-test", status: "pass", testId: "e2e/unknown", reference: "unknown" }])],
    ["duplicate criterion", (candidate) => criterionEvidence(candidate, [{ requirementId: "fix-value", criterionId: "value-test", status: "pass", testId: "e2e/value-test", reference: "one" }, { requirementId: "fix-value", criterionId: "value-test", status: "pass", testId: "e2e/value-test-repeat", reference: "two" }])],
    ["failed criterion masked by global pass", (candidate) => ({ status: "pass", ...criterionEvidence(candidate, [{ requirementId: "fix-value", criterionId: "value-test", status: "failed", testId: "e2e/value-test", reference: "failed-test" }]) })]
  ];
  for (const [label, product] of cases) {
    const fixture = setup(true); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
    try {
      const final = await coordinator.begin({ source: fixture.source, ...fakeRemote(calls, product) });
      const acceptance = router.store.productAcceptanceForRun(final.id);
      assert.equal(final.state, "blocked_acceptance", label); assert.deepEqual(calls, { push: 0, pr: 0, ci: 0, merge: 0 }, label); assert.equal(acceptance.passing, false, label);
    } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("restart idempotency cannot replace an incomplete acceptance report with a merge", async () => {
  const fixture = setup(true); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const incomplete = await coordinator.begin({ source: fixture.source, ...fakeRemote(calls, (candidate) => ({ candidateSha: candidate.sha, results: [] })) });
    assert.equal(incomplete.state, "blocked_acceptance");
    const resumed = await coordinator.resume(fakeRemote(calls));
    assert.equal(resumed.state, "blocked_acceptance"); assert.equal(calls.merge, 0);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("only a persisted source-specification blocker yields blocked_specification", async () => {
  const fixture = setup(true); fixture.config.executionProviderFactory = () => provider(new SourceBlockedClient()); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const final = await coordinator.begin({ source: fixture.source, ...fakeRemote(calls) });
    assert.equal(final.state, "blocked_specification"); assert.deepEqual(calls, { push: 0, pr: 0, ci: 0, merge: 0 });
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("unsupported Bootstrap policy claims block autonomous delivery before Planner", async () => {
  const fixture = setup(true); const client = new SelfAuthorizedPolicyClient(); fixture.config.executionProviderFactory = () => provider(client); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router);
  try {
    const final = await coordinator.begin({ source: fixture.source, ...fakeRemote({ push: 0, pr: 0, ci: 0, merge: 0 }) }); const bootstrap = router.list().find((task) => task.role === "bootstrap");
    assert.equal(final.state, "blocked_specification"); assert.equal(bootstrap.status, "blocked_specification"); assert.match(bootstrap.error, /missing_mandatory_fact:claimed-policy/); assert.equal(client.plannerReads, 0); assert.equal(router.list().some((task) => task.role === "planner"), false);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("legacy SourceRef fails closed as blocked_specification before autonomous planning", async () => {
  const fixture = setup(); fixture.config.executionProviderFactory = () => provider(new LegacySourceRefClient()); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router);
  try {
    const final = await coordinator.begin({ source: fixture.source, ...fakeRemote({ push: 0, pr: 0, ci: 0, merge: 0 }) });
    const bootstrap = router.list().find((task) => task.role === "bootstrap");
    assert.equal(final.state, "blocked_specification"); assert.equal(bootstrap.status, "blocked_specification"); assert.match(bootstrap.error, /source_provenance/); assert.equal(router.list().some((task) => task.role === "planner"), false);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("persisted candidate resumes CI blockers and interruptions without a new intake, Bootstrap, or DAG", async () => {
  const fixture = setup(true); const client = new DeliveryClient(); fixture.config.executionProviderFactory = () => provider(client);
  const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const blockedAdapters = { ...fakeRemote(calls), remoteCiAdapter: { async waitForChecks() { calls.ci += 1; return { status: "timed_out", reason: "required build pending" }; } } };
    const blocked = await coordinator.begin({ source: fixture.source, ...blockedAdapters });
    assert.equal(blocked.state, "blocked_ci"); assert.ok(blocked.integrationPath); assert.equal(blocked.candidate.sha.length, 40);
    assert.equal(router.store.deliveryRun(blocked.id).publicationCheckpoint.stage, "ci");
    const beforeResumeGoals = client.goals.length;
    const resumed = await coordinator.resume(fakeRemote(calls));
    assert.equal(resumed.state, "completed_merged"); assert.equal(client.goals.length, beforeResumeGoals); assert.equal(router.list().filter((task) => task.role === "bootstrap").length, 1);
    router.store.interruptDeliveryRun(resumed.id, { reason: "test restart after merge side effect" });
    const afterInterrupt = await coordinator.resume(fakeRemote(calls));
    assert.equal(afterInterrupt.state, "completed_merged"); assert.equal(router.list().filter((task) => task.role === "bootstrap").length, 1); assert.equal(calls.merge, 1);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a fresh delivery cancels stranded historical tasks but preserves their records", async () => {
  const fixture = setup(true); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const stranded = router.enqueue({ role: "backend", title: "old stranded task", prompt: "old", estimatedTokens: 20 });
    const final = await coordinator.begin({ source: fixture.source, ...fakeRemote(calls) });
    assert.equal(router.store.getTask(stranded.id).status, "cancelled");
    assert.match(router.store.getTask(stranded.id).error, /superseded_by_fresh_delivery/);
    assert.equal(final.state, "completed_merged");
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a terminal failed delivery starts a fresh Bootstrap/DAG instead of requiring an invalid resume", async () => {
  const fixture = setup(false); const client = new DeliveryClient(); fixture.config.executionProviderFactory = () => provider(client);
  const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router);
  try {
    const first = await coordinator.begin({ source: fixture.source });
    router.store.updateDeliveryRun(first.id, { state: "failed", publish: { reason: "input corrected" } });
    const second = await coordinator.begin({ source: fixture.source });
    assert.notEqual(second.id, first.id);
    assert.equal(router.list().filter((task) => task.role === "bootstrap").length, 2);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("tracking-only delivery keeps worker goals uncapped while bounding planning goals", async () => {
  const fixture = setup(false); fixture.config.budget.enforceLocalLimits = false;
  const client = new DeliveryClient(); fixture.config.executionProviderFactory = () => provider(client);
  const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router);
  try {
    await coordinator.begin({ source: fixture.source });
    assert.ok(client.goals.length > 2);
    assert.equal(client.goals.filter((goal) => /^(Bootstrap|Plan )/.test(goal.objective)).every((goal) => "tokenBudget" in goal), true);
    assert.equal(client.goals.filter((goal) => !/^(Bootstrap|Plan )/.test(goal.objective)).some((goal) => "tokenBudget" in goal), false);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("planner validation is repaired in the same delivery run without a new Bootstrap", async () => {
  const fixture = setup(false); const client = new CorrectingPlannerClient(); fixture.config.executionProviderFactory = () => provider(client);
  const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router);
  try {
    await coordinator.begin({ source: fixture.source });
    assert.equal(client.plannerReads, 2);
    assert.equal(router.list().filter((task) => task.role === "bootstrap").length, 1);
    assert.equal(router.list().find((task) => task.role === "planner").status, "done");
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("writer verification failure is repaired in the same worker thread before finalization", async () => {
  const fixture = setup(false); const client = new RepairingWriterClient(); fixture.config.executionProviderFactory = () => provider(client);
  const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router);
  try {
    await coordinator.begin({ source: fixture.source });
    const writer = router.list().find((task) => task.title === "Writer");
    assert.equal(writer.status, "done", writer.error);
    assert.equal(client.writerTurns, 2);
    assert.ok(router.store.workerArtifact(writer.id));
    assert.equal(router.lifecycleEvents().some((event) => event.type === "migrated writer verification retry"), true);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("delivery coordinator refuses completion while any task remains running", async () => {
  const run = { id: "run-active", state: "running" };
  let integrationAttempted = false;
  const router = {
    recoverStaleDeliveries() { return []; }, activateDeliveryRun() {}, isAutonomous() { return true; },
    assertBootstrapSourceIntake() {}, blockRunForSourceCompleteness() { throw new Error("source completeness should not be evaluated by this fixture"); },
    list() { return [{ id: "still-running", role: "bootstrap", status: "running", deliveryRunId: run.id }]; },
    async runUntilIdle() { return { blockedQuota: false, blockedBudget: false, interrupted: false, failed: false }; },
    async runToIntegration() { integrationAttempted = true; throw new Error("must not integrate"); },
    store: {
      currentDeliveryRun() { return run; }, deliveryRun() { return run; },
      updateDeliveryRun(id, update) { return { ...run, id, ...update }; }
    }
  };
  const terminal = await new DeliveryCoordinator(router).resume();
  assert.equal(terminal.state, "failed");
  assert.match(terminal.publish.reason, /still-running remains running/);
  assert.equal(integrationAttempted, false);

});
