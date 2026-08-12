import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commandsForPaths, generateProjectOverlay } from "../src/project-overlay.mjs";
import { validatePlan } from "../src/workflow-contract.mjs";
import { projectModeFor } from "../src/project-mode.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const roots = [{ id: "frontend", path: "frontend", adapter: "next-node" }, { id: "backend", path: "backend", adapter: "dotnet" }];
const task = (id, domain, paths, dependsOn = []) => ({ id, title: id, prompt: id, primaryDomain: domain, supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 10, dependsOn, allowedPaths: paths, acceptanceChecks: [] });

test("greenfield multi-stack ignores controller package manager and scopes verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "multi-stack-"));
  try {
    git(root, ["init", "-b", "main"]); writeFileSync(join(root, "package.json"), JSON.stringify({ name: "controller" })); git(root, ["add", "."]); git(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-m", "base"]);
    const initial = await generateProjectOverlay({ repository: root, baseRef: "main", project: { productRoots: roots } });
    assert.deepEqual(initial.overlay.components.map((item) => item.state), ["unscaffolded", "unscaffolded"]);
    assert.equal(initial.overlay.verificationCommands.length, 0);
    mkdirSync(join(root, "frontend")); mkdirSync(join(root, "backend")); writeFileSync(join(root, "frontend", "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { build: "node --version", test: "node --version" } })); writeFileSync(join(root, "frontend", "package-lock.json"), "{}"); writeFileSync(join(root, "backend", "Product.sln"), "");
    const scaffolded = await generateProjectOverlay({ repository: root, baseRef: "main", project: { productRoots: roots } });
    const frontend = commandsForPaths(scaffolded.overlay, ["frontend/app/page.tsx"]); const backend = commandsForPaths(scaffolded.overlay, ["backend/Api.cs"]);
    assert.equal(frontend.commands.every((command) => command.component === "frontend"), true); assert.equal(backend.commands[0].executable, "dotnet"); assert.deepEqual(backend.commands[0].args.slice(0, 2), ["test", "Product.sln"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("greenfield DAG requires the scaffold writer before product tasks", () => {
  assert.throws(() => validatePlan({ tasks: [task("api", "backend", ["backend/src"]) ] }, { maxTasks: 3, productRoots: roots }), /scaffold-product/);
  const plan = validatePlan({ tasks: [task("scaffold-product", "devops", ["frontend", "backend"]), task("api", "backend", ["backend/src"], ["scaffold-product"]), task("ui", "frontend", ["frontend/app"], ["scaffold-product"])] }, { maxTasks: 4, productRoots: roots });
  assert.equal(plan.tasks.length, 3);
});

test("brownfield product roots never imply a generic scaffold", () => {
  const projectMode = projectModeFor("brownfield");
  const plan = validatePlan({ projectMode, tasks: [task("preserve-api", "backend", ["backend/src"]) ] }, { maxTasks: 3, productRoots: roots, projectMode });
  assert.equal(plan.tasks[0].id, "preserve-api");
  assert.throws(() => validatePlan({ projectMode, tasks: [task("scaffold-product", "devops", ["frontend", "backend"])] }, { maxTasks: 3, productRoots: roots, projectMode }), /forbids generic scaffold/);
  assert.throws(() => validatePlan({ projectMode: projectModeFor("greenfield"), tasks: [task("preserve-api", "backend", ["backend/src"])] }, { maxTasks: 3, productRoots: roots, projectMode }), /ProjectMode must match/);
});
