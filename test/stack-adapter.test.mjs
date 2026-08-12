import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { architectureBlueprintFromProductRoots, selectedAdapters } from "../src/architecture-blueprint.mjs";
import { projectModeFor } from "../src/project-mode.mjs";
import { generateProjectOverlay, assertProjectOverlayAdapterIntegrity } from "../src/project-overlay.mjs";
import { provisionDeterministicScaffold } from "../src/deterministic-scaffold.mjs";
import { SwarmRouter } from "../src/router.mjs";
import { generateVerificationManifest } from "../src/product-evidence-executor.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const roots = [{ id: "web", path: "web", adapter: "next-node" }, { id: "api", path: "api", adapter: "dotnet" }];
const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: "read-only", approvalPolicy: "never", tokenBudget: 10, usesWorktree: false }]));
function repository(prefix) { const root = mkdtempSync(join(tmpdir(), prefix)); git(root, ["init", "-b", "main"]); writeFileSync(join(root, "README.md"), "fixture\n"); git(root, ["add", "."]); git(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-m", "base"]); return root; }
function config(root, productRoots) { return { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", project: { name: "fixture", documentationDir: "docs/in", generatedDir: "docs/out", projectMode: projectModeFor("greenfield"), productRoots }, router: { maxConcurrentTasks: 1, maxChildrenPerTask: 2, maxDelegationDepth: 2, maxPlanTasks: 2, defaultParentBudget: 10, turnTimeoutMs: 1000, approvalMode: "deny" }, roles }; }

test("selection is versioned and entirely derived from an admitted ArchitectureBlueprint", () => {
  const blueprint = architectureBlueprintFromProductRoots(roots, projectModeFor("greenfield"));
  const selected = selectedAdapters(blueprint, projectModeFor("greenfield"));
  assert.deepEqual(selected.map((item) => `${item.adapter.id}@${item.adapter.version}`), ["next-node@1", "dotnet@1"]);
  assert.throws(() => architectureBlueprintFromProductRoots([{ id: "py", path: "py", adapter: "python" }], projectModeFor("greenfield")), /unsupported_stack:python:no_controller_owned_adapter_with_deterministic_fixture_verification/);
  assert.throws(() => architectureBlueprintFromProductRoots([{ id: "go", path: "go", adapter: "go" }], projectModeFor("greenfield")), /unsupported_stack:go:no_controller_owned_adapter_with_deterministic_fixture_verification/);
});

test("Next and .NET use the same selected adapters for greenfield scaffold and brownfield overlay", async () => {
  const root = repository("stack-adapter-");
  try {
    const blueprint = architectureBlueprintFromProductRoots(roots, projectModeFor("greenfield"));
    provisionDeterministicScaffold({ worktree: root, productRoots: blueprint.components });
    const greenfield = await generateProjectOverlay({ repository: root, baseRef: "main", project: { projectMode: projectModeFor("greenfield"), architectureBlueprint: blueprint } });
    assertProjectOverlayAdapterIntegrity(greenfield.overlay, { architectureBlueprint: blueprint, projectMode: projectModeFor("greenfield") });
    assert.deepEqual(greenfield.overlay.components.map((item) => `${item.adapter}@${item.adapterVersion}`), ["next-node@1", "dotnet@1"]);
    const brownfieldBlueprint = architectureBlueprintFromProductRoots(roots, projectModeFor("brownfield"));
    const brownfield = await generateProjectOverlay({ repository: root, baseRef: "main", project: { projectMode: projectModeFor("brownfield"), architectureBlueprint: brownfieldBlueprint } });
    assert.deepEqual(brownfield.overlay.components.map((item) => `${item.id}:${item.adapter}@${item.adapterVersion}`), ["web:next-node@1", "api:dotnet@1"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ambiguous and unsupported stacks block before a worker can be admitted", async () => {
  const root = repository("stack-adapter-blocked-"); let router;
  try {
    mkdirSync(join(root, "api")); writeFileSync(join(root, "api", "one.sln"), ""); writeFileSync(join(root, "api", "two.sln"), "");
    router = new SwarmRouter(config(root, [{ id: "api", path: "api", adapter: "dotnet" }]));
    await assert.rejects(router.ensureProjectOverlay(), /ambiguous_stack:dotnet:multiple_solutions:api/); assert.equal(router.store.listTasks().length, 0); router.close();
    router = new SwarmRouter(config(root, [{ id: "py", path: "py", adapter: "python" }]));
    const run = router.createDeliveryRun({ id: "stack-unsupported", sourceClaimInputMode: "supplied", projectMode: projectModeFor("greenfield"), repositoryMode: "greenfield" });
    await router.runUntilIdle({ deliveryRunId: run.id }); assert.equal(router.store.deliveryRun(run.id).state, "blocked_specification"); assert.match(router.store.deliveryRun(run.id).publish.reason, /^unsupported_stack:python:/); assert.equal(router.store.listTasks().length, 0);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a persisted overlay cannot replace the controller-selected adapter", async () => {
  const root = repository("stack-adapter-integrity-");
  try {
    const blueprint = architectureBlueprintFromProductRoots(roots, projectModeFor("greenfield")); provisionDeterministicScaffold({ worktree: root, productRoots: blueprint.components });
    const { overlay } = await generateProjectOverlay({ repository: root, baseRef: "main", project: { projectMode: projectModeFor("greenfield"), architectureBlueprint: blueprint } });
    const tampered = structuredClone(overlay); tampered.components[0].adapter = "dotnet"; tampered.components[0].adapterVersion = 1;
    assert.throws(() => assertProjectOverlayAdapterIntegrity(tampered, { architectureBlueprint: blueprint, projectMode: projectModeFor("greenfield") }), /overlay_component_selection_mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the selected adapter verification commands propagate unchanged into ProductEvidence manifest", async () => {
  const root = repository("stack-adapter-evidence-");
  try {
    const blueprint = architectureBlueprintFromProductRoots(roots, projectModeFor("greenfield")); provisionDeterministicScaffold({ worktree: root, productRoots: blueprint.components });
    const { overlay } = await generateProjectOverlay({ repository: root, baseRef: "main", project: { projectMode: projectModeFor("greenfield"), architectureBlueprint: blueprint } });
    const manifest = generateVerificationManifest({ overlay, architectureBlueprint: blueprint, projectMode: projectModeFor("greenfield"), blueprint: { blueprintId: "fixture", requirements: [{ requirementId: "works", acceptanceCriteria: [{ criterionId: "verified" }] }] }, integration: { id: "integration", candidateSha: "a".repeat(40) } });
    assert.deepEqual(manifest.commands.map(({ id, component, cwd, executable, args }) => ({ id, component, cwd, executable, args })), overlay.verificationCommands.map(({ id, component, cwd, executable, args }) => ({ id, component, cwd, executable, args })));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
