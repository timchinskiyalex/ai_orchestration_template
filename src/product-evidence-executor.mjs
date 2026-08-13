import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { assertProjectOverlayAdapterIntegrity, commandCwd, loadProjectOverlay, validateRepositoryVerificationReference } from "./project-overlay.mjs";
import { assertAdapterVerificationCommand } from "./stack-adapter.mjs";
import { deriveParallelReadinessEvidence } from "./controller-verification.mjs";

const SHA = /^[a-f0-9]{40,64}$/i;
const stable = (value) => typeof value === "string" && value.trim().length > 0;
const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const posix = (value) => value.split(sep).join("/");
const safeOutputDigest = (result) => digest(`${String(result?.stdout ?? "")}\n${String(result?.stderr ?? "")}`);

function assertCandidate(candidate, integration) {
  if (!candidate || !SHA.test(candidate.sha ?? "") || candidate.sha.toLowerCase() !== integration.candidateSha?.toLowerCase()) throw new Error("Product evidence candidate SHA does not match the integration manifest");
  if (!stable(candidate.branch) || candidate.branch !== integration.branch) throw new Error("Product evidence candidate branch does not match the integration manifest");
  if (!stable(integration.worktree)) throw new Error("Product evidence integration worktree is missing");
}

function exactCandidateWorktree(worktree, candidate) {
  const cwd = resolve(worktree);
  const topLevel = resolve(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  const [head, branch, dirty] = [
    execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" }).trim(),
    execFileSync("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8" })
  ];
  if (topLevel !== cwd || head.toLowerCase() !== candidate.sha.toLowerCase() || branch !== candidate.branch || dirty) throw new Error("Product evidence must run from the clean exact candidate integration worktree and SHA");
  return cwd;
}

function allowedCommand(command, overlay, architectureBlueprint = null, projectMode = null) {
  if (!command || !stable(command.id) || !stable(command.executable) || !Array.isArray(command.args) || !command.args.every((arg) => typeof arg === "string")) return false;
  let blueprint;
  try { blueprint = assertProjectOverlayAdapterIntegrity(overlay, { architectureBlueprint, projectMode }); }
  catch { return false; }
  // Pre-Stage-07 programmatic fixtures have no configured product roots or
  // versioned ProjectMode. They remain a read-compatible generic Node seam;
  // config-loaded and persisted deliveries always carry an admitted blueprint.
  if (!blueprint.components.length) {
    const match = command.id.match(/(?:^|:)package-script:([a-z][a-z0-9:_-]*)$/i);
    if (!match) return false;
    return process.platform === "win32"
      ? command.executable.toLowerCase().endsWith("cmd.exe") && JSON.stringify(command.args) === JSON.stringify(["/d", "/s", "/c", `${overlay.stack?.packageManager?.name ?? "npm"} run ${match[1]}`])
      : ["npm", "pnpm", "yarn"].includes(command.executable) && JSON.stringify(command.args) === JSON.stringify(["run", match[1]]);
  }
  if (!(overlay.verificationCommands ?? []).some((item) => item.id === command.id && item.executable === command.executable && JSON.stringify(item.args) === JSON.stringify(command.args) && item.cwd === command.cwd)) return false;
  const component = blueprint.components.find((item) => item.id === command.component);
  if (!component) return false;
  try { return assertAdapterVerificationCommand(command, component); }
  catch { return false; }
}

// This is deliberately a controller-generated contract.  It contains no worker
// text and turns the selected stack adapter's command objects into one explicit
// criterion mapping per acceptance criterion.
export function generateVerificationManifest({ overlay, blueprint, integration, architectureBlueprint = null, projectMode = null }) {
  if (!overlay || overlay.schemaVersion !== 1 || !blueprint?.blueprintId || !SHA.test(integration?.candidateSha ?? "") || !stable(integration?.id)) throw new Error("VerificationManifest requires a supported ProjectOverlay, blueprint, and candidate integration manifest");
  const criteria = blueprint.requirements.flatMap((requirement) => (requirement.acceptanceCriteria ?? []).map((criterion) => ({ requirementId: requirement.requirementId, criterionId: criterion.criterionId, repositoryVerification: criterion.repositoryVerification, controllerExecution: criterion.controllerExecution })));
  const declared = new Map((overlay.verificationCommands ?? []).map((command) => [command.id, command]));
  const references = criteria.map((criterion) => criterion.repositoryVerification === undefined ? null : (() => { try { return validateRepositoryVerificationReference(criterion.repositoryVerification, overlay); } catch (error) { throw new Error(`VerificationManifest criterion '${criterion.requirementId}:${criterion.criterionId}' ${error.message}`); } })());
  const commands = [...new Map(references.filter(Boolean).map((reference) => [reference.commandId, declared.get(reference.commandId)])).values()];
  if (!criteria.length || criteria.some((criterion) => Number(Boolean(criterion.repositoryVerification)) + Number(Boolean(criterion.controllerExecution)) !== 1) || commands.some((command) => !allowedCommand(command, overlay, architectureBlueprint, projectMode))) throw new Error("VerificationManifest has an invalid criterion verification mapping");
  const seenCommands = new Set();
  if (commands.some((command) => seenCommands.has(command.id) || !seenCommands.add(command.id))) throw new Error("VerificationManifest contains duplicate command ids");
  const mappings = criteria.map((criterion, index) => {
    const reference = references[index];
    if (criterion.controllerExecution) return { requirementId: criterion.requirementId, criterionId: criterion.criterionId, verificationKind: "controller_execution", controllerExecution: structuredClone(criterion.controllerExecution), testId: `controller/${criterion.controllerExecution.capabilityId}/v${criterion.controllerExecution.capabilityVersion}/${criterion.requirementId}/${criterion.criterionId}` };
    const command = declared.get(reference.commandId);
    return { requirementId: criterion.requirementId, criterionId: criterion.criterionId, verificationKind: "repository_command", repositoryVerification: reference, commandId: command.id, testId: `product/${command.id}/${criterion.requirementId}/${criterion.criterionId}` };
  });
  const seenMappings = new Set();
  if (mappings.some((mapping) => seenMappings.has(`${mapping.requirementId}:${mapping.criterionId}`) || !seenMappings.add(`${mapping.requirementId}:${mapping.criterionId}`))) throw new Error("VerificationManifest contains duplicate criterion mappings");
  const immutable = { schemaVersion: 2, kind: "VerificationManifest", integrationManifestId: integration.id, candidateSha: integration.candidateSha, blueprintId: blueprint.blueprintId, commands: commands.map(({ id, component, cwd, executable, args, timeoutMs }) => ({ id, component: component ?? null, cwd: cwd ?? ".", executable, args, timeoutMs: timeoutMs ?? 120000 })), mappings };
  return { ...immutable, id: `verification:${digest(immutable)}`, digest: digest(immutable) };
}

