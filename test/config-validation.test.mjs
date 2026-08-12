import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { policyDigest } from "../src/product-blueprint.mjs";

function config(overrides = {}) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 10, usesWorktree: role === "backend" }]));
  const project = { documentationDir: "docs/in", generatedDir: "docs/out", projectMode: { schemaVersion: 1, kind: "ProjectMode", mode: "greenfield" }, ...(overrides.project ?? {}) };
  return { repository: ".", runtimeDir: "./runtime", roles, ...overrides, project };
}
function load(value) { const root = mkdtempSync(join(tmpdir(), "config-validation-")); const path = join(root, "config.json"); writeFileSync(path, JSON.stringify(value)); try { return loadConfig(path); } finally { rmSync(root, { recursive: true, force: true }); } }
test("config rejects unsafe role capabilities and project paths", () => {
  assert.throws(() => load(config({ roles: { ...config().roles, backend: { ...config().roles.backend, usesWorktree: false } } })), /workspace-write requires/);
  for (const path of ["../escape", "/tmp/x", "C:\\escape", "C:/escape", "\\\\server\\share\\x", "\\escape", "C:escape"]) assert.throws(() => load(config({ project: { documentationDir: "docs/in", generatedDir: path } })), /normalized relative/, path);
  const accepted = load(config({ project: { documentationDir: "docs/in", generatedDir: "controller/output", productRoots: [{ id: "frontend", path: "apps/frontend", adapter: "next-node" }] } }));
  assert.equal(accepted.project.generatedDir, "controller/output");
  assert.equal(accepted.project.productRoots[0].path, "apps/frontend");
  assert.throws(() => load(config({ roles: { ...config().roles, qa: { ...config().roles.qa, approvalPolicy: "on-request" } } })), /approvalPolicy/);
});

test("new config defaults to fully autonomous delivery and retains explicit manual mode", () => {
  const autonomous = load(config());
  assert.equal(autonomous.autonomy.mode, "autonomous");
  assert.equal(autonomous.autonomy.autoMerge, true);
  assert.equal(autonomous.delivery.maxRemediationRounds, 3);
  assert.equal(autonomous.budget.enforceLocalLimits, true);
  const manual = load(config({ autonomy: { mode: "manual", autoApproveWorkflowGates: false, autoRemediate: false, autoPush: false, autoCreatePullRequest: false, autoMerge: false, maxRemediationRounds: 1 }, delivery: { maxRemediationRounds: 1 } }));
  assert.equal(manual.autonomy.mode, "manual");
  assert.throws(() => load(config({ autonomy: { mode: "autonomous", autoApproveWorkflowGates: false } })), /requires all autonomy/);
});

test("ProjectMode is versioned and brownfield alone admits baseline declarations", () => {
  assert.equal(load(config()).project.projectMode.mode, "greenfield");
  assert.throws(() => load(config({ project: { documentationDir: "docs/in", generatedDir: "docs/out", projectMode: { schemaVersion: 1, kind: "ProjectMode", mode: "legacy" } } })), /ProjectMode/);
  assert.throws(() => load(config({ project: { documentationDir: "docs/in", generatedDir: "docs/out", projectMode: { schemaVersion: 1, kind: "ProjectMode", mode: "greenfield" }, repositoryBaselineDeclaration: "baseline.json" } })), /only allowed in brownfield/);
});

test("trusted specification policy registry requires stable digest, scope, and affected requirements", () => {
  const policy = { policyId: "region-default", version: "1", scope: { kind: "unresolved_question", questionIds: ["region-choice"] }, affectedRequirementIds: ["req-one"], resolvedValue: "eu-central" }; policy.digest = policyDigest(policy);
  const loaded = load(config({ specificationResolution: { policyRegistry: { schemaVersion: 1, policies: [policy] } } }));
  assert.equal(loaded.specificationResolution.policyRegistry.policies[0].digest, policy.digest);
  assert.throws(() => load(config({ specificationResolution: { policyRegistry: { schemaVersion: 1, policies: [{ ...policy, digest: "0".repeat(64) }] } } })), /trusted policy registry/);
});
