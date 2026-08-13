import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { SwarmRouter } from "../src/router.mjs";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { createImportedSourceResolver, sourceClaimCandidateId, sourceFragmentDigest, validateSourceClaimExtraction } from "../src/source-evidence.mjs";
import { auditSubjectFromExtraction, normalizedSourceUnits } from "../src/source-claim-audit.mjs";
import { provider } from "./execution-provider-test-adapter.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const sha256 = (value) => createHash("sha256").update(value.replace(/\r\n?/g, "\n")).digest("hex");
const json = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function rawExtraction(root) {
  const resolver = createImportedSourceResolver({ repository: root, documentationDir: "docs/orchestration-input" });
  const source = resolver.sourceDocuments[0];
  const text = readFileSync(join(root, "docs", "orchestration-input", source.path), "utf8");
  const claims = [1, 2, 3, 4].map((line) => {
    const normalizedStatement = `Implement behavior ${line}.`;
    const claim = { documentId: source.documentId, startLine: line, endLine: line, sourceDigest: source.sha256, claimType: "functional", normalizedStatement, confidence: 1, sourceQuote: { documentId: source.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(text, line, line) } };
    return { ...claim, claimId: sourceClaimCandidateId(claim) };
  });
  return { schemaVersion: 1, kind: "SourceClaimExtraction", documentSetDigest: documentSetDigest([source]), claims };
}

function rawAudit(root) {
  const resolver = createImportedSourceResolver({ repository: root, documentationDir: "docs/orchestration-input" });
  const extraction = validateSourceClaimExtraction(rawExtraction(root), { sourceResolver: resolver });
  const subject = auditSubjectFromExtraction(extraction);
  return {
    schemaVersion: 1,
    kind: "SourceClaimAudit",
    documentSetDigest: subject.documentSetDigest,
    candidateId: subject.candidateId,
    candidateDigest: subject.candidateDigest,
    decisions: subject.claims.map((claim) => ({ claimId: claim.claimId, decision: "admitted", classification: "mandatory", reasonCodes: ["verified"], sourceRefs: claim.sourceRefs })),
    coverage: normalizedSourceUnits(resolver).map((unit) => ({ ...unit, disposition: "covered", reasonCodes: ["verified"], candidateClaimIds: subject.claims.filter((claim) => claim.sourceRefs.some((ref) => ref.documentId === unit.documentId && ref.startLine <= unit.startLine && ref.endLine >= unit.endLine)).map((claim) => claim.claimId) }))
  };
}

function blueprint(root) {
  const inventory = JSON.parse(readFileSync(join(root, "docs", "orchestration-input", "inventory.json"), "utf8"));
  const claims = rawExtraction(root).claims;
  const source = inventory.files[0];
  const text = readFileSync(join(root, "docs", "orchestration-input", source.path), "utf8");
  const requirement = (id, line, criterionId, description) => ({
    requirementId: id, type: "functional", priority: "must", mandatory: true, description,
    sourceClaimIds: [claims.find((claim) => claim.startLine === line).claimId],
    sourceRefs: [{ documentId: source.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(text, line, line) }],
    acceptanceCriteria: [{ criterionId, description: `${description} is verified.`, verificationHint: "npm test" }], constraints: []
  });
  return { schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "stage08-blueprint", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest(inventory.files), sourceDocuments: inventory.files, requirements: [requirement("writer-a-behavior", 1, "writer-a-check", "Implement behavior 1."), requirement("writer-c-behavior", 2, "writer-c-check", "Implement behavior 2."), requirement("writer-b-behavior", 3, "writer-b-check", "Implement behavior 3."), requirement("final-behavior", 4, "final-check", "Implement behavior 4.")], nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: [], contradictions: [] };
}

const task = (id, title, prompt, allowedPaths, requirementIds, dependsOn = []) => ({ id, title, prompt, primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 1000, dependsOn, allowedPaths, acceptanceChecks: ["npm test"], requirementIds });

