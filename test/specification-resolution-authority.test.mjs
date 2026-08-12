import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store.mjs";
import { documentSetDigest, policyDigest, specificationBlockers, validateControllerAuthorizedBlueprint } from "../src/product-blueprint.mjs";
import { validateBootstrap } from "../src/workflow-contract.mjs";

const docs = [{ documentId: "doc-input", path: "input.md", sha256: "a".repeat(64) }];
const sourceResolver = { verify() {} };
function claims(overrides = {}) {
  return { schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "pb-authority", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest(docs), sourceDocuments: docs, requirements: [{ requirementId: "req-must", type: "functional", priority: "must", mandatory: true, description: "A required behavior.", sourceRefs: [{ documentId: "doc-input", startLine: 1, endLine: 1, excerptDigest: "b".repeat(64) }], acceptanceCriteria: [{ criterionId: "req-must-check", description: "Works" }], constraints: [] }], nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: [], contradictions: [], ...overrides };
}
function trustedPolicy(overrides = {}) {
  const policy = { policyId: "region-default", version: "2026.1", scope: { kind: "unresolved_question", questionIds: ["region-choice"] }, affectedRequirementIds: ["req-must"], resolvedValue: "eu-central", ...overrides }; policy.digest = policyDigest(policy); return policy;
}
function proposedQuestion(policy, overrides = {}) {
  return { questionId: "region-choice", description: "Deployment region is absent.", requiredForRequirementIds: ["req-must"], proposedPolicyId: policy.policyId, proposedPolicyVersion: policy.version, proposedPolicyDigest: policy.digest, proposedResolution: policy.resolvedValue, ...overrides };
}
function authorize(value, registry) { return validateBootstrap(value, { sourceResolver, policyRegistry: registry }); }

test("Bootstrap status cannot self-authorize resolved_by_policy", () => {
  const blueprint = {
    unresolvedQuestions: [{
      questionId: "region-choice",
      description: "Required deployment region is absent from the source.",
      requiredForRequirementIds: ["req-must"],
      status: "resolved_by_policy",
      policyDefault: "Use untrusted-default",
      resolution: "Use untrusted-default"
    }],
    contradictions: []
  };

  assert.deepEqual(specificationBlockers(blueprint), ["missing_mandatory_fact:region-choice"]);
});

test("Bootstrap contradiction status cannot self-authorize arbitrary resolution text", () => {
  const blueprint = {
    unresolvedQuestions: [],
    contradictions: [{
      contradictionId: "retention-conflict",
      requirementIds: ["req-must"],
      sourceRefs: [],
      description: "Two source statements conflict.",
      status: "resolved",
      resolution: "Ignore the stricter requirement."
    }]
  };

  assert.deepEqual(specificationBlockers(blueprint), ["unresolved_contradiction:retention-conflict"]);
});

test("a valid trusted policy resolution is scoped and produces controller ADR/evidence", () => {
  const policy = trustedPolicy(); const resolved = authorize(claims({ unresolvedQuestions: [proposedQuestion(policy)] }), { schemaVersion: 1, policies: [policy] });
  assert.deepEqual(specificationBlockers(resolved), []); assert.equal(resolved.unresolvedQuestions[0].status, "resolved_by_policy"); assert.equal(resolved.resolutionAuthority.records[0].registryDigest.length, 64); assert.match(resolved.decisions[0].rationale, /^Controller-authorized policy region-default@2026\.1$/);
});

test("one exact controller policy resolves a declared question even without an agent proposal", () => {
  const policy = trustedPolicy();
  const resolved = authorize(claims({ unresolvedQuestions: [{ questionId: "region-choice", description: "Deployment region is absent.", requiredForRequirementIds: ["req-must"] }] }), { schemaVersion: 1, policies: [policy] });
  assert.deepEqual(specificationBlockers(resolved), []); assert.equal(resolved.unresolvedQuestions[0].status, "resolved_by_policy"); assert.equal(resolved.resolutionAuthority.records[0].policyId, policy.policyId);
});

