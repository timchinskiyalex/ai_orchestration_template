import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AppServerExecutionProvider } from "./app-server-execution-provider.mjs";
import { EXECUTION_PROVIDER_VERSION, ExecutionProviderError, assertCapabilities, safeDiagnostics, validateEnvelope } from "./execution-provider-contract.mjs";

// Phase 1 deliberately has exactly two named paths.  This is a transitional
// test/migration seam, not configuration, discovery, or a provider registry.
// Production continues to construct the proven legacy path until Phase 2
// parity is complete, after which this switch must be removed.
export const TRANSITIONAL_RUNTIME_PATHS = Object.freeze(["legacy", "codex-app-server"]);
export const DEFAULT_TRANSITIONAL_RUNTIME_PATH = "legacy";

// These are observations for a controller to consume.  They are explicitly
// not task-state transitions and contain no persistence or Git authority.
export const CODEX_RUNTIME_OBSERVATION_KINDS = Object.freeze([
  "worker_started", "worker_activity", "worker_terminal_candidate",
  "worker_completed", "worker_failed", "worker_cancelled"
]);

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const methodFor = Object.freeze({
  handshake: "handshake", start_thread: "startThread", set_goal: "setGoal",
  start_turn: "startTurn", observe_terminal: "observeTerminal",
  reconcile_terminal: "reconcileTerminal", read_final_result: "readFinalResult",
  interrupt_turn: "interruptTurn", shutdown: "shutdown", diagnostics: "diagnostics"
});

const assertCwd = (cwd) => {
  if (typeof cwd !== "string" || !cwd.trim()) throw new TypeError("CodexAppServerRuntime requires a controller-assigned cwd");
  return cwd;
};

const terminalObservationKind = (terminalClass) => terminalClass === "completed"
  ? "worker_completed"
  : terminalClass === "cancelled" || terminalClass === "interrupted"
    ? "worker_cancelled"
    : "worker_failed";

export function resolveTransitionalRuntimePath(runtimePath = DEFAULT_TRANSITIONAL_RUNTIME_PATH) {
  if (!TRANSITIONAL_RUNTIME_PATHS.includes(runtimePath)) {
    throw new TypeError(`Unsupported transitional runtime path: ${runtimePath}`);
  }
  return runtimePath;
}

// This helper is intentionally not wired into SwarmRouter in Phase 1.  It
// exists only so parity tests and a later migration can select a closed path.
export function createTransitionalRuntime({ runtimePath = DEFAULT_TRANSITIONAL_RUNTIME_PATH, ...options } = {}) {
  return resolveTransitionalRuntimePath(runtimePath) === "legacy"
    ? new AppServerExecutionProvider(options)
    : new CodexAppServerRuntime(options);
}

export class CodexAppServerRuntime extends EventEmitter {
  constructor({ cwd, client = null, clientFactory = null } = {}) {
    super();
    this.cwd = assertCwd(cwd);
    this.connected = false;
    this.closed = false;
    // The existing provider is an internal App Server protocol/transport
    // detail.  This runtime never exposes its envelope API to a controller.
    this.#transport = new AppServerExecutionProvider({ cwd: this.cwd, client, clientFactory });
    this.#transport.on("lifecycle", (event) => this.#translateLifecycle(event));
  }

  #transport;

