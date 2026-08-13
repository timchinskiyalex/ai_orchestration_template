import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { architectureBlueprintFromProductRoots, validateArchitectureBlueprint } from "./architecture-blueprint.mjs";
import { assertAdapterVerificationCommand, controllerStackAdapterRegistry, inspectWithAdapter } from "./stack-adapter.mjs";

const exec = promisify(execFile);
const OVERLAY_VERSION = 1;
const sensitiveName = /(^|\/)(\.env(?:\.|$)|[^/]*\.(?:pem|key)$|[^/]*(?:credentials|secrets)[^/]*)/i;
const ignored = new Set([".git", "node_modules", "dist", "build", "coverage", ".next"]);
const packageManagers = new Map([["npm", "package-lock.json"], ["pnpm", "pnpm-lock.yaml"], ["yarn", "yarn.lock"]]);
const nodeVerificationScripts = new Set(["test", "test:unit", "test:integration", "test:e2e", "lint", "format:check", "typecheck", "build"]);
const toPosix = (value) => value.split(sep).join("/");

export const STACK_ADAPTERS = Object.freeze({
  node: { productionReady: false, reason: "root inference is diagnostic-only; admit an ArchitectureBlueprint" },
  "next-node": { productionReady: true, version: 1, packageManagers: [...packageManagers.keys()] },
  dotnet: { productionReady: true, version: 1, commands: ["dotnet test"] },
  python: { productionReady: false, reason: "a Python adapter is required before verification can run" },
  go: { productionReady: false, reason: "a Go adapter is required before verification can run" }
});

