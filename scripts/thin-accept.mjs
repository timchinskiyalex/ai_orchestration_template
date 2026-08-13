import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runThinAcceptance } from "../src/thin/acceptance.mjs";
import { createIsolatedWorktree, removeIsolatedWorktree } from "../src/thin/git-worktree.mjs";
import { runThinRepair } from "../src/thin/repair.mjs";
import { runThinAppServerWorker } from "../src/thin/app-server-worker.mjs";
import { finalizeWorkerArtifact } from "../src/thin/finalizer.mjs";
import { CodexAppServerRuntime } from "../src/codex-app-server-runtime.mjs";
import { runVerification } from "./thin-deliver.mjs";

const exec = promisify(execFile);

export function parseThinAcceptArgs(argv) {
  const options = { repo: process.cwd(), docs: null, productDocs: [], candidate: null, verify: null, repairSurface: null, auditTimeoutMs: 180_000, confirm: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--confirm-spend-quota") options.confirm = true;
    else if (["--repo", "--docs", "--product-doc", "--candidate", "--verify", "--repair-surface", "--audit-timeout-ms"].includes(value)) {
      const argument = argv[++index]; if (!argument) throw new Error(`${value} requires a value`);
      if (value === "--repo") options.repo = argument;
      if (value === "--docs") options.docs = argument;
      if (value === "--product-doc") options.productDocs.push(argument);
      if (value === "--candidate") options.candidate = argument;
      if (value === "--verify") options.verify = argument;
      if (value === "--repair-surface") options.repairSurface = [...new Set(argument.split(",").map((part) => part.trim()).filter(Boolean))];
      if (value === "--audit-timeout-ms") options.auditTimeoutMs = parseAuditTimeoutMs(argument);
    } else throw new Error(`unknown option: ${value}`);
  }
  return options;
}

export const thinAcceptUsage = () => "Usage: node scripts/thin-accept.mjs --repo <git-repo> --docs <Markdown file-or-directory> [--product-doc <Markdown file> ...] --candidate <SHA> --verify <command> --repair-surface <path,path> [--audit-timeout-ms 1000..240000] --confirm-spend-quota\nA docs directory defaults only to one TECH_SPEC.md; otherwise pass explicit --product-doc values.";

/** Only selected product Markdown can create acceptance criteria. */
export function readThinProductDocuments({ docs, productDocs = [] } = {}) {
  const docsPath = resolve(requireText(docs, "--docs"));
  const docsStats = statSync(docsPath);
  const selected = productDocs.length ? productDocs.map((value) => resolveProductDocument(docsPath, docsStats, value)) : defaultProductDocuments(docsPath, docsStats);
  const unique = [...new Set(selected.map((path) => realpathSync(path)))].sort((left, right) => left.localeCompare(right));
  if (!unique.length) throw new Error("No product document selected; pass --product-doc");
  return Object.freeze(unique.map((path) => Object.freeze({ documentId: productDocumentId(docsPath, docsStats, path), markdown: readFileSync(path, "utf8") })));
}

function defaultProductDocuments(docsPath, docsStats) {
  if (docsStats.isFile()) return [assertMarkdownFile(docsPath, "--docs")];
  if (!docsStats.isDirectory()) throw new Error("--docs must be a Markdown file or directory");
  const matches = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase() === "tech_spec.md") matches.push(path);
    }
  };
  visit(docsPath);
  if (matches.length !== 1) throw new Error(matches.length ? "Multiple TECH_SPEC.md files found; pass explicit --product-doc values" : "No TECH_SPEC.md found; pass explicit --product-doc values");
  return matches;
}

function resolveProductDocument(docsPath, docsStats, input) {
  const value = requireText(input, "--product-doc");
  const candidate = resolve(isAbsolute(value) ? value : docsStats.isDirectory() ? join(docsPath, value) : value);
  if (docsStats.isDirectory() && !isInside(docsPath, candidate)) throw new Error("--product-doc must be inside --docs directory");
  if (docsStats.isFile() && realpathSync(candidate) !== realpathSync(docsPath)) throw new Error("--product-doc must match the --docs file");
  return assertMarkdownFile(candidate, "--product-doc");
}

