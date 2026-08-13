import test from "node:test";
import assert from "node:assert/strict";
import { buildThinPlannerPrompt, createThinPlan, normalizeRelativePath, validateThinPlanCandidate } from "../src/thin/planner.mjs";

const frontend = { title: "Frontend", prompt: "Implement the web page.", allowedPaths: ["apps/web"], dependsOn: [] };
const backend = { title: "Backend", prompt: "Implement the API.", allowedPaths: ["apps/api"], dependsOn: [] };

test("planner creates controller IDs for two independent frontend and backend tasks", async () => {
  let received;
  const plan = await createThinPlan({ markdown: "# Project\nBuild web and API.", runTurn: async ({ prompt }) => {
    received = prompt;
    return JSON.stringify({ tasks: [frontend, backend] });
  } });
  assert.match(received, /Return JSON only/);
  assert.equal(plan.tasks.length, 2);
  assert.match(plan.tasks[0].id, /^task-1-/);
  assert.notEqual(plan.tasks[0].id, frontend.title);
  assert.deepEqual(plan.tasks.map((task) => task.dependsOn), [[], []]);
});

test("planner maps title dependencies to controller IDs", () => {
  const plan = validateThinPlanCandidate({ tasks: [frontend, { title: "UI tests", prompt: "Test the web page.", allowedPaths: ["test/ui"], dependsOn: ["Frontend"] }] });
  assert.deepEqual(plan.tasks[1].dependsOn, [plan.tasks[0].id]);
});

test("planner accepts up to twelve semantic tasks", () => {
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    title: `Task ${index + 1}`,
    prompt: "Implement the isolated task.",
    allowedPaths: [`components/${index + 1}`],
    dependsOn: [],
  }));
  assert.equal(validateThinPlanCandidate({ tasks }).tasks.length, 12);
});

test("planner rejects malformed JSON turn output", async () => {
  await assert.rejects(createThinPlan({ markdown: "x", runTurn: async () => "not-json" }), /malformed JSON/);
});

test("planner rejects unknown authority fields and ignores controller-only metadata", () => {
  assert.throws(() => validateThinPlanCandidate({ tasks: [{ ...frontend, blueprintId: "not-allowed" }] }), /forbidden field 'blueprintId'/);
  const plan = validateThinPlanCandidate({ tasks: [frontend], timestamp: "tomorrow" });
  assert.equal(plan.tasks.length, 1);
});

test("planner discards model-supplied controller IDs without trusting them", () => {
  const plan = validateThinPlanCandidate({ tasks: [{
    id: "model-chosen-id", title: "Frontend", prompt: "Implement it", allowedPaths: ["apps/web"], dependsOn: [],
  }] });
  assert.notEqual(plan.tasks[0].id, "model-chosen-id");
  assert.match(plan.tasks[0].id, /^task-1-/);
});

test("planner rejects absolute, Windows and traversal paths", () => {
  for (const path of ["/etc", "C:/work", "\\\\server\\share", "src/../secret", "src//bad", "./src"]) {
    assert.throws(() => normalizeRelativePath(path), /normalized relative POSIX path|traversal/);
  }
});

test("planner rejects unknown and cyclic dependencies", () => {
  assert.throws(() => validateThinPlanCandidate({ tasks: [{ ...frontend, dependsOn: ["Missing"] }] }), /unknown task/);
  assert.throws(() => validateThinPlanCandidate({ tasks: [
    { ...frontend, dependsOn: ["Backend"] },
    { ...backend, dependsOn: ["Frontend"] },
  ] }), /cycle/);
});

test("planner rejects path overlap for independent tasks but permits ordered tasks", () => {
  assert.throws(() => validateThinPlanCandidate({ tasks: [frontend, { ...backend, allowedPaths: ["apps"] }] }), /overlapping allowed paths/);
  const ordered = validateThinPlanCandidate({ tasks: [frontend, { ...backend, allowedPaths: ["apps"], dependsOn: ["Frontend"] }] });
  assert.equal(ordered.tasks.length, 2);
});

test("planner prompt is a small semantic contract", () => {
  assert.match(buildThinPlannerPrompt("# Brief"), /Do not include IDs/);
  assert.throws(() => buildThinPlannerPrompt(""), /non-empty/);
});
