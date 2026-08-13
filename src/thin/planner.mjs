import { createHash } from "node:crypto";

const TASK_KEYS = new Set(["title", "prompt", "allowedPaths", "dependsOn"]);
const ROOT_KEYS = new Set(["tasks"]);
// These fields are sometimes added by a model despite an explicit prompt not
// to do so. They never have authority in the thin controller, so discard them
// before validating the semantic candidate instead of rejecting an otherwise
// usable plan. Unknown fields are still rejected below.
const CONTROLLER_FIELDS = new Set([
  "id", "taskId", "runId", "baseSha", "headSha", "commitSha", "candidateSha",
  "createdAt", "updatedAt", "timestamp", "status", "metadata", "version",
  "budget", "tokenBudget", "evidence", "sourceClaims",
]);

/**
 * Build a deliberately small, semantic-only planning prompt. The controller
 * creates all task identifiers after validating the returned task list.
 */
export function buildThinPlannerPrompt(markdown) {
  if (typeof markdown !== "string" || markdown.trim() === "") {
    throw new TypeError("markdown must be a non-empty string");
  }
  return [
    "Create a small implementation plan from the Markdown below.",
    "Return JSON only (no prose or Markdown fence) with exactly this shape:",
    '{"tasks":[{"title":"...","prompt":"...","allowedPaths":["relative/path"],"dependsOn":["other task title"]}]}',
    "Return between 1 and 10 tasks. A dependency is another returned task title.",
    "Keep independent tasks in non-overlapping file areas. Do not include IDs,",
    "SHA values, timestamps, budgets, source claims, evidence, or any technical metadata.",
    "\n--- PROJECT MARKDOWN ---\n",
    markdown,
    "\n--- END PROJECT MARKDOWN ---",
  ].join("\n");
}

/**
 * Calls the injected Codex turn runner and canonicalizes its semantic plan.
 * `runTurn` receives `{ prompt }` and must resolve to the model's text result.
 */
export async function createThinPlan({ markdown, runTurn }) {
  if (typeof runTurn !== "function") throw new TypeError("runTurn must be a function");
  const prompt = buildThinPlannerPrompt(markdown);
  const result = await runTurn({ prompt });
  return validateThinPlanCandidate(parsePlannerJson(result));
}

export function parsePlannerJson(result) {
  const text = typeof result === "string" ? result : result?.text;
  if (typeof text !== "string" || text.trim() === "") {
    throw new TypeError("planner turn must return non-empty JSON text");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("planner returned malformed JSON");
  }
}

/**
 * Validates the LLM candidate and returns a controller-owned plan. IDs are
 * deterministic controller values, never accepted from the model.
 */
export function validateThinPlanCandidate(candidate) {
  candidate = discardControllerFields(candidate);
  if (!isPlainObject(candidate)) throw new TypeError("planner output must be a JSON object");
  assertExactKeys(candidate, ROOT_KEYS, "planner output");
  if (!Array.isArray(candidate.tasks) || candidate.tasks.length < 1 || candidate.tasks.length > 10) {
    throw new Error("planner output must contain 1 to 10 tasks");
  }

  const titles = new Set();
  const rawTasks = candidate.tasks.map((task, index) => {
    if (!isPlainObject(task)) throw new TypeError(`task ${index + 1} must be an object`);
    assertExactKeys(task, TASK_KEYS, `task ${index + 1}`);
    const title = requireText(task.title, `task ${index + 1} title`);
    const prompt = requireText(task.prompt, `task '${title}' prompt`);
    if (titles.has(title)) throw new Error(`duplicate task title '${title}'`);
    titles.add(title);
    if (!Array.isArray(task.allowedPaths) || task.allowedPaths.length === 0) {
      throw new Error(`task '${title}' must declare at least one allowed path`);
    }
    const allowedPaths = [...new Set(task.allowedPaths.map((path) => normalizeRelativePath(path)))];
    if (!Array.isArray(task.dependsOn)) throw new Error(`task '${title}' dependsOn must be an array`);
    const dependsOnTitles = [...new Set(task.dependsOn.map((value) => requireText(value, `task '${title}' dependency`)))];
    if (dependsOnTitles.includes(title)) throw new Error(`task '${title}' cannot depend on itself`);
    return { title, prompt, allowedPaths, dependsOnTitles };
  });

  const titleToId = new Map(rawTasks.map((task, index) => [task.title, controllerTaskId(task.title, index)]));
  for (const task of rawTasks) {
    for (const dependency of task.dependsOnTitles) {
      if (!titleToId.has(dependency)) throw new Error(`task '${task.title}' depends on unknown task '${dependency}'`);
    }
  }
  assertAcyclic(rawTasks);
  assertIndependentPathsDoNotOverlap(rawTasks);

  return {
    tasks: rawTasks.map((task) => ({
      id: titleToId.get(task.title),
      title: task.title,
      prompt: task.prompt,
      allowedPaths: task.allowedPaths,
      dependsOn: task.dependsOnTitles.map((title) => titleToId.get(title)),
    })),
  };
}

