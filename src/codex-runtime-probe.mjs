import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CodexAppServerRuntime } from "./codex-app-server-runtime.mjs";
import { WorktreeFinalizer } from "./worktree-finalizer.mjs";

export const CODEX_RUNTIME_PROBE_CONFIRMATION = "--confirm-spend-quota";
export const CODEX_RUNTIME_PROBE_RUNTIME_PATH = "codex-app-server";
export const CODEX_RUNTIME_PROBE_TASK_ID = "codex-runtime-probe-writer";
export const CODEX_RUNTIME_PROBE_ALLOWED_PATH = "src/codex-runtime-probe-output.mjs";
export const CODEX_RUNTIME_PROBE_FILE_CONTENT = "export const codexRuntimeProbe = 'controller-owned-finalizer';\n";

const bounded = (value, limit = 4_000) => String(value ?? "").slice(-limit);
const redact = (value, limit = 4_000) => bounded(value, limit)
  .replace(/((?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
  .replace(/("(?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2");
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const gitRaw = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "buffer" });
const probePrompt = () => `You are the only writer in a disposable repository. Create exactly one file at ${CODEX_RUNTIME_PROBE_ALLOWED_PATH} with exactly this content:\n${CODEX_RUNTIME_PROBE_FILE_CONTENT}\nDo not modify any other path. Do not run git add, git commit, git reset, git checkout, git clean, git worktree, git push, or create agents or threads. Do not explain, plan, or make a Git commit; write the file and finish the turn.`;

export function parseCodexRuntimeProbeArguments(args = []) {
  const values = Array.isArray(args) ? args : [];
  const unsupported = values.filter((value) => value !== CODEX_RUNTIME_PROBE_CONFIRMATION);
  return Object.freeze({ confirmed: values.length === 1 && values[0] === CODEX_RUNTIME_PROBE_CONFIRMATION, unsupported });
}

export function assertCodexRuntimeProbeConfirmation(args = []) {
  const parsed = parseCodexRuntimeProbeArguments(args);
  if (!parsed.confirmed) throw new Error(`Refusing to run real Codex runtime probe without exactly ${CODEX_RUNTIME_PROBE_CONFIRMATION}.`);
  return parsed;
}

export function createCodexRuntimeProbeRepository({ temporaryRoot = null } = {}) {
  const root = temporaryRoot ? resolve(temporaryRoot) : mkdtempSync(join(tmpdir(), "codex-runtime-probe-"));
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  writeFileSync(join(root, "README.md"), "# Disposable Codex runtime probe\n", "utf8");
  git(root, ["add", "--", "README.md"]);
  git(root, ["-c", "user.name=probe-controller", "-c", "user.email=probe-controller@example.invalid", "commit", "-m", "probe base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  return { root, baseSha, worktree: join(root, "writer-worktree") };
}

export function createCodexRuntimeProbeWorktree({ root, baseSha, worktree }) {
  git(root, ["worktree", "add", "--detach", worktree, baseSha]);
  const resolvedBaseSha = git(worktree, ["rev-parse", "HEAD"]);
  if (resolvedBaseSha !== baseSha) throw new Error(`Probe worktree HEAD ${resolvedBaseSha} does not equal controller base SHA ${baseSha}`);
  return { worktree, baseSha: resolvedBaseSha };
}

export function actualProbeDiff({ worktree, baseSha }) {
  const paths = gitRaw(worktree, ["diff", "--name-only", "-z", baseSha, "--"]).toString("utf8").split("\0").filter(Boolean).map((path) => path.replace(/\\/g, "/"));
  const status = gitRaw(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).toString("utf8");
  const untracked = status.split("\0").filter(Boolean).filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3).replace(/\\/g, "/"));
  return [...new Set([...paths, ...untracked])];
}

export function assertAcceptedProbeDiff({ worktree, baseSha }) {
  const workerHead = git(worktree, ["rev-parse", "HEAD"]);
  if (workerHead !== baseSha) throw new Error("Probe writer created a Git commit; only the controller finalizer may commit");
  const changedPaths = actualProbeDiff({ worktree, baseSha });
  if (changedPaths.length !== 1 || changedPaths[0] !== CODEX_RUNTIME_PROBE_ALLOWED_PATH) {
    throw new Error(`Probe diff must contain only ${CODEX_RUNTIME_PROBE_ALLOWED_PATH}; got ${changedPaths.join(", ") || "no paths"}`);
  }
  return changedPaths;
}

function probeOverlay(baseSha) {
  return { schemaVersion: 1, repository: { baseSha }, pathPolicies: { denyWrite: [], generatedDoNotEdit: [], approvalRequired: [] }, components: [], verificationCommands: [] };
}

function safeProcess(value) {
  const process = value && typeof value === "object" ? value : {};
  return { alive: process.alive === true, exited: process.exited === true, code: Number.isFinite(Number(process.code)) ? Number(process.code) : null, signal: typeof process.signal === "string" ? bounded(process.signal, 80) : null };
}

function parseDiagnostics(value) {
  let parsed = value;
  for (let count = 0; count < 2 && typeof parsed === "string"; count += 1) {
    try { parsed = JSON.parse(parsed); } catch { break; }
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function boundedProbeDiagnostics(runtimeDiagnostics = null) {
  const runtime = parseDiagnostics(runtimeDiagnostics?.diagnostics ?? runtimeDiagnostics);
  return {
    process: safeProcess(runtime.process),
    stderrTail: redact(runtime.stderrTail),
    protocolTail: (runtime.protocolEvents ?? []).slice(-20).map((event) => ({ direction: event?.direction ?? null, method: event?.method ?? null, threadId: event?.threadId ?? null, turnId: event?.turnId ?? null, requestedTurnId: event?.requestedTurnId ?? null, resolvedTurnId: event?.resolvedTurnId ?? null, itemStatus: event?.itemStatus ?? null, errorCode: event?.errorCode ?? null, errorMessage: redact(event?.errorMessage, 320) })),
    runtime: { connected: runtimeDiagnostics?.connected === true, closed: runtimeDiagnostics?.closed === true, reconnectRequired: runtimeDiagnostics?.reconnectRequired === true }
  };
}

export function createCodexRuntimeProbeFailureReport({ root = null, worktree = null, stage, requestedTurnId = null, resolvedTurnId = null, lifecycleCandidate = null, durableTerminal = null, runtimeDiagnostics = null, error = null } = {}) {
  return {
    schemaVersion: 1,
    kind: "CodexRuntimeProbeReport",
    status: "failed",
    stage,
    preservedDisposableRoot: root,
    requestedTurnId,
    resolvedTurnId,
    lifecycle: { candidateTerminalStatus: lifecycleCandidate?.terminalClass ?? null, durableTerminalStatus: durableTerminal?.terminalClass ?? null },
    diagnostics: boundedProbeDiagnostics(runtimeDiagnostics),
    error: { name: bounded(error?.name || "Error", 200), message: redact(error?.message), stackTail: redact(error?.stack) },
    recoveryCommand: worktree ? `git -C "${worktree}" status --short` : null
  };
}

function persistProbeReport(report, reportsRoot = null) {
  const root = reportsRoot ? resolve(reportsRoot) : mkdtempSync(join(tmpdir(), "codex-runtime-probe-reports-"));
  mkdirSync(root, { recursive: true });
  const path = join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

function updatePersistedProbeReport(path, report) {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function cleanupRecoveryCommand({ root, worktree }) {
  return root && worktree ? `git -C "${root}" worktree remove --force "${worktree}"` : null;
}

function preservedCleanup(error, repository) {
  return {
    state: "preserved",
    reason: redact(error?.message || "Disposable probe cleanup could not be completed."),
    recoveryCommand: cleanupRecoveryCommand(repository)
  };
}

export function cleanupPassedCodexRuntimeProbeRoot({ root, worktree }) {
  if (!root || !worktree || !resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !resolve(root).includes("codex-runtime-probe-")) throw new Error("Refusing to clean a non-disposable Codex runtime probe root");
  if (existsSync(worktree)) git(root, ["worktree", "remove", "--force", worktree]);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

export async function runCodexRuntimeProbe({ args = [], runtimeFactory = ({ cwd }) => new CodexAppServerRuntime({ cwd }), reportsRoot = null, log = (line) => console.log(line), cleanup = cleanupPassedCodexRuntimeProbeRoot } = {}) {
  assertCodexRuntimeProbeConfirmation(args);
  let repository = null;
  let runtime = null;
  let stage = "initializing";
  let threadId = null;
  let requestedTurnId = null;
  let resolvedTurnId = null;
  let lifecycleCandidate = null;
  let durableTerminal = null;
  let shutdownStarted = false;
  const shutdownRuntime = async () => {
    if (shutdownStarted || !runtime?.shutdown) return;
    shutdownStarted = true;
    await runtime.shutdown();
  };
  try {
    repository = createCodexRuntimeProbeRepository();
    createCodexRuntimeProbeWorktree(repository);
    log(`[probe] selected runtime path: ${CODEX_RUNTIME_PROBE_RUNTIME_PATH}`);
    log(`[probe] task ID: ${CODEX_RUNTIME_PROBE_TASK_ID}`);
    log(`[probe] worktree path: ${repository.worktree}`);
    log(`[probe] base SHA: ${repository.baseSha}`);
    stage = "repository created"; log(`[probe] ${stage}`);
    stage = "worktree created"; log(`[probe] ${stage}`);
    runtime = runtimeFactory({ cwd: repository.worktree, taskId: CODEX_RUNTIME_PROBE_TASK_ID });
    if (!(runtime instanceof CodexAppServerRuntime) && runtime?.cwd !== repository.worktree) throw new Error("Probe runtime did not receive the exact controller-assigned cwd");
    if (runtime.cwd !== repository.worktree) throw new Error("Probe runtime cwd differs from the exact controller-assigned worktree");
    await runtime.connect();
    stage = "runtime connected"; log(`[probe] ${stage}`);
    const thread = await runtime.startThread({}); threadId = thread.threadId;
    stage = "turn started"; log(`[probe] ${stage}`);
    const turn = await runtime.startGoalTurn({ threadId, goal: { objective: "Create the declared deterministic probe source file.", status: "active" }, turn: { input: [{ type: "text", text: probePrompt() }] } });
    requestedTurnId = turn.turnId;
    lifecycleCandidate = await runtime.observeTerminal({ threadId, turnId: requestedTurnId, timeoutMs: 600_000 });
    durableTerminal = await runtime.reconcileTerminal({ threadId, turnId: requestedTurnId, timeoutMs: 30_000 });
    resolvedTurnId = durableTerminal.turnId;
    if (durableTerminal.terminalClass !== "completed") throw new Error(`Probe requires a durable completed terminal, got ${durableTerminal.terminalClass}`);
    if (durableTerminal.terminalReceipt?.schemaVersion !== 1 || durableTerminal.terminalReceipt?.kind !== "AppServerTerminalReceipt") throw new Error("Probe requires a versioned AppServerTerminalReceipt");
    stage = "durable terminal reconciled"; log(`[probe] ${stage}`);
    const changedPaths = assertAcceptedProbeDiff({ worktree: repository.worktree, baseSha: repository.baseSha });
    stage = "diff validated"; log(`[probe] ${stage}`);
    const finalized = await new WorktreeFinalizer({ repository: repository.root, generatedDir: "controller-artifacts" }).finalize({ task: { id: CODEX_RUNTIME_PROBE_TASK_ID, role: "backend", allowedPaths: [CODEX_RUNTIME_PROBE_ALLOWED_PATH], dependencies: [] }, worktree: repository.worktree, branch: "probe/controller-finalizer", overlay: probeOverlay(repository.baseSha), overlayPath: "controller-owned probe overlay" });
    const artifact = finalized.artifact;
    if (artifact.baseSha !== repository.baseSha || artifact.headSha === repository.baseSha || artifact.changedPaths.length !== 1 || artifact.changedPaths[0] !== CODEX_RUNTIME_PROBE_ALLOWED_PATH || !/^[a-f0-9]{64}$/i.test(artifact.diffChecksum)) throw new Error("Controller finalizer returned an invalid WorkerArtifact");
    if (git(repository.worktree, ["rev-parse", "HEAD"]) !== artifact.headSha) throw new Error("Controller finalizer commit does not match WorkerArtifact head SHA");
    stage = "controller artifact committed"; log(`[probe] ${stage}`);
    const report = { schemaVersion: 1, kind: "CodexRuntimeProbeReport", status: "passed", runtimePath: CODEX_RUNTIME_PROBE_RUNTIME_PATH, taskId: CODEX_RUNTIME_PROBE_TASK_ID, baseSha: repository.baseSha, threadId, requestedTurnId, resolvedTurnId, changedPaths, artifact: { ...artifact, path: finalized.path } };
    const reportPath = persistProbeReport(report, reportsRoot);
    try {
      await shutdownRuntime();
      await cleanup({ root: repository.root, worktree: repository.worktree });
      report.cleanup = { state: "completed" };
    } catch (error) {
      report.cleanup = preservedCleanup(error, repository);
      log("[probe] cleanup preserved");
      if (report.cleanup.recoveryCommand) log(`[probe] recovery: ${report.cleanup.recoveryCommand}`);
    }
    updatePersistedProbeReport(reportPath, report);
    stage = "probe passed"; log(`[probe] ${stage}`);
    return { ...report, reportPath };
  } catch (error) {
    const runtimeDiagnostics = runtime ? await runtime.diagnostics().catch((diagnosticError) => ({ diagnostics: diagnosticError?.message })) : null;
    const report = createCodexRuntimeProbeFailureReport({ root: repository?.root ?? null, worktree: repository?.worktree ?? null, stage, requestedTurnId, resolvedTurnId, lifecycleCandidate, durableTerminal, runtimeDiagnostics, error });
    const reportPath = persistProbeReport(report, reportsRoot);
    log("[probe] probe failed");
    log(`[probe] preserved disposable root: ${report.preservedDisposableRoot ?? "none"}`);
    log(`[probe] failure report: ${reportPath}`);
    if (report.recoveryCommand) log(`[probe] recovery: ${report.recoveryCommand}`);
    throw Object.assign(new Error(report.error.message), { probeReport: report, reportPath });
  } finally {
    await shutdownRuntime().catch(() => {});
  }
}
