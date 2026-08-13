import { EventEmitter } from "node:events";
import { AppServerClient } from "./app-server-client.mjs";
import { EXECUTION_PROVIDER_VERSION, REQUIRED_EXECUTION_CAPABILITIES, envelope, lifecycleEvent, safeDiagnostics } from "./execution-provider-contract.mjs";

const terminal = new Set(["completed", "failed", "interrupted", "cancelled"]);
const usage = (params = {}) => {
  const raw = params.tokenUsage ?? params.usage ?? params;
  const value = raw?.last ?? raw?.total ?? raw;
  const totalTokens = Number(value?.totalTokens);
  return Number.isFinite(totalTokens) ? { totalTokens } : null;
};
const codeFor = (error) => {
  const text = String(error?.message ?? error).toLowerCase();
  if (text.includes("timed out") || text.includes("timeout")) return "timeout";
  if (text.includes("exited")) return "process_exit";
  if (text.includes("closed") || text.includes("shutdown")) return "shutdown";
  if (text.includes("interrupt")) return "interrupted";
  return "transport_failure";
};

// Kept with the protocol adapter for low-level client lifecycle coverage; the
// Router never receives this raw nesting.
export function agentResultForTurn(response, turnId) {
  const turn = response?.thread?.turns?.find((item) => item?.id === turnId);
  const text = (turn?.items ?? []).filter((item) => item?.type === "agentMessage" && typeof item.text === "string").at(-1)?.text;
  if (!text?.trim()) throw new Error(`No final agent message was found for turn ${turnId}`);
  return text;
}

