import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { documentIdForPath, documentSetDigest, policyDigest } from "../src/product-blueprint.mjs";
import { createImportedSourceResolver, sourceClaimCandidateId, sourceFragmentDigest, validateSourceClaimExtraction } from "../src/source-evidence.mjs";
import { admitAuditedSourceClaims, auditSubjectFromExtraction, normalizedSourceUnits, validateSourceClaimAudit } from "../src/source-claim-audit.mjs";
import { provider } from "./execution-provider-test-adapter.mjs";

const digest = (value) => createHash("sha256").update(value.replace(/\r\n?/g, "\n")).digest("hex");
const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: false }]));

class AuditClient {
  constructor({ extraction, audit }) { this.extraction = extraction; this.audit = audit; this.id = 0; this.calls = []; this.threads = new Map(); }
  async connect() {} async shutdown() { this.calls.push("shutdown"); }
  async startThread() { const id = `thread-${++this.id}`; this.threads.set(id, {}); this.calls.push("start_thread"); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; this.calls.push(objective); }
  async startTurn({ threadId }) { return { turn: { id: `turn-${threadId}` } }; }
  async waitForTurn(_threadId, turnId) { return { id: turnId, status: "completed" }; }
  async readThread({ threadId }) {
    const goal = this.threads.get(threadId).goal;
    const result = /^Extract atomic/.test(goal) ? this.extraction() : /^Independently audit/.test(goal) ? this.audit() : "not-json";
    this.calls.push(/^Extract atomic/.test(goal) ? "extraction_result" : /^Independently audit/.test(goal) ? "audit_result" : "other_result");
    return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` }] }] } };
  }
}

function fixture({ supplied = false, auditVariant = "admitted", policyRegistry = { schemaVersion: 1, policies: [] } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "source-claim-audit-")); const raw = join(root, "raw"); mkdirSync(raw);
  execFileSync("git", ["-C", root, "init", "-b", "main"]);
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "base", "--no-gpg-sign", "--author", "Audit Test <audit@example.test>"]);
  const text = "# Product\nUse token SUPERSECRET for deployment.\nUsers must sign in.\n";
  const path = "requirements.md"; const file = { documentId: documentIdForPath(path), path, sha256: digest(text) };
  writeFileSync(join(raw, path), text);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "audit-fixture", packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); execFileSync("git", ["-C", root, "add", "package.json", "package-lock.json"]); execFileSync("git", ["-C", root, "commit", "-m", "fixture-package", "--no-gpg-sign", "--author", "Audit Test <audit@example.test>"]);
  const claim = (line, claimType, normalizedStatement) => {
    const value = { documentId: file.documentId, startLine: line, endLine: line, sourceDigest: file.sha256, claimType, normalizedStatement, confidence: 0.9, sourceQuote: { documentId: file.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(text, line, line) } };
    return { ...value, claimId: sourceClaimCandidateId(value) };
  };
  const claims = [claim(1, "scope", "Product requirements."), claim(2, "constraint", "Deployment needs a token."), claim(3, "functional", "Users sign in.")];
  const extraction = () => ({ schemaVersion: 1, kind: "SourceClaimExtraction", documentSetDigest: documentSetDigest([file]), claims });
  const audit = () => auditFor({ root, file, extraction: extraction(), variant: auditVariant, policyRegistry });
  if (supplied) {
    const refs = claims.map((item) => item.sourceQuote);
    writeFileSync(join(raw, "source-claims.json"), JSON.stringify({ schemaVersion: 1, kind: "SourceClaimsDeclaration", documentSetDigest: documentSetDigest([file]), documents: [{ ...file, coverage: refs.map((ref, index) => ({ claimId: `supplied-${index + 1}`, ...ref })) }], claims: refs.map((ref, index) => ({ claimId: `supplied-${index + 1}`, classification: index === 1 ? "mandatory" : "non_mandatory", sourceRefs: [ref] })) }));
  }
  const client = new AuditClient({ extraction, audit });
  const config = { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { documentationDir: "docs/in", generatedDir: "docs/out", repositoryMode: "legacy" }, router: { turnTimeoutMs: 1000, maxConcurrentTasks: 1, maxChildrenPerTask: 1, maxDelegationDepth: 1, maxPlanTasks: 1, defaultParentBudget: 100, approvalMode: "deny" }, delivery: { sourceClaimExtractionTokenBudget: 100, sourceClaimAuditTokenBudget: 100 }, budget: { weeklyTokenLimit: 1000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, autonomy: { mode: "autonomous" }, roles, specificationResolution: { policyRegistry }, executionProviderFactory: () => provider(client) };
  return { root, raw, text, file, claims, extraction, audit, client, config };
}

function auditFor({ root, extraction, variant = "admitted", policyRegistry }) {
  const resolver = createImportedSourceResolver({ repository: root, documentationDir: "docs/in" });
  const verified = validateSourceClaimExtraction(extraction, { sourceResolver: resolver }); const subject = auditSubjectFromExtraction(verified);
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
    const resolver = createImportedSourceResolver({ repository: fx.root, documentationDir: "docs/in" }); const subject = auditSubjectFromExtraction(validateSourceClaimExtraction(fx.extraction(), { sourceResolver: resolver })); const target = subject.claims[1];
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
