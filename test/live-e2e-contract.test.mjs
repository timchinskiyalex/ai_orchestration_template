import test from "node:test";
import assert from "node:assert/strict";
import { deterministicScaffoldFixtureRouterConfig, parseLiveE2eWorkers, selectLiveE2eFailureTask } from "../src/live-e2e-contract.mjs";

test("live deterministic-scaffold fixture uses the propagated worker count as scheduler concurrency", () => {
  assert.equal(parseLiveE2eWorkers("2"), 2);
  assert.equal(deterministicScaffoldFixtureRouterConfig({ workers: 2, timeoutMs: 30_000 }).maxConcurrentTasks, 2);
  assert.throws(() => parseLiveE2eWorkers("11"), /integer from 1 to 10/);
});

test("live E2E reporting selects the actual newest interrupted task", () => {
  const selected = selectLiveE2eFailureTask([
    { id: "scaffold", status: "done", updatedAt: "2026-08-13T05:39:20.000Z" },
    { id: "security", status: "interrupted", updatedAt: "2026-08-13T05:39:27.000Z" },
    { id: "frontend", status: "queued", updatedAt: "2026-08-13T05:39:26.000Z" }
  ], "scaffold");
  assert.equal(selected.id, "security");
});
