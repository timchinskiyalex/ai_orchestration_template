import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { SwarmRouter } from "../src/router.mjs";
import { AppServerExecutionProvider } from "../src/app-server-execution-provider.mjs";
import { finalizeRepositoryBaseline } from "../src/repository-baseline.mjs";
import { ingestDocumentation } from "../src/project-intake.mjs";
import { fakeBlueprint } from "./product-blueprint-fixture.mjs";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { sourceFragmentDigest } from "../src/source-evidence.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const calls = () => ({ push: 0, pr: 0, ci: 0, merge: 0 });

function protectedPlan({ behaviorIds = ["value-preserved"], disjoint = false } = {}) {
  const task = (id, title, allowedPaths, baselineBehaviorIds) => ({ id, title, prompt: title, primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 20, dependsOn: [], allowedPaths, acceptanceChecks: ["npm test"], requirementIds: ["fix-value"], ...(baselineBehaviorIds === undefined ? {} : { baselineBehaviorIds }) });
  return { blueprintId: "pb-test", tasks: [task("writer-protected", "Writer Protected", ["src/value.mjs"], behaviorIds), ...(disjoint ? [task("writer-disjoint", "Writer Disjoint", ["lib/disjoint.mjs"], [])] : [])] };
}
function recoveryPlan() { const task = protectedPlan().tasks[0]; return { blueprintId: "pb-test", tasks: [{ ...task, id: "recovered-writer", title: "Recovered Writer", prompt: "Recovered Writer" }] }; }

class LifecycleClient extends EventEmitter {
  constructor({ plan = protectedPlan(), scopedPlan = plan, onTurn = () => {} } = {}) { super(); this.sequence = 0; this.threads = new Map(); this.goals = []; this.events = []; this.plan = plan; this.scopedPlan = scopedPlan; this.onTurn = onTurn; }
  async connect() {}
  shutdown() {}
  diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.sequence}`; this.threads.set(id, { cwd, goal: "", turn: null }); return { thread: { id } }; }
  async setGoal(goal) { this.goals.push(goal); this.threads.get(goal.threadId).goal = goal.objective; }
  async startTurn({ threadId }) { const thread = this.threads.get(threadId); thread.turn = `turn-${threadId}`; this.onTurn(thread.goal, this); return { turn: { id: thread.turn } }; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (/^Writer Protected/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "value.mjs"), "export const value = 2;\n");
    if (/^Recovered Writer/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "value.mjs"), "export const value = 3;\n");
    if (/^Writer Disjoint/.test(thread.goal)) { mkdirSync(join(thread.cwd, "lib"), { recursive: true }); writeFileSync(join(thread.cwd, "lib", "disjoint.mjs"), "export const disjoint = true;\n"); }
    return { id: turnId, status: "completed" };
  }
  async readThread({ threadId }) {
    const thread = this.threads.get(threadId);
    let text = "worker complete";
    if (/^Bootstrap /.test(thread.goal)) text = `\`\`\`json\n${JSON.stringify(fakeBlueprint(thread.cwd))}\n\`\`\``;
    else if (/^Plan /.test(thread.goal)) text = `\`\`\`json\n${JSON.stringify(this.plan)}\n\`\`\``;
    else if (/^Scoped recovery plan /.test(thread.goal)) text = `\`\`\`json\n${JSON.stringify(this.scopedPlan)}\n\`\`\``;
    else if (/^(Security review:|QA:)/.test(thread.goal)) text = "```json\n{\"verdict\":\"pass\",\"summary\":\"verified\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```";
    return { thread: { turns: [{ id: thread.turn, items: [{ type: "agentMessage", text }] }] } };
  }
}

function remoteAdapters(count, { ci = "passed" } = {}) {
  return {
    remoteGitAdapter: { async pushCandidate({ sha }) { count.push += 1; return { status: "pushed", verifiedSha: sha }; } },
    pullRequestAdapter: { async ensurePullRequest({ sha }) { count.pr += 1; return { status: "open", number: 1, url: "https://example.test/pr/1", headSha: sha }; } },
    remoteCiAdapter: { async waitForChecks() { count.ci += 1; return ci === "passed" ? { status: "passed", checkRuns: [{ name: "test", status: "completed", conclusion: "success" }] } : { status: "timed_out", reason: "deterministic timeout" }; } },
    productEvidenceAdapter: { async verify({ candidate }) { return { candidateSha: candidate.sha, results: [{ requirementId: "fix-value", criterionId: "value-test", status: "pass", testId: "deterministic/value", reference: "fake", candidateSha: candidate.sha }] }; } },
    mergeAdapter: { async merge() { count.merge += 1; return { status: "merged", mainSha: "b".repeat(40), mergeSha: "b".repeat(40), targetVerified: true }; } }
  };
}

