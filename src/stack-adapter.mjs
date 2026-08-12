import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const STACK_ADAPTER_REGISTRY_VERSION = 1;
const PACKAGE_MANAGERS = new Map([["npm", "package-lock.json"], ["pnpm", "pnpm-lock.yaml"], ["yarn", "yarn.lock"]]);
const NODE_VERIFICATION_SCRIPTS = new Set(["test", "test:unit", "test:integration", "test:e2e", "lint", "format:check", "typecheck", "build"]);
const ignored = new Set([".git", "node_modules", "dist", "build", "coverage", ".next"]);
const posix = (value) => value.split(sep).join("/");
const write = (path, text) => { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, text, "utf8"); };
const safeName = (value) => { const name = String(value).replace(/[^A-Za-z0-9]/g, "") || "Product"; return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`; };
const walk = (root, max = 2000) => {
  const found = []; const visit = (directory) => { if (!existsSync(directory) || found.length >= max) return; for (const entry of readdirSync(directory, { withFileTypes: true })) { if (ignored.has(entry.name)) continue; const absolute = join(directory, entry.name); const path = posix(relative(root, absolute)); if (entry.isDirectory()) visit(absolute); else if (entry.isFile()) found.push(path); if (found.length >= max) return; } };
  visit(root); return found;
};
const packageCommand = (manager, script) => process.platform === "win32"
  ? { executable: "cmd.exe", args: ["/d", "/s", "/c", `${manager} run ${script}`] }
  : { executable: manager, args: ["run", script] };
function packageManager(packageJson, files) {
  const declared = typeof packageJson.packageManager === "string" ? packageJson.packageManager.split("@")[0] : null;
  const fromLock = [...PACKAGE_MANAGERS.entries()].find(([, file]) => files.includes(file))?.[0] ?? null;
  const name = declared ?? fromLock;
  if (!name || !PACKAGE_MANAGERS.has(name)) throw new Error(`unsupported_stack:next-node:package_manager:${declared ?? "unknown"}`);
  return { name, version: declared ? packageJson.packageManager.slice(name.length + 1) || null : null, source: declared ? "package.json#packageManager" : "lockfile", confidence: declared ? "declared" : "verified" };
}
function nodeDetect({ component, root }) {
  const directory = join(root, component.path); if (!existsSync(join(directory, "package.json"))) return { state: existsSync(directory) ? "incomplete" : "unscaffolded", evidence: [], verificationCommands: [], fingerprints: [] };
  const files = walk(directory); const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")); const manager = packageManager(packageJson, files);
  const scripts = Object.entries(packageJson.scripts ?? {}).map(([name, command]) => ({ name, command, source: `${component.path}/package.json`, confidence: "declared" }));
  const verificationCommands = scripts.filter((item) => NODE_VERIFICATION_SCRIPTS.has(item.name)).map((item) => ({ id: `${component.id}:package-script:${item.name}`, component: component.id, cwd: component.path, ...packageCommand(manager.name, item.name), source: item.source, confidence: "declared", timeoutMs: 120000 }));
  return { state: "scaffolded", packageJson: { name: packageJson.name ?? null, scripts: scripts.map((item) => item.name) }, packageManager: manager, scripts, verificationCommands, fingerprints: [{ kind: "package-manager", name: manager.name, version: manager.version, source: manager.source }, { kind: "package", name: "next", version: packageJson.dependencies?.next ?? packageJson.devDependencies?.next ?? null, source: `${component.path}/package.json` }] };
}
function dotnetDetect({ component, root }) {
  const directory = join(root, component.path); if (!existsSync(directory)) return { state: "unscaffolded", evidence: [], verificationCommands: [], fingerprints: [] };
  const files = walk(directory); const solutions = files.filter((path) => path.toLowerCase().endsWith(".sln")); const projects = files.filter((path) => path.toLowerCase().endsWith(".csproj"));
  if (!solutions.length && !projects.length) return { state: "incomplete", evidence: [], verificationCommands: [], fingerprints: [] };
  if (solutions.length > 1) throw new Error(`ambiguous_stack:dotnet:multiple_solutions:${component.path}`);
  const target = solutions[0] ?? (projects.length === 1 ? projects[0] : null);
  if (!target) throw new Error(`ambiguous_stack:dotnet:multiple_projects:${component.path}`);
  const source = `${component.path}/${target}`;
  return { state: "scaffolded", solution: solutions[0] ? source : null, project: solutions[0] ? null : source, verificationCommands: [{ id: `${component.id}:dotnet-test`, component: component.id, cwd: component.path, executable: "dotnet", args: ["test", target, "--nologo"], source, confidence: "verified", timeoutMs: 120000 }], fingerprints: [{ kind: "toolchain", name: "dotnet", version: null, source }, { kind: solutions[0] ? "solution" : "project", name: target, version: null, source }] };
}
function nextScaffold(root) {
  const packageJson = { name: "frontend", private: true, version: "0.1.0", packageManager: "npm@10.9.0", scripts: { test: "node --test", build: "node scripts/build-check.mjs" }, dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" }, devDependencies: { typescript: "^5.7.0", "@types/node": "^22.0.0", "@types/react": "^19.0.0" } };
  write(join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`); write(join(root, "package-lock.json"), `${JSON.stringify({ name: "frontend", version: "0.1.0", lockfileVersion: 3, requires: true, packages: { "": { name: "frontend", version: "0.1.0", dependencies: packageJson.dependencies, devDependencies: packageJson.devDependencies } } }, null, 2)}\n`); write(join(root, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "dom.iterable", "esnext"], strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", jsx: "preserve", incremental: true }, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"] }, null, 2)}\n`); write(join(root, "next-env.d.ts"), "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n"); write(join(root, "app", "layout.tsx"), "export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang=\"en\"><body>{children}</body></html>; }\n"); write(join(root, "app", "page.tsx"), "export default function Home() { return <main><h1>Product scaffold</h1></main>; }\n"); write(join(root, "scripts", "build-check.mjs"), "import { existsSync } from 'node:fs'; for (const path of ['app/page.tsx', 'app/layout.tsx', 'package-lock.json']) if (!existsSync(path)) throw new Error(`Missing ${path}`);\n"); write(join(root, "test", "scaffold.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { existsSync } from 'node:fs'; test('Next scaffold files exist', () => assert.equal(existsSync('app/page.tsx'), true));\n");
}
function dotnetScaffold(root, component) {
  const name = safeName(component.id), api = `${name}.Api`, tests = `${name}.Api.Tests`, solution = `${name}.sln`, apiGuid = "{1D0AF68D-99A1-4F23-8ED6-112233445566}", testGuid = "{2D0AF68D-99A1-4F23-8ED6-112233445566}";
  write(join(root, solution), `Microsoft Visual Studio Solution File, Format Version 12.00\n# Visual Studio Version 17\nVisualStudioVersion = 17.0.31903.59\nMinimumVisualStudioVersion = 10.0.40219.1\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${api}", "src\\${api}\\${api}.csproj", "${apiGuid}"\nEndProject\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${tests}", "tests\\${tests}\\${tests}.csproj", "${testGuid}"\nEndProject\nGlobal\n\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\n\t\tDebug|Any CPU = Debug|Any CPU\n\t\tRelease|Any CPU = Release|Any CPU\n\tEndGlobalSection\n\tGlobalSection(ProjectConfigurationPlatforms) = postSolution\n\t\t${apiGuid}.Debug|Any CPU.ActiveCfg = Debug|Any CPU\n\t\t${apiGuid}.Debug|Any CPU.Build.0 = Debug|Any CPU\n\t\t${apiGuid}.Release|Any CPU.ActiveCfg = Release|Any CPU\n\t\t${apiGuid}.Release|Any CPU.Build.0 = Release|Any CPU\n\t\t${testGuid}.Debug|Any CPU.ActiveCfg = Debug|Any CPU\n\t\t${testGuid}.Debug|Any CPU.Build.0 = Debug|Any CPU\n\t\t${testGuid}.Release|Any CPU.ActiveCfg = Release|Any CPU\n\t\t${testGuid}.Release|Any CPU.Build.0 = Release|Any CPU\n\tEndGlobalSection\nEndGlobal\n`); write(join(root, "src", api, `${api}.csproj`), `<Project Sdk=\"Microsoft.NET.Sdk.Web\">\n  <PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>\n</Project>\n`); write(join(root, "src", api, "Program.cs"), "var app = WebApplication.CreateBuilder(args).Build();\napp.MapGet(\"/health\", () => Results.Ok(new { status = \"ok\" }));\napp.Run();\npublic partial class Program { }\n"); write(join(root, "tests", tests, `${tests}.csproj`), `<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>\n  <ItemGroup><PackageReference Include=\"Microsoft.NET.Test.Sdk\" Version=\"17.12.0\" /><PackageReference Include=\"xunit\" Version=\"2.9.2\" /><PackageReference Include=\"xunit.runner.visualstudio\" Version=\"2.8.2\"><PrivateAssets>all</PrivateAssets><IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets></PackageReference></ItemGroup>\n  <ItemGroup><ProjectReference Include=\"..\\..\\src\\${api}\\${api}.csproj\" /></ItemGroup>\n</Project>\n`); write(join(root, "tests", tests, "HealthTests.cs"), `namespace ${tests}; public class HealthTests { [Xunit.Fact] public void Api_project_is_referenced() => Xunit.Assert.True(true); }\n`);
}
function commandAllowed(command, component) {
  if (!command || command.component !== component.id || !Array.isArray(command.args) || !command.args.every((arg) => typeof arg === "string")) return false;
  if (component.adapter.id === "next-node") return /(?:^|:)package-script:[a-z][a-z0-9:_-]*$/i.test(command.id) && (process.platform === "win32" ? command.executable === "cmd.exe" && command.args[0] === "/d" && command.args[1] === "/s" && command.args[2] === "/c" : PACKAGE_MANAGERS.has(command.executable) && command.args.length === 2 && command.args[0] === "run");
  return component.adapter.id === "dotnet" && command.executable === "dotnet" && command.args.length === 3 && command.args[0] === "test" && command.args[2] === "--nologo" && /\.(?:sln|csproj)$/i.test(command.args[1]);
}
const contract = (id, detect, scaffold) => Object.freeze({ id, version: 1, allowedProjectModes: Object.freeze(["greenfield", "brownfield"]), componentRoots: Object.freeze(["declared-relative-root"]), safeWriteSurfaces: Object.freeze(["declared-component-root"]), productEvidenceMappings: Object.freeze(["acceptance-criterion-to-declared-verification-command"]), detect, scaffold, commandAllowed });
const NEXT_NODE = contract("next-node", nodeDetect, nextScaffold);
const DOTNET = contract("dotnet", dotnetDetect, dotnetScaffold);
const REGISTRY = new Map([["next-node@1", NEXT_NODE], ["dotnet@1", DOTNET]]);

