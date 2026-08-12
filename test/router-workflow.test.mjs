import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";

function config(root) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, {
    sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, maxAttempts: 1, usesWorktree: false
  }]));
  return {
    repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "test-model",
    project: { name: "test", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" },
    router: { maxConcurrentTasks: 1, maxChildrenPerTask: 20, maxDelegationDepth: 4, maxPlanTasks: 12, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" },
    budget: { weeklyTokenLimit: 5000, weeklyWindowDays: 7 },
    roles
  };
}

test("project workflow refuses to queue Planner without a persisted ProductBlueprint", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-router-"));
  mkdirSync(join(root, "docs", "orchestration-input"), { recursive: true });
  writeFileSync(join(root, "docs", "orchestration-input", "inventory.json"), "{}", "utf8");
  const router = new SwarmRouter(config(root));
  try {
    const bootstrap = router.startProject();
    assert.equal(bootstrap.role, "bootstrap");
    assert.match(bootstrap.prompt, /sourceClaimIds and sourceRefs are an immutable pair/);
    assert.match(bootstrap.prompt, /copy every sourceRefs object.*verbatim/);
    router.store.transition(bootstrap.id, "preparing");
    router.store.transition(bootstrap.id, "running");
    router.store.transition(bootstrap.id, "awaiting_human");
    assert.throws(() => router.approveHumanGate(bootstrap.id), /persisted ProductBlueprint/);
  } finally {
    router.close();
    rmSync(root, { recursive: true, force: true });
  }
});