function fixture({ plan, declaration = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "repository-baseline-lifecycle-"));
  git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  const source = join(root, "requirements"); mkdirSync(source);
  const sourceText = "# Requirement\nFix value.\n"; const sourceFile = { documentId: documentIdForPath("requirements.md"), path: "requirements.md", sha256: digest(sourceText) };
  const ref = (line) => ({ documentId: sourceFile.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(sourceText, line, line) });
  writeFileSync(join(source, "requirements.md"), sourceText);
  writeFileSync(join(source, "source-claims.json"), JSON.stringify({ schemaVersion: 1, kind: "SourceClaimsDeclaration", documentSetDigest: documentSetDigest([sourceFile]), documents: [{ ...sourceFile, coverage: [{ claimId: "fix-value-claim", ...ref(1) }, { claimId: "context-claim", ...ref(2) }] }], claims: [{ claimId: "fix-value-claim", classification: "mandatory", sourceRefs: [ref(1)] }, { claimId: "context-claim", classification: "non_mandatory", sourceRefs: [ref(2)] }] }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}");
  writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n"); writeFileSync(join(root, "test", "value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value',()=>assert.equal(value,2));\n");
  const baseline = { schemaVersion: 1, kind: "RepositoryBaselineDeclaration", behaviors: [{ behaviorId: "value-preserved", category: "behavior", label: "fixture-label-SECRET_VALUE", protectedSurfaces: ["src"], verificationCommandId: "package-script:test", selectedTrackedPaths: ["src/value.mjs"] }], impactEdges: [{ protectedSurface: "src", behaviorId: "value-preserved" }] };
  if (declaration) writeFileSync(join(root, "baseline.json"), JSON.stringify(baseline));
  git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 200, usesWorktree: role === "backend" }]));
  const processCalls = []; const processRunner = async (command) => { processCalls.push(command); return { pid: 717, stdout: "fixture command output SECRET_VALUE", stderr: "" }; };
  const config = { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", processRunner, project: { name: "brownfield-fixture", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", productRoots: [], repositoryMode: "brownfield", repositoryBaselineDeclaration: "baseline.json" }, router: { maxConcurrentTasks: 1, maxChildrenPerTask: 30, maxDelegationDepth: 6, maxPlanTasks: 8, defaultParentBudget: 10_000, turnTimeoutMs: 1_000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 3 }, budget: { weeklyTokenLimit: 10_000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 3 }, remote: { enabled: true, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: true, mergeMethod: "merge" }, roles };
  return { root, source, config, processCalls, baseline, plan };
}

async function persistedBaseline(fx, client = new LifecycleClient()) {
  fx.config.executionProviderFactory = () => new AppServerExecutionProvider({ client }); const router = new SwarmRouter(fx.config);
  ingestDocumentation({ source: fx.source, repository: fx.root, destinationRelative: fx.config.project.documentationDir });
  await router.ensureProjectOverlay();
  const draft = router.captureRepositoryBaselineDraft(await router.ensureProjectOverlay());
  const bootstrap = router.startProject(); const manifestId = router.sourceClaimManifestIdentity();
  const run = router.createDeliveryRun({ id: "persisted-baseline-run", source: fx.source, bootstrapTaskId: bootstrap.id, sourceClaimManifestId: manifestId, repositoryMode: "brownfield", repositoryBaseSha: draft.baseSha });
  router.store.recordRepositoryBaselineDraft(run.id, draft); router.store.linkTaskToDelivery(bootstrap.id, run.id);
  const blueprint = fakeBlueprint(fx.root); const sourceManifest = router.store.sourceClaimManifest(manifestId); blueprint.sourceClaimManifest = { manifestId, digest: sourceManifest.digest, documentSetDigest: sourceManifest.documentSetDigest }; const blueprintDigest = "c".repeat(64);
  router.store.recordProductBlueprint({ blueprint, artifactPath: "docs/orchestration-generated/blueprints/pb-test.v1.json", digest: blueprintDigest, bootstrapTaskId: bootstrap.id, deliveryRunId: run.id, sourceClaimManifestId: manifestId }); router.store.linkBlueprintToDelivery(run.id, blueprint.blueprintId);
  router.store.recordRepositoryBaseline(run.id, finalizeRepositoryBaseline({ draft, blueprintId: blueprint.blueprintId, blueprintDigest }));
  router.store.updateDeliveryRun(run.id, { state: "interrupted" });
  return { router, run: router.store.deliveryRun(run.id), client };
}

