import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CODEX_RUNTIME_PROBE_ALLOWED_PATH,
  CODEX_RUNTIME_PROBE_CONFIRMATION,
  CODEX_RUNTIME_PROBE_FILE_CONTENT,
  CODEX_RUNTIME_PROBE_TASK_ID,
  assertCodexRuntimeProbeConfirmation,
  boundedProbeDiagnostics,
  createCodexRuntimeProbeFailureReport,
  parseCodexRuntimeProbeArguments,
  runCodexRuntimeProbe
} from "../src/codex-runtime-probe.mjs";
import { CodexAppServerRuntime } from "../src/codex-app-server-runtime.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

class QuotaFreeRuntime {
  constructor({ cwd }) { this.cwd = cwd; this.calls = []; }
  async connect() { this.calls.push("connect"); }
  async startThread() { this.calls.push("thread"); return { threadId: "thread-probe" }; }
  async startGoalTurn({ threadId, turn }) {
    this.calls.push("turn");
    assert.equal(threadId, "thread-probe");
    assert.match(turn.input[0].text, new RegExp(CODEX_RUNTIME_PROBE_ALLOWED_PATH.replace(".", "\\.")));
    mkdirSync(join(this.cwd, "src"), { recursive: true });
    writeFileSync(join(this.cwd, CODEX_RUNTIME_PROBE_ALLOWED_PATH), CODEX_RUNTIME_PROBE_FILE_CONTENT, "utf8");
    return { turnId: "turn-requested" };
  }
  async observeTerminal() { this.calls.push("observe"); return { kind: "worker_terminal_candidate", terminalClass: "completed", turnId: "turn-requested" }; }
  async reconcileTerminal() { this.calls.push("reconcile"); return { kind: "worker_completed", terminalClass: "completed", turnId: "turn-resolved", requestedTurnId: "turn-requested", resolvedTurnId: "turn-resolved", terminalReceipt: { schemaVersion: 1, kind: "AppServerTerminalReceipt", source: "turn_completed", threadId: "thread-probe", requestedTurnId: "turn-requested", resolvedTurnId: "turn-resolved", terminalClass: "completed" } }; }
  async diagnostics() { return { connected: true, closed: false, diagnostics: JSON.stringify({ process: { alive: true, exited: false, code: null, signal: null } }) }; }
  async shutdown() { this.calls.push("shutdown"); }
}

class AliasBeforeReceiptProbeClient extends EventEmitter {
  constructor() { super(); this.events = []; this.cwd = null; this.closed = false; }
  async connect() {}
  async startThread({ cwd }) { this.cwd = cwd; return { thread: { id: "thread-probe" } }; }
  async setGoal() {}
  async startTurn() {
    mkdirSync(join(this.cwd, "src"), { recursive: true });
    writeFileSync(join(this.cwd, CODEX_RUNTIME_PROBE_ALLOWED_PATH), CODEX_RUNTIME_PROBE_FILE_CONTENT, "utf8");
    return { turn: { id: "turn-requested" } };
  }
  async waitForTurn(threadId, requestedTurnId) {
    this.events.push("turn/completed");
    this.emit("notification", { method: "turn/completed", params: { threadId, turn: { id: "turn-resolved", status: "completed" } } });
    this.events.push("turn-id-alias");
    this.emit("protocol", { method: "turn-id-alias", threadId, requestedTurnId, resolvedTurnId: "turn-resolved" });
    return { id: "turn-resolved", status: "completed" };
  }
  async readTerminalTurn() { throw new Error("thread/read: thread not loaded"); }
  async readThread() { throw new Error("thread/read: thread not loaded"); }
  async interruptTurn() {}
  async shutdown() { this.closed = true; }
  diagnostics() { return { process: { alive: !this.closed, exited: false, code: null, signal: null }, stderrTail: "", protocolEvents: [] }; }
}

test("runtime probe confirmation gate fails closed before a runtime can be created", async () => {
  let created = false;
  await assert.rejects(() => runCodexRuntimeProbe({ args: [], runtimeFactory: () => { created = true; throw new Error("must not run"); } }), /--confirm-spend-quota/);
  assert.equal(created, false);
  assert.deepEqual(parseCodexRuntimeProbeArguments([CODEX_RUNTIME_PROBE_CONFIRMATION]), { confirmed: true, unsupported: [] });
  assert.deepEqual(parseCodexRuntimeProbeArguments([CODEX_RUNTIME_PROBE_CONFIRMATION, "--workers"]), { confirmed: false, unsupported: ["--workers"] });
  assert.equal(parseCodexRuntimeProbeArguments([CODEX_RUNTIME_PROBE_CONFIRMATION, CODEX_RUNTIME_PROBE_CONFIRMATION]).confirmed, false);
  assert.throws(() => assertCodexRuntimeProbeConfirmation(["--confirm-spend-quota", "--unexpected"]), /exactly/);
});

