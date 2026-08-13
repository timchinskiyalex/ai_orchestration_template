import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createIsolatedWorktree, removeIsolatedWorktree } from "../src/thin/git-worktree.mjs";
import { scanThinCandidateSecurity } from "../src/thin/security-scan.mjs";

export function parseThinSecurityArgs(argv) {
  const options = { repo: process.cwd(), candidate: null, verify: null, roots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--root") options.roots.push(requireValue(argv[++index], flag));
    else if (["--repo", "--candidate", "--verify"].includes(flag)) options[flag.slice(2)] = requireValue(argv[++index], flag);
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  return options;
}
export function thinSecurityUsage() { return "Usage: node scripts/thin-security.mjs --repo <git-repo> --candidate <sha> --verify <command> [--root <relative-product-root>]"; }

export async function runThinSecurity({ argv = process.argv.slice(2), stdout = console.log, stderr = console.error, dependencies = {} } = {}) {
  let options;
  try { options = parseThinSecurityArgs(argv); } catch (error) { stderr(`[failure] stage=security code=invalid_arguments message=${safe(error.message)}`); return 2; }
  if (options.help) { stdout(thinSecurityUsage()); return 0; }
  if (!options.candidate || !options.verify) { stderr("[failure] stage=security code=candidate_and_verify_required"); return 2; }
  const repository = resolve(options.repo); const runtimeDir = dependencies.createRuntimeDir?.() ?? mkdtempSync(join(tmpdir(), "thin-security-"));
  let isolated; let cleanup = false;
  try {
    isolated = await (dependencies.createIsolatedWorktree ?? createIsolatedWorktree)({ repository, runtimeDir, taskId: `security-${options.candidate.slice(0, 12)}`, baseSha: options.candidate });
    stdout(`[security] started candidate=${isolated.baseSha}`);
    const report = await (dependencies.scan ?? scanThinCandidateSecurity)({ worktree: isolated.worktree, candidateSha: isolated.baseSha, verificationCommand: options.verify, productRoots: options.roots, processRunner: dependencies.processRunner });
    const reportPath = join(runtimeDir, "security-report.json"); writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    stdout(`[security] report ${reportPath}`);
    if (report.state !== "passed") { stdout(`[failure] stage=security code=${report.state} recovery=${isolated.worktree}`); return 1; }
    cleanup = true; stdout(`[security] passed candidate=${report.candidateSha}`); return 0;
  } catch (error) { stderr(`[failure] stage=security code=security_runtime_failed recovery=${isolated?.worktree ?? runtimeDir} message=${safe(error.message)}`); return 1; }
  finally { if (cleanup && isolated) await (dependencies.removeIsolatedWorktree ?? removeIsolatedWorktree)(isolated); if (cleanup) rmSync(runtimeDir, { recursive: true, force: true }); else stdout(`[recovery] security runtime preserved ${runtimeDir}`); }
}
function requireValue(value, flag) { if (typeof value !== "string" || !value || value.startsWith("--")) throw new Error(`${flag} requires a value`); return value; }
function safe(value) { return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 500); }
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await runThinSecurity({});
