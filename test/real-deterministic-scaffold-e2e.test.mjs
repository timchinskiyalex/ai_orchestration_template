import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { SwarmRouter } from "../src/router.mjs";
import { assertMaxObservedActiveTurns, assertObservedParallelTurns, formatE2eDiagnostics, preserveOrCleanupDisposableRoot, withE2eTimeout } from "../src/e2e-smoke.mjs";
import { openE2eRunReporter } from "../src/e2e-report.mjs";
import { ingestDocumentation } from "../src/project-intake.mjs";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { sourceFragmentDigest } from "../src/source-evidence.mjs";
import { fakeBlueprint } from "./product-blueprint-fixture.mjs";
import { deterministicScaffoldFixtureRouterConfig, parseLiveE2eWorkers, selectLiveE2eFailureTask } from "../src/live-e2e-contract.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const enabled = process.env.RUN_REAL_CODEX_E2E === "1";
const timeoutMs = Number(process.env.CODEX_E2E_TIMEOUT_MS ?? 240_000);
const workerCount = parseLiveE2eWorkers(process.env.CODEX_E2E_WORKERS ?? 1);
const reporter = process.env.E2E_REPORT_DIR ? openE2eRunReporter(process.env.E2E_REPORT_DIR) : null;
const productRoots = [{ id: "frontend", path: "frontend", adapter: "next-node" }, { id: "backend", path: "backend", adapter: "dotnet" }];

test("live E2E fixture receives the CLI worker count", { skip: process.env.CODEX_E2E_WORKER_CONFIG_PROBE === "1" ? false : "worker propagation probe only" }, () => {
  const router = deterministicScaffoldFixtureRouterConfig({ workers: workerCount, timeoutMs });
  assert.equal(router.maxConcurrentTasks, workerCount);
  console.log(`worker-config-probe fixture.maxConcurrentTasks=${router.maxConcurrentTasks}`);
});

