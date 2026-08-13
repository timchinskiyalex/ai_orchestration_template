import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runThinAcceptance } from "../src/thin/acceptance.mjs";
import { createIsolatedWorktree, removeIsolatedWorktree } from "../src/thin/git-worktree.mjs";
import { runThinRepair } from "../src/thin/repair.mjs";
import { runThinAppServerWorker } from "../src/thin/app-server-worker.mjs";
import { finalizeWorkerArtifact } from "../src/thin/finalizer.mjs";
import { AppServerClient } from "../src/app-server-client.mjs";
import { finalAgentText, readMarkdownPackage, runVerification } from "./thin-deliver.mjs";

const exec = promisify(execFile);

export function parseThinAcceptArgs(argv) {
  const options = { repo: process.cwd(), docs: null, candidate: null, verify: null, repairSurface: null, confirm: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--confirm-spend-quota") options.confirm = true;
    else if (["--repo", "--docs", "--candidate", "--verify", "--repair-surface"].includes(value)) {
      const argument = argv[++index]; if (!argument) throw new Error(`${value} requires a value`);
      if (value === "--repo") options.repo = argument;
      if (value === "--docs") options.docs = argument;
      if (value === "--candidate") options.candidate = argument;
      if (value === "--verify") options.verify = argument;
      if (value === "--repair-surface") options.repairSurface = [...new Set(argument.split(",").map((part) => part.trim()).filter(Boolean))];
    } else throw new Error(`unknown option: ${value}`);
  }
  return options;
}

export const thinAcceptUsage = () => "Usage: node scripts/thin-accept.mjs --repo <git-repo> --docs <Markdown file-or-directory> --candidate <SHA> --verify <command> --repair-surface <path,path> --confirm-spend-quota";

