import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const MAX_FINDINGS = 50;
const MAX_TEXT = 2_000;

/**
 * Controller-owned dependency scanner. It never evaluates verification text
 * in a shell: it only recognizes a small, documented set of product roots
 * and invokes fixed executable/argument arrays.
 */
export async function scanThinCandidateSecurity({
  worktree,
  candidateSha,
  verificationCommand = "",
  productRoots = [],
  processRunner = defaultProcessRunner,
} = {}) {
  if (!isGitSha(candidateSha)) throw new TypeError("candidateSha must be a Git SHA");
  const root = resolveRequiredDirectory(worktree, "worktree");
  if (typeof verificationCommand !== "string") throw new TypeError("verificationCommand must be a string");
  if (!Array.isArray(productRoots)) throw new TypeError("productRoots must be an array");
  if (typeof processRunner !== "function") throw new TypeError("processRunner must be a function");

  const discovered = discoverThinSecurityTargets({ verificationCommand, productRoots });
  const scans = [];
  for (const target of discovered) {
    const absolute = resolveInside(root, target.root);
    if (!existsSync(absolute)) {
      scans.push(unavailableScan(target, "root_missing"));
      continue;
    }
    scans.push(target.ecosystem === "npm"
      ? await scanNpm({ target, cwd: absolute, processRunner })
      : await scanDotnet({ target, cwd: root, processRunner }));
  }
  const blocking = scans.flatMap((scan) => scan.findings).filter((finding) => BLOCKING_SEVERITIES.has(finding.severity));
  const unavailable = scans.filter((scan) => scan.state === "unavailable");
  const state = unavailable.length ? "scan_unavailable" : blocking.length ? "blocked_security" : "passed";
  return Object.freeze({
    schemaVersion: 1,
    kind: "ThinSecurityScanReport",
    candidateSha: candidateSha.toLowerCase(),
    state,
    policy: Object.freeze({ blockSeverities: ["high", "critical"] }),
    summary: Object.freeze({ targetCount: scans.length, blockingFindingCount: blocking.length, unavailableTargetCount: unavailable.length }),
    scans: Object.freeze(scans),
  });
}

/** Safe, lexical discovery only. No command is executed or expanded here. */
export function discoverThinSecurityTargets({ verificationCommand = "", productRoots = [] } = {}) {
  if (typeof verificationCommand !== "string" || !Array.isArray(productRoots)) throw new TypeError("invalid security target inputs");
  const found = new Map();
  const add = (ecosystem, root) => {
    const normalized = normalizeRelativeRoot(root);
    const key = `${ecosystem}:${normalized}`;
    if (!found.has(key)) found.set(key, Object.freeze({ ecosystem, root: normalized }));
  };
  for (const token of productRoots) {
    if (typeof token === "string") add(inferEcosystem(token), token);
    else if (token && typeof token === "object" && typeof token.root === "string") add(token.ecosystem ?? inferEcosystem(token.root), token.root);
    else throw new TypeError("productRoots entries must be paths or { ecosystem, root }");
  }
  const tokens = tokenizeKnownCommand(verificationCommand);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "npm" && tokens[index + 1] === "--prefix" && tokens[index + 2]) add("npm", tokens[index + 2]);
    if (tokens[index] === "dotnet" && ["test", "build", "run", "publish"].includes(tokens[index + 1]) && tokens[index + 2] && !tokens[index + 2].startsWith("-")) add("dotnet", tokens[index + 2]);
  }
  return [...found.values()].sort((left, right) => `${left.ecosystem}:${left.root}`.localeCompare(`${right.ecosystem}:${right.root}`));
}

async function scanNpm({ target, cwd, processRunner }) {
  try {
    const result = await processRunner({ executable: process.platform === "win32" ? "npm.cmd" : "npm", args: ["audit", "--json"], cwd, timeout: 120_000 });
    return parseNpmAudit(target, result?.stdout ?? "");
  } catch (error) {
    return unavailableScan(target, errorCode(error));
  }
}

function parseNpmAudit(target, stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout)); }
  catch { return unavailableScan(target, "malformed_npm_audit_json"); }
  if (!isPlainObject(parsed) || (!isPlainObject(parsed.metadata) && !isPlainObject(parsed.vulnerabilities))) return unavailableScan(target, "malformed_npm_audit_json");
  const findings = [];
  for (const [name, row] of Object.entries(parsed.vulnerabilities ?? {})) {
    const severity = normalizeSeverity(row?.severity);
    if (!severity) continue;
    findings.push(safeFinding({ packageName: name, severity, source: "npm_audit" }));
  }
  return completedScan(target, findings);
}