test("real App Server controlled E2E: deterministic scaffold, parallel writers, controller QA, and integration", { skip: enabled ? false : "set RUN_REAL_CODEX_E2E=1 to intentionally spend account quota" }, async () => {
  assert.equal(Number.isInteger(timeoutMs) && timeoutMs >= 1_000, true, "CODEX_E2E_TIMEOUT_MS must be an integer of at least 1000");
  const root = mkdtempSync(join(tmpdir(), "orchestration-real-greenfield-e2e-")); const source = join(root, "e2e-source");
  let router; let integration; let execution; let succeeded = false; let currentTaskId = null; const lifecycle = [];
  const progress = (stage, details = {}) => { console.log(`[E2E] ${stage}`); reporter?.event(stage, details); };
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => {
    const tokenBudget = role === "devops" ? 3_000 : ["backend", "frontend"].includes(role) ? 50_000 : 20_000;
    const interruptThresholdTokens = role === "devops" ? 2_000 : ["backend", "frontend"].includes(role) ? 45_000 : 16_000;
    return [role, { sandbox: ["backend", "frontend", "devops"].includes(role) ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget, interruptThresholdTokens, usesWorktree: ["backend", "frontend", "devops"].includes(role) }];
  }));
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(source, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "runtime/\n**/bin/\n**/obj/\n**/node_modules/\n**/.next/\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "controller-only", private: true }));
    const sourceText = "Build the frontend and backend E2E markers.\n";
    const sourceFile = { documentId: documentIdForPath("brief.md"), path: "brief.md", sha256: createHash("sha256").update(sourceText).digest("hex") };
    const sourceRef = { documentId: sourceFile.documentId, startLine: 1, endLine: 1, excerptDigest: sourceFragmentDigest(sourceText, 1, 1) };
    writeFileSync(join(source, "brief.md"), sourceText);
    writeFileSync(join(source, "source-claims.json"), JSON.stringify({ schemaVersion: 1, kind: "SourceClaimsDeclaration", documentSetDigest: documentSetDigest([sourceFile]), documents: [{ ...sourceFile, coverage: [{ claimId: "e2e-marker-claim", ...sourceRef }] }], claims: [{ claimId: "e2e-marker-claim", classification: "mandatory", sourceRefs: [sourceRef] }] }));
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    // This E2E isolates successful controller lifecycle integration. The
    // quota-free suite separately exercises enforced thresholds and delayed
    // usage interrupts; the upstream protocol has no server-side turn cap.
    router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: process.env.CODEX_E2E_MODEL ?? "gpt-5.6-terra", project: { name: "disposable-greenfield-e2e", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", projectMode: { schemaVersion: 1, kind: "ProjectMode", mode: "greenfield" }, productRoots }, router: deterministicScaffoldFixtureRouterConfig({ workers: workerCount, timeoutMs }), autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: false, autoCreatePullRequest: false, autoMerge: false, maxRemediationRounds: 1 }, budget: { weeklyTokenLimit: 180_000, weeklyWindowDays: 7, hardRunTokenLimit: 150_000, interruptSafetyMarginTokens: 1_000, enforceLocalLimits: false }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 1, shutdownGraceMs: 3_000 }, remote: { enabled: false, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: false, mergeMethod: "merge" }, roles });
    router.on("lifecycle", (event) => { lifecycle.push(event); if (event.taskId) currentTaskId = event.taskId; progress(event.type, event); });
    await router.ensureProjectOverlay(); ingestDocumentation({ source, repository: root, destinationRelative: "docs/orchestration-input" });
    const manifestId = router.sourceClaimManifestIdentity();
    const run = router.createDeliveryRun({ id: "real-greenfield-e2e", source, bootstrapTaskId: null, sourceClaimInputMode: "supplied", sourceClaimManifestId: manifestId, projectMode: router.projectMode, repositoryMode: "greenfield" });
    const admitted = router.admitPrecompiledPlan({ deliveryRunId: run.id, blueprint: fakeBlueprint(root), plan: { blueprintId: "pb-test", tasks: [
      { id: "scaffold-product", title: "Scaffold product roots", prompt: "Create all declared product roots.", primaryDomain: "devops", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 1_000, dependsOn: [], allowedPaths: ["frontend", "backend"], acceptanceChecks: ["frontend and backend scaffolded"], requirementIds: ["fix-value"] },
      { id: "frontend-marker", title: "Add frontend E2E marker", prompt: "Create only frontend/app/e2e-marker.tsx exporting a simple React component named E2eMarker. Do not create agents, commits, or explanations; finish the file and return the structured result.", primaryDomain: "frontend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 4_000, dependsOn: ["scaffold-product"], allowedPaths: ["frontend/app/e2e-marker.tsx"], acceptanceChecks: ["frontend marker exists"], requirementIds: ["fix-value"] },
      { id: "backend-marker", title: "Add backend E2E marker", prompt: "Create only backend/src/Backend.Api/E2eMarker.cs containing a valid simple static C# class named E2eMarker. Do not create agents, commits, or explanations; finish the file and return the structured result.", primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 4_000, dependsOn: ["scaffold-product"], allowedPaths: ["backend/src/Backend.Api/E2eMarker.cs"], acceptanceChecks: ["backend marker exists"], requirementIds: ["fix-value"] }
    ] } });
    const planned = router.list(); const scaffold = planned.find((task) => task.title === "Scaffold product roots"); const frontend = planned.find((task) => task.title === "Add frontend E2E marker"); const backend = planned.find((task) => task.title === "Add backend E2E marker");
    currentTaskId = scaffold.id; progress("controller plan admitted", { deliveryRunId: admitted.deliveryRun.id, scaffold: scaffold.id, frontend: frontend.id, backend: backend.id });
    await withE2eTimeout({ timeoutMs, operation: async () => {
      execution = await router.runUntilIdle({ deliveryRunId: run.id });
      if (execution.blockedQuota) throw new Error("blocked_quota: App Server account quota refused the controlled E2E");
      if (execution.blockedBudget) throw new Error("blocked_budget: the controlled E2E reached its configured local guardrail");
      if (execution.failed || execution.interrupted) throw new Error("controlled E2E worker lifecycle did not reach a successful terminal state");
    }, diagnostics: (runtime) => formatE2eDiagnostics({ stage: "workers", taskId: currentTaskId, task: router.store.getTask(currentTaskId), runtime }), onTimeout: async () => { const diagnostics = await router.collectTaskDiagnostics(currentTaskId); reporter?.setDiagnostics(diagnostics); await router.requestShutdown("interrupted_controller_exit: controlled E2E timeout"); return diagnostics; } });
    const allTasks = router.list();
    const scaffoldReviews = allTasks.filter((task) => task.sourceWriterTaskId === scaffold.id);
    const tasks = [scaffold, frontend, backend].map((task) => router.store.getTask(task.id));
    assert.equal(tasks.every((task) => task.status === "done"), true, "all deterministic scaffold and writer tasks must pass");
    assert.deepEqual(scaffoldReviews.map((task) => task.role), ["security", "qa"], "deterministic scaffold must retain its explicit controller-local Security -> QA chain");
    assert.equal(scaffoldReviews.every((task) => router.store.getTask(task.id).status === "done"), true, "controller-local scaffold reviews must pass before writers are released");
    assert.equal(router.store.workerArtifact(scaffold.id) !== null, true);
    assert.equal(lifecycle.some((event) => event.type === "turn started" && event.taskId === scaffold.id), false, "scaffold must not spend an App Server turn");
    assert.equal(lifecycle.some((event) => event.type === "turn started" && scaffoldReviews.some((task) => task.id === event.taskId)), false, "controller-local scaffold reviews must not spend App Server turns");
    const startedRoles = lifecycle.filter((event) => event.type === "turn started").map((event) => router.store.getTask(event.taskId)?.role).sort();
    assert.deepEqual(startedRoles, ["backend", "frontend", "qa", "qa", "security", "security"], "the live fixture must start exactly the two writer and four provider-owned review turns");
    assertMaxObservedActiveTurns(lifecycle, workerCount);
    if (workerCount >= 2) assertObservedParallelTurns(lifecycle, 2);
    assert.equal(execution.dependencyDeadlock, null, "provider failure must not be relabelled as dependency_deadlock");
    const artifacts = [scaffold, frontend, backend].map((task) => router.store.workerArtifact(task.id));
    assert.equal(artifacts.every((artifact) => artifact.verificationResults.every((result) => result.status === "passed")), true, "controller QA verification must pass for every artifact");
    progress("controller QA/local verification passed");
    integration = await router.integrateFinalized([scaffold.id, frontend.id, backend.id]);
    assert.equal(integration.manifest.status, "candidate_ready");
    progress("integration passed", { candidateBranch: integration.manifest.branch, integrationPath: integration.path });
    reporter?.finalize({ status: "passed", task: router.store.getTask(frontend.id), artifact: router.store.workerArtifact(frontend.id), integration, diagnostics: router.appServerDiagnostics() });
    succeeded = true;
  } catch (error) {
    const task = router ? selectLiveE2eFailureTask(router.list(), currentTaskId) : null;
    const delivery = router?.activeDeliveryRunId ? router.store.deliveryRun(router.activeDeliveryRunId) : null;
    const diagnostics = task && router ? await router.collectTaskDiagnostics(task.id) : router?.appServerDiagnostics();
    reporter?.finalize({ status: "failed", task, integration, diagnostics: { ...diagnostics, primaryFailure: delivery?.recovery?.primaryFailure ?? null, dependencyDeadlocks: router ? router.store.db.prepare("SELECT outcome_json AS outcome FROM dependency_deadlocks").all().map((item) => JSON.parse(item.outcome)) : [] }, error, recoveryRoot: root, recoveryAction: `Preserved disposable E2E root: ${root}` });
    throw error;
  } finally {
    try { router?.stop(); router?.close(); } catch { /* preserve the primary result */ }
    const recovery = preserveOrCleanupDisposableRoot(root, { passed: succeeded });
    if (!succeeded) reporter?.update(recovery);
  }
});
