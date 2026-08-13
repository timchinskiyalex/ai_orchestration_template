import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { SwarmRouter } from "../src/router.mjs";
import { admitAuditedSourceClaims, auditSubjectFromExtraction, canonicalizeSourceClaimAuditCandidate } from "../src/source-claim-audit.mjs";
import { canonicalizeSourceClaimExtractionCandidate, createImportedSourceResolver, sourceClaimCandidateId, sourceFragmentDigest } from "../src/source-evidence.mjs";
import { provider } from "./execution-provider-test-adapter.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const digest = (value) => createHash("sha256").update(value.replace(/\r\n?/g, "\n")).digest("hex");
const explicitSource = "# Requirements\nImplement `src/alpha.mjs` exporting `alpha = true`.\nImplement `src/beta.mjs` exporting `beta = true`.\nThe alpha implementation owns only `src/alpha.mjs`.\nThe beta implementation owns only `src/beta.mjs`.\nAlpha and beta have no dependency on each other.\nBoth are eligible to start concurrently.\nEach task must be implemented and verified separately.\n";

function explicitClaims(file) {
  const claim = (line, claimType, normalizedStatement) => ({ claimType, normalizedStatement, classification: "mandatory", sourceLocation: { documentId: file.documentId, startLine: line, endLine: line } });
  return [
    claim(2, "functional", "src/alpha.mjs exports alpha = true."),
    claim(3, "functional", "src/beta.mjs exports beta = true."),
    claim(4, "constraint", "Alpha implementation owns only src/alpha.mjs."),
    claim(5, "constraint", "Beta implementation owns only src/beta.mjs."),
    claim(6, "constraint", "Alpha and beta have no dependency on each other."),
    claim(7, "constraint", "Alpha and beta are eligible to start concurrently."),
    claim(8, "constraint", "Each task must be implemented and verified separately.")
  ];
}

function sourceRef(file, text, line) {
  return { documentId: file.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(text, line, line) };
}

function explicitBlueprint(file, claims, overlayBaseSha) {
  const claimId = (claim) => sourceClaimCandidateId({ documentId: file.documentId, startLine: claim.sourceLocation.startLine, endLine: claim.sourceLocation.endLine, claimType: claim.claimType, normalizedStatement: claim.normalizedStatement });
  const requirement = (requirementId, description, indexes, criterionId) => ({
    requirementId, type: "functional", priority: "must", mandatory: true, description,
    sourceClaimIds: indexes.map((index) => claimId(claims[index])), sourceRefs: indexes.map((index) => sourceRef(file, explicitSource, claims[index].sourceLocation.startLine)),
    acceptanceCriteria: [{ criterionId, description, repositoryVerification: { schemaVersion: 1, source: "project_overlay", commandId: "package-script:test", overlayBaseSha } }], constraints: []
  });
  return {
    schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "pb-g2g3-explicit", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest([file]), sourceDocuments: [file],
    requirements: [
      requirement("alpha-implementation", "Implement alpha in its owned file.", [0, 2], "alpha-module"),
      requirement("beta-implementation", "Implement beta in its owned file.", [1, 3], "beta-module"),
      requirement("independent-delivery", "Keep the alpha and beta delivery paths dependency-free, concurrent, and separately verified.", [4, 5, 6], "independent-delivery")
    ],
    nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: [], contradictions: []
  };
}

function explicitPlan() {
  const writer = (id, title, allowedPaths, requirementIds) => ({ id, title, prompt: title, primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 1000, dependsOn: [], allowedPaths, acceptanceChecks: ["npm test"], requirementIds });
  return { blueprintId: "pb-g2g3-explicit", tasks: [
    writer("write-alpha", "Implement alpha", ["src/alpha.mjs"], ["alpha-implementation", "independent-delivery"]),
    writer("write-beta", "Implement beta", ["src/beta.mjs"], ["beta-implementation"])
  ] };
}

