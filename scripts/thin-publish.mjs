import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { publishThinCandidate, readThinAcceptanceReport } from "../src/thin/github-publication.mjs";

export const thinPublishUsage = () => "Usage: node scripts/thin-publish.mjs --repo <git-repo> --runtime <runtime-dir> --acceptance-report <ThinAcceptanceReport.json> --remote-name <allowlisted-remote> --branch <candidate-branch> --base <base-branch> --required-check <CI-context> [--required-check <CI-context> ...] --confirm-remote-publication [--auto-merge]";

export function parseThinPublishArgs(argv) {
  const options = { repo: process.cwd(), runtime: null, acceptanceReport: null, remoteName: null, branch: null, base: null, requiredChecks: [], confirm: false, autoMerge: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--confirm-remote-publication") options.confirm = true;
    else if (flag === "--auto-merge") options.autoMerge = true;
    else if (["--repo", "--runtime", "--acceptance-report", "--remote-name", "--branch", "--base", "--required-check"].includes(flag)) {
      const value = argv[++index]; if (typeof value !== "string" || !value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--repo") options.repo = value;
      else if (flag === "--runtime") options.runtime = value;
      else if (flag === "--acceptance-report") options.acceptanceReport = value;
      else if (flag === "--remote-name") options.remoteName = value;
      else if (flag === "--branch") options.branch = value;
      else if (flag === "--base") options.base = value;
      else options.requiredChecks.push(value);
    } else throw new Error(`unknown option: ${flag}`);
  }
  return options;
}

export async function runThinPublish({ argv = process.argv.slice(2), stdout = console.log, stderr = console.error, publish = publishThinCandidate } = {}) {
  let options;
  try { options = parseThinPublishArgs(argv); }
  catch (error) { stderr(`[failure] code=invalid_arguments message=${safe(error.message)}`); return 2; }
  if (options.help) { stdout(thinPublishUsage()); return 0; }
  if (!options.confirm) { stderr("[failure] code=remote_confirmation_required message=Pass --confirm-remote-publication to permit push/PR/CI operations."); return 2; }
  try {
    const acceptance = readThinAcceptanceReport(options.acceptanceReport);
    const result = await publish({
      repository: resolve(options.repo), runtimeDir: resolve(options.runtime), acceptance,
      remoteName: options.remoteName, allowedRemotes: [options.remoteName], branch: options.branch, base: options.base,
      requiredCiContexts: [...new Set(options.requiredChecks)], autoMerge: options.autoMerge,
      onEvent: (event) => stdout(`[publication] ${event.type}`),
    });
    if (result.ok) stdout(`[completed] state=${result.state} candidate=${result.candidate.sha}`);
    else stderr(`[blocked] state=${result.state} code=${result.code} candidate=${result.candidate?.sha ?? "-"} recovery=${result.statePath ?? "-"}`);
    return result.ok ? 0 : 1;
  } catch (error) { stderr(`[failure] code=publication_invalid message=${safe(error.message)}`); return 2; }
}
function safe(value) { return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 500); }
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await runThinPublish({});