test("wrong policy identity, digest, version, value, affected requirements, or scope fails closed", () => {
  const cases = [
    ["id", (policy) => proposedQuestion(policy, { proposedPolicyId: "other-policy" }), policy => policy],
    ["version", (policy) => proposedQuestion(policy, { proposedPolicyVersion: "2027.1" }), policy => policy],
    ["digest", (policy) => proposedQuestion(policy, { proposedPolicyDigest: "0".repeat(64) }), policy => policy],
    ["value", (policy) => proposedQuestion(policy, { proposedResolution: "other-region" }), policy => policy],
    ["affected requirements", (policy) => proposedQuestion(policy), policy => trustedPolicy({ ...policy, affectedRequirementIds: ["req-other"] })],
    ["scope", (policy) => proposedQuestion(policy), policy => trustedPolicy({ ...policy, scope: { kind: "unresolved_question", questionIds: ["other-question"] } })]
  ];
  for (const [label, proposal, policyFor] of cases) {
    const baseline = trustedPolicy(); const policy = policyFor(baseline); const matchingPolicy = ["affected requirements", "scope"].includes(label); const result = authorize(claims({ unresolvedQuestions: [proposal(matchingPolicy ? policy : baseline)] }), { schemaVersion: 1, policies: [policy] });
    assert.deepEqual(specificationBlockers(result), ["missing_mandatory_fact:region-choice"], label);
  }
});

test("source-looking untrusted claim and missing or tampered registry evidence fail closed", () => {
  const policy = trustedPolicy(); const question = proposedQuestion(policy, { status: "resolved_by_policy", resolution: "eu-central", sourceRefs: [{ documentId: "doc-input", startLine: 1, endLine: 1, excerptDigest: "b".repeat(64) }] });
  for (const registry of [null, { schemaVersion: 1, policies: [{ ...policy, digest: "0".repeat(64) }] }]) {
    const result = authorize(claims({ unresolvedQuestions: [question] }), registry);
    assert.deepEqual(specificationBlockers(result), ["missing_mandatory_fact:region-choice"]);
  }
});

test("persistence and restart preserve reproducible controller authorization", () => {
  const directory = mkdtempSync(join(tmpdir(), "authority-restart-")); const policy = trustedPolicy(); const registry = { schemaVersion: 1, policies: [policy] }; const resolved = authorize(claims({ unresolvedQuestions: [proposedQuestion(policy)] }), registry);
  let store = new StateStore(join(directory, "state.sqlite"));
  try {
    store.recordProductBlueprint({ blueprint: resolved, artifactPath: "generated/pb-authority.v2.json", digest: "c".repeat(64) }); store.close();
    store = new StateStore(join(directory, "state.sqlite")); const persisted = store.productBlueprint("pb-authority");
    assert.deepEqual(validateControllerAuthorizedBlueprint(persisted.blueprint, { sourceResolver, policyRegistry: registry, persistedResolutionAuthority: persisted.resolutionAuthority }), resolved);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy agent-authorized resolution records cannot bypass authority checks", () => {
  const legacy = claims({ unresolvedQuestions: [{ questionId: "region-choice", description: "Deployment region is absent.", requiredForRequirementIds: ["req-must"], status: "resolved_by_policy", policyDefault: "eu-central" }] });
  const directory = mkdtempSync(join(tmpdir(), "authority-legacy-")); let store = new StateStore(join(directory, "state.sqlite"));
  try {
    store.recordProductBlueprint({ blueprint: legacy, artifactPath: "generated/pb-authority.v1.json", digest: "d".repeat(64) }); store.close(); store = new StateStore(join(directory, "state.sqlite"));
    const persisted = store.productBlueprint("pb-authority"); assert.throws(() => validateControllerAuthorizedBlueprint(persisted.blueprint, { sourceResolver, policyRegistry: { schemaVersion: 1, policies: [] }, persistedResolutionAuthority: persisted.resolutionAuthority }), /legacy resolution authority/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