class DeterministicG2G3Client extends EventEmitter {
  constructor({ extraction, audit, blueprint, plan }) { super(); this.extraction = extraction; this.audit = audit; this.blueprint = blueprint; this.plan = plan; this.sequence = 0; this.threads = new Map(); this.goals = []; }
  async connect() {}
  async shutdown() {}
  async diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.sequence}`; this.threads.set(id, { cwd, goal: "", turnId: null }); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; this.goals.push(objective); }
  async startTurn({ threadId }) { const thread = this.threads.get(threadId); thread.turnId = `turn-${threadId}`; return { turn: { id: thread.turnId } }; }
  async waitForTurn(_threadId, turnId) { return { id: turnId, status: "completed" }; }
  async readTerminalTurn(_threadId, turnId) { return { terminal: { id: turnId, status: "completed" } }; }
  async readThread({ threadId }) {
    const thread = this.threads.get(threadId); const { goal } = thread;
    const result = /^Extract atomic/.test(goal) ? this.extraction : /^Independently audit/.test(goal) ? this.audit : /^Bootstrap/.test(goal) ? this.blueprint : /^Plan /.test(goal) ? this.plan : null;
    if (!result) throw new Error(`Unexpected deterministic fixture turn: ${goal}`);
    return { thread: { turns: [{ id: thread.turnId, status: "completed", items: [{ type: "agentMessage", text: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` }] }] } };
  }
}

function setupExplicitFixture() {
  const root = mkdtempSync(join(tmpdir(), "g2g3-explicit-source-")); const source = join(root, "raw-requirements"); const path = "requirements.md";
  const file = { documentId: documentIdForPath(path), path, sha256: digest(explicitSource) }; const claims = explicitClaims(file);
  git(root, ["init", "-b", "main"]); mkdirSync(source, { recursive: true }); mkdirSync(join(root, "src")); writeFileSync(join(source, path), explicitSource);
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); git(root, ["add", "package.json", "package-lock.json", "raw-requirements/requirements.md"]); git(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"]);
  const extraction = { schemaVersion: 1, kind: "SourceClaimExtractionCandidate", claims };
  const audit = { decisions: claims.map((claim) => ({ claimId: sourceClaimCandidateId({ documentId: file.documentId, startLine: claim.sourceLocation.startLine, endLine: claim.sourceLocation.endLine, claimType: claim.claimType, normalizedStatement: claim.normalizedStatement }), decision: "admitted", classification: "mandatory", reasonCodes: ["explicit_fixture_constraint"] })) };
  const overlayBaseSha = git(root, ["rev-parse", "main"]);
  const client = new DeterministicG2G3Client({ extraction, audit, blueprint: explicitBlueprint(file, claims, overlayBaseSha), plan: explicitPlan() });
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 4_000, interruptThresholdTokens: 3_500, usesWorktree: role === "backend" }]));
  const config = { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fixture", project: { name: "g2g3-explicit", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", projectMode: { schemaVersion: 1, kind: "ProjectMode", mode: "greenfield" }, productRoots: [] }, router: { maxConcurrentTasks: 2, maxChildrenPerTask: 12, maxDelegationDepth: 5, maxPlanTasks: 8, defaultParentBudget: 20_000, turnTimeoutMs: 1_000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true }, budget: { weeklyTokenLimit: 100_000, weeklyWindowDays: 7, hardRunTokenLimit: 90_000, interruptSafetyMarginTokens: 1_000, enforceLocalLimits: false }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxWaves: 2 }, remote: { enabled: false, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: false, mergeMethod: "merge" }, roles, executionProviderFactory: () => provider(client) };
  return { root, source, file, claims, client, overlayBaseSha, router: new SwarmRouter(config) };
}

