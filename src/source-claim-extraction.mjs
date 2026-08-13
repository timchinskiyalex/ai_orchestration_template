import { documentSetDigest } from "./product-blueprint.mjs";
import { createImportedSourceResolver, validateSourceClaimExtraction } from "./source-evidence.mjs";
import { runSourceIntakeTurn } from "./source-intake-runtime.mjs";

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

  async extract({ recordTerminalReceipt = null, recordFailure = null } = {}) {
    const resolver = createImportedSourceResolver({ repository: this.config.repository, documentationDir: this.config.project.documentationDir });
    const controlledInput = { documentSetDigest: this.#documentSetDigest(resolver.sourceDocuments), documents: resolver.controlledDocuments() };
    const prompt = [
        "Return only one fenced JSON SourceClaimExtraction candidate. This is evidence extraction, not fact authorization. Use only the controlled payload below. A source span can produce multiple atomic claims. Do not include source quotations beyond the required digest reference. For each claim ID, calculate claim- + the first 24 lowercase hex characters of SHA-256(documentId + ':' + startLine + ':' + endLine + ':' + claimType + ':' + normalizedStatement with whitespace collapsed).",
        `Contract: ${JSON.stringify(candidateContract())}`,
        `Controlled source payload: ${JSON.stringify(controlledInput)}`
      ].join("\n\n");
    const result = await runSourceIntakeTurn({ config: this.config, role: "source_claim_extraction", developerInstructions: "You are a source-claim extraction role. Use only controller-provided source payload; do not read files, plan engineering work, authorize facts, or expose source text outside the required JSON artifact.", objective: "Extract atomic candidate source claims only.", tokenBudget: this.config.delivery?.sourceClaimExtractionTokenBudget ?? 6000, prompt, recordTerminalReceipt, recordFailure });
    return validateSourceClaimExtraction(parseResult(result.resultText), { sourceResolver: resolver });
  }

  #documentSetDigest(sourceDocuments) { return documentSetDigest(sourceDocuments); }
}
