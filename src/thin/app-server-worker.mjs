import { AppServerClient } from "../app-server-client.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const ACTIVITY_METHODS = new Set(["item/started", "item/completed", "thread/tokenUsage/updated"]);

export class ThinAppServerWorkerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ThinAppServerWorkerError";
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Builds the only instruction text supplied to a thin coding worker.  Git
 * validation and all commit/integration decisions deliberately remain outside
 * this module in the controller.
 */
export function buildThinWorkerGoal({ taskKey, prompt, allowedPaths }) {
  const key = requireText(taskKey, "taskKey");
  const taskPrompt = requireText(prompt, "prompt");
  const paths = normalizeAllowedPaths(allowedPaths);
  return [
    `You are the implementation worker for task: ${key}.`,
    "Work only in the controller-assigned repository directory.",
    "You may edit only these declared relative paths:",
    ...paths.map((path) => `- ${path}`),
    "Do not edit files outside these paths. Do not create a Git commit, push, create a PR, or change Git configuration.",
    "Implement the task and run only relevant local verification when useful.",
    "\n--- TASK ---\n",
    taskPrompt,
    "\n--- END TASK ---"
  ].join("\n");
}

/**
 * Executes exactly one Codex App Server worker turn in a controller-assigned
 * worktree.  This has no filesystem or Git authority: callers decide whether
 * a completed turn's worktree diff becomes an artifact.
 */
export async function runThinAppServerWorker({
  cwd,
  taskKey,
  prompt,
  allowedPaths,
  timeoutMs = 600_000,
  onEvent = null,
  clientFactory = null
} = {}) {
  const assignedCwd = requireText(cwd, "cwd");
  const key = requireText(taskKey, "taskKey");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive number");
  if (onEvent != null && typeof onEvent !== "function") throw new TypeError("onEvent must be a function");
  const goal = buildThinWorkerGoal({ taskKey: key, prompt, allowedPaths });
  const client = clientFactory ? clientFactory({ cwd: assignedCwd, taskKey: key }) : new AppServerClient({ cwd: assignedCwd });
  assertClient(client);

  let threadId = null;
  let requestedTurnId = null;
  let terminal = null;
  let terminalEventEmitted = false;
  const emit = (kind, details = {}) => {
    const event = Object.freeze({ kind, taskKey: key, ...details });
    onEvent?.(event);
    return event;
  };
  const onNotification = (message) => {
    const method = message?.method;
    const params = message?.params ?? {};
    const notificationThreadId = params.threadId ?? params.thread?.id ?? null;
    if (!ACTIVITY_METHODS.has(method) || (threadId && notificationThreadId && notificationThreadId !== threadId)) return;
    emit("activity", {
      threadId: notificationThreadId ?? threadId,
      turnId: params.turnId ?? params.turn?.id ?? requestedTurnId,
      activity: method,
      itemType: safeText(params.item?.type, 80)
    });
  };
  const onFatal = (error) => {
    if (!terminalEventEmitted) {
      terminalEventEmitted = true;
      emit("failed", { threadId, turnId: requestedTurnId, code: "transport_failure", message: safeText(error?.message, 240) });
    }
  };

  client.on?.("notification", onNotification);
  client.on?.("fatal", onFatal);
  try {
    await client.connect();
    const thread = await client.startThread({ cwd: assignedCwd });
    threadId = requireText(thread?.thread?.id ?? thread?.threadId, "App Server thread ID");
    await client.setGoal({ threadId, objective: goal, status: "active" });
    const turn = await client.startTurn({ threadId, input: [{ type: "text", text: goal }] });
    requestedTurnId = requireText(turn?.turn?.id ?? turn?.turnId, "App Server turn ID");
    emit("started", { threadId, turnId: requestedTurnId });
    terminal = await client.waitForTurn(threadId, requestedTurnId, timeoutMs);
    const terminalStatus = terminal?.status;
    const resolvedTurnId = terminal?.id ?? requestedTurnId;
    if (!TERMINAL_STATUSES.has(terminalStatus)) {
      throw new ThinAppServerWorkerError("terminal_status_invalid", "App Server returned a non-terminal worker status", {
        threadId, requestedTurnId, resolvedTurnId, terminalStatus, diagnostics: boundedDiagnostics(client)
      });
    }
    if (terminalStatus !== "completed") {
      terminalEventEmitted = true;
      emit("failed", { threadId, turnId: resolvedTurnId, requestedTurnId, terminalStatus });
      throw new ThinAppServerWorkerError("worker_not_completed", `Worker terminal status is '${terminalStatus}'`, {
        threadId, requestedTurnId, resolvedTurnId, terminalStatus, diagnostics: boundedDiagnostics(client)
      });
    }
    terminalEventEmitted = true;
    emit("completed", { threadId, turnId: resolvedTurnId, requestedTurnId, terminalStatus });
    return Object.freeze({
      taskKey: key,
      threadId,
      requestedTurnId,
      resolvedTurnId,
      terminalStatus,
      diagnostics: boundedDiagnostics(client)
    });
  } catch (error) {
    if (error instanceof ThinAppServerWorkerError) throw error;
    const code = /timed out|timeout/i.test(String(error?.message ?? "")) ? "worker_timeout" : "transport_failure";
    const details = { threadId, requestedTurnId, diagnostics: boundedDiagnostics(client), cause: safeText(error?.message, 240) };
    if (!terminalEventEmitted) {
      terminalEventEmitted = true;
      emit("failed", { threadId, turnId: requestedTurnId, code, message: details.cause });
    }
    throw new ThinAppServerWorkerError(code, `Thin App Server worker failed: ${details.cause ?? code}`, details);
  } finally {
    client.off?.("notification", onNotification);
    client.off?.("fatal", onFatal);
    try { await client.shutdown(); } catch {}
  }
}

function normalizeAllowedPaths(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("allowedPaths must contain at least one declared relative path");
  return [...new Set(value.map((path) => {
    const normalized = requireText(path, "allowed path");
    if (normalized.includes("\\") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`allowed path must be a normalized relative POSIX path: '${normalized}'`);
    }
    return normalized;
  }))];
}

function assertClient(client) {
  for (const method of ["connect", "startThread", "setGoal", "startTurn", "waitForTurn", "shutdown"]) {
    if (typeof client?.[method] !== "function") throw new TypeError(`clientFactory must provide ${method}()`);
  }
}

function boundedDiagnostics(client) {
  try {
    const raw = typeof client?.diagnostics === "function" ? client.diagnostics() : null;
    return Object.freeze({
      process: raw?.process ? {
        alive: raw.process.alive === true,
        exited: raw.process.exited === true,
        code: Number.isInteger(raw.process.code) ? raw.process.code : null,
        signal: safeText(raw.process.signal, 80)
      } : null,
      stderrTail: safeText(raw?.stderrTail, 1_000),
      protocolTail: Array.isArray(raw?.protocolEvents) ? raw.protocolEvents.slice(-12).map((event) => ({
        direction: safeText(event?.direction, 32), method: safeText(event?.method, 80),
        threadId: safeText(event?.threadId, 120), turnId: safeText(event?.turnId, 120),
        errorCode: safeText(event?.errorCode, 80)
      })) : []
    });
  } catch {
    return Object.freeze({ process: null, stderrTail: null, protocolTail: [] });
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function safeText(value, max) {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}
