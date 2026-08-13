import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { SwarmRouter } from "../src/router.mjs";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { sourceFragmentDigest } from "../src/source-evidence.mjs";
import { ingestDocumentation } from "../src/project-intake.mjs";
import { provider } from "./execution-provider-test-adapter.mjs";

const sha256 = (value) => createHash("sha256").update(value.replace(/\r\n?/g, "\n")).digest("hex");
const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: false }]));

class ExtractionClient {
  constructor(result, calls) { this.result = typeof result === "string" ? result : `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``; this.calls = calls; this.threads = new Map(); this.id = 0; }
  async connect() {} async shutdown() { this.calls.shutdown += 1; }
  async startThread() { const id = `thread-${++this.id}`; this.threads.set(id, {}); return { thread: { id } }; }
  async setGoal(goal) { this.threads.get(goal.threadId).goal = goal.objective; }
  async startTurn({ threadId }) { this.calls.turns += 1; return { turn: { id: `turn-${threadId}` } }; }
  async waitForTurn(_threadId, turnId) { return { id: turnId, status: "completed" }; }
  async readTerminalTurn(_threadId, turnId) { return { terminal: { id: turnId, status: "completed" } }; }
  async readThread({ threadId }) { return { thread: { turns: [{ id: `turn-${threadId}`, status: "completed", items: [{ type: "agentMessage", text: this.result }] }] } }; }
}

function fixture(resultFor) {
  const root = mkdtempSync(join(tmpdir(), "source-claim-extraction-")); const source = join(root, "raw"); mkdirSync(source);
  execFileSync("git", ["-C", root, "init", "-b", "main"]);
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "base", "--no-gpg-sign", "--author", "Extraction Test <extraction@example.test>"]);
  const path = "requirements.md"; const text = "# Product\nUse token SUPERSECRET only for deployment.\nUsers must be able to sign in.\n";
  writeFileSync(join(source, path), text);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "source-claim-extraction-fixture", packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}");
  execFileSync("git", ["-C", root, "add", "package.json", "package-lock.json"]); execFileSync("git", ["-C", root, "commit", "-m", "fixture-package", "--no-gpg-sign", "--author", "Extraction Test <extraction@example.test>"]);
  const file = { documentId: documentIdForPath(path), path, sha256: sha256(text) };
  const calls = { turns: 0, shutdown: 0 };
  const config = { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { documentationDir: "docs/in", generatedDir: "docs/out", repositoryMode: "legacy" }, router: { turnTimeoutMs: 1000, maxConcurrentTasks: 1, maxChildrenPerTask: 1, maxDelegationDepth: 1, maxPlanTasks: 1, defaultParentBudget: 100, approvalMode: "deny" }, delivery: { sourceClaimExtractionTokenBudget: 100 }, budget: { weeklyTokenLimit: 1000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, autonomy: { mode: "autonomous" }, roles, executionProviderFactory: () => provider(new ExtractionClient(resultFor({ file, text }), calls)) };
  return { root, source, file, text, config, calls };
}

function candidate({ file }, mutate = (value) => value) {
  const make = (claimType, normalizedStatement) => ({ claimType, normalizedStatement, classification: "mandatory", sourceLocation: { documentId: file.documentId, startLine: 2, endLine: 2 } });
  const claims = [make("constraint", "Deployment requires a token."), make("risk", "Deployment token handling is sensitive.")];
  return mutate({ schemaVersion: 1, kind: "SourceClaimExtractionCandidate", claims });
}

test("raw semantic candidates are controller-canonicalized and never queue Bootstrap before independent audit admission", async () => {
  const subject = fixture((context) => candidate(context, (value) => {
    Object.assign(value.claims[0], { claimId: "claim-agent-controlled", sourceDigest: "0".repeat(64), sourceQuote: { documentId: "foreign", startLine: 99, endLine: 99, excerptDigest: "f".repeat(64) }, documentSetDigest: "f".repeat(64) });
    return value;
  })); const router = new SwarmRouter(subject.config); const coordinator = new DeliveryCoordinator(router);
  try {
    const run = await coordinator.begin({ source: subject.source });
    assert.equal(run.state, "blocked_specification", JSON.stringify(run.publish)); assert.equal(subject.calls.turns, 2); assert.equal(router.list().length, 0);
    const stored = router.store.sourceClaimExtraction(run.sourceClaimExtractionId);
    assert.equal(stored.extraction.claims.length, 2); assert.equal(stored.extraction.claims[0].startLine, stored.extraction.claims[1].startLine);
    assert.notEqual(stored.extraction.claims[0].claimId, "claim-agent-controlled"); assert.equal(stored.extraction.claims[0].sourceDigest, subject.file.sha256);
    assert.equal(stored.extraction.claims[0].sourceQuote.documentId, subject.file.documentId); assert.equal("confidence" in stored.extraction.claims[0], false);
    assert.ok(readFileSync(join(subject.root, stored.artifactPath), "utf8").includes("Deployment requires a token."));
    assert.equal(JSON.stringify(router.statusSnapshot()).includes("SUPERSECRET"), false);
    assert.equal(JSON.stringify(run).includes("SUPERSECRET"), false);
  } finally { router.close(); rmSync(subject.root, { recursive: true, force: true }); }
});

test("raw malformed and semantic failures persist an exact safe SourceIntakeFailure before Bootstrap", async () => {
  const malformed = fixture(() => "not-json"); const malformedRouter = new SwarmRouter(malformed.config);
  try {
    const coordinator = new DeliveryCoordinator(malformedRouter);
    const run = await coordinator.begin({ source: malformed.source }); assert.equal(run.state, "blocked_specification");
    assert.deepEqual(malformedRouter.store.sourceIntakeFailureForRun({ deliveryRunId: run.id }), { id: 1, schemaVersion: 1, role: "extraction", phase: "parse", code: "malformed_json", receiptIdentity: { threadId: "thread-1", requestedTurnId: "turn-thread-1", resolvedTurnId: "turn-thread-1" }, diagnostics: null, createdAt: malformedRouter.store.sourceIntakeFailureForRun({ deliveryRunId: run.id }).createdAt });
    assert.equal(JSON.stringify({ status: malformedRouter.statusSnapshot(), run }).includes("SUPERSECRET"), false);
    malformed.config.executionProviderFactory = () => provider(new ExtractionClient(candidate({ file: malformed.file, text: malformed.text }), malformed.calls));
    assert.equal((await coordinator.resume()).state, "blocked_specification");
  }
  finally { malformedRouter.close(); rmSync(malformed.root, { recursive: true, force: true }); }
  for (const [name, mutate, phase, code] of [
    ["unknown-document", (value) => { value.claims[0].sourceLocation.documentId = "doc-unknown"; }, "canonicalize", "candidate_canonicalization_failed"],
    ["out-of-range", (value) => { value.claims[0].sourceLocation.endLine = 99; }, "canonicalize", "candidate_canonicalization_failed"],
    ["missing-statement", (value) => { delete value.claims[0].normalizedStatement; }, "validate", "candidate_semantics_invalid"],
    ["missing-type", (value) => { delete value.claims[0].claimType; }, "validate", "candidate_semantics_invalid"],
    ["missing-classification", (value) => { delete value.claims[0].classification; }, "validate", "candidate_semantics_invalid"]
  ]) {
    const invalid = fixture((context) => candidate(context, (value) => { mutate(value); return value; })); const invalidRouter = new SwarmRouter(invalid.config);
    try {
      const run = await new DeliveryCoordinator(invalidRouter).begin({ source: invalid.source }); const failure = invalidRouter.store.sourceIntakeFailureForRun({ deliveryRunId: run.id });
      assert.equal(run.state, "blocked_specification", name); assert.equal(run.publish.reason, `source_claim_extraction:${phase}:${code}`, name); assert.equal(invalidRouter.list().length, 0, name); assert.equal(run.sourceClaimExtractionId, null, name); assert.equal(failure.phase, phase, name); assert.equal(failure.code, code, name);
    } finally { invalidRouter.close(); rmSync(invalid.root, { recursive: true, force: true }); }
  }
  const changed = fixture(candidate); const first = new SwarmRouter(changed.config);
  try {
    const run = await new DeliveryCoordinator(first).begin({ source: changed.source }); assert.equal(run.state, "blocked_specification"); first.close();
    writeFileSync(join(changed.root, "docs/in/requirements.md"), "# Product\nChanged source.\n");
    const restarted = new SwarmRouter(changed.config);
    try { assert.equal((await new DeliveryCoordinator(restarted).resume()).state, "blocked_specification"); }
    finally { restarted.close(); }
  } finally { if (!first.closed) first.close(); rmSync(changed.root, { recursive: true, force: true }); }
});

test("candidate persistence failure is safe, durable, and leaves no admitted manifest", async () => {
  const subject = fixture(candidate); subject.config.faultHooks = { async source_claim_candidate_file_before_db_persistence() { throw new Error("test persistence failure"); } };
  const router = new SwarmRouter(subject.config);
  try {
    const run = await new DeliveryCoordinator(router).begin({ source: subject.source }); const failure = router.store.sourceIntakeFailureForRun({ deliveryRunId: run.id });
    assert.equal(run.state, "blocked_specification"); assert.equal(run.publish.reason, "source_claim_extraction:persist:candidate_persistence_failed"); assert.equal(failure.phase, "persist"); assert.equal(failure.code, "candidate_persistence_failed"); assert.equal(run.sourceClaimManifestId, null); assert.equal(router.list().length, 0);
  } finally { router.close(); rmSync(subject.root, { recursive: true, force: true }); }
});

test("supplied declarations remain a high-assurance intake route and candidate restart needs no provider", async () => {
  const supplied = fixture(candidate);
  try {
    const ref = { documentId: supplied.file.documentId, startLine: 1, endLine: 3, excerptDigest: sourceFragmentDigest(supplied.text, 1, 3) };
    writeFileSync(join(supplied.source, "source-claims.json"), JSON.stringify({ schemaVersion: 1, kind: "SourceClaimsDeclaration", documentSetDigest: documentSetDigest([supplied.file]), documents: [{ ...supplied.file, coverage: [{ claimId: "supplied-claim", ...ref }] }], claims: [{ claimId: "supplied-claim", classification: "mandatory", sourceRefs: [ref] }] }));
    assert.equal(ingestDocumentation({ source: supplied.source, repository: supplied.root, destinationRelative: "docs/supplied" }).sourceClaimInput, "supplied");
  } finally { rmSync(supplied.root, { recursive: true, force: true }); }
  const raw = fixture(candidate); const router = new SwarmRouter(raw.config);
  try {
    const first = await new DeliveryCoordinator(router).begin({ source: raw.source }); assert.equal(first.state, "blocked_specification"); router.close();
    const restarted = new SwarmRouter(raw.config);
    try { assert.equal((await new DeliveryCoordinator(restarted).resume()).state, "blocked_specification"); assert.equal(raw.calls.turns, 2); }
    finally { restarted.close(); }
  } finally { if (!router.closed) router.close(); rmSync(raw.root, { recursive: true, force: true }); }
});
