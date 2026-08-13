import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";
import { AppServerExecutionProvider } from "../src/app-server-execution-provider.mjs";
import { fakeBlueprint } from "./product-blueprint-fixture.mjs";
import { createHash } from "node:crypto";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { sourceFragmentDigest } from "../src/source-evidence.mjs";
import { ingestDocumentation } from "../src/project-intake.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const productRoots = [{ id: "frontend", path: "frontend", adapter: "next-node" }, { id: "backend", path: "backend", adapter: "dotnet" }];
const fakeProcessRunner = async ({ executable, args }) => ({ pid: 4242, executable, args, stdout: "deterministic verification passed", stderr: "", code: 0, signal: null });

class DeterministicLifecycleClient extends EventEmitter {
  constructor() { super(); this.next = 0; this.threads = new Map(); this.scaffoldTurnStarts = 0; this.activeWriters = 0; this.maxActiveWriters = 0; this.writerBarrier = []; }
  async connect() {}
  shutdown() {}
  diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.next}`; this.threads.set(id, { cwd, goal: "", turns: 0 }); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; }
  async startTurn({ threadId }) { const thread = this.threads.get(threadId); thread.turns += 1; if (/^Scaffold product roots\n\n/.test(thread.goal)) this.scaffoldTurnStarts += 1; return { turn: { id: `${threadId}-turn-${thread.turns}` } }; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    const writer = /^Build (frontend|backend) feature/.test(thread.goal);
    if (writer) {
      this.activeWriters += 1; this.maxActiveWriters = Math.max(this.maxActiveWriters, this.activeWriters);
      if (this.activeWriters >= 2) { for (const release of this.writerBarrier.splice(0)) release(); }
      else await Promise.race([new Promise((resolve) => this.writerBarrier.push(resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (/frontend/.test(thread.goal)) writeFileSync(join(thread.cwd, "frontend", "app", "feature.tsx"), "export const feature = true;\n");
      else writeFileSync(join(thread.cwd, "backend", "src", "Backend.Api", "Feature.cs"), "namespace Backend.Api; public static class Feature { public const bool Enabled = true; }\n");
      this.activeWriters -= 1;
    }
    return { id: turnId, status: "completed" };
  }
  async readThread({ threadId }) {
    const goal = this.threads.get(threadId).goal;
    const text = /^Bootstrap/.test(goal)
      ? `\`\`\`json\n${JSON.stringify(fakeBlueprint(this.threads.get(threadId).cwd))}\n\`\`\``
      : /^Plan /.test(goal)
        ? "```json\n{\"blueprintId\":\"pb-test\",\"tasks\":[{\"id\":\"scaffold-product\",\"title\":\"Scaffold product roots\",\"prompt\":\"Create every declared product root\",\"primaryDomain\":\"devops\",\"supportingDomains\":[],\"riskFlags\":[],\"humanApprovalRequired\":false,\"estimatedTokens\":20,\"dependsOn\":[],\"allowedPaths\":[\"frontend\",\"backend\"],\"acceptanceChecks\":[\"roots exist\"],\"requirementIds\":[\"fix-value\"]},{\"id\":\"frontend-feature\",\"title\":\"Build frontend feature\",\"prompt\":\"Create frontend feature\",\"primaryDomain\":\"frontend\",\"supportingDomains\":[],\"riskFlags\":[],\"humanApprovalRequired\":false,\"estimatedTokens\":20,\"dependsOn\":[\"scaffold-product\"],\"allowedPaths\":[\"frontend\"],\"acceptanceChecks\":[\"feature exists\"],\"requirementIds\":[\"fix-value\"]},{\"id\":\"backend-feature\",\"title\":\"Build backend feature\",\"prompt\":\"Create backend feature\",\"primaryDomain\":\"backend\",\"supportingDomains\":[],\"riskFlags\":[],\"humanApprovalRequired\":false,\"estimatedTokens\":20,\"dependsOn\":[\"scaffold-product\"],\"allowedPaths\":[\"backend\"],\"acceptanceChecks\":[\"feature exists\"],\"requirementIds\":[\"fix-value\"]}]}\n```"
        : /^Security review:/.test(goal) || /^QA:/.test(goal)
          ? "```json\n{\"verdict\":\"pass\",\"summary\":\"ok\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```"
          : "writer complete";
    const thread = this.threads.get(threadId);
    return { thread: { turns: [{ id: `${threadId}-turn-${thread.turns}`, items: [{ type: "agentMessage", text }] }] } };
  }
}