async function git(repository, args) { return (await exec("git", ["-C", repository, ...args])).stdout.trim(); }
function safeRead(path) { return readFileSync(path, "utf8"); }
function walk(root, max = 2000) {
  const found = [];
  const visit = (directory) => {
    if (!existsSync(directory) || found.length >= max) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = join(directory, entry.name); const path = toPosix(relative(root, absolute));
      if (entry.isDirectory()) visit(absolute); else if (entry.isFile()) found.push(path);
      if (found.length >= max) return;
    }
  };
  visit(root); return found;
}
function evidence(ledger, path, selector, parser, value, confidence = "verified") { ledger.push({ path, selector, parser, value, confidence }); }
function agents(files) { return files.filter((path) => /(^|\/)(AGENTS(?:\.override)?\.md)$/i.test(path)).map((path) => ({ path, scope: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".", confidence: "verified" })); }
function workflowMetadata(repository, files, ledger) {
  return files.filter((path) => /^\.github\/workflows\/.*\.(?:yml|yaml)$/i.test(path)).map((path) => {
    const text = safeRead(join(repository, path)); const jobs = [...text.matchAll(/^\s{2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
    const commands = [...text.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1].trim());
    evidence(ledger, path, "workflow lines", "yaml-line-scanner", { jobs, commands }, "declared");
    return { path, jobs, commands, permissions: [], environments: [], requiredChecks: "unknown", confidence: "declared" };
  });
}
function detectPackageManager(packageJson, files, ledger, packagePath) {
  const declared = typeof packageJson.packageManager === "string" ? packageJson.packageManager.split("@")[0] : null;
  const fromLock = [...packageManagers.entries()].find(([, file]) => files.includes(file))?.[0] ?? null;
  const name = declared ?? fromLock;
  if (!name || !packageManagers.has(name)) throw new Error(`Unsupported Node package manager '${declared ?? "unknown"}'. Declare packageManager as npm, pnpm, or yarn, or commit its supported lockfile.`);
  evidence(ledger, declared ? packagePath : packageManagers.get(name), declared ? "packageManager" : "path", declared ? "json" : "file-name", name, declared ? "declared" : "verified");
  return { name, version: declared ? packageJson.packageManager.slice(name.length + 1) || null : null, source: declared ? "package.json#packageManager" : "lockfile", confidence: declared ? "declared" : "verified" };
}
function packageCommand(manager, script) {
  const rendered = `${manager} run ${script}`;
  return process.platform === "win32" ? { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", rendered] } : { executable: manager, args: ["run", script] };
}
function isInside(path, root) { return path === root || path.startsWith(`${root}/`); }
function productModule(component) { return { present: component.state === "scaffolded", paths: component.state === "unscaffolded" ? [] : [component.root], confidence: component.state === "scaffolded" ? "verified" : "unknown" }; }

function nodeComponent(component, root, ledger) {
  const directory = join(root, component.path); const files = walk(directory); const packagePath = "package.json";
  if (!existsSync(join(directory, packagePath))) return { id: component.id, root: component.path, adapter: component.adapter, state: existsSync(directory) ? "incomplete" : "unscaffolded", evidence: [] };
  const packageJson = JSON.parse(safeRead(join(directory, packagePath))); const manager = detectPackageManager(packageJson, files, ledger, `${component.path}/package.json`);
  const scripts = Object.entries(packageJson.scripts ?? {}).map(([name, command]) => ({ name, command, source: `${component.path}/package.json`, confidence: "declared" }));
  const verificationCommands = scripts.filter((item) => nodeVerificationScripts.has(item.name)).map((item) => ({ id: `${component.id}:package-script:${item.name}`, component: component.id, cwd: component.path, ...packageCommand(manager.name, item.name), source: item.source, confidence: "declared" }));
  evidence(ledger, `${component.path}/package.json`, "package.json", "json", { name: packageJson.name ?? null, scripts: scripts.map((item) => item.name) }, "verified");
  return { id: component.id, root: component.path, adapter: component.adapter, state: "scaffolded", packageJson: { name: packageJson.name ?? null, scripts: scripts.map((item) => item.name) }, packageManager: manager, scripts, verificationCommands };
}
function dotnetComponent(component, root, ledger) {
  const directory = join(root, component.path); if (!existsSync(directory)) return { id: component.id, root: component.path, adapter: component.adapter, state: "unscaffolded", evidence: [] };
  const files = walk(directory); const solutions = files.filter((path) => path.toLowerCase().endsWith(".sln")); const projects = files.filter((path) => path.toLowerCase().endsWith(".csproj"));
  if (!solutions.length && !projects.length) return { id: component.id, root: component.path, adapter: component.adapter, state: "incomplete", evidence: [] };
  if (solutions.length > 1) throw new Error(`Ambiguous .NET solution in declared backend root '${component.path}'`);
  const target = solutions[0] ?? (projects.length === 1 ? projects[0] : null);
  if (!target) throw new Error(`Ambiguous .NET projects in declared backend root '${component.path}'; add one solution file`);
  const source = `${component.path}/${target}`; evidence(ledger, source, solutions.length ? "solution" : "project", "file-name", target, "verified");
  return { id: component.id, root: component.path, adapter: component.adapter, state: "scaffolded", solution: solutions[0] ? source : null, project: solutions[0] ? null : source, verificationCommands: [{ id: `${component.id}:dotnet-test`, component: component.id, cwd: component.path, executable: "dotnet", args: ["test", target, "--nologo"], source, confidence: "verified", timeoutMs: 120000 }] };
}
function componentFor(configured, inspectionRoot, ledger) {
  const adapter = typeof configured.adapter === "string" ? { id: configured.adapter, version: configured.adapterVersion ?? 1 } : configured.adapter;
  const component = { ...configured, adapter };
  const detected = inspectWithAdapter(component, inspectionRoot);
  for (const fingerprint of detected.fingerprints ?? []) evidence(ledger, fingerprint.source ?? component.path, fingerprint.kind, "stack-adapter", fingerprint, "verified");
  return { ...detected, id: component.id, root: component.path, adapter: adapter.id, adapterVersion: adapter.version };
}
function legacyNode(files, root, ledger) {
  const packagePath = files.find((path) => path === "package.json"); if (!packagePath) throw new Error("Unsupported repository stack: no package.json. Add a stack adapter before orchestration.");
  const packageJson = JSON.parse(safeRead(join(root, packagePath))); const manager = detectPackageManager(packageJson, files, ledger, packagePath);
  const scripts = Object.entries(packageJson.scripts ?? {}).map(([name, command]) => ({ name, command, confidence: "declared", source: packagePath }));
  const verificationCommands = scripts.filter((item) => nodeVerificationScripts.has(item.name)).map((item) => ({ id: `package-script:${item.name}`, component: "root", cwd: ".", ...packageCommand(manager.name, item.name), source: packagePath, confidence: "declared" }));
  return { stack: { adapter: "node", adapterSupport: "production-ready", node: true, packageManager: manager, typescript: files.some((path) => /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(path)), packageJson: { name: packageJson.name ?? null, scripts: Object.keys(packageJson.scripts ?? {}) }, lockfiles: files.filter((path) => /(?:^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(path)), tsconfigs: files.filter((path) => /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(path)), workspaces: packageJson.workspaces ?? [] }, scripts, verificationCommands, components: [] };
}

export async function generateProjectOverlay({ repository, baseRef = "HEAD", generatedDir = "docs/orchestration-generated", project = {}, inspectionRoot = repository }) {
  const root = await git(repository, ["rev-parse", "--show-toplevel"]); const inspected = resolve(inspectionRoot);
  const [baseSha, branch, status] = await Promise.all([git(root, ["rev-parse", baseRef]), git(root, ["branch", "--show-current"]), git(root, ["status", "--porcelain"])]);
  const files = walk(inspected); const ledger = []; evidence(ledger, ".git", "rev-parse --show-toplevel", "git", root, "verified"); evidence(ledger, ".git", `rev-parse ${baseRef}`, "git", baseSha, "verified");
  const architectureBlueprint = project.architectureBlueprint
    ? validateArchitectureBlueprint(project.architectureBlueprint, { projectMode: project.projectMode })
    : project.projectMode
      ? architectureBlueprintFromProductRoots(project.productRoots ?? [], project.projectMode)
      : null;
  const configuredRoots = architectureBlueprint?.components ?? (project.productRoots ?? []);
  const discovery = configuredRoots.length ? configuredRoots.map((item) => componentFor(item, inspected, ledger)) : null;
  const legacy = discovery ? null : legacyNode(files, inspected, ledger);
  const components = discovery ?? legacy.components; const verificationCommands = discovery ? components.flatMap((component) => component.verificationCommands ?? []) : legacy.verificationCommands;
  const modules = discovery ? Object.fromEntries(components.map((component) => [component.id, productModule(component)])) : Object.fromEntries(Object.entries({ backend: /(^|\/)(server|api|backend|routes|controllers)(\/|$)/i, frontend: /(^|\/)(src\/)?(?:components|pages|app|frontend)(\/|$)/i, database: /(^|\/)(migrations?|schema|database|db)(\/|$)/i, infrastructure: /(^|\/)(infra|terraform|k8s|helm|docker|\.github)(\/|$)/i }).map(([name, pattern]) => [name, { present: files.some((path) => pattern.test(path)), paths: files.filter((path) => pattern.test(path)).slice(0, 25), confidence: files.some((path) => pattern.test(path)) ? "inferred" : "unknown" }]));
  const sensitivePaths = files.filter((path) => sensitiveName.test(path)).map((path) => ({ path, classification: "sensitive-name", contentRead: false, confidence: "verified" }));
  const pathPolicies = { denyWrite: sensitivePaths.map((item) => item.path), approvalRequired: files.filter((path) => /(^\.github\/workflows\/|(^|\/)(migrations?|infra|terraform|k8s|helm)\/)/i.test(path)), generatedDoNotEdit: [], contextExclude: sensitivePaths.map((item) => item.path) };
  const overlay = { schemaVersion: OVERLAY_VERSION, generatedAt: new Date().toISOString(), repository: { gitRoot: root, baseSha, branch: branch || "detached", clean: !status, dirtyPaths: status ? status.split(/\r?\n/).map((line) => line.slice(3)) : [] }, architectureBlueprint: architectureBlueprint ? { schemaVersion: architectureBlueprint.schemaVersion, kind: architectureBlueprint.kind, projectMode: architectureBlueprint.projectMode, digest: architectureBlueprint.digest, registryVersion: architectureBlueprint.registryVersion, components: architectureBlueprint.components } : null, stack: discovery ? { adapter: "multi-stack", adapterSupport: "production-ready", registryVersion: 1, components: components.map(({ id, root: componentRoot, adapter, adapterVersion, state, fingerprints }) => ({ id, root: componentRoot, adapter, adapterVersion, state, fingerprints: fingerprints ?? [] })) } : { ...legacy.stack, adapterSupport: "diagnostic-only" }, components, scripts: legacy?.scripts ?? [], verificationCommands, workflows: workflowMetadata(inspected, files, ledger), agents: agents(files), modules, pathPolicies, sensitivePaths, evidenceLedger: ledger };
  const destination = join(root, generatedDir, "project-overlay.v1.json"); mkdirSync(resolve(destination, ".."), { recursive: true }); writeFileSync(destination, JSON.stringify(overlay, null, 2) + "\n", "utf8");
  return { overlay, path: toPosix(relative(root, destination)) };
}

export function commandsForPaths(overlay, changedPaths = []) {
  const components = overlay.components ?? []; if (!components.length) return { commands: overlay.verificationCommands ?? [], missing: [] };
  const relevant = components.filter((component) => changedPaths.some((path) => isInside(path, component.root)));
  const missing = relevant.filter((component) => component.state !== "scaffolded" || !(component.verificationCommands ?? []).length).map((component) => ({ component: component.id, reason: component.state !== "scaffolded" ? `component is ${component.state}` : "component declares no allowlisted verification command" }));
  return { commands: relevant.flatMap((component) => component.verificationCommands ?? []), missing };
}
export function commandCwd(worktree, command) { return command.cwd && command.cwd !== "." ? join(worktree, command.cwd) : worktree; }
export function loadProjectOverlay(repository, generatedDir = "docs/orchestration-generated") { const path = join(repository, generatedDir, "project-overlay.v1.json"); if (!existsSync(path)) throw new Error(`Missing ProjectOverlay: ${path}`); const overlay = JSON.parse(safeRead(path)); if (overlay.schemaVersion !== OVERLAY_VERSION) throw new Error(`Unsupported ProjectOverlay schema version: ${overlay.schemaVersion}`); return { overlay, path: toPosix(relative(repository, path)) }; }
export function projectOverlayExecutionSnapshot(overlay) {
  if (!overlay || overlay.schemaVersion !== OVERLAY_VERSION) throw new Error("Cannot create execution snapshot from an unsupported ProjectOverlay");
  return { schemaVersion: 1, sourceOverlayVersion: overlay.schemaVersion, baseSha: overlay.repository?.baseSha ?? null, architectureBlueprint: overlay.architectureBlueprint ? { digest: overlay.architectureBlueprint.digest, registryVersion: overlay.architectureBlueprint.registryVersion } : null, stack: { adapter: overlay.stack?.adapter ?? null, adapterSupport: overlay.stack?.adapterSupport ?? null, components: (overlay.components ?? []).map((component) => ({ id: component.id, root: component.root, adapter: component.adapter, adapterVersion: component.adapterVersion ?? null, state: component.state })) }, verificationCommands: (overlay.verificationCommands ?? []).map(({ id, component, cwd, executable, args, confidence }) => ({ id, component, cwd, executable, args, confidence })), agents: (overlay.agents ?? []).map((agent) => ({ path: agent.path, scope: agent.scope, confidence: agent.confidence })), pathPolicies: { approvalRequired: overlay.pathPolicies?.approvalRequired ?? [], generatedDoNotEdit: overlay.pathPolicies?.generatedDoNotEdit ?? [] }, modules: Object.fromEntries(Object.entries(overlay.modules ?? {}).map(([name, value]) => [name, { present: Boolean(value?.present), confidence: value?.confidence ?? "unknown" }])) };
}

// This deliberately identifies controller-observed repository operations
// separately from source-backed product evidence.  A Bootstrap claim may
// select one of these commands, but the controller must bind it again against
// the current overlay before any later consumer can use it.
export function validateRepositoryVerificationReference(reference, overlay) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference) || reference.schemaVersion !== 1 || reference.source !== "project_overlay" || typeof reference.commandId !== "string" || !reference.commandId.trim() || typeof reference.overlayBaseSha !== "string" || !/^[a-f0-9]{40,64}$/i.test(reference.overlayBaseSha)) throw new Error("repository verification reference is invalid");
  if (!overlay || overlay.schemaVersion !== OVERLAY_VERSION || typeof overlay.repository?.baseSha !== "string" || !/^[a-f0-9]{40,64}$/i.test(overlay.repository.baseSha)) throw new Error("repository verification reference has no supported current ProjectOverlay");
  if (reference.overlayBaseSha.toLowerCase() !== overlay.repository.baseSha.toLowerCase()) throw new Error("repository verification reference overlay base SHA is stale");
  const command = (overlay.verificationCommands ?? []).find((item) => item?.id === reference.commandId);
  if (!command) throw new Error(`repository verification reference command '${reference.commandId}' is unavailable`);
  return structuredClone({ schemaVersion: 1, source: "project_overlay", commandId: command.id, overlayBaseSha: overlay.repository.baseSha });
}

// Persisted overlays are untrusted input on resume.  Re-derive the immutable
// blueprint from controller configuration and check every adapter object and
// command instead of accepting a historic adapter name or executable path.
export function assertProjectOverlayAdapterIntegrity(overlay, { architectureBlueprint, projectMode } = {}) {
  if (!overlay || overlay.schemaVersion !== OVERLAY_VERSION) throw new Error("unsupported_stack:overlay_schema_invalid");
  const expected = validateArchitectureBlueprint(architectureBlueprint ?? overlay.architectureBlueprint, { projectMode: projectMode ?? architectureBlueprint?.projectMode ?? overlay.architectureBlueprint?.projectMode });
  if (!overlay.architectureBlueprint || overlay.architectureBlueprint.digest !== expected.digest || overlay.architectureBlueprint.registryVersion !== expected.registryVersion) throw new Error("unsupported_stack:overlay_architecture_blueprint_integrity_invalid");
  const legacyDiagnosticOnly = !expected.components.length;
  const actual = new Map((overlay.components ?? []).map((component) => [component.id, component]));
  if (actual.size !== expected.components.length) throw new Error("unsupported_stack:overlay_component_selection_mismatch");
  for (const component of expected.components) {
    const observed = actual.get(component.id);
    if (!observed || observed.root !== component.path || observed.adapter !== component.adapter.id || observed.adapterVersion !== component.adapter.version) throw new Error("unsupported_stack:overlay_component_selection_mismatch");
    for (const command of observed.verificationCommands ?? []) assertAdapterVerificationCommand(command, component);
  }
  for (const command of overlay.verificationCommands ?? []) {
    const component = expected.components.find((item) => item.id === command.component);
    if (!component && legacyDiagnosticOnly) continue;
    if (!component) throw new Error("unsupported_stack:overlay_verification_component_invalid");
    assertAdapterVerificationCommand(command, component);
  }
  return expected;
}