export class ProductEvidenceExecutor {
  constructor(router) { this.router = router; }

  async verify({ candidate, manifest: integration, deliveryRunId }) {
    try {
      assertCandidate(candidate, integration);
      const run = this.router.store.deliveryRun(deliveryRunId);
      const stored = run?.blueprintId ? this.router.store.productBlueprint(run.blueprintId) : null;
      if (!run || !stored) throw new Error("Product evidence requires the persisted delivery run and blueprint");
      const { overlay } = loadProjectOverlay(this.router.config.repository, this.router.config.project.generatedDir);
      const verification = generateVerificationManifest({ overlay, blueprint: stored.blueprint, integration, architectureBlueprint: this.router.architectureBlueprint, projectMode: this.router.projectMode });
      const worktree = exactCandidateWorktree(integration.worktree, candidate);
      const identity = { deliveryRunId, integrationManifestId: integration.id, candidateSha: candidate.sha, blueprintId: stored.blueprint.blueprintId, blueprintDigest: stored.digest, verificationManifestId: verification.id, verificationManifestDigest: verification.digest, worktree };
      const prior = this.router.store.productEvidenceExecutionForIdentity(identity);
      if (prior?.success) return prior.record.evidence;

      const byCommand = new Map(verification.commands.map((command) => [command.id, command]));
      const commandResults = [];
      for (const commandId of [...new Set(verification.mappings.map((mapping) => mapping.commandId).filter(Boolean))]) {
        const command = byCommand.get(commandId); const startedAt = new Date().toISOString(); const start = Date.now();
        try {
          const output = await this.router.processRunner({ executable: command.executable, args: command.args, cwd: commandCwd(worktree, command), timeoutMs: command.timeoutMs });
          if (output?.code !== undefined && output.code !== 0) throw Object.assign(new Error(`Allowlisted verification command failed with exit ${output.code}`), output);
          commandResults.push({ commandId, commandDigest: digest(command), component: command.component, cwd: posix(relative(worktree, commandCwd(worktree, command)) || "."), timeoutMs: command.timeoutMs, exitStatus: 0, outputDigest: safeOutputDigest(output), outputReference: `sha256:${safeOutputDigest(output)}`, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - start, candidateSha: candidate.sha, result: "pass" });
        } catch (error) {
          const output = { stdout: error?.stdout, stderr: error?.stderr };
          commandResults.push({ commandId, commandDigest: digest(command), component: command.component, cwd: posix(relative(worktree, commandCwd(worktree, command)) || "."), timeoutMs: command.timeoutMs, exitStatus: Number.isInteger(error?.code) ? error.code : null, outputDigest: safeOutputDigest(output), outputReference: `sha256:${safeOutputDigest(output)}`, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - start, candidateSha: candidate.sha, result: "failed" });
        }
      }
      const resultFor = new Map(commandResults.map((item) => [item.commandId, item]));
      const id = `product-evidence:${digest(identity)}`;
      const evidence = { candidateSha: candidate.sha, results: verification.mappings.map((mapping) => mapping.verificationKind === "controller_execution"
        ? deriveParallelReadinessEvidence({ store: this.router.store, deliveryRunId, blueprintId: stored.blueprint.blueprintId, requirementId: mapping.requirementId, criterionId: mapping.criterionId, reference: mapping.controllerExecution, candidateSha: candidate.sha })
        : ({ requirementId: mapping.requirementId, criterionId: mapping.criterionId, verificationKind: "repository_command", testId: mapping.testId, reference: `${id}:${mapping.testId}`, candidateSha: candidate.sha, status: resultFor.get(mapping.commandId)?.result === "pass" ? "pass" : "failed" })) };
      const persistedManifest = {
        schemaVersion: verification.schemaVersion, kind: verification.kind, id: verification.id, digest: verification.digest,
        integrationManifestId: verification.integrationManifestId, candidateSha: verification.candidateSha, blueprintId: verification.blueprintId,
        commands: verification.commands.map((command) => ({ id: command.id, component: command.component, cwd: command.cwd, commandDigest: digest(command) })),
        mappings: verification.mappings
      };
      this.router.store.recordProductEvidenceExecution({ id, ...identity, verificationManifest: persistedManifest, commands: commandResults, evidence, success: evidence.results.every((item) => item.status === "pass") });
      return evidence;
    } catch {
      // A malformed/missing manifest or candidate mismatch intentionally gives
      // the existing strict report builder no criterion evidence to accept.
      return { candidateSha: candidate?.sha ?? null, results: [] };
    }
  }
}
