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
export function buildThinPlannerPrompt(markdown, { deliveryConstraints = "" } = {}) {
  if (typeof markdown !== "string" || markdown.trim() === "") {
    throw new TypeError("markdown must be a non-empty string");
  }
  return [
    "Create a small implementation plan from the Markdown below.",
    "Return JSON only (no prose or Markdown fence) with exactly this shape:",
    '{"tasks":[{"title":"...","prompt":"...","allowedPaths":["relative/path"],"dependsOn":["other task title"]}]}',
    "Return between 1 and 12 tasks. A dependency is another returned task title.",
    "Every task owns an exclusive file area for the entire delivery: no allowed path may be equal to,",
    "inside, or contain an allowed path of any other task, including dependencies. Combine work that",
    "needs shared files into one task. Do not use a whole project root when a narrower ownership area",
    "can be named. A downstream task must not repeat a predecessor's responsibility in different files.",
    "Each worker prompt must be actionable only inside its allowedPaths. Never ask a worker to start a",
    "long-running dev server such as `dotnet run`, `npm run dev`, or `next dev`.",
    "Do not include IDs,",
    "SHA values, timestamps, budgets, source claims, evidence, or any technical metadata.",
    deliveryConstraints ? `\n--- CONTROLLER DELIVERY CONSTRAINTS ---\n${deliveryConstraints}\n--- END CONTROLLER DELIVERY CONSTRAINTS ---` : "",
    "\n--- PROJECT MARKDOWN ---\n",
    markdown,
    "\n--- END PROJECT MARKDOWN ---",
  ].join("\n");
}

/**
 * Calls the injected Codex turn runner and canonicalizes its semantic plan.
 * `runTurn` receives `{ prompt }` and must resolve to the model's text result.
 */
export async function createThinPlan({ markdown, runTurn, deliveryConstraints = "" }) {
  if (typeof runTurn !== "function") throw new TypeError("runTurn must be a function");
  if (typeof deliveryConstraints !== "string") throw new TypeError("deliveryConstraints must be a string");
  const initialPrompt = buildThinPlannerPrompt(markdown, { deliveryConstraints });
  let prompt = initialPrompt;
  let priorResult = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runTurn({ prompt, attempt: attempt + 1 });
    try {
      return validateThinPlanCandidate(parsePlannerJson(result));
    } catch (error) {
      if (attempt === 1) throw error;
      priorResult = String(typeof result === "string" ? result : result?.text ?? "").slice(0, 12000);
      prompt = buildThinPlannerCorrectionPrompt({ initialPrompt, priorResult, rejection: String(error.message ?? error) });
    }
  }
  throw new Error("planner correction attempts exhausted");
}

export function buildThinPlannerCorrectionPrompt({ initialPrompt, priorResult, rejection }) {
  return [
    initialPrompt,
    "\n--- CONTROLLER PLAN REJECTION ---",
    String(rejection).slice(0, 500),
    "\nYour previous JSON was rejected. Return a corrected replacement JSON only.",
    "Do not split one owned module across tasks. Every task path must be exclusive across the whole plan.",
    "\n--- PREVIOUS CANDIDATE ---",
    priorResult,
    "\n--- END PREVIOUS CANDIDATE ---",
  ].join("\n");
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
  if (!Array.isArray(candidate.tasks) || candidate.tasks.length < 1 || candidate.tasks.length > 12) {
    throw new Error("planner output must contain 1 to 12 tasks");
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
  const idToTitle = new Map([...titleToId].map(([title, id]) => [id, title]));
  for (const task of rawTasks) {
    task.dependsOnTitles = task.dependsOnTitles.map((dependency) => {
      if (titleToId.has(dependency)) return dependency;
      // A model may echo the deterministic controller ID displayed by a
      // previous planning convention. Accept it only when it is exactly the
      // ID minted for one of these returned tasks; never accept a foreign ID.
      if (idToTitle.has(dependency)) return idToTitle.get(dependency);
      throw new Error(`task '${task.title}' depends on unknown task '${dependency}'`);
    });
  }
  assertAcyclic(rawTasks);
  assertTaskOwnershipPathsDoNotOverlap(rawTasks);

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

function assertTaskOwnershipPathsDoNotOverlap(tasks) {
  for (let left = 0; left < tasks.length; left += 1) {
    for (let right = left + 1; right < tasks.length; right += 1) {
      const a = tasks[left]; const b = tasks[right];
      for (const pathA of a.allowedPaths) for (const pathB of b.allowedPaths) {
        if (pathsOverlap(pathA, pathB)) {
          throw new Error(`tasks '${a.title}' and '${b.title}' have overlapping ownership paths '${pathA}' and '${pathB}'`);
        }
      }
    }
  }
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
