import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { documentSetDigest } from "../src/product-blueprint.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function fakeBlueprint(repository, { question = null, contradiction = null } = {}) {
  const inventory = JSON.parse(readFileSync(join(repository, "docs", "orchestration-input", "inventory.json"), "utf8"));
  const sourceDocuments = inventory.files.map(({ documentId, path, sha256 }) => ({ documentId, path, sha256 }));
  const source = sourceDocuments[0];
  const firstLine = readFileSync(join(repository, "docs", "orchestration-input", source.path), "utf8").replace(/\r\n?/g, "\n").split("\n")[0];
  const declarationPath = join(repository, "docs", "orchestration-input", "source-claims.json");
  let sourceClaimIds = undefined;
  try { sourceClaimIds = [JSON.parse(readFileSync(declarationPath, "utf8")).claims.find((claim) => claim.classification === "mandatory")?.claimId].filter(Boolean); } catch {}
  const packageJsonPath = join(repository, "package.json");
  const hasDeclaredTest = existsSync(packageJsonPath) && typeof JSON.parse(readFileSync(packageJsonPath, "utf8")).scripts?.test === "string";
  const repositoryVerification = hasDeclaredTest ? { repositoryVerification: { schemaVersion: 1, source: "project_overlay", commandId: "package-script:test", overlayBaseSha: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() } } : {};
  return {
    schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "pb-test", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest(sourceDocuments), sourceDocuments,
    requirements: [{ requirementId: "fix-value", type: "functional", priority: "must", mandatory: true, description: "Fix the value.", ...(sourceClaimIds ? { sourceClaimIds } : {}), sourceRefs: [{ documentId: source.documentId, startLine: 1, endLine: 1, excerptDigest: digest(firstLine) }], acceptanceCriteria: [{ criterionId: "value-test", description: "The value test passes.", ...repositoryVerification }], constraints: [] }],
    nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: question ? [question] : [], contradictions: contradiction ? [contradiction] : []
  };
}
export function fakePlan() {
  return { blueprintId: "pb-test", tasks: [{ id: "writer", title: "Writer", prompt: "Writer", primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 20, dependsOn: [], allowedPaths: ["src/value.mjs"], acceptanceChecks: ["npm test"], requirementIds: ["fix-value"] }] };
}