function assertMarkdownFile(path, label) {
  if (extname(path).toLowerCase() !== ".md") throw new Error(`${label} must identify a Markdown file`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label} must identify a regular Markdown file`);
  return path;
}

function isInside(root, child) {
  const value = relative(realpathSync(root), realpathSync(child));
  return value !== "" && !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value);
}

function productDocumentId(docsPath, docsStats, path) {
  return docsStats.isDirectory() ? relative(realpathSync(docsPath), realpathSync(path)).replaceAll("\\", "/") : realpathSync(path).replaceAll("\\", "/");
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} requires a value`);
  return value.trim();
}

/**
 * The optional dependencies are deliberately test-only seams.  They keep the
 * CLI controller-owned: production always uses the concrete Git/App Server
 * implementations below.
 */
export async function runThinAccept({ argv = process.argv.slice(2), stdout = console.log, stderr = console.error, dependencies = {} } = {}) {
  let options;
  try { options = parseThinAcceptArgs(argv); } catch (error) { stderr(`[failure] stage=argument code=invalid_arguments message=${safe(error.message)}`); return 2; }
  if (options.help) { stdout(thinAcceptUsage()); return 0; }
  if (!options.confirm) { stderr("[failure] stage=admission code=quota_confirmation_required"); return 2; }
  if (![options.docs, options.candidate, options.verify, options.repairSurface?.length].every(Boolean)) { stderr("[failure] stage=argument code=docs_candidate_verify_and_repair_surface_required"); return 2; }
  if (!/^[0-9a-f]{7,64}$/i.test(options.candidate)) { stderr("[failure] stage=argument code=candidate_sha_invalid"); return 2; }

  const repository = resolve(options.repo);
  const runtimeDir = dependencies.createRuntimeDir?.() ?? mkdtempSync(join(tmpdir(), "thin-acceptance-"));
  let isolated = null; let result = null; let cleanupAllowed = false;
  const writeReport = (report) => { const path = join(runtimeDir, "acceptance-report.json"); writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`); stdout(`[acceptance] report ${path}`); return path; };
  try {
    const sources = (dependencies.readThinProductDocuments ?? readThinProductDocuments)({ docs: options.docs, productDocs: options.productDocs });
    const sourceIdentity = await readSourceIdentity(repository);
    const createWorktree = dependencies.createIsolatedWorktree ?? createIsolatedWorktree;
    const removeWorktree = dependencies.removeIsolatedWorktree ?? removeIsolatedWorktree;
    const semanticTurn = dependencies.runSemanticAuditTurn ?? ((args) => runSemanticAuditTurn({
      ...args,
      timeoutMs: options.auditTimeoutMs,
      runtimeFactory: dependencies.acceptanceRuntimeFactory,
      heartbeatMs: dependencies.acceptanceHeartbeatMs
    }));
    const runWorker = dependencies.runThinAppServerWorker ?? runThinAppServerWorker;
    const finalize = dependencies.finalizeWorkerArtifact ?? finalizeWorkerArtifact;
    const verifyCommand = dependencies.runVerification ?? runVerification;
    isolated = await createWorktree({ repository, runtimeDir, taskId: `acceptance-candidate-${options.candidate.slice(0, 12)}`, baseSha: options.candidate });
    const assertAuditClean = async () => {
      const { stdout: status } = await exec("git", ["-C", isolated.worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer" });
      if (status.length) throw new Error("acceptance audit modified the candidate worktree");
    };
    const audit = async ({ prompt }) => {
      await assertAuditClean();
      const text = await semanticTurn({ cwd: isolated.worktree, prompt, stdout, label: "acceptance" });
      await assertAuditClean();
      return text;
    };
    const verify = () => verifyCommand({ worktree: isolated.worktree, command: options.verify });
    const repair = ({ candidateSha, failureOutput, attempts }) => runThinRepair({
      candidateSha, verificationFailure: failureOutput, attempts, repairSurface: options.repairSurface, previousWaveTaskScopes: [],
      planRepair: async ({ verificationFailure, repairSurface }) => JSON.parse(await semanticTurn({ cwd: isolated.worktree, label: "acceptance-repair", stdout, prompt: repairPrompt({ verificationFailure, repairSurface }) })),
      executeRepair: async ({ candidateSha: baseSha, repairPlan }) => {
        await runWorker({ cwd: isolated.worktree, taskKey: "acceptance-repair-1", prompt: repairPlan.prompt, allowedPaths: repairPlan.allowedPaths, onEvent: (event) => { if (event.kind === "started" || event.kind === "completed") stdout(`[repair] ${event.kind}`); } });
        return finalize({ taskId: "acceptance-repair-1", worktree: isolated.worktree, baseSha, allowedPaths: repairPlan.allowedPaths });
      },
    }).then((repairResult) => repairResult.ok ? { ok: true, candidateSha: repairResult.artifact.commitSha, attempts: repairResult.attempts } : repairResult);
    result = await runThinAcceptance({ sources, candidateSha: isolated.baseSha, audit, verify, repair, onEvent: (event) => { if (event.type === "audit_started") stdout(`[acceptance] audit ${event.phase} started`); if (event.type === "audit_completed") stdout(`[acceptance] audit ${event.phase} ${event.passing ? "passed" : "gaps"}`); if (event.type === "verification_completed") stdout(`[acceptance] verification ${event.phase} passed`); } });
    let candidateBranch = null;
    if (result.ok && result.repaired) {
      candidateBranch = await assertDurableAcceptanceCandidate({ repository, isolated, candidateSha: result.candidateSha, sourceIdentity });
    } else if (result.ok) {
      await assertSourceIdentity(repository, sourceIdentity);
    }
    writeReport({ ...result.report, candidateBranch });
    if (!result.ok) { stdout(`[failure] stage=acceptance code=${result.code} recovery=${isolated.worktree}`); return 1; }
    cleanupAllowed = true;
    stdout(`[completed] accepted candidate ${result.candidateSha}${candidateBranch ? ` branch=${candidateBranch}` : ""}`);
    return 0;
  } catch (error) {
    writeReport({
      schemaVersion: 1,
      kind: "ThinAcceptanceReport",
      state: "blocked",
      code: "acceptance_runtime_failed",
      detail: safe(error?.message),
      auditRuntime: safeAuditDiagnostic(error?.acceptanceAuditDiagnostic)
    });
    stderr(`[failure] stage=acceptance code=acceptance_runtime_failed recovery=${isolated?.worktree ?? runtimeDir} message=${safe(error?.message)}`);
    return 1;
  } finally {
    if (cleanupAllowed && isolated) await (dependencies.removeIsolatedWorktree ?? removeIsolatedWorktree)(isolated);
    else stdout(`[recovery] acceptance runtime preserved ${runtimeDir}`);
  }
}

async function readSourceIdentity(repository) {
  const [head, branch, status] = await Promise.all([
    exec("git", ["-C", repository, "rev-parse", "HEAD"]),
    exec("git", ["-C", repository, "rev-parse", "--abbrev-ref", "HEAD"]),
    exec("git", ["-C", repository, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer" }),
  ]);
  if (status.stdout.length) throw new Error("Source repository is dirty; refusing acceptance");
  return { head: String(head.stdout).trim(), branch: String(branch.stdout).trim() };
}

async function assertSourceIdentity(repository, expected) {
  const observed = await readSourceIdentity(repository);
  if (observed.head !== expected.head || observed.branch !== expected.branch) {
    throw new Error("Source branch changed during acceptance; preserving candidate recovery worktree");
  }
}

async function assertDurableAcceptanceCandidate({ repository, isolated, candidateSha, sourceIdentity }) {
  await assertSourceIdentity(repository, sourceIdentity);
  if (typeof isolated.branch !== "string" || !/^thin\/acceptance-candidate-[A-Za-z0-9._-]+(?:-[A-Za-z0-9._-]+)*$/.test(isolated.branch)) {
    throw new Error("Acceptance candidate branch is not controller-owned");
  }
  const [branchHead, worktreeHead] = await Promise.all([
    exec("git", ["-C", repository, "rev-parse", "--verify", `${isolated.branch}^{commit}`]),
    exec("git", ["-C", isolated.worktree, "rev-parse", "HEAD"]),
  ]);
  const expected = String(candidateSha).trim();
  if (String(branchHead.stdout).trim() !== expected || String(worktreeHead.stdout).trim() !== expected) {
    throw new Error("Acceptance repair candidate branch does not point to the verified candidate SHA");
  }
  return isolated.branch;
}

function repairPrompt({ verificationFailure, repairSurface }) {
  return [
    "You are the repair planner for exactly one acceptance failure.",
    "Return exactly JSON, no Markdown: {\"title\":\"...\",\"prompt\":\"...\",\"allowedPaths\":[\"relative/path\"]}.",
    "Use only these controller-authorized repair surfaces:", ...repairSurface.map((path) => `- ${path}`),
    "Do not propose Git operations or edit paths outside the surface.",
    "Failure evidence:", verificationFailure,
  ].join("\n");
}

export class ThinAcceptanceAuditRuntimeError extends Error {
  constructor(code, message, diagnostic = null) {
    super(message);
    this.name = "ThinAcceptanceAuditRuntimeError";
    this.code = code;
    this.acceptanceAuditDiagnostic = diagnostic;
  }
}

/**
 * Runs an acceptance-only, read-only semantic audit through the same thin
 * Codex runtime used by workers.  The runtime, not a raw waitForTurn call,
 * owns terminal receipt correlation and reconciliation.
 */
export async function runSemanticAuditTurn({ cwd, prompt, stdout = () => {}, label = "acceptance", timeoutMs = 180_000, runtimeFactory = null, heartbeatMs = 10_000 } = {}) {
  const boundedTimeoutMs = normalizeAuditTimeoutMs(timeoutMs);
  const boundedHeartbeatMs = normalizeHeartbeatMs(heartbeatMs);
  const runtime = runtimeFactory?.({ cwd, label }) ?? new CodexAppServerRuntime({ cwd });
  assertAcceptanceRuntime(runtime, cwd);
  let threadId = null;
  let requestedTurnId = null;
  let resolvedTurnId = null;
  let runtimeStage = "connect";
  let heartbeat = null;
  const startedAt = Date.now();
  const observation = (event) => {
    if (["worker_activity", "worker_terminal_candidate"].includes(event?.kind)) stdout(`[${label}] activity`);
  };
  const startHeartbeat = () => {
    heartbeat = setInterval(() => stdout(`[${label}] heartbeat thread=${safeId(threadId)} turn=${safeId(requestedTurnId)} elapsedMs=${Date.now() - startedAt}`), boundedHeartbeatMs);
  };
  try {
    await runtime.connect();
    runtimeStage = "start_thread";
    const thread = await runtime.startThread({ cwd, serviceName: "thin-acceptance-auditor", sandbox: "read-only", approvalPolicy: "never" });
    threadId = requireId(thread?.threadId, "acceptance audit thread ID");
    runtimeStage = "start_turn";
    const turn = await runtime.startGoalTurn({
      threadId,
      goal: { objective: "Return only requested semantic JSON; do not modify the repository.", status: "active" },
      turn: { input: [{ type: "text", text: prompt }], effort: "low" }
    });
    requestedTurnId = requireId(turn?.turnId, "acceptance audit turn ID");
    runtime.on?.("observation", observation);
    stdout(`[${label}] started`);
    startHeartbeat();
    runtimeStage = "observe_terminal";
    const candidate = await runtime.observeTerminal({ threadId, turnId: requestedTurnId, timeoutMs: boundedTimeoutMs });
    if (candidate?.threadId !== threadId || !TERMINAL.has(candidate?.terminalClass) || typeof candidate?.turnId !== "string") {
      throw new Error("acceptance audit terminal candidate is not correlated");
    }
    resolvedTurnId = candidate.turnId;
    runtimeStage = "reconcile_terminal";
    const durable = await runtime.reconcileTerminal({ threadId, turnId: requestedTurnId, timeoutMs: Math.min(2_500, boundedTimeoutMs) });
    if (durable?.kind !== "worker_completed" || durable?.terminalClass !== "completed" || durable?.threadId !== threadId || durable?.turnId !== resolvedTurnId) {
      throw new Error("acceptance audit terminal reconciliation did not prove completion");
    }
    if (!isExactReceipt(durable.terminalReceipt, { threadId, requestedTurnId, resolvedTurnId })) {
      throw new Error("acceptance audit terminal receipt is unavailable or uncorrelated");
    }
    runtimeStage = "result_read";
    const result = await runtime.readFinalResult({ threadId, turnId: resolvedTurnId });
    if (result?.threadId !== threadId || result?.turnId !== resolvedTurnId || typeof result?.resultText !== "string" || !result.resultText.trim()) {
      throw new Error("acceptance audit final result unavailable");
    }
    return result.resultText;
  } catch (cause) {
    const code = auditRuntimeCode(cause, runtimeStage);
    if (threadId && requestedTurnId && (code === "timeout" || runtimeStage === "observe_terminal" || runtimeStage === "reconcile_terminal")) {
      try { await runtime.cancel({ threadId, turnId: requestedTurnId }); } catch {}
    }
    const diagnostic = await auditDiagnostic({ runtime, threadId, requestedTurnId, resolvedTurnId, runtimeStage, code, cause });
    throw new ThinAcceptanceAuditRuntimeError(code, `acceptance audit ${code}`, diagnostic);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    runtime.off?.("observation", observation);
    await runtime.shutdown().catch(() => {});
  }
}

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const RECEIPT_SOURCES = new Set(["turn_completed", "same_provider_thread_read", "same_provider_thread_read_result_equivalence"]);

function parseAuditTimeoutMs(value) {
  if (!/^\d+$/.test(String(value))) throw new Error("--audit-timeout-ms must be an integer between 1000 and 240000");
  return normalizeAuditTimeoutMs(Number(value));
}

function normalizeAuditTimeoutMs(value) {
  if (!Number.isInteger(value) || value < 1_000 || value > 240_000) throw new Error("audit timeout must be an integer between 1000 and 240000 ms");
  return value;
}

function normalizeHeartbeatMs(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new Error("acceptance heartbeat must be an integer between 1 and 10000 ms");
  return value;
}

function assertAcceptanceRuntime(runtime, cwd) {
  const required = ["connect", "startThread", "startGoalTurn", "observeTerminal", "reconcileTerminal", "readFinalResult", "cancel", "diagnostics", "shutdown"];
  if (!runtime || runtime.cwd !== cwd || required.some((method) => typeof runtime[method] !== "function")) throw new Error("acceptance audit requires the controller-owned Codex App Server runtime");
}

function requireId(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} unavailable`);
  return value;
}