test("G2/G3 explicit source fixture admits canonical intake and plans two parallel-eligible writers without controller semantic inference", async () => {
  const fx = setupExplicitFixture();
  try {
    const claimNext = fx.router.store.claimNext.bind(fx.router.store);
    fx.router.store.claimNext = (...args) => {
      const writers = fx.router.list().filter((task) => task.role === "backend" && ["Implement alpha", "Implement beta"].includes(task.title));
      return writers.length === 2 && writers.every((task) => task.status === "queued") ? null : claimNext(...args);
    };
    const run = await new DeliveryCoordinator(fx.router).begin({ source: fx.source });
    assert.equal(run.sourceClaimInputMode, "raw"); assert.ok(run.sourceClaimExtractionId && run.sourceClaimAuditId && run.sourceClaimManifestId, JSON.stringify(run.publish));
    assert.equal(fx.router.store.sourceIntakeFailureForRun({ deliveryRunId: run.id }), null);
    const manifest = fx.router.store.sourceClaimManifest(run.sourceClaimManifestId).manifest;
    const audit = fx.router.store.sourceClaimAudit(run.sourceClaimAuditId).audit;
    assert.deepEqual(manifest.claims.map((claim) => claim.sourceRefs[0].startLine).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(audit.decisions.map((decision) => [decision.decision, decision.classification, decision.reasonCodes]).sort((left, right) => left[2][0].localeCompare(right[2][0])), Array.from({ length: 7 }, () => ["admitted", "mandatory", ["explicit_fixture_constraint"]]));
    const persistedBlueprint = fx.router.store.productBlueprint(fx.router.store.deliveryRun(run.id).blueprintId).blueprint;
    assert.deepEqual(persistedBlueprint.requirements.flatMap((requirement) => requirement.acceptanceCriteria.map((criterion) => criterion.repositoryVerification)), Array.from({ length: 3 }, () => ({ schemaVersion: 1, source: "project_overlay", commandId: "package-script:test", overlayBaseSha: fx.overlayBaseSha })));
    const planner = fx.router.list().find((task) => task.role === "planner"); const writers = fx.router.list().filter((task) => task.role === "backend" && ["Implement alpha", "Implement beta"].includes(task.title)).sort((left, right) => left.title.localeCompare(right.title));
    assert.equal(writers.length, 2, JSON.stringify({ run: fx.router.store.deliveryRun(run.id), tasks: fx.router.list().map((task) => ({ role: task.role, title: task.title, status: task.status, error: task.error })) })); assert.deepEqual(writers.map((task) => [task.title, task.allowedPaths, task.requirementIds]), [["Implement alpha", ["src/alpha.mjs"], ["alpha-implementation", "independent-delivery"]], ["Implement beta", ["src/beta.mjs"], ["beta-implementation"]]]);
    assert.ok(writers.every((task) => task.status === "queued" && task.executionReleaseState === "pending"));
    assert.ok(writers.every((task) => task.dependencies.length === 1 && task.dependencies[0] === planner.id && task.executionDependencies.length === 0), "only the controller's structural Planner parent is present; neither writer depends on the other");
    assert.deepEqual(fx.router.store.planBatches(run.id)[0].tasks.map((task) => [task.id, task.dependsOn, task.allowedPaths]).sort((left, right) => left[0].localeCompare(right[0])), [["write-alpha", [], ["src/alpha.mjs"]], ["write-beta", [], ["src/beta.mjs"]]]);
    assert.equal(fx.client.goals.some((goal) => /^Implement (alpha|beta)$/.test(goal)), false, "the deterministic fixture stops before any writer turn");
  } finally { fx.router.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test("the old vague independently implemented phrase is audit-unresolved and blocks source admission", () => {
  const root = mkdtempSync(join(tmpdir(), "g2g3-vague-source-"));
  try {
    const text = "The alpha and beta requirements must be independently implemented.\n"; const path = "requirements.md"; const file = { documentId: documentIdForPath(path), path, sha256: digest(text) };
    mkdirSync(join(root, "docs", "in"), { recursive: true }); writeFileSync(join(root, "docs", "in", path), text); writeFileSync(join(root, "docs", "in", "inventory.json"), JSON.stringify({ files: [file], documentSetDigest: documentSetDigest([file]) }));
    const resolver = createImportedSourceResolver({ repository: root, documentationDir: "docs/in" });
    const extraction = canonicalizeSourceClaimExtractionCandidate({ schemaVersion: 1, kind: "SourceClaimExtractionCandidate", claims: [{ claimType: "constraint", normalizedStatement: "The alpha and beta requirements must be independently implemented.", classification: "mandatory", sourceLocation: { documentId: file.documentId, startLine: 1, endLine: 1 } }] }, { sourceResolver: resolver });
    const subject = auditSubjectFromExtraction(extraction); const audit = canonicalizeSourceClaimAuditCandidate({ decisions: [{ claimId: subject.claims[0].claimId, decision: "unresolved", classification: null, reasonCodes: ["ambiguous_independence_criterion"] }] }, { subject, sourceResolver: resolver });
    assert.equal(audit.decisions[0].decision, "unresolved"); assert.deepEqual(audit.decisions[0].reasonCodes, ["ambiguous_independence_criterion"]);
    assert.throws(() => admitAuditedSourceClaims({ subject, audit }), /source_claim_audit:admission_blocked:unresolved:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