  async connect() {
    const handshake = await this.#call("handshake", {}, ["providerRunId"]);
    assertCapabilities(handshake, this.#transport);
    this.connected = true;
    this.closed = false;
    return { providerRunId: handshake.providerRunId, cwd: this.cwd };
  }

  async startThread(thread = {}) {
    const { cwd, ...request } = thread;
    if (cwd != null && cwd !== this.cwd) throw new TypeError("Runtime cwd must remain the controller-assigned cwd");
    const data = await this.#call("start_thread", { ...request, cwd: this.cwd }, ["threadId"]);
    return { threadId: data.threadId, providerRunId: data.providerRunId };
  }

  async startGoalTurn({ threadId, goal, turn } = {}) {
    if (typeof threadId !== "string" || !threadId) throw new TypeError("startGoalTurn requires threadId");
    await this.#call("set_goal", { ...(goal ?? {}), threadId }, ["threadId"]);
    const started = await this.#call("start_turn", { ...(turn ?? {}), threadId }, ["threadId", "turnId"]);
    const observation = this.#emitObservation("worker_started", {
      threadId, turnId: started.turnId, requestedTurnId: started.turnId, providerRunId: started.providerRunId
    });
    return { threadId, turnId: started.turnId, providerRunId: started.providerRunId, observation };
  }

  async observeTerminal({ threadId, turnId, timeoutMs } = {}) {
    const terminal = await this.#call("observe_terminal", { threadId, turnId, timeoutMs }, ["threadId", "turnId", "terminalClass"]);
    if (!TERMINAL.has(terminal.terminalClass)) throw new ExecutionProviderError("protocol_violation", "runtime received a non-terminal candidate");
    return this.#emitObservation("worker_terminal_candidate", terminal);
  }

  async reconcileTerminal({ threadId, turnId, timeoutMs } = {}) {
    // The underlying operation is bounded and read-only.  The returned fact is
    // still only an observation; the controller decides every task transition.
    const terminal = await this.#call("reconcile_terminal", { threadId, turnId, timeoutMs }, ["threadId", "turnId", "terminalClass"]);
    if (!TERMINAL.has(terminal.terminalClass)) throw new ExecutionProviderError("terminal_reconciliation_unavailable", "runtime could not prove a terminal turn");
    return this.#emitObservation(terminalObservationKind(terminal.terminalClass), terminal);
  }

  async readFinalResult({ threadId, turnId } = {}) {
    const result = await this.#call("read_final_result", { threadId, turnId }, ["threadId", "turnId", "resultText"]);
    return { threadId: result.threadId, turnId: result.turnId, resultText: result.resultText, providerRunId: result.providerRunId };
  }

  async cancel({ threadId, turnId } = {}) {
    const terminal = await this.#call("interrupt_turn", { threadId, turnId }, ["threadId", "turnId"]);
    return this.#emitObservation("worker_cancelled", terminal);
  }

  async shutdown() {
    const result = await this.#call("shutdown", {});
    this.closed = true;
    this.connected = false;
    return { providerRunId: result.providerRunId, terminalClass: result.terminalClass ?? "shutdown" };
  }

  async diagnostics() {
    try {
      const result = await this.#call("diagnostics", {});
      const diagnostics = safeDiagnostics(result.diagnostics);
      let processExited = false;
      try {
        const once = JSON.parse(diagnostics);
        const parsed = typeof once === "string" ? JSON.parse(once) : once;
        processExited = parsed?.process?.exited === true;
      } catch {}
      return { connected: this.connected, closed: this.closed, reconnectRequired: processExited, diagnostics };
    } catch (error) {
      return {
        connected: this.connected,
        closed: this.closed,
        reconnectRequired: true,
        diagnostics: safeDiagnostics(error?.diagnostics ?? error?.message ?? error)
      };
    }
  }

  async #call(operation, data, requiredIds = []) {
    const method = this.#transport[methodFor[operation]];
    const correlationId = randomUUID();
    let response;
    try {
      response = await method.call(this.#transport, { contractVersion: EXECUTION_PROVIDER_VERSION, correlationId, data });
    } catch (error) {
      if (error instanceof ExecutionProviderError) throw error;
      const message = String(error?.message ?? error);
      const errorCode = error?.errorCode ?? (message.toLowerCase().includes("thread not loaded") ? "execution_provider_terminal_unavailable" : "transport_failure");
      throw new ExecutionProviderError(errorCode, message, { errorClass: error?.errorClass ?? "transport", diagnostics: error?.diagnostics ?? message });
    }
    return validateEnvelope(response, { operation, correlationId, requiredIds });
  }

  #translateLifecycle(event) {
    if (event?.providerGlobal) {
      if (event.kind === "process_exit") this.#emitObservation("worker_failed", { terminalClass: "process_exit", diagnostics: event.diagnostics ?? null });
      return;
    }
    if (!event?.success) {
      this.#emitObservation("worker_failed", { ...event.data, errorCode: event.errorCode, diagnostics: event.diagnostics ?? null });
      return;
    }
    if (event.kind === "turn_completed") {
      this.#emitObservation("worker_terminal_candidate", event.data);
      return;
    }
    this.#emitObservation("worker_activity", { ...event.data, activity: event.kind });
  }

  #emitObservation(kind, data) {
    const observation = Object.freeze({ kind, ...data });
    this.emit("observation", observation);
    return observation;
  }
}
