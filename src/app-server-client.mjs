import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { appServerInvocation } from "./app-server-invocation.mjs";
import { terminateProcessTree } from "./managed-process-runner.mjs";

const TRACE_LIMIT = 100;
const STDERR_LIMIT = 4_000;
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);

const bounded = (value, length = 320) => typeof value === "string" ? value.slice(0, length) : null;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

function redact(text) {
  return String(text ?? "")
    .replace(/((?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/("(?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2");
}

function turnFromCompleted(params = {}) {
  const turn = params.turn && typeof params.turn === "object" ? params.turn : (params.turnId ? { id: params.turnId, status: params.status ?? "completed" } : null);
  const threadId = params.threadId ?? params.thread?.id ?? turn?.threadId ?? null;
  return turn?.id && threadId ? { threadId, turn } : null;
}

function terminalTurnFromThread(result, threadId, turnId) {
  const turns = result?.thread?.turns ?? result?.turns ?? [];
  const turn = turns.find((item) => item?.id === turnId);
  if (!turn || !TERMINAL_TURN_STATUSES.has(turn.status)) return null;
  return { threadId: result?.thread?.id ?? threadId, turn };
}

function tokenTotals(params = {}) {
  const rawUsage = params.tokenUsage ?? params.usage ?? params;
  const usage = rawUsage?.last ?? rawUsage?.total ?? rawUsage;
  const totals = Object.fromEntries(["totalTokens", "inputTokens", "outputTokens", "cachedInputTokens"].map((name) => [name, number(usage?.[name])]).filter(([, value]) => value !== null));
  return Object.keys(totals).length ? totals : null;
}

function safeEvent({ direction, message = {}, extra = {} }) {
  const params = message.params ?? {};
  const result = message.result ?? {};
  const turn = params.turn ?? result.turn ?? null;
  const item = params.item ?? null;
  const error = message.error ?? extra.error ?? null;
  return {
    timestamp: new Date().toISOString(), direction,
    method: message.method ?? extra.method ?? null,
    id: message.id ?? null,
    threadId: params.threadId ?? params.thread?.id ?? result.thread?.id ?? turn?.threadId ?? null,
    turnId: params.turnId ?? turn?.id ?? result.turn?.id ?? null,
    requestedTurnId: extra.requestedTurnId ?? null,
    resolvedTurnId: extra.resolvedTurnId ?? null,
    itemType: item?.type ?? null,
    itemStatus: item?.status ?? turn?.status ?? null,
    tokenUsage: tokenTotals(params),
    errorCode: error?.code ?? null,
    errorMessage: bounded(redact(error?.message ?? extra.errorMessage ?? ""))
  };
}

export class AppServerClient extends EventEmitter {
  constructor({ cwd, serviceName = "codex-swarm-router", requestTimeoutMs = 30_000, fallbackReadTimeoutMs = 2_500, terminalPollIntervalMs = 10_000, spawnProcess = spawn, appServerLauncher = appServerInvocation, platform = process.platform, terminate = terminateProcessTree } = {}) {
    super();
    this.cwd = cwd;
    this.serviceName = serviceName;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fallbackReadTimeoutMs = fallbackReadTimeoutMs;
    this.terminalPollIntervalMs = terminalPollIntervalMs;
    this.spawnProcess = spawnProcess;
    this.appServerLauncher = appServerLauncher;
    this.platform = platform;
    this.terminate = terminate;
    this.nextId = 1;
    this.pending = new Map();
    this.completedTurns = new Map();
    this.awaitedTurnsByThread = new Map();
    this.terminalReadAttempts = new Map();
    this.protocolTrace = [];
    this.stderrTail = "";
    this.process = { alive: false, exited: false, code: null, signal: null };
    this.closed = false;
    this.failure = null;
    this.shutdownPromise = null;
  }

  async connect() {
    const launcher = this.appServerLauncher();
    this.proc = this.spawnProcess(launcher.command, launcher.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.process.alive = true;
    this.proc.once("error", (error) => this.#fail(error));
    this.proc.once("exit", (code, signal) => this.handleProcessExit({ code, signal }));
    this.proc.stderr?.on("data", (chunk) => this.ingestStderr(chunk));
    const lines = readline.createInterface({ input: this.proc.stdout });
    lines.on("line", (line) => this.#onLine(line));
    const initialization = this.request("initialize", {
      clientInfo: { name: this.serviceName, title: "Codex Swarm Router", version: "0.1.0" },
      capabilities: { experimentalApi: false }
    });
    this.notify("initialized", {});
    await initialization;
  }

  notify(method, params) { this.#write({ method, params }); }

  request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(this.failure ?? new Error("App Server client closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      try { this.#write({ id, method, params }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  respond(id, result) { this.#write({ id, result }); }
  startThread(params) { return this.request("thread/start", params); }
  readThread(params, options) { return this.request("thread/read", params, options); }
  setGoal(params) { return this.request("thread/goal/set", params); }
  startTurn(params) { return this.request("turn/start", params); }
  interruptTurn(params) { return this.request("turn/interrupt", params); }
  startReview(params) { return this.request("review/start", params); }

  protocolEvents() { return [...this.protocolTrace]; }
  diagnostics() { return { protocolEvents: this.protocolEvents(), stderrTail: this.stderrTail, process: { ...this.process }, closed: this.closed }; }

  async readTerminalTurn(threadId, turnId, timeoutMs = this.fallbackReadTimeoutMs) {
    const key = `${threadId}:${turnId}`;
    const existing = this.terminalReadAttempts.get(key);
    if (existing) return existing;
    const attempt = this.readThread({ threadId, includeTurns: true }, { timeoutMs }).then((result) => {
      const terminal = this.#terminalTurnFromThread(result, threadId, turnId);
      return { terminal: terminal?.turn ?? null, summary: {
        available: true, threadId: result?.thread?.id ?? threadId, turnId,
        turnStatus: terminal?.turn?.status ?? null,
        itemTypes: (terminal?.turn?.items ?? []).map((item) => item?.type).filter(Boolean).slice(0, 20)
      } };
    });
    this.terminalReadAttempts.set(key, attempt);
    attempt.then(
      (result) => { if (!result.terminal && this.terminalReadAttempts.get(key) === attempt) this.terminalReadAttempts.delete(key); },
      () => { if (this.terminalReadAttempts.get(key) === attempt) this.terminalReadAttempts.delete(key); }
    );
    return attempt;
  }

  waitForTurn(threadId, turnId, timeoutMs = 600_000) {
    const key = `${threadId}:${turnId}`;
    const completed = this.completedTurns.get(key);
    if (completed) return Promise.resolve(completed);
    return new Promise((resolve, reject) => {
      let settled = false;
      let polling = false;
      const awaited = { requestedTurnId: turnId, observedTurnIds: new Set() };
      this.#registerAwaitedTurn(threadId, awaited);
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(poll);
        this.off("notification", listener);
        this.off("fatal", onFatal);
        this.off("exit", onExit);
        this.#removeAwaitedTurn(threadId, awaited);
      };
      const listener = (message) => {
        if (message.method !== "turn/completed") return;
        const completedTurn = turnFromCompleted(message.params);
        if (completedTurn?.threadId !== threadId) return;
        if (completedTurn.turn.id === turnId) return settle(resolve, completedTurn.turn);
        if (this.#allowsAlias(threadId, awaited, completedTurn.turn.id)) {
          this.#recordTurnAlias(threadId, turnId, completedTurn.turn.id);
          this.completedTurns.set(`${threadId}:${turnId}`, completedTurn.turn);
          settle(resolve, completedTurn.turn);
        }
      };
      const onFatal = (error) => settle(reject, error);
      const onExit = ({ code, signal }) => settle(reject, new Error(`App Server exited during turn ${turnId} (code: ${code}, signal: ${signal})`));
      const pollTerminal = async () => {
        if (settled || polling) return;
        polling = true;
        try {
          const fallback = await this.readTerminalTurn(threadId, turnId);
          if (fallback.terminal) settle(resolve, fallback.terminal);
        } catch {}
        finally { polling = false; }
      };
      const poll = setInterval(pollTerminal, Math.max(1_000, this.terminalPollIntervalMs));
      const timeout = setTimeout(async () => {
        try {
          const fallback = await this.readTerminalTurn(threadId, turnId);
          if (fallback.terminal) return settle(resolve, fallback.terminal);
          settle(reject, new Error(`Timed out waiting for turn ${turnId} after ${timeoutMs}ms; thread/read found no terminal turn`));
        } catch (error) {
          settle(reject, new Error(`Timed out waiting for turn ${turnId} after ${timeoutMs}ms; thread/read fallback failed: ${error.message}`));
        }
      }, timeoutMs);
      this.on("notification", listener);
      this.on("fatal", onFatal);
      this.on("exit", onExit);
    });
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.#fail(new Error("App Server client closed"));
    const proc = this.proc;
    // App Server is launched through cmd.exe on Windows. Killing only that
    // launcher can leave Codex and its server descendants alive, so always
    // await the full process-tree termination request.
    this.shutdownPromise = Promise.resolve(this.terminate({ pid: proc?.pid, platform: this.platform, spawnProcess: this.spawnProcess, child: proc }))
      .catch((error) => ({ attempted: true, error: String(error.message) }));
    return this.shutdownPromise;
  }

  ingestStderr(chunk) {
    this.stderrTail = `${this.stderrTail}${redact(chunk)}`.slice(-STDERR_LIMIT);
    this.#record({ direction: "stderr", extra: { errorMessage: redact(chunk) } });
  }

  handleProcessExit({ code = null, signal = null } = {}) {
    this.process = { alive: false, exited: true, code, signal };
    this.#record({ direction: "processExit", extra: { errorMessage: `code=${code ?? "none"}; signal=${signal ?? "none"}` } });
    this.#fail(new Error(`App Server exited (code: ${code}, signal: ${signal})`));
    this.emit("exit", { code, signal });
  }

  ingestProtocolMessage(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      this.#record({ direction: "response", message, extra: { method: pending?.method ?? null } });
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.#record({ direction: "serverRequest", message });
      this.emit("serverRequest", message);
      return;
    }
    this.#record({ direction: "notification", message });
    if (message.method === "turn/completed") {
      const completed = turnFromCompleted(message.params);
      if (completed) this.completedTurns.set(`${completed.threadId}:${completed.turn.id}`, completed.turn);
    }
    this.#observeTurnEvent(message);
    this.emit("notification", message);
  }

  #write(message) {
    if (!this.proc?.stdin?.writable) throw new Error("App Server stdin is unavailable");
    const direction = message.id !== undefined && message.method ? "request" : (message.method ? "notification" : "response");
    this.#record({ direction, message });
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch {
      const error = new Error("App Server emitted a non-JSON protocol line");
      this.#record({ direction: "stderr", extra: { error } });
      this.#fail(error);
      return;
    }
    this.ingestProtocolMessage(message);
  }

  #record(event) {
    const safe = safeEvent(event);
    this.protocolTrace.push(safe);
    if (this.protocolTrace.length > TRACE_LIMIT) this.protocolTrace.splice(0, this.protocolTrace.length - TRACE_LIMIT);
    this.emit("protocol", safe);
  }

  #registerAwaitedTurn(threadId, awaited) {
    const turns = this.awaitedTurnsByThread.get(threadId) ?? new Set();
    turns.add(awaited);
    this.awaitedTurnsByThread.set(threadId, turns);
  }

  #removeAwaitedTurn(threadId, awaited) {
    const turns = this.awaitedTurnsByThread.get(threadId);
    if (!turns) return;
    turns.delete(awaited);
    if (!turns.size) this.awaitedTurnsByThread.delete(threadId);
  }

  #allowsAlias(threadId, awaited, resolvedTurnId) {
    const turns = this.awaitedTurnsByThread.get(threadId);
    return turns?.size === 1 && turns.has(awaited) && awaited.observedTurnIds.has(resolvedTurnId);
  }

  #observeTurnEvent(message) {
    if (!/^item\/(?:started|completed)$/.test(message.method ?? "")) return;
    const threadId = message.params?.threadId ?? null;
    const observedTurnId = message.params?.turnId ?? message.params?.turn?.id ?? null;
    const awaited = threadId ? this.awaitedTurnsByThread.get(threadId) : null;
    if (awaited?.size === 1 && observedTurnId) [...awaited][0].observedTurnIds.add(observedTurnId);
  }

  #terminalTurnFromThread(result, threadId, requestedTurnId) {
    const exact = terminalTurnFromThread(result, threadId, requestedTurnId);
    if (exact) return exact;
    const awaited = this.awaitedTurnsByThread.get(threadId);
    if (awaited?.size !== 1) return null;
    const active = [...awaited][0];
    if (active.requestedTurnId !== requestedTurnId) return null;
    const turns = result?.thread?.turns ?? result?.turns ?? [];
    const candidate = turns.find((turn) => TERMINAL_TURN_STATUSES.has(turn?.status) && this.#allowsAlias(threadId, active, turn.id));
    if (candidate) {
      this.#recordTurnAlias(threadId, requestedTurnId, candidate.id);
      this.completedTurns.set(`${threadId}:${requestedTurnId}`, candidate);
      return { threadId: result?.thread?.id ?? threadId, turn: candidate };
    }
    const onlyTurn = turns.length === 1 && TERMINAL_TURN_STATUSES.has(turns[0]?.status) ? turns[0] : null;
    if (!onlyTurn) return null;
    this.#recordTurnAlias(threadId, requestedTurnId, onlyTurn.id);
    this.completedTurns.set(`${threadId}:${requestedTurnId}`, onlyTurn);
    return { threadId: result?.thread?.id ?? threadId, turn: onlyTurn };
  }

  #recordTurnAlias(threadId, requestedTurnId, resolvedTurnId) {
    this.#record({ direction: "notification", extra: { method: "turn-id-alias", requestedTurnId, resolvedTurnId }, message: { params: { threadId, turnId: resolvedTurnId } } });
  }

  #fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const { reject, timeout } of this.pending.values()) { clearTimeout(timeout); reject(error); }
    this.pending.clear();
    this.emit("fatal", error);
  }
}