test("brownfield controller lifecycle captures, finalizes, materializes, verifies, and accepts the exact baseline", async () => {
  const fx = fixture(); let router; const count = calls(); const client = new LifecycleClient({ plan: protectedPlan(), onTurn: (goal) => {
    const run = router.store.currentDeliveryRun();
    if (/^Bootstrap /.test(goal)) { assert.ok(router.store.repositoryBaselineDraft(run.id)); client.events.push("draft-before-bootstrap"); }
    if (/^Plan /.test(goal)) { assert.ok(router.store.repositoryBaselineForRun(run.id)); client.events.push("final-before-planner"); }
  } }); fx.config.executionProviderFactory = () => new AppServerExecutionProvider({ client }); router = new SwarmRouter(fx.config); const coordinator = new DeliveryCoordinator(router);
  try {
    const final = await coordinator.begin({ source: fx.source, ...remoteAdapters(count) });
    const run = router.store.deliveryRun(final.id); const draft = router.store.repositoryBaselineDraft(final.id); const baseline = router.store.repositoryBaselineForRun(final.id); const manifest = router.store.integrationManifest(final.integrationPath); const acceptance = router.store.productAcceptanceForRun(final.id).report;
    assert.equal(final.state, "completed_merged"); assert.equal(draft.baseSha, git(fx.root, ["rev-parse", "main"])); assert.equal(baseline.baseSha, draft.baseSha); assert.equal(baseline.productBlueprintDigest, router.store.productBlueprint(run.blueprintId).digest);
    assert.deepEqual(client.events, ["draft-before-bootstrap", "final-before-planner"]);
    assert.equal(run.projectMode.mode, "brownfield"); assert.equal(router.list().some((item) => item.prompt.startsWith("[[product-scaffold]]")), false);
    assert.deepEqual(router.list().filter((item) => item.title === "Writer Protected").map((item) => item.baselineBehaviorIds), [["value-preserved"]]);
    assert.ok(fx.processCalls.some((command) => command.cwd === manifest.worktree && command.args.join(" ").includes("test")), "candidate worktree runs the declared Overlay command");
    assert.equal(acceptance.candidateSha, manifest.candidateSha); assert.equal(acceptance.repositoryBaselineDigest, baseline.digest); assert.deepEqual(acceptance.behaviorEvidence.map((item) => ({ behaviorId: item.behaviorId, commandId: item.commandId, candidateSha: item.candidateSha, baselineDigest: item.baselineDigest, classification: item.classification })), [{ behaviorId: "value-preserved", commandId: "package-script:test", candidateSha: manifest.candidateSha, baselineDigest: baseline.digest, classification: "pass" }]);
  } finally { router?.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test("legacy persisted records without ProjectMode are fail-closed before a worker can start", async () => {
  const fx = fixture(); const client = new LifecycleClient(); const { router, run } = await persistedBaseline(fx, client);
  try {
    router.store.db.prepare("UPDATE delivery_runs SET project_mode_json = NULL WHERE id = ?").run(run.id);
    router.close();
    const resumed = new SwarmRouter(fx.config);
    try {
      const persisted = resumed.store.deliveryRun(run.id);
      assert.equal(persisted.state, "blocked_specification");
      assert.equal(persisted.publish.reason, "project_mode:persisted_record_missing");
    } finally { resumed.close(); }
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("missing or invalid declaration blocks a coordinator delivery before Bootstrap and redacts fixture values", async () => {
  for (const [kind, prepare, code] of [
    ["missing", (fx) => rmSync(join(fx.root, "baseline.json")), "repository_baseline:declaration_unavailable"],
    ["invalid", (fx) => writeFileSync(join(fx.root, "baseline.json"), JSON.stringify({ label: "fixture-label-SECRET_VALUE", args: ["--token", "fixture command output SECRET_VALUE"] })), "repository_baseline:declaration_malformed"]
  ]) {
    const fx = fixture(); const client = new LifecycleClient(); fx.config.executionProviderFactory = () => new AppServerExecutionProvider({ client }); const router = new SwarmRouter(fx.config); const coordinator = new DeliveryCoordinator(router);
    try {
      prepare(fx); const blocked = await coordinator.begin({ source: fx.source, ...remoteAdapters(calls()) }); const bootstrap = router.list().find((item) => item.role === "bootstrap"); const serialized = JSON.stringify({ blocked, status: router.statusSnapshot(), bootstrap });
      assert.equal(blocked.state, "blocked_repository_baseline", kind); assert.deepEqual(blocked.publish.codes, [code], kind); assert.equal(bootstrap.status, "blocked_repository_baseline", kind); assert.deepEqual(client.goals, [], kind); assert.equal(router.list().some((item) => item.role === "planner"), false, kind);
      for (const secret of ["fixture-label-SECRET_VALUE", "baseline.json", "fixture command output SECRET_VALUE"]) assert.equal(serialized.includes(secret), false, kind);
    } finally { router.close(); rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("planner rejects missing, unknown, and out-of-scope behavior coverage before worker creation", async () => {
  const variants = [
    ["missing", (() => { const plan = protectedPlan(); delete plan.tasks[0].baselineBehaviorIds; return plan; })()],
    ["unknown", protectedPlan({ behaviorIds: ["unknown-behavior"] })],
    ["out-of-scope", { blueprintId: "pb-test", tasks: [{ ...protectedPlan().tasks[0], allowedPaths: ["lib/disjoint.mjs"], baselineBehaviorIds: ["value-preserved"] }] }]
  ];
  for (const [label, plan] of variants) {
    const fx = fixture(); const client = new LifecycleClient({ plan }); fx.config.executionProviderFactory = () => new AppServerExecutionProvider({ client }); const router = new SwarmRouter(fx.config);
    try {
      const result = await new DeliveryCoordinator(router).begin({ source: fx.source, ...remoteAdapters(calls()) });
      assert.equal(result.state, "failed", label); assert.equal(router.list().some((item) => item.role === "backend"), false, label); assert.equal(client.goals.some((goal) => /^Writer /.test(goal.objective)), false, label);
    } finally { router.close(); rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("unchanged brownfield candidate resumes with its exact baseline, while legacy and stale records cannot publish", async () => {
  const fx = fixture(); const count = calls(); const client = new LifecycleClient(); fx.config.executionProviderFactory = () => new AppServerExecutionProvider({ client }); const router = new SwarmRouter(fx.config); const coordinator = new DeliveryCoordinator(router);
  try {
    const blockedCi = await coordinator.begin({ source: fx.source, ...remoteAdapters(count, { ci: "timed_out" }) }); const baseline = router.store.repositoryBaselineForRun(blockedCi.id); const goalCount = client.goals.length;
    const resumed = await coordinator.resume(remoteAdapters(count));
    assert.equal(blockedCi.state, "blocked_ci"); assert.equal(resumed.state, "completed_merged"); assert.equal(client.goals.length, goalCount); assert.equal(router.store.repositoryBaselineForRun(resumed.id).digest, baseline.digest);
  } finally { router.close(); rmSync(fx.root, { recursive: true, force: true }); }

  const legacy = fixture(); const legacyClient = new LifecycleClient(); legacy.config.executionProviderFactory = () => new AppServerExecutionProvider({ client: legacyClient }); const legacyRouter = new SwarmRouter(legacy.config); const legacyCount = calls();
  try {
    const bootstrap = legacyRouter.enqueue({ role: "bootstrap", title: "legacy", prompt: "legacy" }); const run = legacyRouter.createDeliveryRun({ id: "legacy-brownfield-candidate", bootstrapTaskId: bootstrap.id, repositoryMode: "brownfield", repositoryBaseSha: null }); legacyRouter.store.linkTaskToDelivery(bootstrap.id, run.id); legacyRouter.store.updateDeliveryRun(run.id, { state: "interrupted", integrationPath: "missing-manifest", candidate: { branch: "swarm/candidate/legacy", sha: "a".repeat(40) } });
    const blocked = await new DeliveryCoordinator(legacyRouter).resume(remoteAdapters(legacyCount));
    assert.equal(blocked.state, "blocked_repository_baseline"); assert.deepEqual(legacyCount, calls()); assert.deepEqual(legacyClient.goals, []);
  } finally { legacyRouter.close(); rmSync(legacy.root, { recursive: true, force: true }); }
});

test("stale declaration, base/tree, and stored baseline stop interrupted resume before any App Server or remote call", async () => {
  const mutations = [
    ["declaration", (fx) => writeFileSync(join(fx.root, "baseline.json"), JSON.stringify({ ...fx.baseline, behaviors: [{ ...fx.baseline.behaviors[0], label: "changed" }] }))],
    ["base", (fx) => git(fx.root, ["commit", "--allow-empty", "-m", "move-base"])],
    ["tree", (fx) => { writeFileSync(join(fx.root, "src", "value.mjs"), "export const value = 99;\n"); git(fx.root, ["add", "src/value.mjs"]); git(fx.root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "move-tree"]); }],
    ["baseline", (_fx, router, run) => { const row = router.store.repositoryBaselineForRun(run.id); row.digest = "0".repeat(64); router.store.db.prepare("UPDATE repository_baselines SET baseline_json = ? WHERE delivery_run_id = ?").run(JSON.stringify(row), run.id); }]
  ];
  for (const [label, mutate] of mutations) {
    const fx = fixture(); const client = new LifecycleClient(); const { router, run } = await persistedBaseline(fx, client); const count = calls();
    try {
      mutate(fx, router, run); const blocked = await new DeliveryCoordinator(router).resume(remoteAdapters(count));
      assert.equal(blocked.state, "blocked_repository_baseline", label); assert.match(blocked.publish.reason, /^repository_baseline:[a-z_]+$/, label); assert.deepEqual(count, calls(), label); assert.deepEqual(client.goals, [], label);
    } finally { router.close(); rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("scoped replan retains a valid baseline and a stale baseline blocks recovery Planner creation", async () => {
  for (const stale of [false, true]) {
    const fx = fixture({ plan: protectedPlan() }); const client = new LifecycleClient({ plan: protectedPlan(), scopedPlan: recoveryPlan(), onTurn: (goal) => { if (/^Scoped recovery plan /.test(goal)) client.events.push("scoped-planner-turn"); } }); fx.config.executionProviderFactory = () => new AppServerExecutionProvider({ client }); const router = new SwarmRouter(fx.config); const coordinator = new DeliveryCoordinator(router);
    try {
      const initial = await coordinator.begin({ source: fx.source, ...remoteAdapters(calls(), { ci: "timed_out" }) }); const run = router.store.deliveryRun(initial.id); router.store.updateDeliveryRun(run.id, { state: "running" });
      const writer = router.enqueue({ role: "backend", title: "failed writer", prompt: "failed writer", allowedPaths: ["src/value.mjs"], requirementIds: ["fix-value"], baselineBehaviorIds: ["value-preserved"], blueprintId: "pb-test", deliveryRunId: run.id }); router.store.transition(writer.id, "preparing"); router.store.transition(writer.id, "running"); assert.ok(router.recordDependencyContractChange(writer.id, "deterministic recovery"));
      const baselineDigest = router.store.repositoryBaselineForRun(run.id).digest;
      if (stale) writeFileSync(join(fx.root, "baseline.json"), JSON.stringify({ ...fx.baseline, behaviors: [{ ...fx.baseline.behaviors[0], label: "stale" }] }));
      const result = await router.runUntilIdle({ deliveryRunId: run.id });
      if (stale) { assert.equal(result.repositoryBaselineBlocked, true); assert.equal(client.events.includes("scoped-planner-turn"), false); assert.equal(router.store.scopedReplans(run.id)[0].status, "fatal"); }
      else { assert.equal(client.events.includes("scoped-planner-turn"), true); assert.equal(router.store.repositoryBaselineForRun(run.id).digest, baselineDigest); assert.ok(router.store.scopedReplans(run.id)[0].plannerTaskId); }
    } finally { router.close(); rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("legacy and greenfield router flows remain baseline-free", async () => {
  for (const mode of ["legacy", "greenfield"]) {
    const fx = fixture(); fx.config.project.repositoryMode = mode; fx.config.project.repositoryBaselineDeclaration = null; const router = new SwarmRouter(fx.config);
    try { await router.ensureProjectOverlay(); assert.equal(router.captureRepositoryBaselineDraft(await router.ensureProjectOverlay()), null, mode); assert.equal(router.statusSnapshot().repositoryBaseline, null, mode); }
    finally { router.close(); rmSync(fx.root, { recursive: true, force: true }); }
  }
});
