import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { deriveParallelReadinessEvidence } from "../src/controller-verification.mjs";
import { validateProductAcceptanceReport } from "../src/final-acceptance.mjs";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { SwarmRouter } from "../src/router.mjs";
import { sourceClaimCandidateId, sourceFragmentDigest } from "../src/source-evidence.mjs";
import { provider } from "./execution-provider-test-adapter.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const digest = (value) => createHash("sha256").update(value.replace(/\r\n?/g, "\n")).digest("hex");
const markdown = "# Requirements\nImplement `src/alpha.mjs` exporting `alpha = true`.\nImplement `src/beta.mjs` exporting `beta = true`.\nThe alpha implementation owns only `src/alpha.mjs`.\nThe beta implementation owns only `src/beta.mjs`.\nAlpha and beta have no dependency on each other.\nBoth are eligible to start concurrently.\nEach task must be implemented and verified separately.\n";
const controllerReference = { schemaVersion: 1, source: "controller", kind: "controller_execution", capabilityId: "parallel-readiness", capabilityVersion: 1, requirements: ["no_writer_predecessor", "same_wave_eligibility", "overlapping_active_turns", "checkpoint_lineage"], writerRequirementIds: ["alpha-implementation", "beta-implementation"], minimumConcurrentActiveTurns: 2 };
const fenced = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function fixtureBlueprint(file, claims, overlayBaseSha) {
  const idFor = (claim) => sourceClaimCandidateId({ documentId: file.documentId, startLine: claim.sourceLocation.startLine, endLine: claim.sourceLocation.endLine, claimType: claim.claimType, normalizedStatement: claim.normalizedStatement });
  const sourceRef = (claim) => ({ documentId: file.documentId, startLine: claim.sourceLocation.startLine, endLine: claim.sourceLocation.endLine, excerptDigest: sourceFragmentDigest(markdown, claim.sourceLocation.startLine, claim.sourceLocation.endLine) });
  const requirement = (requirementId, description, claimIndexes, criterionId, verification) => ({ requirementId, type: "functional", priority: "must", mandatory: true, description, sourceClaimIds: claimIndexes.map((index) => idFor(claims[index])), sourceRefs: claimIndexes.map((index) => sourceRef(claims[index])), acceptanceCriteria: [{ criterionId, description, ...verification }], constraints: [] });
  return { schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "g2g3-controller-path", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest([file]), sourceDocuments: [file], requirements: [
    requirement("alpha-implementation", "Implement alpha in its owned file.", [0, 2], "alpha-module", { repositoryVerification: { schemaVersion: 1, source: "project_overlay", commandId: "package-script:test", overlayBaseSha } }),
    requirement("beta-implementation", "Implement beta in its owned file.", [1, 3], "beta-module", { repositoryVerification: { schemaVersion: 1, source: "project_overlay", commandId: "package-script:test", overlayBaseSha } }),
    requirement("independent-delivery", "Keep the two writer paths independent and concurrent.", [4, 5, 6], "parallel-writers", { controllerExecution: controllerReference })
  ], nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: [], contradictions: [] };
}

