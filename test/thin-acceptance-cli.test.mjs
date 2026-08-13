import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { parseThinAcceptArgs, readThinProductDocuments, runSemanticAuditTurn, runThinAccept, ThinAcceptanceAuditRuntimeError, thinAcceptUsage } from "../scripts/thin-accept.mjs";

test("thin acceptance CLI parses only explicit candidate and repair inputs", () => {
  const parsed = parseThinAcceptArgs(["--repo", "repo", "--docs", "docs", "--candidate", "abcdef1", "--verify", "node --test", "--repair-surface", "apps/api, apps/web", "--confirm-spend-quota"]);
  assert.deepEqual(parsed, { repo: "repo", docs: "docs", productDocs: [], candidate: "abcdef1", verify: "node --test", repairSurface: ["apps/api", "apps/web"], auditTimeoutMs: 180_000, confirm: true, help: false });
  assert.match(thinAcceptUsage(), /thin-accept/);
});

test("acceptance selects only TECH_SPEC by default and requires explicit selection when ambiguous", (t) => {
  const root = mkdtempSync(join(tmpdir(), "thin-product-docs-"));
  const docs = join(root, "docs"); mkdirSync(join(docs, "nested"), { recursive: true });
  writeFileSync(join(docs, "TECH_SPEC.md"), "# Spec\n- The application must show city guides.\n");
  writeFileSync(join(docs, "agency_manifesto.md"), "# Process\n- Agents must commit after every task.\n");
  const selected = readThinProductDocuments({ docs });
  assert.deepEqual(selected.map((document) => document.documentId), ["TECH_SPEC.md"]);
  assert.match(selected[0].markdown, /city guides/);
  writeFileSync(join(docs, "nested", "TECH_SPEC.md"), "# Other\n- The application must provide a map.\n");
  assert.throws(() => readThinProductDocuments({ docs }), /Multiple TECH_SPEC/);
  const explicit = readThinProductDocuments({ docs, productDocs: ["TECH_SPEC.md"] });
  assert.equal(explicit.length, 1);
  writeFileSync(join(root, "outside.md"), "# Outside\n- The application must not be read.\n");
  assert.throws(() => readThinProductDocuments({ docs, productDocs: ["../outside.md"] }), /inside --docs/);
  t.after(() => rmSync(root, { recursive: true, force: true }));
});

test("acceptance audit uses the thin runtime receipt and resolved turn alias", async () => {
  const runtime = new FakeAcceptanceRuntime({ alias: true });
  const text = await runSemanticAuditTurn({
    cwd: runtime.cwd,
    prompt: "Return JSON.",
    stdout: () => {},
    timeoutMs: 1_000,
    runtimeFactory: () => runtime
  });
  assert.equal(text, '{"results":[]}');
  assert.deepEqual(runtime.calls.map(([method]) => method), ["connect", "startThread", "startGoalTurn", "observeTerminal", "reconcileTerminal", "readFinalResult", "shutdown"]);
  assert.deepEqual(runtime.calls.find(([method]) => method === "reconcileTerminal")[1], { threadId: "audit-thread", turnId: "audit-requested", timeoutMs: 1_000 });
  assert.deepEqual(runtime.calls.find(([method]) => method === "readFinalResult")[1], { threadId: "audit-thread", turnId: "audit-resolved" });
  assert.equal(runtime.closed, true);
});

test("acceptance audit emits bounded heartbeats and cancels then shuts down on timeout", async () => {
  const runtime = new FakeAcceptanceRuntime({ timeout: true });
  const output = [];
  await assert.rejects(
    runSemanticAuditTurn({ cwd: runtime.cwd, prompt: "Return JSON.", stdout: (line) => output.push(line), timeoutMs: 1_000, heartbeatMs: 5, runtimeFactory: () => runtime }),
    (error) => error instanceof ThinAcceptanceAuditRuntimeError && error.code === "timeout"
  );
  assert.ok(output.some((line) => line.startsWith("[acceptance] heartbeat thread=audit-thread turn=audit-requested")));
  assert.equal(runtime.calls.some(([method]) => method === "cancel"), true);
  assert.equal(runtime.closed, true);
});