function isExactReceipt(receipt, { threadId, requestedTurnId, resolvedTurnId }) {
  return receipt?.schemaVersion === 1 && receipt?.kind === "AppServerTerminalReceipt" && RECEIPT_SOURCES.has(receipt?.source)
    && receipt.threadId === threadId && receipt.requestedTurnId === requestedTurnId && receipt.resolvedTurnId === resolvedTurnId
    && receipt.terminalClass === "completed" && typeof receipt.correlationId === "string" && Boolean(receipt.correlationId);
}

function auditRuntimeCode(cause, stage) {
  const declared = String(cause?.errorCode ?? cause?.code ?? "");
  if (/timeout/i.test(declared) || /timed out|timeout/i.test(String(cause?.message ?? ""))) return "timeout";
  if (/process_exit|exited/i.test(declared) || /process exit|exited/i.test(String(cause?.message ?? ""))) return "process_exit";
  if (/receipt|reconcile|terminal/i.test(declared) || stage === "reconcile_terminal") return "terminal_unavailable";
  if (stage === "result_read") return "final_result_unavailable";
  return "transport_failure";
}

async function auditDiagnostic({ runtime, threadId, requestedTurnId, resolvedTurnId, runtimeStage, code, cause }) {
  let diagnostics = null;
  try { diagnostics = await runtime.diagnostics(); } catch {}
  return {
    threadId: safeId(threadId),
    requestedTurnId: safeId(requestedTurnId),
    resolvedTurnId: safeId(resolvedTurnId),
    runtimeStage,
    code,
    errorClass: safeId(cause?.errorClass) ?? "runtime",
    process: safeDiagnosticText(diagnostics?.diagnostics),
    reconnectRequired: diagnostics?.reconnectRequired === true
  };
}

function safeAuditDiagnostic(value) {
  if (!value || typeof value !== "object") return null;
  return {
    threadId: safeId(value.threadId), requestedTurnId: safeId(value.requestedTurnId), resolvedTurnId: safeId(value.resolvedTurnId),
    runtimeStage: safeId(value.runtimeStage), code: safeId(value.code), errorClass: safeId(value.errorClass),
    process: safeDiagnosticText(value.process), reconnectRequired: value.reconnectRequired === true
  };
}

function safeDiagnosticText(value) {
  return typeof value === "string"
    ? value.replace(/((?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]").replace(/[\r\n]+/g, " ").slice(0, 2_000)
    : null;
}
function safeId(value) { return typeof value === "string" && value.length <= 512 ? value : null; }
function safe(value) { return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 500); }

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await runThinAccept({});
