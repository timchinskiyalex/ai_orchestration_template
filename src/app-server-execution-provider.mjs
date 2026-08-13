import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "./app-server-client.mjs";
import { EXECUTION_PROVIDER_VERSION, REQUIRED_EXECUTION_CAPABILITIES, envelope, lifecycleEvent, safeDiagnostics } from "./execution-provider-contract.mjs";

const terminal = new Set(["completed", "failed", "interrupted", "cancelled"]);
const PENDING_TERMINAL_CANDIDATE_LIMIT = 64;
const PENDING_TERMINAL_CANDIDATE_TTL_MS = 60_000;
const usage = (params = {}) => {
  const raw = params.tokenUsage ?? params.usage ?? params;
  const value = raw?.last ?? raw?.total ?? raw;
  const totalTokens = Number(value?.totalTokens);
  return Number.isFinite(totalTokens) ? { totalTokens } : null;
};
const codeFor = (error) => {
  const text = String(error?.message ?? error).toLowerCase();
  if (error?.errorCode) return error.errorCode;
  if (text.includes("thread not loaded") || text.includes("same-provider thread/read unavailable")) return "transport_failure";
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
    this.connected = false; this.closed = false; this.interrupted = new Set(); this.active = new Map(); this.terminalReceipts = new Map(); this.pendingTerminalCandidates = new Map(); this.approvalRequests = new Map();
    this.providerConnectionId = randomUUID();
    this.client.on?.("notification", (message) => this.#notification(message));
    this.client.on?.("serverRequest", (message) => this.#serverRequest(message));
    this.client.on?.("protocol", (event) => this.#protocol(event));
    this.client.on?.("exit", (details) => { this.connected = false; this.#clearPendingTerminalCandidates(); this.emit("lifecycle", lifecycleEvent({ kind: "process_exit", providerGlobal: true, success: false, errorCode: "process_exit", errorClass: "transport", diagnostics: details })); });
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
    if (!terminal.has(turn?.status)) throw Object.assign(new Error("terminal status is missing or non-terminal"), { errorCode: "terminal_status_missing", errorClass: "protocol" });
    this.#bind(args.data.threadId, turnId, args.correlationId);
    return { threadId: args.data.threadId, turnId, providerRunId: `${args.data.threadId}:${turnId}`, terminalClass: turn.status, usage: usage(turn) };
  }); }
  async reconcileTerminal(args) { return this.#raw("reconcile_terminal", args, async () => {
    const { threadId, turnId: requestedTurnId, timeoutMs } = args.data;
    const receipt = this.#terminalReceipt(threadId, requestedTurnId);
    if (receipt) {
      // `turn/completed` from this active provider connection is the terminal
      // authority.  thread/read is useful corroboration only: Codex threads
      // can be process-local and unavailable to a later server instance.
      const corroboration = await this.#corroborateTerminal(threadId, requestedTurnId, timeoutMs, receipt.resolvedTurnId);
      const terminalReceipt = { ...receipt, corroboration };
      return {
        threadId, turnId: receipt.resolvedTurnId, providerRunId: `${threadId}:${receipt.resolvedTurnId}`,
        terminalClass: receipt.terminalClass, requestedTurnId, resolvedTurnId: receipt.resolvedTurnId,
        reconciliationSource: "turn_completed_receipt",
        verifiedEquivalence: receipt.resolvedTurnId === requestedTurnId ? "exact" : "observed_alias",
        terminalReceipt
      };
    }
    const corroborated = await this.#readTerminalTurn(threadId, requestedTurnId, timeoutMs);
    if (!corroborated.turn || !terminal.has(corroborated.turn.status)) {
      const errorCode = corroborated.status == null ? "terminal_receipt_missing" : "terminal_status_missing";
      throw Object.assign(new Error("no correlated terminal receipt or admissible same-provider thread/read corroboration"), { errorCode, errorClass: "protocol" });
    }
    const resolvedTurnId = corroborated.turn.id ?? requestedTurnId;
    const resolvedActive = this.#active(threadId, resolvedTurnId);
    const active = resolvedActive ?? this.#active(threadId, requestedTurnId);
    if (!active || (resolvedTurnId !== requestedTurnId && (!resolvedActive || resolvedActive.requestedTurnId !== requestedTurnId))) {
      throw Object.assign(new Error("thread/read terminal is not correlated to the requested turn"), { errorCode: "terminal_alias_unresolved", errorClass: "protocol" });
    }
    const resultText = (corroborated.turn.items ?? []).filter((item) => item?.type === "agentMessage" && typeof item.text === "string").at(-1)?.text;
    const terminalReceipt = this.#receipt({ threadId, requestedTurnId, resolvedTurnId, terminalClass: corroborated.turn.status, correlationId: active.correlationId, source: corroborated.source, corroboration: { available: true, source: corroborated.source, terminalClass: corroborated.turn.status } });
    return { threadId, turnId: resolvedTurnId, providerRunId: `${threadId}:${resolvedTurnId}`, terminalClass: corroborated.turn.status, requestedTurnId, resolvedTurnId, reconciliationSource: corroborated.source, verifiedEquivalence: resolvedTurnId === requestedTurnId ? "exact" : "observed_alias", terminalReceipt, ...(resultText?.trim() ? { resultText } : {}) };
  }); }
  async readFinalResult(args) { return this.#raw("read_final_result", args, async () => { const result = await this.client.readThread({ threadId: args.data.threadId, includeTurns: true }); const turns = result?.thread?.turns ?? result?.turns ?? []; const turn = turns.find((item) => item?.id === args.data.turnId); const text = (turn?.items ?? []).filter((item) => item?.type === "agentMessage" && typeof item.text === "string").at(-1)?.text; if (!text?.trim()) throw new Error("result_unavailable"); return { threadId: args.data.threadId, turnId: args.data.turnId, providerRunId: `${args.data.threadId}:${args.data.turnId}`, resultText: text }; }); }
  async interruptTurn(args) { const key = `${args.data.threadId}:${args.data.turnId}`; if (this.interrupted.has(key)) return this.#ok("interrupt_turn", args, { threadId: args.data.threadId, turnId: args.data.turnId, providerRunId: key, terminalClass: "interrupted" }); this.interrupted.add(key); return this.#raw("interrupt_turn", args, async () => { await this.client.interruptTurn(args.data); return { threadId: args.data.threadId, turnId: args.data.turnId, providerRunId: key, terminalClass: "interrupted" }; }); }
  async approvalResponse(args) { return this.#raw("approval_response", args, async () => { const { requestId, response } = args.data; if (typeof requestId !== "string" || !response || typeof response !== "object") throw new Error("invalid approval response"); const rawId = this.approvalRequests.get(requestId); if (rawId === undefined) throw new Error("unknown approval request"); this.client.respond(rawId, response); this.approvalRequests.delete(requestId); return { providerRunId: "app-server", requestId }; }); }
  async shutdown(args) { if (!this.closed) { this.closed = true; this.#clearPendingTerminalCandidates(); await this.client.shutdown(); } return this.#ok("shutdown", args, { providerRunId: "app-server", terminalClass: "shutdown" }); }
  async diagnostics(args) { return this.#ok("diagnostics", args, { diagnostics: safeDiagnostics(this.client.diagnostics?.() ?? {}) }); }

  #bind(threadId, turnId, correlationId, requestedTurnId = turnId) { if (typeof threadId === "string" && typeof turnId === "string" && typeof correlationId === "string") this.active.set(`${threadId}:${turnId}`, { correlationId, requestedTurnId }); }
  #active(threadId, turnId) { return this.active.get(`${threadId}:${turnId}`) ?? null; }
  #correlation(threadId, turnId) { return this.#active(threadId, turnId)?.correlationId ?? null; }
  #hasControllerOwnedRequestedTurn(threadId) {
    for (const [key, active] of this.active) if (key === `${threadId}:${active.requestedTurnId}`) return true;
    return false;
  }
  #pendingTerminalCandidateKey(threadId, resolvedTurnId) { return `${threadId}:${resolvedTurnId}`; }
  #clearPendingTerminalCandidates() { this.pendingTerminalCandidates.clear(); }
  #prunePendingTerminalCandidates(now = Date.now()) {
    for (const [key, candidate] of this.pendingTerminalCandidates) {
      if (now - candidate.capturedAtMs > PENDING_TERMINAL_CANDIDATE_TTL_MS) this.pendingTerminalCandidates.delete(key);
    }
    while (this.pendingTerminalCandidates.size > PENDING_TERMINAL_CANDIDATE_LIMIT) this.pendingTerminalCandidates.delete(this.pendingTerminalCandidates.keys().next().value);
  }
  #rememberPendingTerminalCandidate({ threadId, resolvedTurnId, terminalClass, usage: candidateUsage }) {
    if (!this.connected || this.closed || !terminal.has(terminalClass) || !this.#hasControllerOwnedRequestedTurn(threadId)) return;
    const key = this.#pendingTerminalCandidateKey(threadId, resolvedTurnId); const capturedAtMs = Date.now(); this.#prunePendingTerminalCandidates(capturedAtMs);
    if (this.pendingTerminalCandidates.has(key)) return;
    this.pendingTerminalCandidates.set(key, Object.freeze({ threadId, resolvedTurnId, terminalClass, usage: candidateUsage ?? null, capturedAtMs }));
    this.#prunePendingTerminalCandidates(capturedAtMs);
  }
  #storeTerminalReceipt({ threadId, requestedTurnId, resolvedTurnId, terminalClass, correlationId, source, corroboration = null }) {
    if (!this.connected || this.closed || !terminal.has(terminalClass)) return null;
    if (this.terminalReceipts.has(`${threadId}:${resolvedTurnId}`) || this.#terminalReceipt(threadId, requestedTurnId)) return null;
    const receipt = this.#receipt({ threadId, requestedTurnId, resolvedTurnId, terminalClass, correlationId, source, corroboration });
    this.terminalReceipts.set(`${threadId}:${resolvedTurnId}`, receipt);
    return receipt;
  }
  #task(kind, params, data = {}) {
    const threadId = params?.threadId ?? params?.thread?.id;
    const turnId = params?.turnId ?? params?.turn?.id;
    const active = this.#active(threadId, turnId); const correlationId = active?.correlationId ?? null;
    if (typeof threadId !== "string" || typeof turnId !== "string") return;
    if (!correlationId) {
      if (kind === "turn_completed" && terminal.has(data.terminalClass)) this.#rememberPendingTerminalCandidate({ threadId, resolvedTurnId: turnId, terminalClass: data.terminalClass, usage: data.usage });
      return;
    }
    if (kind === "turn_completed" && terminal.has(data.terminalClass) && this.connected && !this.closed) {
      if (!this.#storeTerminalReceipt({ threadId, requestedTurnId: active.requestedTurnId, resolvedTurnId: turnId, terminalClass: data.terminalClass, correlationId, source: "turn_completed" })) return;
    }
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
    const active = this.#active(event.threadId, event.requestedTurnId);
    if (!active || active.requestedTurnId !== event.requestedTurnId || event.requestedTurnId === event.resolvedTurnId) return;
    const resolved = this.#active(event.threadId, event.resolvedTurnId);
    if (resolved && (resolved.correlationId !== active.correlationId || resolved.requestedTurnId !== event.requestedTurnId)) return;
    if (resolved) return;
    this.#bind(event.threadId, event.resolvedTurnId, active.correlationId, event.requestedTurnId);
    this.emit("lifecycle", lifecycleEvent({ kind: "turn_alias", correlationId: active.correlationId, data: { threadId: event.threadId, turnId: event.resolvedTurnId, requestedTurnId: event.requestedTurnId, resolvedTurnId: event.resolvedTurnId, providerRunId: `${event.threadId}:${event.resolvedTurnId}` } }));
    this.#prunePendingTerminalCandidates();
    const key = this.#pendingTerminalCandidateKey(event.threadId, event.resolvedTurnId);
    const candidate = this.pendingTerminalCandidates.get(key);
    if (!candidate || candidate.threadId !== event.threadId || candidate.resolvedTurnId !== event.resolvedTurnId || !terminal.has(candidate.terminalClass)) return;
    const receipt = this.#storeTerminalReceipt({ threadId: event.threadId, requestedTurnId: event.requestedTurnId, resolvedTurnId: event.resolvedTurnId, terminalClass: candidate.terminalClass, correlationId: active.correlationId, source: "turn_completed" });
    this.pendingTerminalCandidates.delete(key);
    if (!receipt) return;
    this.emit("lifecycle", lifecycleEvent({ kind: "turn_completed", correlationId: active.correlationId, data: { threadId: event.threadId, turnId: event.resolvedTurnId, providerRunId: `${event.threadId}:${event.resolvedTurnId}`, terminalClass: candidate.terminalClass, usage: candidate.usage } }));
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
  #receipt({ threadId, requestedTurnId, resolvedTurnId, terminalClass, correlationId, source, corroboration = null }) { return Object.freeze({ schemaVersion: 1, kind: "AppServerTerminalReceipt", source, capturedAt: new Date().toISOString(), providerConnectionId: this.providerConnectionId, correlationId, threadId, requestedTurnId, resolvedTurnId, terminalClass, corroboration }); }
  #terminalReceipt(threadId, requestedTurnId) {
    const exact = this.terminalReceipts.get(`${threadId}:${requestedTurnId}`);
    if (exact?.requestedTurnId === requestedTurnId) return exact;
    for (const receipt of this.terminalReceipts.values()) if (receipt.threadId === threadId && receipt.requestedTurnId === requestedTurnId) return receipt;
    return null;
  }
  async #readTerminalTurn(threadId, turnId, timeoutMs) {
    if (this.client.diagnostics?.().process?.exited === true) {
      throw Object.assign(new Error("same-provider thread/read unavailable after provider exit"), { errorCode: "process_exit", errorClass: "transport" });
    }
    if (typeof this.client.readTerminalTurn === "function") {
      const read = await this.client.readTerminalTurn(threadId, turnId, timeoutMs);
      return { turn: read?.terminal ?? null, status: read?.summary?.turnStatus ?? read?.terminal?.status ?? null, source: "same_provider_thread_read" };
    }
    const result = await this.client.readThread({ threadId, includeTurns: true }); const exact = (result?.thread?.turns ?? result?.turns ?? []).find((item) => item?.id === turnId);
    const finalMessage = (exact?.items ?? []).filter((item) => item?.type === "agentMessage" && typeof item.text === "string").at(-1)?.text;
    // Legacy fixtures may expose only an exact final message through the same
    // live provider.  This remains bounded corroboration, never an accepted
    // lifecycle receipt and never a cross-process authority.
    if (finalMessage?.trim() && !terminal.has(exact?.status)) return { turn: { ...exact, status: "completed" }, status: exact?.status ?? null, source: "same_provider_thread_read_result_equivalence" };
    return { turn: terminal.has(exact?.status) ? exact : null, status: exact?.status ?? null, source: "same_provider_thread_read" };
  }
  async #corroborateTerminal(threadId, requestedTurnId, timeoutMs, resolvedTurnId) {
    try {
      const corroborated = await this.#readTerminalTurn(threadId, requestedTurnId, timeoutMs);
      const turn = corroborated.turn;
      if (turn && terminal.has(turn.status) && turn.id === resolvedTurnId) return { available: true, source: corroborated.source, terminalClass: turn.status };
      return { available: false, source: corroborated.source, reason: "terminal_not_found_or_identity_mismatch" };
    } catch (error) { return { available: false, source: "same_provider_thread_read", reason: "unavailable", diagnostics: safeDiagnostics(error?.message ?? error) }; }
  }
  #caught(operation, args, error) { const errorCode = String(error?.message) === "result_unavailable" ? "final_result_unavailable" : String(error?.message) === "turn_failed" ? "terminal_status_missing" : codeFor(error); return envelope({ operation, correlationId: args.correlationId, success: false, errorCode, errorClass: error?.errorClass ?? "transport", diagnostics: error?.diagnostics ?? error?.message }); }
}
