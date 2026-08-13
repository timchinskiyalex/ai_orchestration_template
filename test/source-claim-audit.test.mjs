import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { documentIdForPath, documentSetDigest, policyDigest } from "../src/product-blueprint.mjs";
import { canonicalizeSourceClaimExtractionCandidate, createImportedSourceResolver, sourceClaimCandidateId, sourceFragmentDigest, validateSourceClaimExtraction } from "../src/source-evidence.mjs";
import { admitAuditedSourceClaims, auditSubjectFromExtraction, normalizedSourceUnits, validateSourceClaimAudit } from "../src/source-claim-audit.mjs";
import { provider } from "./execution-provider-test-adapter.mjs";
import { CodexAppServerRuntime } from "../src/codex-app-server-runtime.mjs";

const digest = (value) => createHash("sha256").update(value.replace(/\r\n?/g, "\n")).digest("hex");
const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: false }]));

class AuditClient extends EventEmitter {
  constructor(options) { super(); const { extraction, audit, aliasRoles = [], unavailableRoles = [] } = options; this.extraction = extraction; this.audit = audit; this.aliasRoles = new Set(aliasRoles); this.unavailableRoles = new Set(unavailableRoles); this.id = 0; this.calls = []; this.threads = new Map(); }
  async connect() {} async shutdown() { this.calls.push("shutdown"); }
  async startThread() { const id = `thread-${++this.id}`; this.threads.set(id, {}); this.calls.push("start_thread"); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; this.calls.push(objective); }
  #role(threadId) { return /^Extract atomic/.test(this.threads.get(threadId).goal) ? "source_claim_extraction" : /^Independently audit/.test(this.threads.get(threadId).goal) ? "source_claim_audit" : "unknown"; }
  async startTurn({ threadId }) { const requestedTurnId = `turn-${threadId}`; const role = this.#role(threadId); this.threads.get(threadId).turn = { requestedTurnId, resolvedTurnId: this.aliasRoles.has(role) ? `${requestedTurnId}-resolved` : requestedTurnId }; return { turn: { id: requestedTurnId } }; }
  async waitForTurn(threadId, turnId) {
    const state = this.threads.get(threadId); const { resolvedTurnId } = state.turn;
    if (resolvedTurnId !== turnId) {
      this.emit("protocol", { method: "turn-id-alias", threadId, requestedTurnId: "stale-requested", resolvedTurnId });
      this.emit("protocol", { method: "turn-id-alias", threadId, requestedTurnId: turnId, resolvedTurnId });
      this.emit("protocol", { method: "turn-id-alias", threadId, requestedTurnId: turnId, resolvedTurnId });
    }
    this.emit?.("notification", { method: "turn/completed", params: { threadId, turn: { id: resolvedTurnId, status: "completed" } } });
    this.emit?.("notification", { method: "turn/completed", params: { threadId, turn: { id: resolvedTurnId, status: "completed" } } });
    return { id: resolvedTurnId, status: "completed" };
  }
  async readTerminalTurn(threadId) { const state = this.threads.get(threadId); return { terminal: { id: state.turn.resolvedTurnId, status: "completed" } }; }
  async readThread({ threadId }) {
    const goal = this.threads.get(threadId).goal; const role = this.#role(threadId);
    if (this.unavailableRoles.has(role)) throw new Error("thread/read: thread not loaded");
    const result = /^Extract atomic/.test(goal) ? this.extraction() : /^Independently audit/.test(goal) ? this.audit() : "not-json";
    this.calls.push(/^Extract atomic/.test(goal) ? "extraction_result" : /^Independently audit/.test(goal) ? "audit_result" : "other_result");
    return { thread: { turns: [{ id: this.threads.get(threadId).turn.resolvedTurnId, status: "completed", items: [{ type: "agentMessage", text: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` }] }] } };
  }
}

function fixture({ supplied = false, auditVariant = "admitted", auditMutator = null, policyRegistry = { schemaVersion: 1, policies: [] }, aliasRoles = [], unavailableRoles = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "source-claim-audit-")); const raw = join(root, "raw"); mkdirSync(raw);
  execFileSync("git", ["-C", root, "init", "-b", "main"]);
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "base", "--no-gpg-sign", "--author", "Audit Test <audit@example.test>"]);
  const text = "# Product\nUse token SUPERSECRET for deployment.\nUsers must sign in.\n";
  const path = "requirements.md"; const file = { documentId: documentIdForPath(path), path, sha256: digest(text) };
  writeFileSync(join(raw, path), text);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "audit-fixture", packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); execFileSync("git", ["-C", root, "add", "package.json", "package-lock.json"]); execFileSync("git", ["-C", root, "commit", "-m", "fixture-package", "--no-gpg-sign", "--author", "Audit Test <audit@example.test>"]);
  const claim = (line, claimType, normalizedStatement) => ({ claimType, normalizedStatement, classification: "mandatory", sourceLocation: { documentId: file.documentId, startLine: line, endLine: line } });
  const claims = [claim(1, "scope", "Product requirements."), claim(2, "constraint", "Deployment needs a token."), claim(3, "functional", "Users sign in.")];
  const extraction = () => ({ schemaVersion: 1, kind: "SourceClaimExtractionCandidate", claims });
  const audit = () => { const value = auditFor({ root, file, extraction: extraction(), variant: auditVariant, policyRegistry }); auditMutator?.(value); return value; };
  if (supplied) {
    const refs = [1, 2, 3].map((line) => ({ documentId: file.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(text, line, line) }));
    writeFileSync(join(raw, "source-claims.json"), JSON.stringify({ schemaVersion: 1, kind: "SourceClaimsDeclaration", documentSetDigest: documentSetDigest([file]), documents: [{ ...file, coverage: refs.map((ref, index) => ({ claimId: `supplied-${index + 1}`, ...ref })) }], claims: refs.map((ref, index) => ({ claimId: `supplied-${index + 1}`, classification: index === 1 ? "mandatory" : "non_mandatory", sourceRefs: [ref] })) }));
  }
  const client = new AuditClient({ extraction, audit, aliasRoles, unavailableRoles });
  const config = { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { documentationDir: "docs/in", generatedDir: "docs/out", repositoryMode: "legacy" }, router: { turnTimeoutMs: 1000, maxConcurrentTasks: 1, maxChildrenPerTask: 1, maxDelegationDepth: 1, maxPlanTasks: 1, defaultParentBudget: 100, approvalMode: "deny" }, delivery: { sourceClaimExtractionTokenBudget: 100, sourceClaimAuditTokenBudget: 100 }, budget: { weeklyTokenLimit: 1000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, autonomy: { mode: "autonomous" }, roles, specificationResolution: { policyRegistry }, executionProviderFactory: () => provider(client) };
  return { root, raw, text, file, claims, extraction, audit, client, config };
}

class FailingIntakeRuntime {
  constructor({ cwd, role, failure }) { this.cwd = cwd; this.role = role; this.failure = failure; }
  async connect() {} async shutdown() {} async diagnostics() { return { connected: true, closed: false, reconnectRequired: false, diagnostics: "bounded test diagnostic" }; }
  async startThread() { return { threadId: `thread-${this.role}` }; }
  async startGoalTurn({ threadId }) { return { threadId, turnId: `turn-${this.role}` }; }
  async observeTerminal({ threadId, turnId }) { return { kind: "worker_terminal_candidate", threadId: this.failure === "wrong_thread" ? "foreign-thread" : threadId, turnId: this.failure === "wrong_turn" ? "foreign-turn" : turnId, terminalClass: "completed" }; }
  async reconcileTerminal({ threadId, turnId }) {
    const terminalClass = this.failure === "missing_terminal_status" ? "running" : "completed";
    return { kind: "worker_completed", threadId, turnId, terminalClass, terminalReceipt: { schemaVersion: 1, kind: "AppServerTerminalReceipt", source: "turn_completed", capturedAt: "2026-01-01T00:00:00.000Z", providerConnectionId: "test-connection", correlationId: "test-correlation", threadId, requestedTurnId: turnId, resolvedTurnId: turnId, terminalClass } };
  }
  async readFinalResult({ threadId, turnId }) {
    if (this.failure === "final_result_unavailable") throw new Error("thread/read: thread not loaded");
    return { threadId, turnId, resultText: "not-json", providerRunId: `${threadId}:${turnId}` };
  }
}

function failRoleWithRuntime(fx, role, failure) {
  const providerFactory = fx.config.executionProviderFactory;
  fx.config.sourceIntakeRuntimeFactory = ({ cwd, role: requestedRole }) => requestedRole === role
    ? new FailingIntakeRuntime({ cwd, role, failure })
    : new CodexAppServerRuntime({ cwd, transport: providerFactory({ cwd }) });
}

function auditFor({ root, extraction, variant = "admitted", policyRegistry }) {
  const resolver = createImportedSourceResolver({ repository: root, documentationDir: "docs/in" });
  const verified = canonicalizeSourceClaimExtractionCandidate(extraction, { sourceResolver: resolver }); const subject = auditSubjectFromExtraction(verified);
  const target = subject.claims[1];
  const decisions = subject.claims.map((claim) => ({ claimId: claim.claimId, decision: claim.claimId === target.claimId && !["admitted", "omitted"].includes(variant) ? variant : "admitted", ...(claim.claimId === target.claimId && !["admitted", "omitted"].includes(variant) ? {} : { classification: "mandatory" }), reasonCodes: [claim.claimId === target.claimId && variant !== "admitted" ? variant.replace("-", "_") : "verified"], sourceRefs: claim.sourceRefs }));
  const coverage = normalizedSourceUnits(resolver).map((unit) => {
    const candidateClaimIds = subject.claims.filter((claim) => claim.sourceRefs.some((ref) => ref.documentId === unit.documentId && ref.startLine <= unit.startLine && ref.endLine >= unit.endLine)).map((claim) => claim.claimId).filter((id) => variant !== "omitted" || id !== target.claimId);
    const blocked = candidateClaimIds.includes(target.claimId) && !["admitted", "omitted"].includes(variant);
    return { ...unit, disposition: blocked ? "blocked" : "covered", reasonCodes: [blocked ? "requires_resolution" : "verified"], candidateClaimIds };
  });
  return { schemaVersion: 1, kind: "SourceClaimAudit", documentSetDigest: subject.documentSetDigest, candidateId: subject.candidateId, candidateDigest: subject.candidateDigest, decisions, coverage, policyRegistry };
}

test("raw extraction is independently audited before Bootstrap and Planner admission", async () => {
  const fx = fixture(); const router = new SwarmRouter(fx.config);
  try {
    const result = await new DeliveryCoordinator(router).begin({ source: fx.raw });
    assert.equal(router.store.deliveryRun(result.id).sourceClaimInputMode, "raw");
    assert.ok(result.sourceClaimExtractionId); assert.ok(result.sourceClaimAuditId); assert.ok(result.sourceClaimManifestId);
    assert.equal(fx.client.calls.filter((item) => item === "Extract atomic candidate source claims only.").length, 1);
    assert.equal(fx.client.calls.filter((item) => item === "Independently audit source claims and source coverage.").length, 1);
    assert.ok(fx.client.calls.indexOf("extraction_result") < fx.client.calls.indexOf("Independently audit source claims and source coverage."));
    assert.equal(fx.client.calls.some((item) => /^Plan /.test(item)), false);
    assert.equal(JSON.stringify({ status: router.statusSnapshot(), run: result }).includes("SUPERSECRET"), false);
  } finally { router.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test("source intake persists one exact alias receipt for extraction and independent audit before admission", async () => {
  const fx = fixture({ aliasRoles: ["source_claim_extraction", "source_claim_audit"] }); const router = new SwarmRouter(fx.config);
  try {
    const result = await new DeliveryCoordinator(router).begin({ source: fx.raw });
    const extraction = router.store.sourceIntakeTerminalReceipt({ deliveryRunId: result.id, role: "source_claim_extraction" });
    const audit = router.store.sourceIntakeTerminalReceipt({ deliveryRunId: result.id, role: "source_claim_audit" });
    assert.deepEqual([extraction.receipt.requestedTurnId.endsWith("-resolved"), extraction.receipt.resolvedTurnId.endsWith("-resolved"), audit.receipt.requestedTurnId.endsWith("-resolved"), audit.receipt.resolvedTurnId.endsWith("-resolved")], [false, true, false, true]);
    assert.equal(router.store.events({ limit: 500 }).filter((event) => event.type === "source-intake/terminal-receipt").length, 2);
    assert.equal(readdirSync(join(fx.root, "docs/out/source-claim-extractions")).length, 1);
    assert.equal(readdirSync(join(fx.root, "docs/out/source-claim-audits")).length, 1);
    assert.ok(result.sourceClaimManifestId);
  } finally { router.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test("independent audit receives canonical subjects and cannot substitute controller IDs or source refs", async () => {
  for (const [name, mutate] of [
    ["claim-id", (audit) => { audit.decisions[0].claimId = "claim-substituted"; }],
    ["source-ref", (audit) => { audit.decisions[0].sourceRefs = [{ ...audit.decisions[0].sourceRefs[0], excerptDigest: "0".repeat(64) }]; }]
  ]) {
    const fx = fixture({ auditMutator: mutate }); const router = new SwarmRouter(fx.config);
    try {
      const result = await new DeliveryCoordinator(router).begin({ source: fx.raw }); const failure = router.store.sourceIntakeFailureForRun({ deliveryRunId: result.id });
      assert.equal(result.state, "blocked_specification", name); assert.equal(result.publish.reason, "source_claim_audit:validate:audit_result_invalid", name); assert.equal(router.list().length, 0, name); assert.ok(result.sourceClaimExtractionId, name); assert.equal(result.sourceClaimManifestId, null, name); assert.equal(failure.role, "audit", name); assert.equal(failure.phase, "validate", name); assert.equal(failure.code, "audit_result_invalid", name);
    } finally { router.close(); rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("source executors have no direct legacy provider path", async () => {
  const { readFileSync } = await import("node:fs");
  for (const path of ["src/source-claim-extraction.mjs", "src/source-claim-audit.mjs"]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /app-server-execution-provider|AppServerExecutionProvider|observeTerminal|readFinalResult/);
    assert.match(source, /runSourceIntakeTurn/);
  }
});

test("source intake fail-closes wrong correlation, missing terminal status, malformed JSON, and unavailable final results before Bootstrap", async () => {
  for (const [role, failure] of [["source_claim_extraction", "wrong_thread"], ["source_claim_extraction", "wrong_turn"], ["source_claim_extraction", "missing_terminal_status"], ["source_claim_extraction", "malformed_json"], ["source_claim_extraction", "final_result_unavailable"], ["source_claim_audit", "wrong_thread"], ["source_claim_audit", "wrong_turn"], ["source_claim_audit", "missing_terminal_status"], ["source_claim_audit", "malformed_json"], ["source_claim_audit", "final_result_unavailable"]]) {
    const fx = fixture(); const router = new SwarmRouter(fx.config);
    try {
      failRoleWithRuntime(fx, role, failure);
      const result = await new DeliveryCoordinator(router).begin({ source: fx.raw });
      assert.equal(result.state, "blocked_specification", `${role}:${failure}`);
      assert.equal(router.list().length, 0, `${role}:${failure}`);
      const persisted = router.store.sourceIntakeFailureForRun({ deliveryRunId: result.id, role: role === "source_claim_extraction" ? "extraction" : "audit" });
      assert.equal(persisted.phase, failure === "malformed_json" ? "parse" : failure === "final_result_unavailable" ? "result_read" : "terminal", `${role}:${failure}`);
      assert.equal(persisted.code, failure === "malformed_json" ? "malformed_json" : failure === "final_result_unavailable" ? "final_result_unavailable" : "terminal_correlation_invalid", `${role}:${failure}`);
      if (failure === "final_result_unavailable") {
        assert.match(result.publish.reason, /final_result_unavailable/, `${role}:${failure}`);
        assert.ok(router.store.sourceIntakeTerminalReceipt({ deliveryRunId: result.id, role }), `${role}:${failure}`);
        assert.ok(persisted.receiptIdentity, `${role}:${failure}`);
      }
    } finally { router.close(); rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("omitted material, contradiction, and split-required source fail closed before Bootstrap", async () => {
  for (const variant of ["omitted", "contradiction", "split-required"]) {
    const fx = fixture({ auditVariant: variant }); const router = new SwarmRouter(fx.config);
    try {
      const result = await new DeliveryCoordinator(router).begin({ source: fx.raw });
      assert.equal(result.state, "blocked_specification", variant); assert.equal(router.list().length, 0, variant);
      assert.match(result.publish.reason, /^source_claim_audit:/, variant);
      assert.equal(JSON.stringify({ result, status: router.statusSnapshot() }).includes("SUPERSECRET"), false, variant);
    } finally { router.close(); rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("trusted source-audit policy is exact and an auditor cannot self-authorize it", () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, "docs/in"), { recursive: true }); writeFileSync(join(fx.root, "docs/in", fx.file.path), fx.text); writeFileSync(join(fx.root, "docs/in", "inventory.json"), JSON.stringify({ files: [fx.file], documentSetDigest: documentSetDigest([fx.file]) }));
    const resolver = createImportedSourceResolver({ repository: fx.root, documentationDir: "docs/in" }); const subject = auditSubjectFromExtraction(canonicalizeSourceClaimExtractionCandidate(fx.extraction(), { sourceResolver: resolver })); const target = subject.claims[1];
    const policy = { policyId: "resolve-token", version: "1", scope: { kind: "source_claim_audit", claimIds: [target.claimId] }, affectedRequirementIds: [], resolvedValue: "Use controller-managed deployment secret." }; policy.digest = policyDigest(policy);
    const audit = auditFor({ root: fx.root, extraction: fx.extraction(), policyRegistry: { schemaVersion: 1, policies: [policy] } }); audit.decisions[1].policy = { policyId: policy.policyId, version: policy.version, digest: policy.digest, resolvedValue: policy.resolvedValue };
    const admitted = validateSourceClaimAudit(audit, { subject, sourceResolver: resolver, policyRegistry: { schemaVersion: 1, policies: [policy] } }); assert.ok(admitAuditedSourceClaims({ subject, audit: admitted }).manifestId);
    assert.throws(() => validateSourceClaimAudit(audit, { subject, sourceResolver: resolver, policyRegistry: { schemaVersion: 1, policies: [] } }), /untrusted_policy_binding/);
    policy.scope.claimIds = [subject.claims[0].claimId]; policy.digest = policyDigest(policy);
    assert.throws(() => validateSourceClaimAudit(audit, { subject, sourceResolver: resolver, policyRegistry: { schemaVersion: 1, policies: [policy] } }), /untrusted_policy_binding/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("restart/source mutation and supplied manifests retain one audit-admission lineage", async () => {
  const raw = fixture(); let router = new SwarmRouter(raw.config);
  try {
    const run = await new DeliveryCoordinator(router).begin({ source: raw.raw }); const storedAudit = router.store.sourceClaimAudit(run.sourceClaimAuditId);
    assert.equal(storedAudit.candidateId, router.store.sourceClaimExtraction(run.sourceClaimExtractionId).extraction.extractionId);
    router.close(); router = null;
    writeFileSync(join(raw.root, "docs/in", raw.file.path), "# Product\nChanged source.\nUsers must sign in.\n");
    const restarted = new SwarmRouter(raw.config);
    try { assert.throws(() => restarted.assertBootstrapSourceIntake(restarted.store.deliveryRun(run.id)), /source_claim_contract/); }
    finally { restarted.close(); }
  } finally { router?.close(); rmSync(raw.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }

  const supplied = fixture({ supplied: true }); const suppliedRouter = new SwarmRouter(supplied.config);
  try {
    const intake = await new DeliveryCoordinator(suppliedRouter).begin({ source: supplied.raw });
    assert.equal(intake.sourceClaimInputMode, "supplied"); assert.ok(intake.sourceClaimAuditId); assert.ok(intake.sourceClaimManifestId);
    assert.equal(supplied.client.calls.includes("Independently audit source claims and source coverage."), false);
  } finally { suppliedRouter.close(); rmSync(supplied.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
