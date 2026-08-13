import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join } from "node:path";
import { ExecutionProviderError } from "../src/execution-provider-contract.mjs";
import { auditSubjectFromExtraction } from "../src/source-claim-audit.mjs";
import { createImportedSourceResolver } from "../src/source-evidence.mjs";
import { parseSourceIntakeProbeArgs, runSourceIntakeProbe, SOURCE_INTAKE_PROBE_CONFIRMATION } from "../src/source-intake-probe.mjs";

function receipt({ threadId, turnId }) {
  return { schemaVersion: 1, kind: "AppServerTerminalReceipt", source: "turn_completed", capturedAt: "2026-01-01T00:00:00.000Z", providerConnectionId: "probe-test-connection", correlationId: `correlation-${turnId}`, threadId, requestedTurnId: turnId, resolvedTurnId: turnId, terminalClass: "completed" };
}

class ProbeRuntime {
  constructor({ cwd, role, failure = null, claimCount = 1 }) { this.cwd = cwd; this.role = role; this.failure = failure; this.claimCount = claimCount; this.threadId = `thread-${role}`; this.turnId = `turn-${role}`; }
  async connect() {}
  async shutdown() {}
  async diagnostics() {
    return { diagnostics: JSON.stringify({ process: { alive: false, exited: this.failure === "audit_timeout", code: this.failure === "audit_timeout" ? 19 : null, signal: null }, stderrTail: "SECRET_SOURCE_MARKDOWN must not escape", protocolEvents: [{ direction: "stderr", method: "turn/completed", threadId: this.threadId, turnId: this.turnId, errorCode: this.failure === "audit_timeout" ? "timeout" : "none", rawResult: "PROMPT_SECRET" }] }) };
  }
  async startThread() { return { threadId: this.threadId }; }
  async startGoalTurn({ threadId }) { return { threadId, turnId: this.turnId }; }
  async observeTerminal({ threadId, turnId }) {
    if (this.failure === "audit_timeout" && this.role === "source_claim_audit") throw new ExecutionProviderError("timeout", "raw agent result SECRET_SOURCE_MARKDOWN", { errorClass: "transport" });
    return { kind: "worker_terminal_candidate", threadId, turnId, terminalClass: "completed" };
  }
  async reconcileTerminal({ threadId, turnId }) { return { kind: "worker_completed", threadId, turnId, terminalClass: "completed", terminalReceipt: receipt({ threadId, turnId }) }; }
  async readFinalResult() {
    const root = dirname(this.cwd);
    const resolver = createImportedSourceResolver({ repository: root, documentationDir: "docs/orchestration-input" });
    if (this.role === "source_claim_extraction") {
      const document = resolver.sourceDocuments[0];
      return { threadId: this.threadId, turnId: this.turnId, resultText: JSON.stringify({ schemaVersion: 1, kind: "SourceClaimExtractionCandidate", claims: Array.from({ length: this.claimCount }, (_, index) => ({ claimType: "constraint", normalizedStatement: `An admitted manifest requirement ${index + 1}.`, classification: "mandatory", sourceLocation: { documentId: document.documentId, startLine: index + 2, endLine: index + 2 } })) }) };
    }
    const directory = join(root, "docs", "orchestration-generated", "source-claim-extractions");
    const extraction = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), "utf8"));
    const subject = auditSubjectFromExtraction(extraction);
    const decisions = subject.claims.map((claim) => ({ claimId: claim.claimId, decision: "admitted", classification: claim.candidateClassification, reasonCodes: ["fixture_admitted"] }));
    return { threadId: this.threadId, turnId: this.turnId, resultText: JSON.stringify({ decisions }) };
  }
}

const factory = (failure = null, claimCount = 1) => ({ cwd, role }) => new ProbeRuntime({ cwd, role, failure, claimCount });

