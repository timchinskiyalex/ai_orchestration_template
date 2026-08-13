import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const allowedEventKeys = new Set(["timestamp", "type", "stage", "status", "taskId", "threadId", "turnId", "requestedTurnId", "resolvedTurnId", "itemType", "itemStatus", "tokenUsage", "artifactPath", "integrationPath", "candidateBranch", "localVerification", "errorKind", "errorCode", "method", "direction", "reason", "lifecycleKind"]);
const numericUsage = (usage) => Object.fromEntries(Object.entries(usage ?? {}).filter(([, value]) => Number.isFinite(Number(value))).map(([key, value]) => [key, Number(value)]));
const bounded = (value, limit = 4_000) => String(value ?? "").slice(-limit);
const redact = (value) => bounded(value)
  .replace(/((?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
  .replace(/("(?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2");

export function safeE2eEvent(type, details = {}) {
  const value = { timestamp: details.timestamp ?? new Date().toISOString(), type };
  for (const [key, item] of Object.entries(details)) {
    if (!allowedEventKeys.has(key) || item === undefined || item === null) continue;
    value[key] = key === "tokenUsage" ? numericUsage(item) : item;
  }
  return value;
}

function safeTask(task) {
  if (!task) return null;
  return { id: task.id ?? null, status: task.status ?? null, threadId: task.threadId ?? null, turnId: task.turnId ?? null, worktree: task.worktree ?? null };
}

function safeProcess(process = null) {
  if (!process || typeof process !== "object") return null;
  return {
    alive: process.alive === true,
    exited: process.exited === true,
    code: process.code != null && Number.isFinite(Number(process.code)) ? Number(process.code) : null,
    signal: typeof process.signal === "string" ? bounded(process.signal, 80) : null
  };
}

function safeProtocolEvent(event) {
  if (!event || typeof event !== "object") return null;
  return {
    timestamp: event.timestamp ?? null, direction: event.direction ?? null, method: event.method ?? null,
    threadId: event.threadId ?? null, turnId: event.turnId ?? null,
    requestedTurnId: event.requestedTurnId ?? null, resolvedTurnId: event.resolvedTurnId ?? null,
    itemType: event.itemType ?? null, itemStatus: event.itemStatus ?? null,
    errorCode: event.errorCode ?? null, errorMessage: redact(event.errorMessage)
  };
}

function safeLifecycleEvent(event) {
  if (!event || typeof event !== "object") return null;
  return {
    timestamp: event.timestamp ?? null, type: event.type ?? null, taskId: event.taskId ?? null,
    threadId: event.threadId ?? null, turnId: event.turnId ?? null, itemStatus: event.itemStatus ?? null,
    errorCode: event.errorCode ?? null, taxonomy: event.taxonomy ?? null,
    lifecycleKind: event.lifecycleKind ?? null, method: event.method ?? null,
    direction: event.direction ?? null, reason: redact(event.reason)
  };
}

function safeDiagnostics(runtime = null) {
  if (!runtime) return null;
  const appServer = runtime.appServer?.appServer ?? runtime.appServer ?? null;
  const processExit = runtime.processExit ?? appServer?.processExit ?? null;
  return {
    task: safeTask(runtime.task),
    threadRead: runtime.threadRead ? {
      available: runtime.threadRead.available === true, source: runtime.threadRead.source ?? null,
      threadId: runtime.threadRead.threadId ?? null, turnId: runtime.threadRead.turnId ?? null,
      turnStatus: runtime.threadRead.turnStatus ?? null, resultAvailable: runtime.threadRead.resultAvailable === true,
      reason: redact(runtime.threadRead.reason), error: redact(runtime.threadRead.error)
    } : null,
    process: safeProcess(appServer?.process ?? processExit?.process ?? processExit?.processExit ?? null),
    stderrTail: redact(appServer?.stderrTail ?? ""),
    protocolEvents: (appServer?.protocolEvents ?? []).slice(-100).map(safeProtocolEvent).filter(Boolean),
    lifecycleEvents: (runtime.lifecycleEvents ?? []).slice(-100).map(safeLifecycleEvent).filter(Boolean),
    activeTurns: (runtime.activeTurns ?? runtime.appServer?.activeTurns ?? []).slice(-20).map((turn) => ({
      taskId: turn?.taskId ?? null, threadId: turn?.threadId ?? null, turnId: turn?.turnId ?? null,
      requestedTurnId: turn?.requestedTurnId ?? null, authoritativeTerminal: turn?.authoritativeTerminal === true
    })),
    primaryFailure: runtime.primaryFailure ? {
      taxonomy: runtime.primaryFailure.taxonomy ?? null,
      providerErrorCode: runtime.primaryFailure.providerErrorCode ?? null,
      recoveryState: runtime.primaryFailure.recoveryState ?? null,
      reason: redact(runtime.primaryFailure.reason),
      impactedTaskIds: Array.isArray(runtime.primaryFailure.impactedTaskIds) ? runtime.primaryFailure.impactedTaskIds.slice(-20).filter((id) => typeof id === "string") : [],
      activeTasks: Array.isArray(runtime.primaryFailure.activeTasks)
        ? runtime.primaryFailure.activeTasks.slice(-10).map((task) => ({ taskId: task?.taskId ?? null, threadId: task?.threadId ?? null, turnId: task?.turnId ?? null, status: task?.status ?? null }))
        : []
    } : null
  };
}

export function safeE2eError(error = null) {
  if (!error) return null;
  return {
    name: bounded(error.name || "Error", 200),
    message: redact(error.message),
    code: error.code ?? null,
    signal: error.signal ?? null,
    stdoutTail: redact(error.stdout),
    stderrTail: redact(error.stderr),
    stackTail: redact(error.stack)
  };
}

export function createE2eRunReporter({ reportsRoot, runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}` } = {}) {
  const runDir = join(reportsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const reporter = new E2eRunReporter(runDir);
  reporter.writeSummary({ schemaVersion: 1, runId, status: "running", startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, stage: "created", task: null, artifact: null, integration: null, diagnostics: null, error: null, recoveryRoot: null, recoveryAction: null });
  reporter.event("run created");
  return reporter;
}

export function openE2eRunReporter(runDir) { return new E2eRunReporter(runDir); }

export function readLatestE2eReport(reportsRoot) {
  const path = join(reportsRoot, "latest.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export class E2eRunReporter {
  constructor(runDir) {
    this.runDir = runDir;
    this.eventsPath = join(runDir, "events.jsonl");
    this.summaryPath = join(runDir, "summary.json");
    this.latestPath = join(dirname(runDir), "latest.json");
  }

  summary() { return existsSync(this.summaryPath) ? JSON.parse(readFileSync(this.summaryPath, "utf8")) : null; }

  event(type, details = {}) {
    const event = safeE2eEvent(type, details);
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    this.update({ stage: type });
    return event;
  }

  update(patch = {}) {
    const summary = { ...(this.summary() ?? {}), ...patch, resultPath: this.summaryPath };
    this.writeSummary(summary);
    return summary;
  }

  setTask(task) { return this.update({ task: safeTask(task) }); }
  setDiagnostics(runtime) { return this.update({ diagnostics: safeDiagnostics(runtime) }); }

  finalize({ status, task = null, artifact = null, integration = null, diagnostics = null, error = null, recoveryRoot = null, recoveryAction = null } = {}) {
    const current = this.summary() ?? {};
    const finishedAt = new Date().toISOString();
    const durationMs = current.startedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(current.startedAt)) : null;
    return this.update({ status, finishedAt, durationMs, task: safeTask(task) ?? current.task ?? null, artifact: artifact ? { taskId: artifact.taskId ?? null, headSha: artifact.headSha ?? null, path: artifact.path ?? null } : current.artifact ?? null, integration: integration ? { manifestPath: integration.path ?? null, status: integration.manifest?.status ?? null, candidateBranch: integration.manifest?.branch ?? null, localVerification: integration.manifest?.localVerification?.status ?? null, blockedReason: integration.manifest?.blockedReason ?? null, worktree: integration.manifest?.worktree ?? null } : current.integration ?? null, diagnostics: diagnostics ? safeDiagnostics(diagnostics) : current.diagnostics ?? null, error: safeE2eError(error) ?? current.error ?? null, recoveryRoot: recoveryRoot ?? current.recoveryRoot ?? null, recoveryAction: recoveryAction ?? current.recoveryAction ?? null });
  }

  writeSummary(summary) {
    writeFileSync(this.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    writeFileSync(this.latestPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
}