test("probe script is registered and rejects missing or unsupported arguments without spending quota", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["e2e:codex-runtime-probe"], "node scripts/e2e-codex-runtime-probe.mjs");
  for (const args of [[], ["--unexpected"], ["--confirm-spend-quota", "--unexpected"]]) {
    const result = spawnSync(process.execPath, ["scripts/e2e-codex-runtime-probe.mjs", ...args], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--confirm-spend-quota/);
  }
});

test("quota-free compatibility harness passes only from exact cwd, actual diff, and controller finalizer artifact", async () => {
  const reportsRoot = mkdtempSync(join(tmpdir(), "codex-runtime-probe-test-reports-"));
  let runtime = null;
  const logs = [];
  try {
    const result = await runCodexRuntimeProbe({
      args: [CODEX_RUNTIME_PROBE_CONFIRMATION], reportsRoot, log: (line) => logs.push(line),
      runtimeFactory: ({ cwd }) => { runtime = new QuotaFreeRuntime({ cwd }); return runtime; }
    });
    assert.ok(runtime);
    assert.deepEqual(runtime.calls, ["connect", "thread", "turn", "observe", "reconcile", "shutdown"]);
    assert.equal(result.taskId, CODEX_RUNTIME_PROBE_TASK_ID);
    assert.deepEqual(result.cleanup, { state: "completed" });
    assert.deepEqual(result.changedPaths, [CODEX_RUNTIME_PROBE_ALLOWED_PATH]);
    assert.equal(result.artifact.baseSha, result.baseSha);
    assert.equal(runtime.calls.includes("reconcile"), true, "fake runtime exercises the terminal receipt path");
    assert.notEqual(result.artifact.headSha, result.baseSha);
    assert.deepEqual(result.artifact.changedPaths, [CODEX_RUNTIME_PROBE_ALLOWED_PATH]);
    assert.match(result.artifact.diffChecksum, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(result.reportPath), true, "report persists before disposable root cleanup");
    assert.equal(existsSync(runtime.cwd), false, "successful disposable worktree is cleaned only after report persistence");
    assert.deepEqual(logs.filter((line) => line.startsWith("[probe] ")).slice(-8), [
      "[probe] repository created", "[probe] worktree created", "[probe] runtime connected", "[probe] turn started",
      "[probe] durable terminal reconciled", "[probe] diff validated", "[probe] controller artifact committed", "[probe] probe passed"
    ]);
  } finally { rmSync(reportsRoot, { recursive: true, force: true }); }
});

test("successful artifact shuts down the runtime before disposable cleanup", async () => {
  const reportsRoot = mkdtempSync(join(tmpdir(), "codex-runtime-probe-order-test-reports-"));
  let runtime = null;
  const sequence = [];
  try {
    const result = await runCodexRuntimeProbe({
      args: [CODEX_RUNTIME_PROBE_CONFIRMATION], reportsRoot,
      runtimeFactory: ({ cwd }) => {
        runtime = new QuotaFreeRuntime({ cwd });
        const shutdown = runtime.shutdown.bind(runtime);
        runtime.shutdown = async () => { sequence.push("shutdown"); await shutdown(); };
        return runtime;
      },
      cleanup: ({ root, worktree }) => {
        sequence.push("cleanup");
        assert.equal(runtime.calls.includes("shutdown"), true);
        rmSync(root, { recursive: true, force: true });
        assert.equal(existsSync(worktree), false);
      }
    });
    assert.deepEqual(sequence, ["shutdown", "cleanup"]);
    assert.deepEqual(result.cleanup, { state: "completed" });
    assert.deepEqual(runtime.calls.filter((call) => call === "shutdown"), ["shutdown"]);
  } finally { rmSync(reportsRoot, { recursive: true, force: true }); }
});

test("cleanup failure after a successful artifact preserves the root without creating a failure report", async () => {
  const reportsRoot = mkdtempSync(join(tmpdir(), "codex-runtime-probe-preserved-test-reports-"));
  let runtime = null;
  const logs = [];
  try {
    const result = await runCodexRuntimeProbe({
      args: [CODEX_RUNTIME_PROBE_CONFIRMATION], reportsRoot, log: (line) => logs.push(line),
      runtimeFactory: ({ cwd }) => { runtime = new QuotaFreeRuntime({ cwd }); return runtime; },
      cleanup: () => { throw new Error("Permission denied while removing disposable worktree"); }
    });
    assert.equal(result.status, "passed");
    assert.equal(result.cleanup.state, "preserved");
    assert.match(result.cleanup.reason, /Permission denied/);
    assert.match(result.cleanup.recoveryCommand, /git -C/);
    assert.notEqual(result.artifact.headSha, result.baseSha, "cleanup failure does not mask the committed artifact");
    assert.deepEqual(runtime.calls.filter((call) => call === "shutdown"), ["shutdown"]);
    const persisted = JSON.parse(readFileSync(result.reportPath, "utf8"));
    assert.equal(persisted.status, "passed");
    assert.equal(persisted.cleanup.state, "preserved");
    assert.deepEqual(readdirSync(reportsRoot), [result.reportPath.split(/[\\/]/).at(-1)]);
    assert.equal(logs.includes("[probe] cleanup preserved"), true);
    assert.equal(logs.includes("[probe] probe passed"), true);
    assert.equal(logs.includes("[probe] probe failed"), false);
    rmSync(runtime.cwd.replace(/\\writer-worktree$/, ""), { recursive: true, force: true });
  } finally { rmSync(reportsRoot, { recursive: true, force: true }); }
});