test("acceptance failure report persists only safe runtime terminal diagnostics", async (t) => {
  const fixture = createRepositoryFixture(t);
  const output = [];
  const code = await runThinAccept({
    argv: acceptanceArgv(fixture), stdout: (line) => output.push(line), stderr: (line) => output.push(line),
    dependencies: {
      createRuntimeDir: () => fixture.runtime,
      acceptanceRuntimeFactory: ({ cwd }) => new FakeAcceptanceRuntime({ cwd, timeout: true, diagnostics: "process exited; SECRET=do-not-leak" }),
      acceptanceHeartbeatMs: 5
    }
  });
  assert.equal(code, 1);
  const reportPath = output.find((line) => line.startsWith("[acceptance] report ")).slice("[acceptance] report ".length);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.code, "audit_execution_failed");
  assert.deepEqual(report.auditRuntime, {
    threadId: "audit-thread", requestedTurnId: "audit-requested", resolvedTurnId: null,
    runtimeStage: "observe_terminal", code: "timeout", errorClass: "runtime",
    process: "process exited; SECRET=[redacted]", reconnectRequired: false
  });
  // The persisted report is the contract; the fake runtime's cancellation
  // and shutdown behavior is covered directly above.
});

test("accepted repair remains on an explicit candidate branch without mutating the source branch", async (t) => {
  const fixture = createRepositoryFixture(t);
  const output = [];
  let auditCalls = 0;
  let verificationCalls = 0;
  const code = await runThinAccept({
    argv: acceptanceArgv(fixture), stdout: (line) => output.push(line), stderr: (line) => output.push(line),
    dependencies: {
      createRuntimeDir: () => fixture.runtime,
      runSemanticAuditTurn: async ({ label, prompt }) => {
        if (label === "acceptance-repair") return JSON.stringify({ title: "Repair acceptance gap", prompt: "Create the required repair file in src.", allowedPaths: ["src"] });
        auditCalls += 1;
        return acceptanceResponse(prompt, auditCalls === 1 ? "gap" : "pass");
      },
      runThinAppServerWorker: async ({ cwd }) => { writeFileSync(join(cwd, "src", "repaired.txt"), "repaired\n"); },
      runVerification: async () => { verificationCalls += 1; return { ok: true }; },
    },
  });

  assert.equal(code, 0);
  assert.equal(auditCalls, 2, "repair is accepted only after the second audit");
  assert.equal(verificationCalls, 2, "repair is accepted only after the second verification");
  const completed = output.find((line) => line.startsWith("[completed] accepted candidate "));
  assert.ok(completed);
  const match = completed.match(/^\[completed\] accepted candidate ([0-9a-f]{40}) branch=(thin\/acceptance-candidate-[A-Za-z0-9._-]+)$/);
  assert.ok(match, completed);
  const [, candidateSha, candidateBranch] = match;
  assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]), fixture.sourceHead);
  assert.equal(git(fixture.repository, ["branch", "--show-current"]), "main");
  assert.equal(git(fixture.repository, ["status", "--porcelain=v1"]), "");
  assert.equal(git(fixture.repository, ["rev-parse", "--verify", `${candidateBranch}^{commit}`]), candidateSha);
  execFileSync("git", ["-C", fixture.repository, "merge-base", "--is-ancestor", fixture.sourceHead, candidateSha]);
  const reportPath = output.find((line) => line.startsWith("[acceptance] report ")).slice("[acceptance] report ".length);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.candidateSha, candidateSha);
  assert.equal(report.candidateBranch, candidateBranch);
});

test("failed acceptance repair preserves its candidate worktree and branch without mutating the source branch", async (t) => {
  const fixture = createRepositoryFixture(t);
  const output = [];
  const code = await runThinAccept({
    argv: acceptanceArgv(fixture), stdout: (line) => output.push(line), stderr: (line) => output.push(line),
    dependencies: {
      createRuntimeDir: () => fixture.runtime,
      runSemanticAuditTurn: async ({ label, prompt }) => label === "acceptance-repair"
        ? JSON.stringify({ title: "Repair acceptance gap", prompt: "Create the required repair file in src.", allowedPaths: ["src"] })
        : acceptanceResponse(prompt, "gap"),
      runThinAppServerWorker: async () => { throw new Error("controlled worker failure"); },
      runVerification: async () => ({ ok: true }),
    },
  });

  assert.equal(code, 1);
  const failure = output.find((line) => line.startsWith("[failure] stage=acceptance code=repair_worker_failed recovery="));
  assert.ok(failure);
  const worktree = failure.slice(failure.indexOf("recovery=") + "recovery=".length);
  assert.equal(existsSync(worktree), true, "failed repair worktree is preserved for recovery");
  const branches = git(fixture.repository, ["branch", "--format=%(refname:short)"]).split(/\r?\n/).filter((branch) => branch.startsWith("thin/acceptance-candidate-"));
  assert.equal(branches.length, 1, "failed repair branch remains reachable for recovery");
  assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]), fixture.sourceHead);
  assert.equal(git(fixture.repository, ["branch", "--show-current"]), "main");
  assert.equal(git(fixture.repository, ["status", "--porcelain=v1"]), "");
  await cleanupPreservedWorktree(fixture.repository, worktree, branches[0]);
});

function createRepositoryFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "thin-acceptance-cli-"));
  const repository = join(root, "product");
  const docs = join(root, "docs");
  const runtime = join(root, "runtime");
  mkdirSync(join(repository, "src"), { recursive: true });
  mkdirSync(docs, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repository]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.test"]);
  writeFileSync(join(repository, "src", "seed.txt"), "seed\n");
  writeFileSync(join(docs, "TECH_SPEC.md"), "# Product\n\n- The application must create repaired output.\n");
  git(repository, ["add", "--", "src/seed.txt"]);
  git(repository, ["commit", "-m", "fixture"]);
  const sourceHead = git(repository, ["rev-parse", "HEAD"]);
  t.after(async () => {
    const worktrees = git(repository, ["worktree", "list", "--porcelain"]).split(/\r?\n/)
      .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length))
      .filter((path) => path.startsWith(runtime));
    for (const worktree of worktrees) await cleanupPreservedWorktree(repository, worktree);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repository, docs, runtime, sourceHead };
}

function acceptanceArgv({ repository, docs, sourceHead }) {
  return ["--repo", repository, "--docs", docs, "--candidate", sourceHead, "--verify", "ignored", "--repair-surface", "src", "--confirm-spend-quota"];
}

function acceptanceResponse(prompt, status) {
  const criterionId = [...prompt.matchAll(/"criterionId":"(criterion-[a-f0-9]+)"/g)].at(-1)?.[1];
  assert.ok(criterionId, "controller criterion ID must be present in semantic prompt");
  return JSON.stringify({ results: [{ criterionId, status, reason: status === "pass" ? "verified after controller repair" : "missing repair output" }] });
}

async function cleanupPreservedWorktree(repository, worktree, branch = null) {
  if (worktree && existsSync(worktree)) execFileSync("git", ["-C", repository, "worktree", "remove", "--force", worktree]);
  if (branch) execFileSync("git", ["-C", repository, "branch", "-D", branch]);
}

function git(cwd, args) {
  return String(execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })).trim();
}

class FakeAcceptanceRuntime extends EventEmitter {
  constructor({ cwd = "D:/controller-owned/acceptance-worktree", alias = false, timeout = false, diagnostics = "process healthy" } = {}) {
    super();
    this.cwd = cwd;
    this.alias = alias; this.timeout = timeout; this.diagnosticText = diagnostics; this.calls = []; this.closed = false;
  }
  async connect() { this.calls.push(["connect"]); }
  async startThread(data) { this.calls.push(["startThread", data]); return { threadId: "audit-thread" }; }
  async startGoalTurn(data) { this.calls.push(["startGoalTurn", data]); return { threadId: "audit-thread", turnId: "audit-requested" }; }
  async observeTerminal(data) {
    this.calls.push(["observeTerminal", data]);
    if (this.timeout) { await new Promise((resolve) => setTimeout(resolve, 15)); throw new Error("timed out"); }
    return { kind: "worker_terminal_candidate", threadId: "audit-thread", turnId: this.alias ? "audit-resolved" : "audit-requested", terminalClass: "completed" };
  }
  async reconcileTerminal(data) {
    this.calls.push(["reconcileTerminal", data]);
    const resolvedTurnId = this.alias ? "audit-resolved" : "audit-requested";
    return {
      kind: "worker_completed", threadId: "audit-thread", turnId: resolvedTurnId, terminalClass: "completed",
      terminalReceipt: { schemaVersion: 1, kind: "AppServerTerminalReceipt", source: "turn_completed", threadId: "audit-thread", requestedTurnId: "audit-requested", resolvedTurnId, terminalClass: "completed", correlationId: "audit-correlation" }
    };
  }
  async readFinalResult(data) { this.calls.push(["readFinalResult", data]); return { threadId: "audit-thread", turnId: data.turnId, resultText: '{"results":[]}' }; }
  async cancel(data) { this.calls.push(["cancel", data]); return { kind: "worker_cancelled" }; }
  async diagnostics() { this.calls.push(["diagnostics"]); return { diagnostics: this.diagnosticText, reconnectRequired: false }; }
  async shutdown() { this.calls.push(["shutdown"]); this.closed = true; }
}