export async function runThinAccept({ argv = process.argv.slice(2), stdout = console.log, stderr = console.error } = {}) {
  let options;
  try { options = parseThinAcceptArgs(argv); } catch (error) { stderr(`[failure] stage=argument code=invalid_arguments message=${safe(error.message)}`); return 2; }
  if (options.help) { stdout(thinAcceptUsage()); return 0; }
  if (!options.confirm) { stderr("[failure] stage=admission code=quota_confirmation_required"); return 2; }
  if (![options.docs, options.candidate, options.verify, options.repairSurface?.length].every(Boolean)) { stderr("[failure] stage=argument code=docs_candidate_verify_and_repair_surface_required"); return 2; }
  if (!/^[0-9a-f]{7,64}$/i.test(options.candidate)) { stderr("[failure] stage=argument code=candidate_sha_invalid"); return 2; }

  const repository = resolve(options.repo); const markdown = readMarkdownPackage(options.docs);
  const runtimeDir = mkdtempSync(join(tmpdir(), "thin-acceptance-"));
  let isolated = null; let result = null;
  const writeReport = (report) => { const path = join(runtimeDir, "acceptance-report.json"); writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`); stdout(`[acceptance] report ${path}`); return path; };
  try {
    isolated = await createIsolatedWorktree({ repository, runtimeDir, taskId: "acceptance", baseSha: options.candidate });
    const assertAuditClean = async () => {
      const { stdout: status } = await exec("git", ["-C", isolated.worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer" });
      if (status.length) throw new Error("acceptance audit modified the candidate worktree");
    };
    const audit = async ({ prompt }) => {
      await assertAuditClean();
      const text = await runSemanticAuditTurn({ cwd: isolated.worktree, prompt, stdout, label: "acceptance" });
      await assertAuditClean();
      return text;
    };
    const verify = () => runVerification({ worktree: isolated.worktree, command: options.verify });
    const repair = ({ candidateSha, failureOutput, attempts }) => runThinRepair({
      candidateSha, verificationFailure: failureOutput, attempts, repairSurface: options.repairSurface, previousWaveTaskScopes: [],
      planRepair: async ({ verificationFailure, repairSurface }) => JSON.parse(await runSemanticAuditTurn({ cwd: isolated.worktree, label: "acceptance-repair", stdout, prompt: repairPrompt({ verificationFailure, repairSurface }) })),
      executeRepair: async ({ candidateSha: baseSha, repairPlan }) => {
        await runThinAppServerWorker({ cwd: isolated.worktree, taskKey: "acceptance-repair-1", prompt: repairPlan.prompt, allowedPaths: repairPlan.allowedPaths, onEvent: (event) => { if (event.kind === "started" || event.kind === "completed") stdout(`[repair] ${event.kind}`); } });
        return finalizeWorkerArtifact({ taskId: "acceptance-repair-1", worktree: isolated.worktree, baseSha, allowedPaths: repairPlan.allowedPaths });
      },
    }).then((repairResult) => repairResult.ok ? { ok: true, candidateSha: repairResult.artifact.commitSha, attempts: repairResult.attempts } : repairResult);
    result = await runThinAcceptance({ markdown, candidateSha: isolated.baseSha, audit, verify, repair, onEvent: (event) => { if (event.type === "audit_started") stdout(`[acceptance] audit ${event.phase} started`); if (event.type === "audit_completed") stdout(`[acceptance] audit ${event.phase} ${event.passing ? "passed" : "gaps"}`); if (event.type === "verification_completed") stdout(`[acceptance] verification ${event.phase} passed`); } });
    writeReport(result.report);
    if (!result.ok) { stdout(`[failure] stage=acceptance code=${result.code} recovery=${isolated.worktree}`); return 1; }
    stdout(`[completed] accepted candidate ${result.candidateSha}`);
    return 0;
  } catch (error) {
    writeReport({ schemaVersion: 1, kind: "ThinAcceptanceReport", state: "blocked", code: "acceptance_runtime_failed", detail: safe(error?.message) });
    stderr(`[failure] stage=acceptance code=acceptance_runtime_failed recovery=${isolated?.worktree ?? runtimeDir} message=${safe(error?.message)}`);
    return 1;
  } finally {
    if (result?.ok && isolated) await removeIsolatedWorktree(isolated);
    else stdout(`[recovery] acceptance runtime preserved ${runtimeDir}`);
  }
}

function repairPrompt({ verificationFailure, repairSurface }) {
  return [
    "You are the repair planner for exactly one acceptance failure.",
    "Return exactly JSON, no Markdown: {\"title\":\"...\",\"prompt\":\"...\",\"allowedPaths\":[\"relative/path\"]}.",
    "Use only these controller-authorized repair surfaces:", ...repairSurface.map((path) => `- ${path}`),
    "Do not propose Git operations or edit paths outside the surface.",
    "Failure evidence:", verificationFailure,
  ].join("\n");
}

async function runSemanticAuditTurn({ cwd, prompt, stdout, label }) {
  const client = new AppServerClient({ cwd, serviceName: "thin-acceptance-auditor" });
  const activity = (message) => { if (["item/started", "item/completed", "thread/tokenUsage/updated"].includes(message?.method)) stdout(`[${label}] activity`); };
  client.on("notification", activity);
  try {
    await client.connect();
    const thread = await client.startThread({ cwd }); const threadId = thread?.thread?.id ?? thread?.threadId;
    if (!threadId) throw new Error("acceptance audit thread ID unavailable");
    await client.setGoal({ threadId, objective: "Return only requested semantic JSON; do not modify the repository.", status: "active" });
    const turn = await client.startTurn({ threadId, input: [{ type: "text", text: prompt }] }); const turnId = turn?.turn?.id ?? turn?.turnId;
    if (!turnId) throw new Error("acceptance audit turn ID unavailable");
    const terminal = await client.waitForTurn(threadId, turnId, 600_000);
    if (terminal?.status !== "completed") throw new Error(`acceptance audit terminal status is '${terminal?.status ?? "unknown"}'`);
    const read = await client.readThread({ threadId, includeTurns: true }); const text = finalAgentText(read, terminal?.id ?? turnId);
    if (!text) throw new Error("acceptance audit final result unavailable");
    return text;
  } finally { client.off("notification", activity); await client.shutdown().catch(() => {}); }
}
function safe(value) { return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 500); }

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await runThinAccept({});