function configuration(root, client) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: ["backend", "frontend", "devops"].includes(role) ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, interruptThresholdTokens: 80, usesWorktree: ["backend", "frontend", "devops"].includes(role) }]));
  return { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", processRunner: fakeProcessRunner, project: { name: "deterministic-greenfield", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", projectMode: { schemaVersion: 1, kind: "ProjectMode", mode: "greenfield" }, productRoots }, router: { maxConcurrentTasks: 3, maxChildrenPerTask: 20, maxDelegationDepth: 5, maxPlanTasks: 8, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 2 }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7, hardRunTokenLimit: 5000, interruptSafetyMarginTokens: 20, enforceLocalLimits: true }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 2, leaseHeartbeatMs: 250, staleLeaseMs: 250, shutdownGraceMs: 250 }, remote: { enabled: true, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: true, mergeMethod: "merge" }, roles, executionProviderFactory: () => new AppServerExecutionProvider({ client }) };
}

test("deterministic scaffold creates a WorkerArtifact before two dependent writers run in parallel", async () => {
  const root = mkdtempSync(join(tmpdir(), "deterministic-scaffold-")); const source = join(root, "requirements"); const client = new DeterministicLifecycleClient(); let router;
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(source); const text = "# Product\nCreate frontend and backend."; const file = { documentId: documentIdForPath("spec.md"), path: "spec.md", sha256: createHash("sha256").update(text).digest("hex") }; const ref = (line) => ({ documentId: file.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(text, line, line) }); writeFileSync(join(source, "spec.md"), text); writeFileSync(join(source, "source-claims.json"), JSON.stringify({ schemaVersion: 1, kind: "SourceClaimsDeclaration", documentSetDigest: documentSetDigest([file]), documents: [{ ...file, coverage: [{ claimId: "fix-value-claim", ...ref(1) }, { claimId: "context-claim", ...ref(2) }] }], claims: [{ claimId: "fix-value-claim", classification: "mandatory", sourceRefs: [ref(1)] }, { claimId: "context-claim", classification: "non_mandatory", sourceRefs: [ref(2)] }] })); writeFileSync(join(root, "package.json"), JSON.stringify({ name: "controller-only" })); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    router = new SwarmRouter(configuration(root, client));
    await router.ensureProjectOverlay(); ingestDocumentation({ source, repository: root, destinationRelative: "docs/orchestration-input" });
    const manifestId = router.sourceClaimManifestIdentity();
    const run = router.createDeliveryRun({ id: "precompiled-greenfield", source, bootstrapTaskId: null, sourceClaimInputMode: "supplied", sourceClaimManifestId: manifestId, projectMode: router.projectMode, repositoryMode: "greenfield" });
    router.admitPrecompiledPlan({ deliveryRunId: run.id, blueprint: fakeBlueprint(root), plan: { blueprintId: "pb-test", tasks: [
      { id: "scaffold-product", title: "Scaffold product roots", prompt: "Create every declared product root", primaryDomain: "devops", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 20, dependsOn: [], allowedPaths: ["frontend", "backend"], acceptanceChecks: ["roots exist"], requirementIds: ["fix-value"] },
      { id: "frontend-feature", title: "Build frontend feature", prompt: "Create frontend feature", primaryDomain: "frontend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 20, dependsOn: ["scaffold-product"], allowedPaths: ["frontend"], acceptanceChecks: ["feature exists"], requirementIds: ["fix-value"] },
      { id: "backend-feature", title: "Build backend feature", prompt: "Create backend feature", primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 20, dependsOn: ["scaffold-product"], allowedPaths: ["backend"], acceptanceChecks: ["feature exists"], requirementIds: ["fix-value"] }
    ] } });
    await router.runUntilIdle({ deliveryRunId: run.id });
    const scaffold = router.list().find((task) => task.title === "Scaffold product roots");
    assert.equal(router.store.deliveryRun(run.id).projectMode.mode, "greenfield");
    assert.equal(client.scaffoldTurnStarts, 0, "the App Server never receives a scaffold turn");
    assert.ok(router.store.workerArtifact(scaffold.id));
    assert.equal(existsSync(join(scaffold.worktree, "frontend", "package.json")), true);
    assert.equal(existsSync(join(scaffold.worktree, "backend", "Backend.sln")), true);
    assert.equal(existsSync(join(scaffold.worktree, "backend", "src", "Backend.Api", "Backend.Api.csproj")), true);
    assert.ok(client.maxActiveWriters >= 2, "independent writers overlap after the artifact is finalized");
    const writers = router.list().filter((task) => ["Build frontend feature", "Build backend feature"].includes(task.title));
    assert.equal(writers.every((task) => task.dependencies.includes(scaffold.id) && task.status === "done" && router.store.workerArtifact(task.id)), true);
    assert.ok(router.lifecycleEvents().some((event) => event.type === "deterministic scaffold completed"));
    assert.equal((await router.integrateFinalized([scaffold.id, ...writers.map((task) => task.id)])).manifest.status, "candidate_ready");
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
