import test from "node:test";
import assert from "node:assert/strict";
import { redactAndBoundFailureOutput, runThinRepair } from "../src/thin/repair.mjs";

const input = {
  verificationFailure: "npm test failed: expected green",
  candidateSha: "a1b2c3d4e5f6",
  previousWaveTaskScopes: [{ taskId: "frontend", allowedPaths: ["apps/web"] }],
  repairSurface: ["apps/web", "test"],
};

test("thin repair executes one valid controller-bounded repair", async () => {
  let execution;
  const result = await runThinRepair({
    ...input,
    planRepair: async () => ({ title: "Fix web test", prompt: "Fix the asserted behavior.", allowedPaths: ["apps/web/page.js", "test/web.test.mjs"] }),
    executeRepair: async (request) => { execution = request; return { commitSha: "f00baa1", changedPaths: ["apps/web/page.js"] }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "repair_artifact_ready");
  assert.equal(result.attempts, 1);
  assert.equal(execution.candidateSha, input.candidateSha);
  assert.deepEqual(execution.repairPlan.allowedPaths, ["apps/web/page.js", "test/web.test.mjs"]);
});

test("thin repair rejects an unsafe plan before worker execution", async () => {
  let ran = false;
  const result = await runThinRepair({
    ...input,
    planRepair: async () => ({ title: "Escape", prompt: "Change anything", allowedPaths: [".github/workflows/ci.yml"] }),
    executeRepair: async () => { ran = true; },
  });
  assert.equal(result.reasonCode, "repair_plan_rejected");
  assert.equal(ran, false);
});

test("thin repair returns a structured result for no repair plan", async () => {
  const result = await runThinRepair({ ...input, planRepair: async () => null, executeRepair: async () => ({}) });
  assert.equal(result.reasonCode, "repair_plan_missing");
});

test("thin repair denies a second attempt", async () => {
  let planned = false;
  const result = await runThinRepair({ ...input, attempts: 1, planRepair: async () => { planned = true; }, executeRepair: async () => ({}) });
  assert.equal(result.reasonCode, "repair_attempt_limit_reached");
  assert.equal(planned, false);
});

test("failure output is redacted and bounded before it reaches a repair planner", async () => {
  const raw = `Authorization: Bearer private-value\nTOKEN=super-secret\n${"x".repeat(5_000)}`;
  let plannerInput;
  const result = await runThinRepair({
    ...input,
    verificationFailure: raw,
    planRepair: async (request) => { plannerInput = request.verificationFailure; return null; },
    executeRepair: async () => ({}) ,
  });
  assert.equal(result.reasonCode, "repair_plan_missing");
  assert.doesNotMatch(plannerInput, /private-value|super-secret/);
  assert.match(plannerInput, /\[REDACTED\]/);
  assert.ok(plannerInput.length <= 4_020);
  assert.equal(redactAndBoundFailureOutput(raw), plannerInput);
});