async function scanDotnet({ target, cwd, processRunner }) {
  const modern = ["list", target.root, "package", "--vulnerable", "--include-transitive", "--format", "json"];
  try {
    const result = await processRunner({ executable: "dotnet", args: modern, cwd, timeout: 120_000 });
    const parsed = parseDotnetJson(target, result?.stdout ?? "");
    if (parsed) return parsed;
  } catch (error) {
    if (!isDotnetFormatFallback(error)) return unavailableScan(target, errorCode(error));
  }
  try {
    const result = await processRunner({ executable: "dotnet", args: ["list", target.root, "package", "--vulnerable", "--include-transitive"], cwd, timeout: 120_000 });
    return parseDotnetText(target, result?.stdout ?? "");
  } catch (error) {
    return unavailableScan(target, errorCode(error));
  }
}

function parseDotnetJson(target, stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout)); } catch { return null; }
  if (!isPlainObject(parsed)) return null;
  const findings = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isPlainObject(value)) return;
    if (typeof value.id === "string" && Array.isArray(value.vulnerabilities)) {
      for (const vulnerability of value.vulnerabilities) {
        const severity = normalizeSeverity(vulnerability?.severity ?? vulnerability?.severityLevel);
        if (severity) findings.push(safeFinding({ packageName: value.id, severity, advisory: vulnerability?.advisoryurl ?? vulnerability?.advisoryUrl, source: "dotnet_list" }));
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(parsed);
  return completedScan(target, findings);
}

function parseDotnetText(target, stdout) {
  const findings = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /^\s*>?\s*([A-Za-z0-9_.-]+)\s+[0-9][^\s]*.*\b(low|moderate|medium|high|critical)\b/i.exec(line);
    if (match) findings.push(safeFinding({ packageName: match[1], severity: normalizeSeverity(match[2]), source: "dotnet_list_fallback" }));
  }
  return completedScan(target, findings);
}

function completedScan(target, findings) {
  const bounded = findings.slice(0, MAX_FINDINGS);
  return Object.freeze({ ecosystem: target.ecosystem, root: target.root, state: "completed", findingCount: findings.length, findings: Object.freeze(bounded), truncated: findings.length > bounded.length });
}
function unavailableScan(target, reasonCode) {
  return Object.freeze({ ecosystem: target.ecosystem, root: target.root, state: "unavailable", reasonCode: String(reasonCode).replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "scan_unavailable", findingCount: 0, findings: Object.freeze([]), truncated: false });
}
function safeFinding({ packageName, severity, advisory = null, source }) {
  return Object.freeze({ packageName: String(packageName).replace(/[^A-Za-z0-9_.@/-]/g, "_").slice(0, 200), severity, advisory: typeof advisory === "string" ? advisory.replace(/[^A-Za-z0-9:/.?=_-]/g, "").slice(0, 300) : null, source });
}
function normalizeSeverity(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "medium") return "moderate";
  return ["low", "moderate", "high", "critical"].includes(normalized) ? normalized : null;
}
function tokenizeKnownCommand(command) {
  // Lexing is deliberately minimal: quoted literals and ordinary whitespace;
  // control operators become separators and are never interpreted.
  return String(command).match(/(?:"[^"]*"|'[^']*'|[^\s;&|]+)+/g)?.map((token) => token.replace(/^(?:"|')|(?:"|')$/g, "")) ?? [];
}
function inferEcosystem(root) {
  return /\.(?:sln|csproj|fsproj)$/i.test(root) ? "dotnet" : "npm";
}
function normalizeRelativeRoot(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("security scan roots must be normalized relative paths");
  return value;
}
function resolveInside(root, path) {
  const absolute = resolve(root, path); const delta = relative(root, absolute);
  if (delta === "" || delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("security scan root escapes worktree");
  return absolute;
}
function resolveRequiredDirectory(value, label) {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} is required`);
  return resolve(value);
}
function isDotnetFormatFallback(error) { return /format|unrecognized|unknown option|invalid option/i.test(`${error?.message ?? ""} ${error?.stderr ?? ""}`); }
function errorCode(error) { return /ENOENT|not recognized|not found/i.test(`${error?.code ?? ""} ${error?.message ?? ""}`) ? "tool_unavailable" : "scan_command_failed"; }
function isGitSha(value) { return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value); }
function isPlainObject(value) { return value != null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
async function defaultProcessRunner({ executable, args, cwd, timeout }) { return exec(executable, args, { cwd, encoding: "utf8", timeout }); }