class DeterministicControllerClient extends EventEmitter {
  constructor({ extraction, audit, blueprint, plan }) { super(); this.extraction = extraction; this.audit = audit; this.blueprint = blueprint; this.plan = plan; this.sequence = 0; this.threads = new Map(); this.writerWaiters = new Map(); this.writerTurns = []; }
  async connect() {}
  async shutdown() {}
  diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.sequence}`; this.threads.set(id, { cwd, goal: "", turnId: null }); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; }
  async startTurn({ threadId }) { const thread = this.threads.get(threadId); thread.turnId = `turn-${threadId}`; return { turn: { id: thread.turnId } }; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (!/^Implement (alpha|beta)/.test(thread.goal)) return { id: turnId, status: "completed" };
    this.writerTurns.push({ threadId, turnId, title: thread.goal });
    return await new Promise((resolve) => {
      this.writerWaiters.set(threadId, resolve);
      if (this.writerWaiters.size !== 2) return;
      for (const [id, release] of this.writerWaiters) {
        const writer = this.threads.get(id);
        const path = /^Implement alpha/.test(writer.goal) ? "alpha.mjs" : "beta.mjs";
        const symbol = /^Implement alpha/.test(writer.goal) ? "alpha" : "beta";
        mkdirSync(join(writer.cwd, "src"), { recursive: true });
        writeFileSync(join(writer.cwd, "src", path), `export const ${symbol} = true;\n`);
        release({ id: writer.turnId, status: "completed" });
      }
      this.writerWaiters.clear();
    });
  }
  async readTerminalTurn(_threadId, turnId) { return { terminal: { id: turnId, status: "completed" } }; }
  async readThread({ threadId }) {
    const goal = this.threads.get(threadId).goal;
    const result = /^Extract atomic/.test(goal) ? this.extraction
      : /^Independently audit/.test(goal) ? this.audit
        : /^Bootstrap/.test(goal) ? this.blueprint
          : /^Plan /.test(goal) ? this.plan
            : /^Security review:/.test(goal) ? { verdict: "pass", summary: "deterministic security pass", findings: [], executedChecks: [], notRunChecks: [] }
              : /^QA:/.test(goal) ? { verdict: "pass", summary: "deterministic QA pass", findings: [], executedChecks: [], notRunChecks: [] }
                : null;
    if (result === null) return { thread: { turns: [{ id: this.threads.get(threadId).turnId, status: "completed", items: [{ type: "agentMessage", text: "writer complete" }] }] } };
    return { thread: { turns: [{ id: this.threads.get(threadId).turnId, status: "completed", items: [{ type: "agentMessage", text: fenced(result) }] }] } };
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "g2g3-controller-path-")); const source = join(root, "raw"); const path = "requirements.md";
  const file = { documentId: documentIdForPath(path), path, sha256: digest(markdown) };
  const statements = ["src/alpha.mjs exports alpha = true.", "src/beta.mjs exports beta = true.", "Alpha owns only src/alpha.mjs.", "Beta owns only src/beta.mjs.", "Alpha and beta have no dependency on each other.", "Alpha and beta are eligible to start concurrently.", "Each task is separately verified."];
  const claims = statements.map((normalizedStatement, index) => ({ claimType: index < 2 ? "functional" : "constraint", normalizedStatement, classification: "mandatory", sourceLocation: { documentId: file.documentId, startLine: index + 2, endLine: index + 2 } }));
  git(root, ["init", "-b", "main"]); mkdirSync(source, { recursive: true }); mkdirSync(join(root, "src")); writeFileSync(join(source, path), markdown); writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); git(root, ["add", "package.json", "package-lock.json", "raw/requirements.md"]); git(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"]);
  const extraction = { schemaVersion: 1, kind: "SourceClaimExtractionCandidate", claims };
  const audit = { decisions: claims.map((claim) => ({ claimId: sourceClaimCandidateId({ documentId: file.documentId, startLine: claim.sourceLocation.startLine, endLine: claim.sourceLocation.endLine, claimType: claim.claimType, normalizedStatement: claim.normalizedStatement }), decision: "admitted", classification: "mandatory", reasonCodes: ["deterministic_fixture"] })) };
  const overlayBaseSha = git(root, ["rev-parse", "main"]); const plan = { blueprintId: "g2g3-controller-path", tasks: [{ id: "write-alpha", title: "Implement alpha", prompt: "Implement alpha", primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 1000, dependsOn: [], allowedPaths: ["src/alpha.mjs"], acceptanceChecks: ["npm test"], requirementIds: ["alpha-implementation", "independent-delivery"] }, { id: "write-beta", title: "Implement beta", prompt: "Implement beta", primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 1000, dependsOn: [], allowedPaths: ["src/beta.mjs"], acceptanceChecks: ["npm test"], requirementIds: ["beta-implementation"] }] };
  const client = new DeterministicControllerClient({ extraction, audit, blueprint: fixtureBlueprint(file, claims, overlayBaseSha), plan }); const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 4_000, usesWorktree: role === "backend" }]));
  const router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "deterministic", processRunner: async () => ({ pid: 1, code: 0, stdout: "deterministic verification", stderr: "" }), project: { name: "g2g3-controller-path", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", projectMode: { schemaVersion: 1, kind: "ProjectMode", mode: "greenfield" }, productRoots: [] }, router: { maxConcurrentTasks: 2, maxChildrenPerTask: 12, maxDelegationDepth: 5, maxPlanTasks: 8, defaultParentBudget: 20_000, turnTimeoutMs: 1_000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true }, budget: { weeklyTokenLimit: 100_000, weeklyWindowDays: 7, hardRunTokenLimit: 90_000, interruptSafetyMarginTokens: 1_000, enforceLocalLimits: false }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxWaves: 2 }, remote: { enabled: false, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: false, mergeMethod: "merge" }, roles, executionProviderFactory: () => provider(client) });
  return { root, source, client, router };
}

test("G2/G3 controller path deterministically carries raw intake through concurrent writers, evidence, and local candidate acceptance", async () => {
  const fx = setup();
  try {
    const final = await new DeliveryCoordinator(fx.router).begin({ source: fx.source });
    assert.equal(final.state, "completed_candidate_ready", JSON.stringify({ final, tasks: fx.router.list().map((task) => ({ title: task.title, role: task.role, status: task.status, error: task.error })), events: fx.router.store.events({ limit: 100000 }).filter((event) => event.type.startsWith("delivery/") || event.type === "dependency deadlock") })); assert.equal(final.sourceClaimInputMode, "raw"); assert.ok(final.sourceClaimExtractionId && final.sourceClaimAuditId && final.sourceClaimManifestId);
    const manifest = fx.router.store.sourceClaimManifest(final.sourceClaimManifestId).manifest; const audit = fx.router.store.sourceClaimAudit(final.sourceClaimAuditId).audit;
    assert.equal(manifest.claims.length, 7); assert.ok(audit.decisions.every((item) => item.decision === "admitted"));
    const blueprint = fx.router.store.productBlueprint(final.blueprintId).blueprint; assert.ok(blueprint.requirements.slice(0, 2).every((requirement) => requirement.acceptanceCriteria[0].repositoryVerification)); assert.deepEqual(blueprint.requirements[2].acceptanceCriteria[0].controllerExecution, controllerReference);
    const writers = fx.router.list().filter((task) => task.executionIsWriter).sort((left, right) => left.title.localeCompare(right.title)); assert.deepEqual(writers.map((task) => [task.title, task.allowedPaths]), [["Implement alpha", ["src/alpha.mjs"]], ["Implement beta", ["src/beta.mjs"]]]); assert.equal(fx.client.writerTurns.length, 2, "both writers reached the provider barrier through the Router");
    const lifecycle = fx.router.store.events({ limit: 100000 }); const intervals = writers.map((writer) => ({ start: Date.parse(lifecycle.find((event) => event.taskId === writer.id && ["lifecycle/turn started", "lifecycle/migrated writer turn started"].includes(event.type)).createdAt), end: Date.parse(lifecycle.find((event) => event.taskId === writer.id && ["lifecycle/turn terminal candidate", "lifecycle/migrated writer finalized"].includes(event.type)).createdAt) })); assert.ok(Math.max(...intervals.map((item) => item.start)) <= Math.min(...intervals.map((item) => item.end)), "writer active-turn intervals overlap");
    for (const writer of writers) { const artifact = fx.router.store.workerArtifact(writer.id); assert.ok(artifact); assert.match(artifact.headSha, /^[a-f0-9]{40}$/); git(fx.root, ["cat-file", "-e", `${artifact.headSha}^{commit}`]); }
    const reviews = fx.router.list().filter((task) => ["security", "qa"].includes(task.role)); assert.equal(reviews.length, 4); assert.ok(reviews.every((task) => task.status === "done"));
    const checkpoint = fx.router.store.globalWaveCheckpoint(final.id, 1); const integration = fx.router.store.integrationManifest(final.integrationPath); assert.equal(checkpoint.outputSha, integration.candidateSha); assert.equal(integration.candidateSha, final.candidate.sha);
    const storedEvidence = JSON.parse(fx.router.store.db.prepare("SELECT execution_json FROM product_evidence_executions").get().execution_json); const controllerEvidence = storedEvidence.evidence.results.find((item) => item.verificationKind === "controller_execution"); assert.equal(controllerEvidence.status, "pass"); assert.deepEqual(controllerEvidence.controllerExecution.taskIds, writers.map((task) => task.id).sort());
    const acceptance = fx.router.store.productAcceptanceForRun(final.id); assert.equal(acceptance.passing, true); assert.equal(acceptance.report.results.find((item) => item.criterionId === "parallel-writers").status, "pass");
    const evidenceFor = ({ events = lifecycle, tasks = fx.router.store.listTasks(), candidateSha = final.candidate.sha, outputSha = checkpoint.outputSha } = {}) => deriveParallelReadinessEvidence({ store: { deliveryRun: fx.router.store.deliveryRun.bind(fx.router.store), productBlueprint: fx.router.store.productBlueprint.bind(fx.router.store), listTasks: () => structuredClone(tasks), planBatch: fx.router.store.planBatch.bind(fx.router.store), events: () => structuredClone(events), globalWaveCheckpoint: () => ({ ...checkpoint, outputSha }) }, deliveryRunId: final.id, blueprintId: blueprint.blueprintId, requirementId: "independent-delivery", criterionId: "parallel-writers", reference: controllerReference, candidateSha });
    const serialEvents = lifecycle.map((event) => ({ ...event, createdAt: event.taskId === writers[1].id && ["lifecycle/turn started", "lifecycle/migrated writer turn started"].includes(event.type) ? new Date(intervals[0].end + 1).toISOString() : event.createdAt, payload: event.taskId === writers[1].id && ["lifecycle/turn started", "lifecycle/migrated writer turn started"].includes(event.type) ? { ...event.payload, timestamp: new Date(intervals[0].end + 1).toISOString() } : event.payload }));
    assert.equal(evidenceFor({ events: serialEvents }).status, "not_verified", "serial writer starts fail closed");
    assert.equal(evidenceFor({ events: lifecycle.filter((event) => !(event.taskId === writers[0].id && ["lifecycle/turn terminal candidate", "lifecycle/migrated writer finalized"].includes(event.type))) }).status, "not_verified", "missing terminal lifecycle evidence fails closed");
    assert.equal(evidenceFor({ outputSha: "f".repeat(40) }).status, "not_verified", "altered checkpoint SHA fails closed");
    assert.equal(evidenceFor({ candidateSha: "f".repeat(40) }).status, "not_verified", "altered candidate SHA fails closed");
    assert.equal(evidenceFor({ tasks: fx.router.store.listTasks().map((task) => task.id === writers[1].id ? { ...task, executionDependencies: [...task.executionDependencies, writers[0].id] } : task) }).status, "not_verified", "writer dependency edge fails closed");
    const stale = structuredClone(acceptance.report); const controllerResult = stale.results.find((item) => item.criterionId === "parallel-writers"); delete controllerResult.evidence.find((item) => item.kind === "controller-execution").controllerExecution.lifecycleIntervals;
    assert.throws(() => validateProductAcceptanceReport(stale, { blueprint, blueprintDigest: fx.router.store.productBlueprint(final.blueprintId).digest, manifest: integration, manifestPath: final.integrationPath }), /controller evidence identity/, "final acceptance rejects missing controller evidence");
  } finally { fx.router.close(); rmSync(fx.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