test("failure before the artifact remains failed and preserves disposable-root recovery", async () => {
  const reportsRoot = mkdtempSync(join(tmpdir(), "codex-runtime-probe-failure-test-reports-"));
  let failure = null;
  let runtime = null;
  try {
    await assert.rejects(
      () => runCodexRuntimeProbe({
        args: [CODEX_RUNTIME_PROBE_CONFIRMATION], reportsRoot,
        runtimeFactory: ({ cwd }) => {
          runtime = new QuotaFreeRuntime({ cwd });
          runtime.startGoalTurn = async () => { throw new Error("turn failed before artifact"); };
          return runtime;
        }
      }),
      (error) => { failure = error; return true; }
    );
    assert.equal(failure.probeReport.status, "failed");
    assert.match(failure.probeReport.stage, /turn started/);
    assert.equal(existsSync(failure.probeReport.preservedDisposableRoot), true);
    assert.match(failure.probeReport.recoveryCommand, /git -C/);
    assert.deepEqual(runtime.calls.filter((call) => call === "shutdown"), ["shutdown"]);
    rmSync(failure.probeReport.preservedDisposableRoot, { recursive: true, force: true });
  } finally { rmSync(reportsRoot, { recursive: true, force: true }); }
});

test("quota-free probe fake passes through completed-before-alias receipt reconciliation", async () => {
  const reportsRoot = mkdtempSync(join(tmpdir(), "codex-runtime-probe-alias-test-reports-"));
  let client = null;
  try {
    const result = await runCodexRuntimeProbe({
      args: [CODEX_RUNTIME_PROBE_CONFIRMATION], reportsRoot,
      runtimeFactory: ({ cwd }) => {
        client = new AliasBeforeReceiptProbeClient();
        return new CodexAppServerRuntime({ cwd, client });
      }
    });
    assert.deepEqual(client.events, ["turn/completed", "turn-id-alias"]);
    assert.equal(result.requestedTurnId, "turn-requested");
    assert.equal(result.resolvedTurnId, "turn-resolved");
  } finally { rmSync(reportsRoot, { recursive: true, force: true }); }
});

test("failure reports are bounded, redact secrets, retain turn status, and preserve the disposable root", () => {
  const report = createCodexRuntimeProbeFailureReport({
    root: "C:/temp/codex-runtime-probe-failed", worktree: "C:/temp/codex-runtime-probe-failed/writer-worktree", stage: "turn started",
    requestedTurnId: "turn-requested", resolvedTurnId: "turn-resolved", lifecycleCandidate: { terminalClass: "completed" }, durableTerminal: { terminalClass: "failed" },
    runtimeDiagnostics: { connected: true, diagnostics: JSON.stringify({ process: { alive: false, exited: true, code: 17, signal: "SIGTERM" }, stderrTail: `token=top-secret ${"x".repeat(5_000)}`, protocolEvents: Array.from({ length: 25 }, () => ({ method: "thread/read", errorMessage: "secret=top-secret" })) }) },
    error: Object.assign(new Error("authorization=top-secret failed"), { stack: `password=top-secret ${"y".repeat(5_000)}` })
  });
  const text = JSON.stringify(report);
  assert.equal(report.preservedDisposableRoot, "C:/temp/codex-runtime-probe-failed");
  assert.equal(report.requestedTurnId, "turn-requested");
  assert.equal(report.resolvedTurnId, "turn-resolved");
  assert.deepEqual(report.lifecycle, { candidateTerminalStatus: "completed", durableTerminalStatus: "failed" });
  assert.deepEqual(report.diagnostics.process, { alive: false, exited: true, code: 17, signal: "SIGTERM" });
  assert.equal(report.diagnostics.protocolTail.length, 20);
  assert.equal(report.diagnostics.stderrTail.length <= 4_000, true);
  assert.match(report.recoveryCommand, /git -C/);
  assert.doesNotMatch(text, /top-secret/);
  assert.match(text, /\[redacted\]/);
  assert.deepEqual(boundedProbeDiagnostics(null).process, { alive: false, exited: false, code: null, signal: null });
});

test("focused probe has no delivery-stage, remote, GitHub, or multi-worker invocation", () => {
  const source = readFileSync(join(root, "src", "codex-runtime-probe.mjs"), "utf8");
  assert.doesNotMatch(source, /SwarmRouter|bootstrap|planner|source-claim|source-evidence|security-gate|quality-gate|Integrator|integration|GitHub|remote-adapters|scheduler|wave/i);
  assert.doesNotMatch(source, /git", \["-C", .*"(?:push|fetch|pull|remote)"/);
  assert.doesNotMatch(source, /git add \./i);
});
