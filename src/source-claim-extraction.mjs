import { createImportedSourceResolver, canonicalizeSourceClaimExtractionCandidate } from "./source-evidence.mjs";
import { runSourceIntakeTurn } from "./source-intake-runtime.mjs";
import { sourceIntakeFailure } from "./source-intake-failure.mjs";

function candidateContract() {
  return {
    schemaVersion: 1,
    kind: "SourceClaimExtractionCandidate",
    claims: [{
      claimType: "functional|non_functional|constraint|decision|risk|assumption|scope", normalizedStatement: "atomic normalized statement",
      classification: "mandatory|non_mandatory|ambiguous", sourceLocation: { documentId: "controller inventory document id", startLine: 1, endLine: 1 }
    }]
  };
}

function parseResult(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  try { return JSON.parse((fenced?.[1] ?? text).trim()); }
  catch { throw sourceIntakeFailure({ role: "source_claim_extraction", phase: "parse", code: "malformed_json" }); }
}

export class SourceClaimExtractionExecutor {
  constructor(config) { this.config = config; }

  async extract({ recordTerminalReceipt = null, recordFailure = null } = {}) {
    const resolver = createImportedSourceResolver({ repository: this.config.repository, documentationDir: this.config.project.documentationDir });
    const controlledInput = { documents: resolver.controlledDocuments() };
    const prompt = [
        "Return only one fenced JSON SourceClaimExtractionCandidate. This is semantic evidence extraction, not fact authorization. Use only the controlled payload below. A source span can produce multiple atomic claims. Return only claimType, normalizedStatement, classification, and sourceLocation (documentId/startLine/endLine). Do not return claimId, any digest, any document SHA, sourceQuote, confidence, or calculated hashes; the controller derives them.",
        `Contract: ${JSON.stringify(candidateContract())}`,
        `Controlled source payload: ${JSON.stringify(controlledInput)}`
      ].join("\n\n");
    const result = await runSourceIntakeTurn({ config: this.config, role: "source_claim_extraction", developerInstructions: "You are a source-claim extraction role. Use only controller-provided source payload; do not read files, plan engineering work, authorize facts, or expose source text outside the required JSON artifact.", objective: "Extract atomic candidate source claims only.", tokenBudget: this.config.delivery?.sourceClaimExtractionTokenBudget ?? 6000, prompt, recordTerminalReceipt, recordFailure });
    let candidate;
    try { candidate = parseResult(result.resultText); }
    catch (error) {
      const failure = sourceIntakeFailure({ role: "source_claim_extraction", phase: "parse", code: "malformed_json", receipt: result.terminalReceipt });
      await recordFailure?.(failure.sourceIntakeFailure); throw failure;
    }
    try { return canonicalizeSourceClaimExtractionCandidate(candidate, { sourceResolver: resolver }); }
    catch (error) {
      const phase = /canonicalization_failed|duplicate_claim/.test(String(error?.message)) ? "canonicalize" : "validate";
      const code = phase === "canonicalize" ? "candidate_canonicalization_failed" : "candidate_semantics_invalid";
      const failure = sourceIntakeFailure({ role: "source_claim_extraction", phase, code, receipt: result.terminalReceipt });
      await recordFailure?.(failure.sourceIntakeFailure); throw failure;
    }
  }
}