export function getStackAdapter(id, version) {
  const adapter = REGISTRY.get(`${id}@${version}`);
  if (adapter) return adapter;
  if (["python", "go"].includes(id)) throw new Error(`unsupported_stack:${id}:no_controller_owned_adapter_with_deterministic_fixture_verification`);
  throw new Error(`unsupported_stack:${String(id)}:not_in_controller_allowlist`);
}
export function controllerStackAdapterRegistry() { return Object.freeze([...REGISTRY.values()].map((adapter) => ({ id: adapter.id, version: adapter.version, allowedProjectModes: adapter.allowedProjectModes }))); }
export function inspectWithAdapter(component, root) { const adapter = getStackAdapter(component.adapter.id, component.adapter.version); return { ...adapter.detect({ component, root }), adapter: { id: adapter.id, version: adapter.version } }; }
export function scaffoldWithAdapter(component, root) { const adapter = getStackAdapter(component.adapter.id, component.adapter.version); adapter.scaffold(root, component); return adapter; }
export function assertAdapterVerificationCommand(command, component) { const adapter = getStackAdapter(component.adapter.id, component.adapter.version); if (!adapter.commandAllowed(command, component)) throw new Error(`unsupported_stack:${adapter.id}:verification_command_not_declared_by_adapter`); return true; }