test("source intake probe requires the explicit quota-spend confirmation and accepts no worker argument", () => {
  assert.deepEqual(parseSourceIntakeProbeArgs([SOURCE_INTAKE_PROBE_CONFIRMATION]), { confirmed: true });
  assert.throws(() => parseSourceIntakeProbeArgs([]), /Usage:/);
  assert.throws(() => parseSourceIntakeProbeArgs([SOURCE_INTAKE_PROBE_CONFIRMATION, "--workers", "1"]), /Usage:/);
  const child = spawnSync(process.execPath, ["scripts/e2e-source-intake-probe.mjs", SOURCE_INTAKE_PROBE_CONFIRMATION, "--workers", "1"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(child.status, 1); assert.match(child.stderr, /Usage:/);
});

test("source intake probe success fixture persists only intake artifacts and cleans its disposable root", async () => {
  const progress = []; let observed = null; let createdRoot = null;
  const result = await runSourceIntakeProbe({ timeoutMs: 5_000, model: "fixture", progress: (message) => progress.push(message), sourceIntakeRuntimeFactory: factory(), rootFactory: () => {
    createdRoot = mkdtempSync(join(tmpdir(), "orchestration-source-intake-probe-")); return createdRoot;
  }, onPassed: ({ router, run }) => {
    observed = { taskCount: router.list().length, extraction: router.store.sourceClaimExtraction(run.sourceClaimExtractionId), audit: router.store.sourceClaimAudit(run.sourceClaimAuditId), manifest: router.store.sourceClaimManifest(run.sourceClaimManifestId), extractionReceipt: router.store.sourceIntakeTerminalReceipt({ deliveryRunId: run.id, role: "source_claim_extraction" }), auditReceipt: router.store.sourceIntakeTerminalReceipt({ deliveryRunId: run.id, role: "source_claim_audit" }) };
  } });
  assert.equal(result.status, "passed"); assert.equal(result.root, null); assert.equal(result.reportPath, null);
  assert.equal(existsSync(createdRoot), false, "passed probes remove their disposable root");
  assert.deepEqual(progress, ["extraction started", "extraction completed", "audit started", "audit completed", "manifest admitted", "probe passed"]);
  assert.equal(observed.taskCount, 0); assert.ok(observed.extraction?.artifactPath); assert.ok(observed.audit?.artifactPath); assert.ok(observed.manifest?.manifest); assert.ok(observed.extractionReceipt?.receipt); assert.ok(observed.auditReceipt?.receipt);
});

test("quota-free multiclaim probe accepts three decisions and controller-generates all coverage", async () => {
  let observed = null;
  const result = await runSourceIntakeProbe({ timeoutMs: 5_000, model: "fixture", sourceIntakeRuntimeFactory: factory(null, 3), fixture: { requirements: ["First controller requirement.", "Second controller requirement.", "Third controller requirement."] }, onPassed: ({ router, run }) => {
    observed = { audit: router.store.sourceClaimAudit(run.sourceClaimAuditId).audit, manifest: router.store.sourceClaimManifest(run.sourceClaimManifestId).manifest };
  } });
  assert.equal(result.status, "passed"); assert.equal(observed.audit.decisions.length, 3); assert.equal(observed.manifest.claims.length, 3);
  const meaningful = observed.audit.coverage.filter((unit) => unit.kind === "meaningful");
  assert.equal(meaningful.length, 3); assert.deepEqual(meaningful.map((unit) => [unit.disposition, unit.reasonCodes, unit.candidateClaimIds.length]), [["covered", ["admitted_claim_coverage"], 1], ["covered", ["admitted_claim_coverage"], 1], ["covered", ["admitted_claim_coverage"], 1]]);
  assert.deepEqual(observed.audit.coverage.find((unit) => unit.kind === "structural_header").reasonCodes, ["structural_header"]);
});

test("audit failure preserves a bounded redacted report and never queues Bootstrap", async () => {
  const progress = [];
  const result = await runSourceIntakeProbe({ timeoutMs: 5_000, model: "fixture", progress: (message) => progress.push(message), sourceIntakeRuntimeFactory: factory("audit_timeout") });
  try {
    assert.equal(result.status, "failed"); assert.ok(existsSync(result.root)); assert.ok(existsSync(result.reportPath));
    const reportText = readFileSync(result.reportPath, "utf8"); const report = JSON.parse(reportText);
    assert.equal(report.kind, "SourceIntakeProbeReport"); assert.equal(report.status, "failed"); assert.equal(report.diagnostics.failures.length, 1);
    const failure = report.diagnostics.failures[0];
    assert.equal(failure.role, "audit"); assert.equal(failure.diagnostics.runtimeStage, "observe_terminal"); assert.equal(failure.diagnostics.primaryReason, "timeout"); assert.equal(failure.diagnostics.requestedTurnId, "turn-source_claim_audit"); assert.equal(failure.diagnostics.processState.exited, true); assert.equal(failure.diagnostics.protocolTail[0].errorCode, "timeout");
    for (const sensitive of ["SECRET_SOURCE_MARKDOWN", "PROMPT_SECRET", "raw agent result", "Controlled source payload", "requirements.md"]) assert.equal(reportText.includes(sensitive), false, sensitive);
    const taskCount = execFileSync(process.execPath, ["--input-type=module", "--eval", `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(${JSON.stringify(join(result.root, "runtime", "swarm.sqlite"))}, { readOnly: true }); console.log(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count); db.close();`], { encoding: "utf8" }).trim();
    assert.equal(taskCount, "0");
    assert.equal(progress.some((message) => message.startsWith("probe failed role=audit runtimeStage=observe_terminal primaryReason=timeout")), true);
  } finally {
    // This invokes the public cleanup guard through a fresh passed fixture's internal cleanup only in production; tests remove their own preserved failure fixture explicitly.
    if (result.root && existsSync(result.root)) execFileSync(process.execPath, ["--input-type=module", "--eval", `import { cleanupSourceIntakeProbeRoot } from './src/source-intake-probe.mjs'; cleanupSourceIntakeProbeRoot(${JSON.stringify(result.root)});`], { cwd: process.cwd() });
  }
});