export class AppServerExecutionProvider extends EventEmitter {
  constructor({ cwd, client = null, clientFactory = null } = {}) {
    super();
    this.client = client ?? (clientFactory ? clientFactory({ cwd }) : new AppServerClient({ cwd }));
    this.connected = false; this.closed = false; this.interrupted = new Set(); this.active = new Map(); this.approvalRequests = new Map();
    this.client.on?.("notification", (message) => this.#notification(message));
    this.client.on?.("serverRequest", (message) => this.#serverRequest(message));
    this.client.on?.("protocol", (event) => this.#protocol(event));
    this.client.on?.("exit", (details) => this.emit("lifecycle", lifecycleEvent({ kind: "process_exit", providerGlobal: true, success: false, errorCode: "process_exit", errorClass: "transport", diagnostics: details })));
  }
  async handshake(args) {
    if (args.contractVersion !== EXECUTION_PROVIDER_VERSION) return this.#failure("handshake", args, "unsupported_contract_version", "protocol");
    try { if (!this.connected) { await this.client.connect(); this.connected = true; } return this.#ok("handshake", args, { capabilities: [...REQUIRED_EXECUTION_CAPABILITIES], providerRunId: "app-server" }); }
    catch (error) { return this.#caught("handshake", args, error); }
  }
  async accountRead(args) { return this.#raw("account_read", args, async () => ({ account: await this.client.request("account/read", {}), usage: await this.client.request("account/usage/read", {}), rateLimits: await this.client.request("account/rateLimits/read", {}) })); }
  async startThread(args) { return this.#raw("start_thread", args, async () => { const result = await this.client.startThread(args.data); const threadId = result?.thread?.id; if (!threadId) throw new Error("invalid thread/start response"); return { threadId, providerRunId: threadId }; }); }
  async setGoal(args) { return this.#raw("set_goal", args, async () => { await this.client.setGoal(args.data); return { threadId: args.data.threadId, providerRunId: args.data.threadId }; }); }
  async startTurn(args) { return this.#raw("start_turn", args, async () => { const result = await this.client.startTurn(args.data); const turnId = result?.turn?.id; if (!turnId) throw new Error("invalid turn/start response"); const data = { threadId: args.data.threadId, turnId, providerRunId: `${args.data.threadId}:${turnId}` }; this.#bind(data.threadId, turnId, args.correlationId); return data; }); }
  async observeTerminal(args) { return this.#raw("observe_terminal", args, async () => {
    this.#bind(args.data.threadId, args.data.turnId, args.correlationId);
    const exited = this.client.diagnostics?.().process?.exited === true;
    // After the child exits, do not trust a stale waiter or try to start
    // work.  `readTerminalTurn` performs one bounded, read-only thread/read
    // probe and returns only a verified terminal turn.
    const recovered = exited && typeof this.client.readTerminalTurn === "function"
      ? await this.client.readTerminalTurn(args.data.threadId, args.data.turnId, args.data.timeoutMs)
      : null;
    const turn = recovered?.terminal ?? await this.client.waitForTurn(args.data.threadId, args.data.turnId, args.data.timeoutMs);
    const turnId = turn?.id ?? args.data.turnId;
    if (!terminal.has(turn?.status)) throw new Error("turn_failed");
    this.#bind(args.data.threadId, turnId, args.correlationId);
    return { threadId: args.data.threadId, turnId, providerRunId: `${args.data.threadId}:${turnId}`, terminalClass: turn.status, usage: usage(turn) };
  }); }
  async reconcileTerminal(args) { return this.#raw("reconcile_terminal", args, async () => {
    // This is deliberately independent of lifecycle delivery: it is the
    // controller-requested, bounded, read-only thread/read authority used
    // before any task terminal state or review evidence is persisted.
    const requestedTurnId = args.data.turnId;
    let turn, reconciliationSource = "thread_read";
    if (typeof this.client.readTerminalTurn === "function") {
      turn = (await this.client.readTerminalTurn(args.data.threadId, requestedTurnId, args.data.timeoutMs))?.terminal;
    } else {
      const result = await this.client.readThread({ threadId: args.data.threadId, includeTurns: true });
      const exact = (result?.thread?.turns ?? result?.turns ?? []).find((item) => item?.id === requestedTurnId);
      // Older App Server schema fixtures omit the turn status but retain the
      // exact, durable final agent message.  That is a narrowly defined
      // equivalence contract for completed only; failed/interrupted still
      // require an explicit durable terminal status.
      const finalMessage = (exact?.items ?? []).filter((item) => item?.type === "agentMessage" && typeof item.text === "string").at(-1)?.text;
      turn = terminal.has(exact?.status) ? exact : (finalMessage?.trim() ? { ...exact, status: "completed" } : null);
      if (turn?.status === "completed" && !terminal.has(exact?.status)) reconciliationSource = "thread_read_result_equivalence";
    }
    if (!turn || !terminal.has(turn.status)) throw new Error("terminal_reconciliation_unavailable");
    const resolvedTurnId = turn.id ?? requestedTurnId;
    const resultText = (turn.items ?? []).filter((item) => item?.type === "agentMessage" && typeof item.text === "string").at(-1)?.text;
    this.#bind(args.data.threadId, resolvedTurnId, args.correlationId);
    return {
      threadId: args.data.threadId, turnId: resolvedTurnId, providerRunId: `${args.data.threadId}:${resolvedTurnId}`,
      terminalClass: turn.status, requestedTurnId, resolvedTurnId,
      reconciliationSource,
      verifiedEquivalence: resolvedTurnId === requestedTurnId ? "exact" : "observed_alias",
      ...(resultText?.trim() ? { resultText } : {})
    };
  }); }
  async readFinalResult(args) { return this.#raw("read_final_result", args, async () => { const result = await this.client.readThread({ threadId: args.data.threadId, includeTurns: true }); const turns = result?.thread?.turns ?? result?.turns ?? []; const turn = turns.find((item) => item?.id === args.data.turnId); const text = (turn?.items ?? []).filter((item) => item?.type === "agentMessage" && typeof item.text === "string").at(-1)?.text; if (!text?.trim()) throw new Error("result_unavailable"); return { threadId: args.data.threadId, turnId: args.data.turnId, providerRunId: `${args.data.threadId}:${args.data.turnId}`, resultText: text }; }); }
  async interruptTurn(args) { const key = `${args.data.threadId}:${args.data.turnId}`; if (this.interrupted.has(key)) return this.#ok("interrupt_turn", args, { threadId: args.data.threadId, turnId: args.data.turnId, providerRunId: key, terminalClass: "interrupted" }); this.interrupted.add(key); return this.#raw("interrupt_turn", args, async () => { await this.client.interruptTurn(args.data); return { threadId: args.data.threadId, turnId: args.data.turnId, providerRunId: key, terminalClass: "interrupted" }; }); }
  async approvalResponse(args) { return this.#raw("approval_response", args, async () => { const { requestId, response } = args.data; if (typeof requestId !== "string" || !response || typeof response !== "object") throw new Error("invalid approval response"); const rawId = this.approvalRequests.get(requestId); if (rawId === undefined) throw new Error("unknown approval request"); this.client.respond(rawId, response); this.approvalRequests.delete(requestId); return { providerRunId: "app-server", requestId }; }); }
  async shutdown(args) { if (!this.closed) { this.closed = true; await this.client.shutdown(); } return this.#ok("shutdown", args, { providerRunId: "app-server", terminalClass: "shutdown" }); }
  async diagnostics(args) { return this.#ok("diagnostics", args, { diagnostics: safeDiagnostics(this.client.diagnostics?.() ?? {}) }); }

  #bind(threadId, turnId, correlationId) { if (typeof threadId === "string" && typeof turnId === "string" && typeof correlationId === "string") this.active.set(`${threadId}:${turnId}`, correlationId); }
  #correlation(threadId, turnId) { return this.active.get(`${threadId}:${turnId}`) ?? null; }
  #task(kind, params, data = {}) {
    const threadId = params?.threadId ?? params?.thread?.id;
    const turnId = params?.turnId ?? params?.turn?.id;
    const correlationId = this.#correlation(threadId, turnId);
    if (!correlationId || typeof threadId !== "string" || typeof turnId !== "string") return;
    this.emit("lifecycle", lifecycleEvent({ kind, correlationId, data: { threadId, turnId, providerRunId: `${threadId}:${turnId}`, ...data } }));
  }
  #notification(message) {
    if (message?.method === "thread/tokenUsage/updated") this.#task("usage_updated", message.params, { usage: usage(message.params) });
    else if (message?.method === "item/started") this.#task("item_started", message.params, { itemType: message.params?.item?.type ?? null, itemStatus: message.params?.item?.status ?? null });
    else if (message?.method === "item/completed") this.#task("item_completed", message.params, { itemType: message.params?.item?.type ?? null, itemStatus: message.params?.item?.status ?? null });
    else if (message?.method === "turn/completed") this.#task("turn_completed", message.params, { terminalClass: message.params?.turn?.status ?? message.params?.status ?? null, usage: usage(message.params) });
    else if (message?.method === "account/rateLimits/updated") this.emit("lifecycle", lifecycleEvent({ kind: "account_updated", providerGlobal: true, data: { rateLimits: message.params?.rateLimits ?? {} } }));
  }
  #protocol(event) {
    if (event?.method !== "turn-id-alias" || typeof event.threadId !== "string" || typeof event.requestedTurnId !== "string" || typeof event.resolvedTurnId !== "string") return;
    const correlationId = this.#correlation(event.threadId, event.requestedTurnId);
    if (!correlationId) return;
    this.#bind(event.threadId, event.resolvedTurnId, correlationId);
    this.emit("lifecycle", lifecycleEvent({ kind: "turn_alias", correlationId, data: { threadId: event.threadId, turnId: event.resolvedTurnId, requestedTurnId: event.requestedTurnId, resolvedTurnId: event.resolvedTurnId, providerRunId: `${event.threadId}:${event.resolvedTurnId}` } }));
  }
  #serverRequest(message) {
    const params = message?.params ?? {}; const correlationId = this.#correlation(params.threadId, params.turnId);
    if (typeof message?.id !== "string" && typeof message?.id !== "number") return;
    if (!correlationId) {
      // An unowned server request cannot be delegated to controller policy.
      // Settle it conservatively and stop the identifiable orphan turn.
      try { this.client.respond(message.id, { decision: "cancel" }); } catch {}
      if (typeof params.threadId === "string" && typeof params.turnId === "string") this.client.interruptTurn({ threadId: params.threadId, turnId: params.turnId }).catch(() => {});
      return;
    }
    this.approvalRequests.set(String(message.id), message.id);
    this.emit("lifecycle", lifecycleEvent({ kind: "approval_requested", correlationId, data: { threadId: params.threadId, turnId: params.turnId, requestId: String(message.id), approvalKind: message.method === "item/commandExecution/requestApproval" ? "command" : message.method === "item/fileChange/requestApproval" ? "file" : message.method === "item/permissions/requestApproval" ? "permissions" : "unknown", providerRunId: `${params.threadId}:${params.turnId}` } }));
  }
  async #raw(operation, args, fn) { try { return this.#ok(operation, args, await fn()); } catch (error) { return this.#caught(operation, args, error); } }
  #ok(operation, args, data) { return envelope({ operation, correlationId: args.correlationId, success: true, data }); }
  #failure(operation, args, errorCode, errorClass) { return envelope({ operation, correlationId: args.correlationId, success: false, errorCode, errorClass }); }
  #caught(operation, args, error) { const errorCode = String(error?.message) === "result_unavailable" ? "result_unavailable" : String(error?.message) === "turn_failed" ? "turn_failed" : codeFor(error); return envelope({ operation, correlationId: args.correlationId, success: false, errorCode, errorClass: "transport", diagnostics: error?.message }); }
}