class LocalFakeDeliveryAdapter extends EventEmitter {
  constructor(root) { super(); this.root = root; this.id = 0; this.threads = new Map(); this.goals = []; this.plannerReads = 0; }
  async connect() {}
  shutdown() {}
  diagnostics() { return { protocolEvents: [], stderrTail: "", process: { alive: false } }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.id}`; this.threads.set(id, { cwd, goal: "" }); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; this.goals.push(objective); }
  async startTurn({ threadId }) { return { turn: { id: `turn-${threadId}` } }; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (/Writer A/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "a.mjs"), "export const a = true;\n");
    if (/Writer C/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "context.mjs"), "export const context = 'created';\n");
    if (/Writer B/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "context.mjs"), "export const context = 'reconciled';\n");
    if (/Writer D/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "final.mjs"), "export const final = true;\n");
    return { id: turnId, status: "completed" };
  }
  async readThread({ threadId }) {
    const thread = this.threads.get(threadId);
    if (/^Extract atomic/.test(thread.goal)) return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text: json(rawExtraction(this.root)) }] }] } };
    if (/^Independently audit/.test(thread.goal)) return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text: json(rawAudit(this.root)) }] }] } };
    if (/^Bootstrap /.test(thread.goal)) return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text: json(blueprint(this.root)) }] }] } };
    if (/^Plan /.test(thread.goal)) {
      this.plannerReads += 1;
      const plan = this.plannerReads === 1
        ? { blueprintId: "stage08-blueprint", tasks: [task("writer-a", "Writer A", "Writer A", ["src/a.mjs"], ["writer-a-behavior"]), task("writer-c", "Writer C", "Writer C", ["src"], ["writer-c-behavior"]), task("writer-b", "Writer B", "Writer B", ["src"], ["writer-b-behavior"], ["writer-c"])] }
        : { blueprintId: "stage08-blueprint", tasks: [task("writer-d", "Writer D", "Writer D", ["src/final.mjs"], ["final-behavior"])] };
      return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text: json(plan) }] }] } };
    }
    const text = /^Security review:/.test(thread.goal)
      ? json({ verdict: "pass", summary: "local fake security pass", findings: [], executedChecks: [], notRunChecks: [] })
      : /^QA:/.test(thread.goal)
        ? json({ verdict: "pass", summary: "local fake QA pass", findings: [], executedChecks: [], notRunChecks: [] })
        : "worker complete";
    return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text }] }] } };
  }
}

function fakePublication(calls) {
  return {
    remoteGitAdapter: { async pushCandidate({ sha }) { calls.push += 1; return { status: "pushed", verifiedSha: sha }; } },
    pullRequestAdapter: { async ensurePullRequest({ sha }) { calls.pr += 1; return { status: "open", number: 8, url: "https://local.invalid/8", headSha: sha }; } },
    remoteCiAdapter: { async waitForChecks() { calls.ci += 1; return { status: "passed", checkRuns: [{ name: "local-fake-ci", status: "completed", conclusion: "success" }] }; } },
    mergeAdapter: { async merge() { calls.merge += 1; return { status: "merged", mainSha: "b".repeat(40), mergeSha: "b".repeat(40), targetVerified: true }; } }
  };
}

test("Stage 08 controller wiring proves raw-source two-wave fan-in delivery with candidate-bound controller evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "stage08-acceptance-")); let router;
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
    const source = join(root, "raw"); mkdirSync(source); writeFileSync(join(source, "requirements.md"), "Implement behavior 1.\nImplement behavior 2.\nImplement behavior 3.\nImplement behavior 4.\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); writeFileSync(join(root, "src", "base.mjs"), "export const base = true;\n");
    git(root, ["add", "."]); git(root, ["-c", "user.name=Stage 08", "-c", "user.email=stage08@example.test", "commit", "-m", "base"]);
    const client = new LocalFakeDeliveryAdapter(root); const commands = []; const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
    const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 2_000, usesWorktree: role === "backend" }]));
    router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "local-fake", processRunner: async (command) => { commands.push(command); return { pid: 8, code: 0, stdout: "local fake verification", stderr: "" }; }, project: { name: "stage08", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" }, router: { maxConcurrentTasks: 3, maxChildrenPerTask: 30, maxDelegationDepth: 5, maxPlanTasks: 10, defaultParentBudget: 20_000, turnTimeoutMs: 1_000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 1 }, budget: { weeklyTokenLimit: 100_000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxWaves: 2, maxReconciliationDiagnostics: 10 }, remote: { enabled: true, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: true, mergeMethod: "merge" }, roles, executionProviderFactory: () => provider(client) });
    const final = await new DeliveryCoordinator(router).begin({ source, ...fakePublication(calls) });
    assert.equal(final.state, "completed_merged", JSON.stringify({ final, events: router.store.events().filter((event) => event.type === "delivery/state" || event.type === "dependency deadlock"), tasks: router.list().map((item) => ({ title: item.title, status: item.status, error: item.error })) })); assert.equal(client.plannerReads, 2, "wave one is partial and reconciliation schedules wave two");
    assert.ok(final.sourceClaimExtractionId); assert.ok(final.sourceClaimAuditId); assert.ok(final.sourceClaimManifestId); assert.ok(final.integrationPath);
    const batches = router.store.planBatches(final.id); assert.deepEqual(batches.map((batch) => batch.wave), [1, 2]);
    const checkpoints = [router.store.globalWaveCheckpoint(final.id, 1), router.store.globalWaveCheckpoint(final.id, 2)]; assert.ok(checkpoints.every((checkpoint) => checkpoint?.status === "passed"));
    const writerB = router.list().find((item) => item.title === "Writer B"); const local = router.store.integrationCheckpoint(writerB.localCheckpointId);
    assert.ok(local && local.status === "passed"); assert.equal(writerB.artifactBaseSha, local.outputSha); assert.equal(writerB.executionDependencies.length, 1); assert.equal(writerB.dependencies.filter((id) => id !== writerB.parentTaskId).length, 1);
    const integration = router.store.integrationManifest(final.integrationPath); const acceptance = router.store.productAcceptanceForRun(final.id);
    assert.equal(acceptance.passing, true); assert.equal(acceptance.report.candidateSha, integration.candidateSha); assert.equal(acceptance.report.results.filter((result) => result.criterionId).length, 4); assert.ok(acceptance.report.results.filter((result) => result.criterionId).every((result) => result.status === "pass"));
    const evidence = router.store.db.prepare("SELECT execution_json FROM product_evidence_executions").get(); assert.ok(evidence); assert.match(evidence.execution_json, new RegExp(integration.candidateSha));
    assert.ok(commands.some((command) => String(command.cwd).replace(/\\/g, "/").includes("/integrations/")), "controller-owned criterion executor ran on the integration candidate");
    assert.deepEqual(calls, { push: 1, pr: 1, ci: 1, merge: 1 });
  } finally { router?.close(); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
