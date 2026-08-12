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
import { sourceClaimCandidateId, sourceFragmentDigest } from "../src/source-evidence.mjs";
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
  async readThread({ threadId }) { return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text: this.result }] }] } }; }
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

function candidate({ file, text }, mutate = (value) => value) {
  const make = (claimType, normalizedStatement) => ({ documentId: file.documentId, startLine: 2, endLine: 2, sourceDigest: file.sha256, claimType, normalizedStatement, confidence: 0.8, sourceQuote: { documentId: file.documentId, startLine: 2, endLine: 2, excerptDigest: sourceFragmentDigest(text, 2, 2) } });
  const claims = [make("constraint", "Deployment requires a token."), make("risk", "Deployment token handling is sensitive.")].map((item) => ({ ...item, claimId: sourceClaimCandidateId(item) }));
  return mutate({ schemaVersion: 1, kind: "SourceClaimExtraction", documentSetDigest: documentSetDigest([file]), claims });
}

test("raw Markdown persists atomic extraction candidates but never queues Bootstrap before independent audit admission", async () => {
  const subject = fixture(candidate); const router = new SwarmRouter(subject.config); const coordinator = new DeliveryCoordinator(router);
  try {
    const run = await coordinator.begin({ source: subject.source });
    assert.equal(run.state, "blocked_specification", JSON.stringify(run.publish)); assert.equal(subject.calls.turns, 2); assert.equal(router.list().length, 0);
    const stored = router.store.sourceClaimExtraction(run.sourceClaimExtractionId);
    assert.equal(stored.extraction.claims.length, 2); assert.equal(stored.extraction.claims[0].startLine, stored.extraction.claims[1].startLine);
    assert.ok(readFileSync(join(subject.root, stored.artifactPath), "utf8").includes("Deployment requires a token."));
    assert.equal(JSON.stringify(router.statusSnapshot()).includes("SUPERSECRET"), false);
    assert.equal(JSON.stringify(run).includes("SUPERSECRET"), false);
  } finally { router.close(); rmSync(subject.root, { recursive: true, force: true }); }
});

test("malformed, unknown, and changed raw sources become bounded specification blocks", async () => {
  const malformed = fixture(() => "not-json"); const malformedRouter = new SwarmRouter(malformed.config);
  try {
    const coordinator = new DeliveryCoordinator(malformedRouter);
    assert.equal((await coordinator.begin({ source: malformed.source })).state, "blocked_specification");
    malformed.config.executionProviderFactory = () => provider(new ExtractionClient(candidate({ file: malformed.file, text: malformed.text }), malformed.calls));
    assert.equal((await coordinator.resume()).state, "blocked_specification");
  }
  finally { malformedRouter.close(); rmSync(malformed.root, { recursive: true, force: true }); }
  const unknown = fixture((context) => candidate(context, (value) => { value.claims[0].documentId = "doc-unknown"; return value; })); const unknownRouter = new SwarmRouter(unknown.config);
  try { assert.equal((await new DeliveryCoordinator(unknownRouter).begin({ source: unknown.source })).state, "blocked_specification"); }
  finally { unknownRouter.close(); rmSync(unknown.root, { recursive: true, force: true }); }
  const changed = fixture(candidate); const first = new SwarmRouter(changed.config);
  try {
    const run = await new DeliveryCoordinator(first).begin({ source: changed.source }); assert.equal(run.state, "blocked_specification"); first.close();
    writeFileSync(join(changed.root, "docs/in/requirements.md"), "# Product\nChanged source.\n");
    const restarted = new SwarmRouter(changed.config);
    try { assert.equal((await new DeliveryCoordinator(restarted).resume()).state, "blocked_specification"); }
    finally { restarted.close(); }
  } finally { if (!first.closed) first.close(); rmSync(changed.root, { recursive: true, force: true }); }
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
