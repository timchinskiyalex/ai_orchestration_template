import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { assertObservedParallelTurns, preserveOrCleanupDisposableRoot, withE2eTimeout } from "../src/e2e-smoke.mjs";
import { parseLiveE2eWorkers } from "../src/live-e2e-contract.mjs";
import { SwarmRouter } from "../src/router.mjs";

const enabled = process.env.RUN_REAL_G2G3_LOCAL_CANDIDATE_E2E === "1";
const workers = parseLiveE2eWorkers(process.env.CODEX_E2E_WORKERS ?? 2);
const timeoutMs = Number(process.env.CODEX_E2E_TIMEOUT_MS ?? 300_000);
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("real G2/G3 raw-Markdown local candidate: two parallel writers, no remote publication", { skip: enabled ? false : "set RUN_REAL_G2G3_LOCAL_CANDIDATE_E2E=1 via npm run e2e:g2g3-local-candidate -- --confirm-spend-quota --workers 2" }, async () => {
  assert.equal(workers, 2, "this acceptance fixture requires exactly two writers");
  assert.equal(Number.isInteger(timeoutMs) && timeoutMs >= 1_000, true, "CODEX_E2E_TIMEOUT_MS must be at least 1000");
  const root = mkdtempSync(join(tmpdir(), "orchestration-g2g3-local-candidate-")); const source = join(root, "raw-requirements"); let router; let passed = false;
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(source, { recursive: true }); mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
    writeFileSync(join(source, "requirements.md"), "# Local candidate fixture\nImplement `src/alpha.mjs` exporting `alpha = true`.\nImplement `src/beta.mjs` exporting `beta = true`.\nBoth requirements are mandatory and must be independently implemented.\n");
    // The actual acceptance contract is the controller's exact-SHA ProductEvidence
    // execution. This stable command keeps writer QA deterministic across the two
    // independent files while the App Server performs the real writer turns.
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, packageManager: "npm@10", scripts: { test: "node --test test/smoke.test.mjs" } }));
    writeFileSync(join(root, "test", "smoke.test.mjs"), "import test from 'node:test'; test('controller fixture', () => {});\n");
    git(root, ["add", "."]); git(root, ["-c", "user.name=G2G3", "-c", "user.email=g2g3@example.test", "commit", "-m", "base"]);
    const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 40_000, interruptThresholdTokens: 35_000, usesWorktree: role === "backend" }]));
    router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: process.env.CODEX_E2E_MODEL ?? "gpt-5.6-terra", project: { name: "g2g3-local-candidate", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" }, router: { maxConcurrentTasks: workers, maxChildrenPerTask: 12, maxDelegationDepth: 3, maxPlanTasks: 8, defaultParentBudget: 120_000, turnTimeoutMs: timeoutMs, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 1 }, budget: { weeklyTokenLimit: 180_000, weeklyWindowDays: 7, hardRunTokenLimit: 150_000, interruptSafetyMarginTokens: 1_000, enforceLocalLimits: false }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxWaves: 2, maxRemediationRounds: 1, shutdownGraceMs: 3_000 }, remote: { enabled: false, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: false, mergeMethod: "merge" }, roles });
    const lifecycle = []; router.on("lifecycle", (event) => lifecycle.push(event));
    const coordinator = new DeliveryCoordinator(router);
    const final = await withE2eTimeout({ timeoutMs, operation: () => coordinator.begin({ source }), diagnostics: () => JSON.stringify({ run: router.store.currentDeliveryRun(), tasks: router.list().map((item) => ({ id: item.id, role: item.role, status: item.status })) }), onTimeout: () => router.requestShutdown("interrupted_controller_exit: G2/G3 live fixture timeout") });
    assert.equal(final.state, "completed_candidate_ready"); assert.equal(final.sourceClaimInputMode, "raw"); assert.ok(final.sourceClaimExtractionId && final.sourceClaimAuditId && final.sourceClaimManifestId);
    assert.equal(final.publish.localCandidate, true); assert.equal(final.publish.remoteEnabled, false); assert.equal(router.store.db.prepare("SELECT COUNT(*) AS count FROM external_actions").get().count, 0, "remote adapters must not be invoked");
    const writerTurns = lifecycle.filter((event) => event.type === "turn started" && router.store.getTask(event.taskId)?.role === "backend"); assert.equal(writerTurns.length, 2, "the raw fixture must execute exactly two real writer turns"); assertObservedParallelTurns(lifecycle.filter((event) => writerTurns.some((turn) => turn.taskId === event.taskId)), 2);
    const acceptance = router.store.productAcceptanceForRun(final.id); assert.equal(acceptance.passing, true); assert.equal(acceptance.report.candidateSha, final.candidate.sha); assert.ok(acceptance.report.results.filter((item) => item.criterionId).every((item) => item.status === "pass"));
    passed = true;
  } finally {
    try { router?.stop(); router?.close(); } catch { /* preserve the primary result */ }
    preserveOrCleanupDisposableRoot(root, { passed });
  }
});
