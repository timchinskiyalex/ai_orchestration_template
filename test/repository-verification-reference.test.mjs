import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentIdForPath, documentSetDigest, specificationBlockers } from "../src/product-blueprint.mjs";
import { createImportedSourceResolver, sourceFragmentDigest } from "../src/source-evidence.mjs";
import { validateBootstrap } from "../src/workflow-contract.mjs";

const BASE_SHA = "a".repeat(40);
const command = process.platform === "win32"
  ? { id: "package-script:test", component: "root", cwd: ".", executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm run test"], confidence: "declared" }
  : { id: "package-script:test", component: "root", cwd: ".", executable: "npm", args: ["run", "test"], confidence: "declared" };
const overlay = ({ baseSha = BASE_SHA, commands = [command] } = {}) => ({ schemaVersion: 1, repository: { baseSha }, stack: { adapter: "node", packageManager: { name: "npm" } }, verificationCommands: commands });

function context() {
  const root = mkdtempSync(join(tmpdir(), "repository-verification-reference-")); const documentationDir = "docs/in"; const path = "requirements.md"; const text = "Implement the feature and verify it separately.\n";
  const file = { documentId: documentIdForPath(path), path, sha256: createHash("sha256").update(text).digest("hex") };
  mkdirSync(join(root, documentationDir), { recursive: true }); writeFileSync(join(root, documentationDir, path), text); writeFileSync(join(root, documentationDir, "inventory.json"), JSON.stringify({ files: [file], documentSetDigest: documentSetDigest([file]) }));
  return { root, file, resolver: createImportedSourceResolver({ repository: root, documentationDir }), digest: sourceFragmentDigest(text, 1, 1) };
}

function blueprint(context, criterion = {}) {
  return {
    schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "repository-verification", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest([context.file]), sourceDocuments: [context.file],
    requirements: [{ requirementId: "verified-feature", type: "functional", priority: "must", mandatory: true, description: "Implement the feature.", sourceRefs: [{ documentId: context.file.documentId, startLine: 1, endLine: 1, excerptDigest: context.digest }], acceptanceCriteria: [{ criterionId: "separate-verification", description: "The feature is verified separately.", ...criterion }], constraints: [] }],
    nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: [], contradictions: []
  };
}

const reference = (overrides = {}) => ({ schemaVersion: 1, source: "project_overlay", commandId: "package-script:test", overlayBaseSha: BASE_SHA, ...overrides });

test("Bootstrap selects a declared Overlay command for a source verification requirement without a named command", () => {
  const value = context();
  try {
    const admitted = validateBootstrap(blueprint(value, { repositoryVerification: reference() }), { sourceResolver: value.resolver, projectOverlay: overlay() });
    assert.deepEqual(admitted.requirements[0].acceptanceCriteria[0].repositoryVerification, reference());
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("unknown command IDs and stale Overlay base SHAs fail closed", () => {
  const value = context();
  try {
    assert.throws(() => validateBootstrap(blueprint(value, { repositoryVerification: reference({ commandId: "package-script:unknown" }) }), { sourceResolver: value.resolver, projectOverlay: overlay() }), /command 'package-script:unknown' is unavailable/);
    assert.throws(() => validateBootstrap(blueprint(value, { repositoryVerification: reference({ overlayBaseSha: "c".repeat(40) }) }), { sourceResolver: value.resolver, projectOverlay: overlay() }), /overlay base SHA is stale/);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("no eligible Overlay command leaves only the verification method unresolved", () => {
  const value = context();
  try {
    const candidate = blueprint(value); candidate.unresolvedQuestions = [{ questionId: "separate-verification-method", description: "No declared repository command can verify this criterion.", requiredForRequirementIds: ["verified-feature"] }];
    const admitted = validateBootstrap(candidate, { sourceResolver: value.resolver, projectOverlay: overlay({ commands: [] }) });
    assert.deepEqual(specificationBlockers(admitted), ["missing_mandatory_fact:separate-verification-method"]);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("a source-level product ambiguity remains blocked when Overlay declares npm test", () => {
  const value = context();
  try {
    const candidate = blueprint(value, { repositoryVerification: reference() }); candidate.unresolvedQuestions = [{ questionId: "external-payment-provider", description: "The source does not name the required payment provider.", requiredForRequirementIds: ["verified-feature"] }];
    const admitted = validateBootstrap(candidate, { sourceResolver: value.resolver, projectOverlay: overlay() });
    assert.deepEqual(specificationBlockers(admitted), ["missing_mandatory_fact:external-payment-provider"]);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});