function discardControllerFields(candidate) {
  if (!isPlainObject(candidate)) return candidate;
  const root = Object.fromEntries(Object.entries(candidate).filter(([key]) => !CONTROLLER_FIELDS.has(key)));
  if (Array.isArray(root.tasks)) {
    root.tasks = root.tasks.map((task) => isPlainObject(task)
      ? Object.fromEntries(Object.entries(task).filter(([key]) => !CONTROLLER_FIELDS.has(key)))
      : task);
  }
  return root;
}

export function normalizeRelativePath(value) {
  const path = requireText(value, "allowed path");
  if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("//")) {
    throw new Error(`allowed path must be a normalized relative POSIX path: '${path}'`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`allowed path must not contain traversal or dot segments: '${path}'`);
  }
  return path;
}

function controllerTaskId(title, index) {
  const digest = createHash("sha256").update(title).digest("hex").slice(0, 10);
  return `task-${index + 1}-${digest}`;
}

function assertAcyclic(tasks) {
  const byTitle = new Map(tasks.map((task) => [task.title, task]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (title) => {
    if (visiting.has(title)) throw new Error("planner task dependencies contain a cycle");
    if (visited.has(title)) return;
    visiting.add(title);
    for (const dependency of byTitle.get(title).dependsOnTitles) visit(dependency);
    visiting.delete(title);
    visited.add(title);
  };
  for (const task of tasks) visit(task.title);
}

function assertIndependentPathsDoNotOverlap(tasks) {
  const ancestors = new Map(tasks.map((task) => [task.title, allAncestors(task.title, tasks)]));
  for (let left = 0; left < tasks.length; left += 1) {
    for (let right = left + 1; right < tasks.length; right += 1) {
      const a = tasks[left]; const b = tasks[right];
      const ordered = ancestors.get(a.title).has(b.title) || ancestors.get(b.title).has(a.title);
      if (ordered) continue;
      for (const pathA of a.allowedPaths) for (const pathB of b.allowedPaths) {
        if (pathsOverlap(pathA, pathB)) {
          throw new Error(`independent tasks '${a.title}' and '${b.title}' have overlapping allowed paths '${pathA}' and '${pathB}'`);
        }
      }
    }
  }
}

function allAncestors(title, tasks) {
  const byTitle = new Map(tasks.map((task) => [task.title, task]));
  const result = new Set();
  const collect = (current) => {
    for (const dependency of byTitle.get(current).dependsOnTitles) {
      if (!result.has(dependency)) { result.add(dependency); collect(dependency); }
    }
  };
  collect(title);
  return result;
}

function pathsOverlap(a, b) { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains forbidden field '${key}'`);
  for (const key of allowed) if (!(key in value)) throw new Error(`${label} is missing required field '${key}'`);
}
