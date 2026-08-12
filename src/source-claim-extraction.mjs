import { randomUUID } from "node:crypto";
import { EXECUTION_PROVIDER_VERSION, ExecutionProviderError, assertCapabilities, validateEnvelope } from "./execution-provider-contract.mjs";
import { documentSetDigest } from "./product-blueprint.mjs";
import { createImportedSourceResolver, validateSourceClaimExtraction } from "./source-evidence.mjs";
import { AppServerExecutionProvider } from "./app-server-execution-provider.mjs";

const methods = { handshake: "handshake", start_thread: "startThread", set_goal: "setGoal", start_turn: "startTurn", observe_terminal: "observeTerminal", read_final_result: "readFinalResult", shutdown: "shutdown" };

async function call(provider, operation, data, requiredIds = []) {
  const correlationId = randomUUID();
  const method = provider?.[methods[operation]];
  if (typeof method !== "function") throw new ExecutionProviderError("source_claim_extraction_provider_unavailable", `provider does not implement ${operation}`);
  let result;
  try { result = await method.call(provider, { contractVersion: EXECUTION_PROVIDER_VERSION, correlationId, data }); }
  catch { throw new ExecutionProviderError("source_claim_extraction_provider_unavailable", "provider invocation failed"); }
  return validateEnvelope(result, { operation, correlationId, requiredIds });
}

function candidateContract() {
  return {
    schemaVersion: 1,
    kind: "SourceClaimExtraction",
    documentSetDigest: "controller-provided",
    claims: [{
      claimId: "claim-sha256(documentId:startLine:endLine:claimType:normalizedStatement)[0:24]",
      documentId: "controller inventory document id", startLine: 1, endLine: 1,
      sourceDigest: "controller inventory SHA-256", claimType: "functional|non_functional|constraint|decision|risk|assumption|scope",
      normalizedStatement: "atomic normalized statement", confidence: 0.0,
      sourceQuote: { documentId: "same document id", startLine: 1, endLine: 1, excerptDigest: "SHA-256 of normalized inclusive source lines" }
    }]
  };
}

function parseResult(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  try { return JSON.parse((fenced?.[1] ?? text).trim()); }
  catch { throw new Error("source_claim_extraction_malformed_json"); }
}

export class SourceClaimExtractionExecutor {
  constructor(config) { this.config = config; }

  async extract() {
    const resolver = createImportedSourceResolver({ repository: this.config.repository, documentationDir: this.config.project.documentationDir });
    const controlledInput = { documentSetDigest: this.#documentSetDigest(resolver.sourceDocuments), documents: resolver.controlledDocuments() };
    const provider = this.config.executionProviderFactory?.({ cwd: this.config.runtimeDir }) ?? new AppServerExecutionProvider({ cwd: this.config.runtimeDir });
    try {
      const handshake = await call(provider, "handshake", {}, ["providerRunId"]);
      assertCapabilities(handshake, provider);
      const thread = await call(provider, "start_thread", { model: this.config.model, cwd: this.config.runtimeDir, sandbox: "read-only", approvalPolicy: "never", developerInstructions: "You are a source-claim extraction role. Use only controller-provided source payload; do not read files, plan engineering work, authorize facts, or expose source text outside the required JSON artifact." }, ["threadId"]);
      await call(provider, "set_goal", { threadId: thread.threadId, status: "active", tokenBudget: this.config.delivery?.sourceClaimExtractionTokenBudget ?? 6000, objective: "Extract atomic candidate source claims only." }, ["threadId"]);
      const prompt = [
        "Return only one fenced JSON SourceClaimExtraction candidate. This is evidence extraction, not fact authorization. Use only the controlled payload below. A source span can produce multiple atomic claims. Do not include source quotations beyond the required digest reference. For each claim ID, calculate claim- + the first 24 lowercase hex characters of SHA-256(documentId + ':' + startLine + ':' + endLine + ':' + claimType + ':' + normalizedStatement with whitespace collapsed).",
        `Contract: ${JSON.stringify(candidateContract())}`,
        `Controlled source payload: ${JSON.stringify(controlledInput)}`
      ].join("\n\n");
      const started = await call(provider, "start_turn", { threadId: thread.threadId, input: [{ type: "text", text: prompt }], effort: "low" }, ["threadId", "turnId"]);
      const terminal = await call(provider, "observe_terminal", { threadId: thread.threadId, turnId: started.turnId, timeoutMs: this.config.router.turnTimeoutMs }, ["threadId", "turnId", "terminalClass"]);
      if (terminal.terminalClass !== "completed") throw new Error("source_claim_extraction_provider_unavailable");
      const result = await call(provider, "read_final_result", { threadId: thread.threadId, turnId: terminal.turnId }, ["threadId", "turnId", "resultText"]);
      return validateSourceClaimExtraction(parseResult(result.resultText), { sourceResolver: resolver });
    } finally {
      try { await call(provider, "shutdown", {}); } catch {}
    }
  }

  #documentSetDigest(sourceDocuments) { return documentSetDigest(sourceDocuments); }
}
