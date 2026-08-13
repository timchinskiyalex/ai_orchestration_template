import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { AppServerExecutionProvider } from "./app-server-execution-provider.mjs";
import { EXECUTION_PROVIDER_VERSION, assertCapabilities, validateEnvelope, validateLifecycleEvent, ExecutionProviderError } from "./execution-provider-contract.mjs";
import { BudgetGovernor } from "./budget-governor.mjs";
import { depthOf, finalStatusForRole, assertRole, ENGINEERING_DOMAINS } from "./domain.mjs";
import { StateStore } from "./state-store.mjs";
import { WorktreeManager } from "./worktree-manager.mjs";
import { extractOrchestrationJson, validateBootstrap, validateLocalIntegrationCheckpoint, validatePlan } from "./workflow-contract.mjs";
import { BudgetAccountAdapter } from "./budget-account-adapter.mjs";
import { assertProjectOverlayAdapterIntegrity, commandCwd, commandsForPaths, generateProjectOverlay, loadProjectOverlay, projectOverlayExecutionSnapshot } from "./project-overlay.mjs";
import { WorktreeFinalizer } from "./worktree-finalizer.mjs";
import { Integrator } from "./integrator.mjs";
import { remediationScope, validateQualityGateReport } from "./quality-gate.mjs";
import { validateSecurityGateReport } from "./security-gate.mjs";
import { GitHubCiAdapter, GitHubMergeAdapter, GitHubPullRequestAdapter, RemoteAdapterError, RemoteCiAdapter, RemoteGitAdapter } from "./remote-adapters.mjs";
import { runManagedProcess } from "./managed-process-runner.mjs";
import { provisionDeterministicScaffold } from "./deterministic-scaffold.mjs";
import { documentSetDigest, sourceClaimBlockers, specificationBlockers, validateControllerAuthorizedBlueprint } from "./product-blueprint.mjs";
import { compileImportedSourceClaimManifest, createImportedSourceResolver, validateSourceClaimExtraction } from "./source-evidence.mjs";
import { SourceClaimExtractionExecutor } from "./source-claim-extraction.mjs";
import { SourceClaimAuditExecutor, admitAuditedSourceClaims, auditSubjectFromExtraction, auditSubjectFromManifest, deterministicSuppliedSourceClaimAudit, validateSourceClaimAudit } from "./source-claim-audit.mjs";
import { PRODUCT_ACCEPTANCE_KIND, PRODUCT_ACCEPTANCE_SCHEMA_VERSION, productAcceptancePasses } from "./final-acceptance.mjs";
import { compileWriteSurfaceTopology } from "./write-surface.mjs";
import { assertRepositoryBaselineCurrent, captureRepositoryBaselineDraft, finalizeRepositoryBaseline, repositoryBaselineStatus, validateTaskBaselineBehaviorIds } from "./repository-baseline.mjs";
import { configuredProjectMode, projectModeFor, sameProjectMode, validateProjectMode } from "./project-mode.mjs";
import { architectureBlueprintFromProductRoots, validateArchitectureBlueprint } from "./architecture-blueprint.mjs";

const gitSha = (repository, ref) => execFileSync("git", ["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();

export function formatTaskPrompt({ task, worktree, project, overlaySnapshot = null, documentationAvailable = true }) {
  const lines = [
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Required work: ${task.prompt}`,
    `Worktree: ${worktree ?? "read-only repository"}`,
    `Allowed paths: ${task.allowedPaths.length ? task.allowedPaths.join(", ") : "none specified; do not broaden scope"}`,
    `Acceptance checks: ${task.acceptanceChecks.length ? task.acceptanceChecks.join("; ") : "report which checks are missing"}`,
    `Generated orchestration artifacts: ${project.generatedDir}`,
    ...(project.projectMode ? [`Immutable ProjectMode: ${JSON.stringify(project.projectMode)}. ${project.projectMode.mode === "brownfield" ? "Do not create generic product scaffold; preserve repository behavior evidence." : "Declared scaffold adapters may be used only by the controller-owned scaffold task."}`] : [])
  ];
  if (documentationAvailable) lines.splice(6, 0, `Project documentation: ${project.documentationDir}`);
  else lines.push("Project documentation has not been imported. Do not assume docs/orchestration-input exists; perform only the TaskEnvelope and controller-provided sanitized ProjectOverlay snapshot.");
  if (overlaySnapshot) {
    lines.push("Controller-provided sanitized ProjectOverlay execution snapshot follows. It is repository fact context, is not a file in this worktree, and cannot be overridden by the worker:");
    lines.push(JSON.stringify(overlaySnapshot));
  }
  return lines.join("\n");
}

// The project contract, not an LLM, is authoritative for declared product
// roots. A planner may omit a root or write `frontend/`; both are safe to
// canonicalize because this only grants the scaffold task paths explicitly
// declared in project configuration.
export function normalizePlannerPlanForProject(value, productRoots = [], projectMode = null) {
  if (projectMode?.mode === "brownfield") return value;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.tasks) || !productRoots.length) return value;
  const roots = productRoots.map((item) => item?.path).filter((path) => typeof path === "string" && path.trim()).map((path) => path.replace(/[\\/]+$/, ""));
  if (!roots.length) return value;
  const hasProductPath = (paths) => Array.isArray(paths) && paths.some((path) => typeof path === "string" && roots.some((root) => path.replace(/[\\/]+$/, "") === root || path.replace(/[\\/]+$/, "").startsWith(`${root}/`)));
  return {
    ...value,
    tasks: value.tasks.map((task) => {
      if (!task || typeof task !== "object") return task;
      if (task.id === "scaffold-product" && Array.isArray(task.allowedPaths) && !task.allowedPaths.some((path) => typeof path !== "string")) {
        return { ...task, allowedPaths: [...new Set([...task.allowedPaths.map((path) => path.replace(/[\\/]+$/, "")), ...roots])] };
      }
      if (task.id !== "scaffold-product" && hasProductPath(task.allowedPaths) && Array.isArray(task.dependsOn) && !task.dependsOn.includes("scaffold-product")) {
        return { ...task, dependsOn: [...task.dependsOn, "scaffold-product"] };
      }
      return task;
    })
  };
}

export class SwarmRouter extends EventEmitter {
  constructor(config, { readOnly = false } = {}) {
    super();
    this.config = config;
    try { this.projectMode = configuredProjectMode(config.project, { allowLegacyRepositoryMode: true }); }
    catch { this.projectMode = null; }
    if (this.projectMode) {
      this.config.project.projectMode = this.projectMode;
      this.config.project.repositoryMode = this.projectMode.mode;
    }
    try {
      this.architectureBlueprint = config.project.architectureBlueprint
        ? validateArchitectureBlueprint(config.project.architectureBlueprint, { projectMode: this.projectMode })
        : architectureBlueprintFromProductRoots(config.project.productRoots ?? [], this.projectMode ?? projectModeFor("greenfield"));
      this.config.project.architectureBlueprint = this.architectureBlueprint;
      this.config.project.productRoots = this.architectureBlueprint.components.map((component) => ({ id: component.id, path: component.path, adapter: component.adapter.id, adapterVersion: component.adapter.version }));
      this.stackAdapterAdmissionError = null;
    } catch (error) {
      this.architectureBlueprint = null;
      this.stackAdapterAdmissionError = String(error.message ?? error);
    }
    this.store = new StateStore(join(config.runtimeDir, "swarm.sqlite"), { readOnly, faultHooks: config.faultHooks });
    this.governor = new BudgetGovernor(config.router);
    this.worktrees = new WorktreeManager({ ...config, store: this.store, readOnly });
    this.threadTasks = new Map();
    this.account = new BudgetAccountAdapter(this.store);
    this.processRunner = config.processRunner ?? runManagedProcess;
    this.finalizer = new WorktreeFinalizer({ repository: config.repository, generatedDir: config.project.generatedDir, autonomy: config.autonomy, runtimeIdentity: config.runtimeIdentity, processRunner: this.processRunner, faultHooks: config.faultHooks });
    this.lifecycleTrace = [];
    this.lastAppServerDiagnostics = null;
    this.lifecyclePath = join(config.runtimeDir, "lifecycle.jsonl");
    this.activeDeliveryRunId = null;
    this.activeDeliverySessionId = null;
    this.stopRequested = false;
    this.expectedClientShutdown = false;
    this.budgetInterruptedTasks = new Set();
    this.pendingBudgetWatchdogs = new Set();
    this.activeTurns = new Map();
    this.closed = false;
    this.reconciliationBarrier = null;
    this.reconciliationState = { state: "not-run", outcome: null };
  }

  init() {
    mkdirSync(this.config.runtimeDir, { recursive: true });
    return { runtimeDir: this.config.runtimeDir, database: join(this.config.runtimeDir, "swarm.sqlite") };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.store.close();
  }

  stop() {
    this.activeClient?.shutdown?.({ contractVersion: EXECUTION_PROVIDER_VERSION, correlationId: randomUUID(), data: {} })?.catch?.(() => {});
  }

  async requestShutdown(reason = "interrupted_controller_exit") {
    if (this.stopRequested) return;
    this.stopRequested = true;
    const client = this.activeClient;
    const active = [...this.activeTurns.values()];
    this.#lifecycle("controller shutdown requested", { reason, activeTurns: active.map(({ taskId, threadId, turnId }) => ({ taskId, threadId, turnId })) });
    if (client) {
      await Promise.allSettled(active.map((turn) => this.#interruptAndAwaitTurn(client, turn, reason, { timeoutMs: this.config.delivery?.shutdownGraceMs ?? 3_000 })));
    }
    this.#markInterrupted(reason, { activeTurns: active.map(({ taskId, threadId, turnId }) => ({ taskId, threadId, turnId })) });
    if (client) { try { await this.#provider(client, "shutdown", {}); } catch {} }
  }

  #markInterrupted(reason, recovery = {}) {
    if (!this.activeDeliveryRunId) {
      for (const active of this.activeTurns.values()) {
        const task = this.store.getTask(active.taskId);
        if (task?.status === "running") this.store.transition(task.id, "interrupted", { error: reason });
      }
      return null;
    }
    const run = this.store.deliveryRun(this.activeDeliveryRunId);
    if (run && !["interrupted", "completed_merged", "failed", "blocked_budget", "blocked_specification", "blocked_quota", "blocked_credentials", "blocked_ci", "blocked_branch_protection", "conflict_blocked"].includes(run.state)) return this.store.interruptDeliveryRun(run.id, { reason, recovery });
    return run;
  }

  async recoverStaleDeliveries() {
    if (this.reconciliationBarrier) return await this.reconciliationBarrier;
    this.reconciliationBarrier = this.#recoverStaleDeliveries();
    return await this.reconciliationBarrier;
  }

  async #recoverStaleDeliveries() {
    const staleAfterMs = this.config.delivery?.staleLeaseMs ?? 30_000;
    const recovered = this.store.recoverStaleDeliveryRuns({ staleAfterMs, isProcessAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    } });
    for (const run of recovered) this.#lifecycle("stale delivery recovered", { deliveryRunId: run.id, state: run.state, recovery: run.recovery });
    try {
      // Git/filesystem facts are authoritative. This only classifies and
      // preserves records; it never prunes, resets, or recreates a worktree.
      const result = await this.worktrees.reconcile({ taskForRecord: (record) => record.taskId ? this.store.getTask(record.taskId) : null });
      const integrityBlocked = result.records.filter((record) => record.classification === "integrity-blocked");
      if (integrityBlocked.length) {
        const recovery = integrityBlocked.slice(0, 5).map((record) => `${record.kind}:${record.recordId}`).join(", ");
        throw new Error(`Managed worktree reconciliation requires recovery for ${recovery}`);
      }
      const reconciliation = { state: "completed", records: result.records.slice(0, 100), observations: result.observations.slice(0, 100), inventoryCount: result.inventoryCount, truncated: result.truncated };
      this.reconciliationState = { state: "completed", outcome: reconciliation };
      return Object.assign(recovered, { reconciliation });
    } catch (error) {
      const reconciliation = { state: "integrity-blocked", error: String(error.message).slice(0, 300) };
      this.reconciliationState = { state: "integrity-blocked", outcome: reconciliation };
      this.#lifecycle("managed worktree reconciliation failed", { error: reconciliation.error });
      throw Object.assign(new Error(`Managed worktree reconciliation blocked execution: ${reconciliation.error}`), { reconciliation });
    }
  }

  activateDeliveryRun(runId, sessionId = undefined) {
    const sameRun = this.activeDeliveryRunId === runId;
    this.activeDeliveryRunId = runId;
    if (sessionId !== undefined) this.activeDeliverySessionId = sessionId;
    else if (!sameRun) this.activeDeliverySessionId = null;
  }

  createDeliveryRun(details) {
    const sessionId = randomUUID();
    let run = this.store.createDeliveryRun({ ...details, projectMode: details.projectMode ?? this.projectMode, repositoryMode: details.repositoryMode ?? this.projectMode?.mode ?? "legacy", ownerPid: process.pid, ownerSessionId: sessionId });
    this.activateDeliveryRun(run.id, sessionId);
    // Programmatic callers from before source-claim audit/admission supplied a
    // compiled, persisted declaration directly.  It remains usable only after
    // the same deterministic supplied-input audit as the normal intake path.
    // Keep its immutable ID: a persisted Blueprint/replan may already bind it.
    if (run.sourceClaimInputMode === "supplied" && run.sourceClaimManifestId && !run.sourceClaimAuditId) {
      this.admitPersistedSuppliedManifestForRun(run);
      run = this.store.deliveryRun(run.id);
    }
    return run;
  }

  captureRepositoryBaselineDraft(overlay) {
    if (this.projectMode?.mode !== "brownfield") return null;
    return captureRepositoryBaselineDraft({ repository: this.config.repository, baseRef: this.config.baseRef, declarationPath: join(this.config.repository, this.config.project.repositoryBaselineDeclaration), overlay: overlay?.overlay ?? overlay });
  }

  assertRepositoryBaseline(run, { requireFinal = true } = {}) { return this.#assertRepositoryBaseline(run, { requireFinal }); }
  blockRunForRepositoryBaseline(run, error) {
    const reason = this.#safeRepositoryBaselineReason(error);
    return this.store.blockDeliveryForRepositoryBaseline(run.id, { reason, recovery: { action: "Start a fresh brownfield delivery from a valid repository baseline; historical records remain readable." } });
  }

  resumeDeliveryRun(id) {
    const sessionId = randomUUID();
    const run = this.store.resumeDeliveryRun(id, { ownerPid: process.pid, ownerSessionId: sessionId });
    this.activateDeliveryRun(run.id, sessionId);
    return run;
  }

  resumeSourceClaimExtractionRun(id) {
    const sessionId = randomUUID();
    const run = this.store.resumeSourceClaimExtractionRun(id, { ownerPid: process.pid, ownerSessionId: sessionId });
    this.activateDeliveryRun(run.id, sessionId);
    return run;
  }

  lifecycleEvents() { return [...this.lifecycleTrace]; }

  sourceClaimManifestIdentity() {
    const manifest = this.#currentSourceClaimManifest();
    this.store.recordSourceClaimManifest(manifest);
    return manifest.manifestId;
  }

  async auditAndAdmitSourceClaimsForRun(run) {
    if (!run || !["raw", "supplied"].includes(run.sourceClaimInputMode)) throw new Error("source_claim_audit:intake_mode_invalid");
    // Preserve the identity used by a pre-Stage-04 supplied run (and any
    // Blueprint/replan already bound to it).  This is still an admission: the
    // deterministic supplied audit validates the current declaration first.
    if (run.sourceClaimInputMode === "supplied" && run.sourceClaimManifestId) {
      const manifest = this.admitPersistedSuppliedManifestForRun(run);
      const admittedRun = this.store.deliveryRun(run.id);
      const storedAudit = this.store.sourceClaimAudit(admittedRun.sourceClaimAuditId);
      return { subject: auditSubjectFromManifest(manifest), audit: storedAudit.audit, manifest };
    }
    const resolver = this.#sourceEvidenceResolver();
    let subject;
    if (run.sourceClaimInputMode === "raw") {
      const extraction = run.sourceClaimExtractionId ? this.store.sourceClaimExtraction(run.sourceClaimExtractionId) : null;
      if (!extraction || extraction.deliveryRunId !== run.id) throw new Error("source_claim_audit:extraction_missing_or_foreign");
      const verified = validateSourceClaimExtraction(extraction.extraction, { sourceResolver: resolver });
      if (verified.digest !== extraction.digest) throw new Error("source_claim_audit:extraction_digest_mismatch");
      subject = auditSubjectFromExtraction(verified);
    } else {
      subject = auditSubjectFromManifest(this.#currentSourceClaimManifest());
    }
    let storedAudit = run.sourceClaimAuditId ? this.store.sourceClaimAudit(run.sourceClaimAuditId) : null;
    let audit;
    if (storedAudit) {
      if (storedAudit.deliveryRunId !== run.id || storedAudit.candidateId !== subject.candidateId || storedAudit.candidateDigest !== subject.candidateDigest) throw new Error("source_claim_audit:stored_audit_lineage_mismatch");
      audit = validateSourceClaimAudit(storedAudit.audit, { subject, sourceResolver: resolver, policyRegistry: this.#controllerPolicyRegistry() });
      if (audit.digest !== storedAudit.digest) throw new Error("source_claim_audit:stored_audit_digest_mismatch");
    } else {
      audit = run.sourceClaimInputMode === "supplied"
        ? deterministicSuppliedSourceClaimAudit(subject, resolver)
        : await new SourceClaimAuditExecutor(this.config).audit(subject);
      const directory = join(this.config.repository, this.config.project.generatedDir, "source-claim-audits"); mkdirSync(directory, { recursive: true });
      const path = join(directory, `${audit.auditId}.json`); const serialized = `${JSON.stringify(audit, null, 2)}\n`;
      if (existsSync(path) && readFileSync(path, "utf8") !== serialized) throw new Error("source_claim_audit:existing_audit_artifact_mismatch");
      if (!existsSync(path)) writeFileSync(path, serialized, "utf8");
      storedAudit = this.store.recordSourceClaimAudit({ deliveryRunId: run.id, audit, artifactPath: relative(this.config.repository, path).split("\\").join("/") });
    }
    const manifest = admitAuditedSourceClaims({ subject, audit });
    const manifestDirectory = join(this.config.repository, this.config.project.generatedDir, "source-claim-manifests"); mkdirSync(manifestDirectory, { recursive: true });
    const manifestPath = join(manifestDirectory, `${manifest.manifestId}.json`); const manifestSerialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (existsSync(manifestPath) && readFileSync(manifestPath, "utf8") !== manifestSerialized) throw new Error("source_claim_audit:existing_manifest_artifact_mismatch");
    if (!existsSync(manifestPath)) writeFileSync(manifestPath, manifestSerialized, "utf8");
    this.store.recordSourceClaimManifest(manifest);
    this.store.linkSourceClaimManifestToDelivery(run.id, manifest.manifestId);
    this.store.recordEvent(null, "source-claim-admission/admitted", { deliveryRunId: run.id, extractionId: run.sourceClaimExtractionId ?? null, auditId: audit.auditId, manifestId: manifest.manifestId, documentSetDigest: manifest.documentSetDigest, claimCount: manifest.claims.length });
    return { subject, audit, manifest };
  }

  admitPersistedSuppliedManifestForRun(run) {
    if (!run || run.sourceClaimInputMode !== "supplied" || !run.sourceClaimManifestId) throw new Error("source_claim_audit:supplied_manifest_required");
    const persisted = this.store.sourceClaimManifest(run.sourceClaimManifestId);
    if (!persisted?.manifest || persisted.manifest.digest !== persisted.digest) throw new Error("source_claim_audit:supplied_manifest_missing_or_corrupt");
    const current = this.#currentSourceClaimManifest();
    // The declaration compiler validates document inventory, coverage, and
    // exact source fragments. Digest equality binds the old persisted artifact
    // to that independently validated current declaration.
    if (current.manifestId !== persisted.manifest.manifestId || current.digest !== persisted.digest) throw new Error("source_claim_audit:supplied_manifest_source_identity_mismatch");
    const resolver = this.#sourceEvidenceResolver();
    const subject = auditSubjectFromManifest(persisted.manifest);
    const existing = run.sourceClaimAuditId ? this.store.sourceClaimAudit(run.sourceClaimAuditId) : null;
    const audit = existing
      ? validateSourceClaimAudit(existing.audit, { subject, sourceResolver: resolver, policyRegistry: this.#controllerPolicyRegistry() })
      : deterministicSuppliedSourceClaimAudit(subject, resolver);
    if (existing && (existing.deliveryRunId !== run.id || existing.digest !== audit.digest)) throw new Error("source_claim_audit:stored_audit_lineage_mismatch");
    admitAuditedSourceClaims({ subject, audit });
    // Retain the original identity but materialize the admitted historical
    // artifact where Bootstrap expects controller-owned manifest evidence.
    const manifestDirectory = join(this.config.repository, this.config.project.generatedDir, "source-claim-manifests"); mkdirSync(manifestDirectory, { recursive: true });
    const manifestPath = join(manifestDirectory, `${persisted.manifest.manifestId}.json`); const manifestSerialized = `${JSON.stringify(persisted.manifest, null, 2)}\n`;
    if (existsSync(manifestPath) && readFileSync(manifestPath, "utf8") !== manifestSerialized) throw new Error("source_claim_audit:existing_manifest_artifact_mismatch");
    if (!existsSync(manifestPath)) writeFileSync(manifestPath, manifestSerialized, "utf8");
    if (!existing) {
      const directory = join(this.config.repository, this.config.project.generatedDir, "source-claim-audits"); mkdirSync(directory, { recursive: true });
      const path = join(directory, `${audit.auditId}.json`); const serialized = `${JSON.stringify(audit, null, 2)}\n`;
      if (existsSync(path) && readFileSync(path, "utf8") !== serialized) throw new Error("source_claim_audit:existing_audit_artifact_mismatch");
      if (!existsSync(path)) writeFileSync(path, serialized, "utf8");
      this.store.recordSourceClaimAudit({ deliveryRunId: run.id, audit, artifactPath: relative(this.config.repository, path).split("\\").join("/") });
      this.store.recordEvent(null, "source-claim-admission/supplied-legacy-admitted", { deliveryRunId: run.id, auditId: audit.auditId, manifestId: persisted.manifest.manifestId, documentSetDigest: persisted.manifest.documentSetDigest, claimCount: persisted.manifest.claims.length });
    }
    return persisted.manifest;
  }

  async extractSourceClaimsForRun(run) {
    if (!run || run.sourceClaimInputMode !== "raw") throw new Error("source_claim_extraction:raw_intake_required");
    const existing = run.sourceClaimExtractionId ? this.store.sourceClaimExtraction(run.sourceClaimExtractionId) : null;
    if (existing) {
      validateSourceClaimExtraction(existing.extraction, { sourceResolver: this.#sourceEvidenceResolver() });
      return existing;
    }
    const extraction = await new SourceClaimExtractionExecutor(this.config).extract();
    const directory = join(this.config.repository, this.config.project.generatedDir, "source-claim-extractions");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${extraction.extractionId}.json`);
    const serialized = `${JSON.stringify(extraction, null, 2)}\n`;
    if (existsSync(path) && readFileSync(path, "utf8") !== serialized) throw new Error("source_claim_extraction:existing_candidate_artifact_mismatch");
    if (!existsSync(path)) writeFileSync(path, serialized, "utf8");
    await this.config.faultHooks?.source_claim_candidate_file_before_db_persistence?.({ deliveryRunId: run.id, extractionId: extraction.extractionId, path });
    return this.store.recordSourceClaimExtraction({ deliveryRunId: run.id, extraction, artifactPath: relative(this.config.repository, path).split("\\").join("/") });
  }

  blockRunForSourceExtraction(run, error) {
    const message = String(error?.message ?? error);
    const prefix = /source_claim_audit/.test(message) ? "source_claim_audit" : "source_claim_extraction";
    const code = /malformed_json/i.test(message) ? `${prefix}:malformed_json` : /provider_unavailable|transport|unsupported_capability/i.test(message) ? `${prefix}:provider_unavailable` : /admission_blocked/.test(message) ? "source_claim_audit:blocked_specification" : /source_provenance|source_claim_contract|source_claim_audit/.test(message) ? `${prefix}:source_integrity_or_coverage_invalid` : `${prefix}:failed`;
    return this.store.blockDeliveryForSpecification(run.id, { reason: code, recovery: { action: "Correct the imported documentation or extraction provider, then resume this intake or start a fresh delivery." } });
  }

  blockRunForSourceClaimAudit(run, error) {
    const detail = String(error?.message ?? error);
    const code = /malformed_json/i.test(detail)
      ? "source_claim_audit:malformed_json"
      : /provider_unavailable|transport|unsupported_capability/i.test(detail)
        ? "source_claim_audit:provider_unavailable"
        : /meaningful_source_material_unresolved|source_coverage_incomplete|admission_blocked|claim_decision_invalid|candidate_decision_incomplete/i.test(detail)
          ? "source_claim_audit:unresolved_source_material"
          : /source_provenance|source_claim_contract|lineage|digest|source_identity/i.test(detail)
            ? "source_claim_audit:source_integrity_invalid"
            : "source_claim_audit:failed";
    return this.store.blockDeliveryForSpecification(run.id, {
      reason: code,
      recovery: { action: "Correct the source material, controller policy, or independent audit result, then start a fresh delivery." }
    });
  }

  assertRunSourceCompleteness(run) { return this.#assertRunSourceCompleteness(run); }
  assertBootstrapSourceIntake(run) { return this.#assertBootstrapSourceIntake(run); }
  sourceCompletenessReason(error) { return this.#safeSpecificationReason(error); }
  stackAdapterReason(error) { return this.#safeStackAdapterReason(error); }
  blockRunForSourceCompleteness(run, error) {
    const reason = this.#safeSpecificationReason(error);
    return this.store.blockDeliveryForSpecification(run.id, {
      reason,
      recovery: { action: "Start a fresh documentation intake and Bootstrap delivery; historical records remain readable." }
    });
  }

  appServerDiagnostics() {
    return {
      lifecycleEvents: this.lifecycleEvents(),
      appServer: this.lastAppServerDiagnostics ?? null
    };
  }

  async collectTaskDiagnostics(taskId, { threadReadTimeoutMs = 1_500 } = {}) {
    const task = this.store.getTask(taskId);
    let threadRead = { available: false, reason: "thread/read unavailable" };
    if (task?.threadId && task.turnId && this.activeClient) {
      try {
        const result = await this.#provider(this.activeClient, "read_final_result", { threadId: task.threadId, turnId: task.turnId, timeoutMs: threadReadTimeoutMs }, ["threadId", "turnId"]);
        threadRead = { available: true, threadId: result.threadId, turnId: result.turnId, resultAvailable: Boolean(result.resultText) };
      } catch {
        threadRead = { available: false, threadId: task.threadId, turnId: task.turnId, error: "thread/read failed" };
      }
    }
    return { task, threadRead, ...this.appServerDiagnostics() };
  }

  enqueue({ role, title, prompt, parentTaskId = null, allowedPaths = [], acceptanceChecks = [], dependencies = [], estimatedTokens = null, humanApprovalRequired = false, riskFlags = [], supportingDomains = [], artifactBaseSha = null, artifactDependencies = [], remediationRound = 0, sourceWriterTaskId = null, blueprintId = null, requirementIds = [], baselineBehaviorIds = [], deliveryRunId = this.activeDeliveryRunId }) {
    assertRole(role);
    if (!title?.trim() || !prompt?.trim()) throw new Error("title and prompt are required");
    const roleConfig = this.config.roles[role];
    const estimate = estimatedTokens ?? roleConfig.tokenBudget;
    if (!Number.isInteger(estimate) || estimate < 1 || estimate > roleConfig.tokenBudget) throw new Error(`Invalid token estimate for ${role}; it must be between 1 and ${roleConfig.tokenBudget}`);
    if (parentTaskId) this.#validateChild(parentTaskId);
    this.#validateDependencies(dependencies);
    return this.store.createTask({
      id: randomUUID(), parentTaskId, role, title: title.trim(), prompt: prompt.trim(),
      allowedPaths, acceptanceChecks, dependencies, humanApprovalRequired, estimatedTokens: estimate, tokenBudget: roleConfig.tokenBudget, maxAttempts: 1,
      riskFlags, supportingDomains, artifactBaseSha, artifactDependencies, remediationRound, sourceWriterTaskId, blueprintId, requirementIds, baselineBehaviorIds, deliveryRunId
    });
  }

  list() { return this.store.listTasks(); }

  statusSnapshot() {
    const readiness = this.executionReadiness();
    const tasks = this.list();
    const reports = tasks.filter((task) => task.role === "qa").map((task) => ({ taskId: task.id, ...this.store.qualityReport(task.id) })).filter((item) => item.report);
    const securityReports = tasks.filter((task) => task.role === "security").map((task) => ({ taskId: task.id, ...this.store.securityReport(task.id) })).filter((item) => item.report);
    const worktreeInventory = this.worktrees.inventoryViewSync();
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      tasks: tasks.map((task) => ({ id: task.id, title: task.title, role: task.role, status: task.status, dependencies: task.dependencies, executionDependencies: task.executionDependencies, executionTopologyVersion: task.executionTopologyVersion, executionIsWriter: task.executionIsWriter, executionRelease: task.executionIsWriter ? { state: task.executionReleaseState, artifactTaskId: task.executionReleaseArtifactTaskId } : null, blocker: task.error ?? this.#executionBlocker(task), tokenUsed: task.tokenUsed, estimatedTokens: task.estimatedTokens, tokenBudget: task.tokenBudget, interruptThresholdTokens: task.interruptThresholdTokens, configuredBudgetCap: task.configuredBudgetCap, budgetInterrupt: task.budgetInterrupt, threadId: task.threadId, turnId: task.turnId, worktree: task.worktree, remediationRound: task.remediationRound })),
      activeTurns: tasks.filter((task) => task.status === "running").map((task) => ({ taskId: task.id, threadId: task.threadId, turnId: task.turnId })),
      realConcurrency: tasks.filter((task) => task.status === "running").length,
      localBudget: readiness.localBudget,
      localBudgetEnforcement: this.#enforcesLocalBudget() ? "enforced" : "tracking_only",
      localForecast: readiness.localForecast,
      appServerQuotaWindows: readiness.accountQuota.quotaWindows ?? [],
      quotaThrottle: readiness.quotaThrottle,
      qualityReports: reports.map(({ taskId, path, report }) => ({ taskId, path, verdict: report.verdict, findings: report.findings.length })),
      securityReports: securityReports.map(({ taskId, path, report }) => ({ taskId, path, verdict: report.verdict, findings: report.findings.length })),
      deliveryRun: this.store.currentDeliveryRun(),
      projectMode: this.store.currentDeliveryRun()?.projectMode ?? this.projectMode,
      repositoryBaseline: repositoryBaselineStatus(this.store.currentDeliveryRun() ? this.store.repositoryBaselineForRun(this.store.currentDeliveryRun().id) : null),
      finalAcceptance: this.store.currentDeliveryRun() ? this.store.productAcceptanceForRun(this.store.currentDeliveryRun().id) : null,
      managedWorktrees: this.store.listManagedWorktrees({ limit: 50 }).map((record) => ({ recordId: record.recordId, kind: record.kind, phase: record.phase, classification: worktreeInventory.current.get(record.recordId)?.classification ?? record.classification, persistedClassification: record.classification, currentVerification: worktreeInventory.current.get(record.recordId) ?? null, taskId: record.taskId, deliveryRunId: record.deliveryRunId, barrierId: record.barrierId, candidateId: record.candidateId, branch: record.branch, lastVerifiedHead: record.lastVerifiedHead, updatedAt: record.updatedAt })),
      managedWorktreeObservations: worktreeInventory.observations,
      managedWorktreeInventory: { inventoryCount: worktreeInventory.inventoryCount, truncated: worktreeInventory.truncated, error: worktreeInventory.error, readOnly: true },
      lifecycle: this.store.recentEvents(20)
    };
  }

  budgetSummary() {
    const limit = this.config.budget.weeklyTokenLimit;
    const since = new Date(Date.now() - this.config.budget.weeklyWindowDays * 86_400_000).toISOString();
    const usage = this.store.weeklyUsageSince(since);
    const usedPercent = Number(((usage.used / limit) * 100).toFixed(2));
    const projectedPercent = Number((((usage.used + usage.estimate) / limit) * 100).toFixed(2));
    return {
      label: `local rolling ${this.config.budget.weeklyWindowDays}-day ${this.#enforcesLocalBudget() ? "budget" : "usage tracking"}`, windowStartedAt: since, weeklyTokenLimit: limit, usedTokens: usage.used,
      enforcement: this.#enforcesLocalBudget() ? "enforced" : "tracking_only",
      usedPercent, plannedTokens: usage.estimate, reservedTokens: usage.reserved,
      projectedTokens: usage.used + usage.estimate,
      projectedPercent, remainingTokens: Math.max(0, limit - usage.used),
      remainingPercent: Number((Math.max(0, (limit - usage.used) / limit * 100)).toFixed(2)),
      remainingAfterPlanTokens: Math.max(0, limit - usage.used - usage.estimate),
      remainingAfterPlanPercent: Number((Math.max(0, (limit - usage.used - usage.estimate) / limit * 100)).toFixed(2))
    };
  }

  accountSummary() { return this.store.latestAccountSnapshot() ?? { schemaVersion: 1, account: { availability: "not-yet-read" }, accountActivity: [], quotaWindows: [], diagnostics: [] }; }

  implementationForecast() {
    const tasks = this.store.listTasks().filter((task) => ENGINEERING_DOMAINS.has(task.role) && ["queued", "awaiting_human", "preparing", "running", "awaiting_approval"].includes(task.status));
    return this.account.forecast(tasks, this.store.completedTelemetry());
  }

  executionReadiness() {
    const budget = this.budgetSummary();
    const forecast = this.implementationForecast();
    return {
      localBudget: budget, localForecast: forecast,
      localUsedTokens: budget.usedTokens, localReservedTokens: budget.reservedTokens, localRemainingTokens: budget.remainingTokens,
      localUsedPercent: budget.usedPercent, localP90ProjectedTokens: budget.usedTokens + forecast.p90Tokens,
      localP90ProjectedPercent: Number((((budget.usedTokens + forecast.p90Tokens) / budget.weeklyTokenLimit) * 100).toFixed(2)),
      accountQuota: this.accountSummary(), quotaThrottle: this.quotaThrottleStatus()
    };
  }

  quotaThrottleStatus() {
    const account = this.accountSummary();
    const threshold = this.config.quota?.throttleAtUsedPercent ?? 90;
    const unavailable = account.account?.availability === "unavailable" || account.account?.availability === "not-yet-read";
    const windows = (account.quotaWindows ?? []).filter((window) => window.usedPercent >= threshold);
    return { threshold, throttled: windows.length > 0 || (unavailable && Boolean(this.config.quota?.throttleWhenUnavailable)), windows, reason: windows.length ? `App Server quota window reached ${threshold}%` : (unavailable ? "App Server quota unavailable" : null) };
  }

  async ensureProjectOverlay() {
    if (this.stackAdapterAdmissionError) throw new Error(this.stackAdapterAdmissionError);
    const result = await generateProjectOverlay({ repository: this.config.repository, baseRef: this.config.baseRef, generatedDir: this.config.project.generatedDir, project: this.config.project });
    assertProjectOverlayAdapterIntegrity(result.overlay, { architectureBlueprint: this.architectureBlueprint, projectMode: this.projectMode ?? null });
    return result;
  }

  assertStackAdapterIntegrity(overlay) {
    if (this.stackAdapterAdmissionError) throw new Error(this.stackAdapterAdmissionError);
    return assertProjectOverlayAdapterIntegrity(overlay, { architectureBlueprint: this.architectureBlueprint, projectMode: this.projectMode ?? null });
  }

  async integrateFinalized(taskIds) {
    const ids = Array.isArray(taskIds) ? taskIds : [];
    if (!ids.length) throw new Error("Provide at least one finalized task id");
    if (new Set(ids).size !== ids.length) throw new Error("Integration task ids must be unique");
    const selected = ids.map((id) => {
      const task = this.store.getTask(id);
      if (!task) throw new Error(`Task ${id} has no finalized WorkerArtifact (task was not found)`);
      if (task.status !== "done") throw new Error(`Task ${id} must be done before integration (current status: ${task.status})`);
      const artifact = this.store.workerArtifact(id);
      if (!artifact) throw new Error(`Task ${id} has no finalized WorkerArtifact`);
      if (artifact.taskId !== task.id) throw new Error(`Task ${id} WorkerArtifact taskId does not match the task`);
      if (this.config.roles[task.role]?.sandbox === "workspace-write" && !this.#writerReviewPassed(task.id)) {
        throw new Error(`Task ${id} requires a passed Security and QA review chain before integration`);
      }
      return { task, artifact };
    });
    const resolved = this.#resolveEffectiveLineage(selected.map((item) => item.task.id));
    const { overlay } = loadProjectOverlay(this.config.repository, this.config.project.generatedDir);
    const result = await new Integrator({ ...this.config, processRunner: this.processRunner, worktrees: this.worktrees, deliveryRunId: this.activeDeliveryRunId }).integrate({ artifacts: resolved.artifacts, overlay, baseSha: resolved.baseSha, allowedBaseShas: resolved.allowedBaseShas, lineage: resolved.lineage });
    this.store.recordIntegrationManifest(result.path, result.manifest);
    return result;
  }

  async publishCandidate(integration, { confirmRemotePush = false, remoteGitAdapter = null, pullRequestAdapter = null, remoteCiAdapter = null, mergeAdapter = null, acceptanceReportId = null } = {}) {
    const manifest = integration?.manifest;
    if (!manifest || !["candidate_ready", "awaiting_human_merge"].includes(manifest.status) || manifest.localVerification?.status !== "passed") return { terminalState: "conflict_blocked", status: "conflict_blocked", reason: manifest?.blockedReason ?? "No locally verified candidate integration manifest" };
    const run = this.activeDeliveryRunId ? this.store.deliveryRun(this.activeDeliveryRunId) : null;
    if (!run || !integration.path || this.store.integrationManifest(integration.path)?.id !== manifest.id || !run.blueprintId || !run.candidate || run.candidate.sha.toLowerCase() !== manifest.candidateSha?.toLowerCase()) return { terminalState: "conflict_blocked", status: "conflict_blocked", reason: "Publication requires the exact persisted delivery run, blueprint, candidate, and integration manifest." };
    try { this.#assertRunSourceCompleteness(run); this.#assertRepositoryBaseline(run); }
    catch (error) {
      if (/^repository_baseline:/.test(String(error?.message))) {
        this.blockRunForRepositoryBaseline(run, error);
        return { terminalState: "blocked_repository_baseline", status: "blocked_repository_baseline", reason: this.#safeRepositoryBaselineReason(error) };
      }
      this.blockRunForSourceCompleteness(run, error);
      return { terminalState: "blocked_specification", status: "blocked_specification", reason: this.#safeSpecificationReason(error) };
    }
    const remote = this.config.remote ?? {};
    const autonomy = { mode: "autonomous", autoPush: true, autoCreatePullRequest: true, autoMerge: true, autoRemediate: true, ...(this.config.autonomy ?? {}) };
    const autonomous = this.isAutonomous();
    const auto = autonomous && autonomy.autoPush && autonomy.autoCreatePullRequest && autonomy.autoMerge;
    if (!remote.enabled || (!auto && !confirmRemotePush)) return { terminalState: autonomous ? "blocked_credentials" : "awaiting_human", status: autonomous ? "blocked_remote" : "awaiting_human_remote_handoff", reason: remote.enabled ? "Remote publication is disabled by autonomy policy." : "Remote publication is disabled in config.", candidate: { branch: manifest.branch, sha: manifest.candidateSha } };
    const candidate = { branch: manifest.branch, sha: manifest.candidateSha, base: this.config.baseRef };
    if (!candidate.branch || !/^[0-9a-f]{40}$/i.test(candidate.sha ?? "")) return { terminalState: "conflict_blocked", status: "conflict_blocked", reason: "Integration manifest does not contain an exact candidate branch and SHA." };
    const checkpoint = (stage, extra = {}) => {
      if (run.candidate && (run.candidate.branch !== candidate.branch || run.candidate.sha.toLowerCase() !== candidate.sha.toLowerCase())) throw new Error("Persisted delivery candidate identity does not match the integration manifest.");
      this.store.updateDeliveryRun(run.id, { state: "running", integrationPath: integration.path ?? run.integrationPath, candidate, publicationCheckpoint: { stage, candidate, updatedAt: new Date().toISOString(), ...extra } });
    };
    const failure = (error, stage, extra = {}) => {
      const code = error instanceof RemoteAdapterError ? error.code : "remote_failed";
      const terminalState = code === "credentials" ? "blocked_credentials" : code === "branch_protection" ? "blocked_branch_protection" : stage === "ci" ? "blocked_ci" : "failed";
      return { terminalState, status: terminalState, stage, reason: String(error.message ?? error).slice(0, 500), candidate, recovery: { action: "Inspect the persisted remote action and resolve the stated remote condition; rerun the launcher to resume idempotently." }, ...extra };
    };
    const runAction = async ({ key, kind, stage, action }) => {
      let stored = this.store.externalAction(key);
      if (stored?.status === "passed") return stored.payload;
      if (!stored) this.store.recordExternalAction({ idempotencyKey: key, kind, status: "started", payload: { candidate } });
      else this.store.updateExternalAction(key, { status: "started", payload: { ...stored.payload, candidate, retrying: true } });
      checkpoint(stage, { externalAction: key, status: "started" });
      try {
        const payload = await action();
        this.store.updateExternalAction(key, { status: payload?.status === "failed" || payload?.status === "timed_out" ? "failed" : "passed", payload });
        checkpoint(stage, { externalAction: key, status: "passed" });
        return payload;
      } catch (error) {
        this.store.updateExternalAction(key, { status: "failed", payload: { reason: String(error.message ?? error).slice(0, 500), code: error.code ?? null } });
        throw error;
      }
    };
    try {
      const pushKey = `push:${remote.remoteName}:${candidate.branch}:${candidate.sha}`;
      checkpoint("publication-ready");
      const remotePush = await runAction({ key: pushKey, kind: "remote-push", stage: "push", action: () => (remoteGitAdapter ?? new RemoteGitAdapter({ repository: this.config.repository, remoteName: remote.remoteName, allowedRemotes: remote.allowedRemotes, branchPrefix: remote.candidateBranchPrefix })).pushCandidate({ branch: candidate.branch, sha: candidate.sha, confirmRemotePush: auto || confirmRemotePush, idempotencyKey: pushKey }) });
      if ((remotePush?.verifiedSha ?? remotePush?.sha)?.toLowerCase() !== candidate.sha.toLowerCase()) throw new RemoteAdapterError("remote_sha_mismatch", "Candidate push did not verify the exact candidate SHA.");
      if (!autonomy.autoCreatePullRequest && !confirmRemotePush) return { terminalState: "awaiting_human", status: "awaiting_human_remote_handoff", candidate, remotePush, reason: "Candidate is pushed; manual PR mode is active." };
      const prKey = `pr:${candidate.branch}:${candidate.base}:${candidate.sha}`;
      const pullRequest = await runAction({ key: prKey, kind: "pull-request", stage: "pull-request", action: async () => {
        const adapter = pullRequestAdapter ?? new GitHubPullRequestAdapter({ repository: this.config.repository });
        if (typeof adapter.ensurePullRequest === "function") return adapter.ensurePullRequest({ branch: candidate.branch, base: candidate.base, sha: candidate.sha, idempotencyKey: prKey });
        if (typeof adapter.handoff === "function") return adapter.handoff(candidate);
        throw new RemoteAdapterError("pr_create_failed", "Configured pull request adapter cannot create a pull request.");
      } });
      if (!pullRequest?.number || pullRequest.headSha?.toLowerCase() !== candidate.sha.toLowerCase()) throw new RemoteAdapterError("pr_create_failed", "Pull request adapter did not verify that the PR head is the candidate SHA.");
      const ciKey = `ci:${pullRequest.number}:${candidate.sha}`;
      const remoteCi = await runAction({ key: ciKey, kind: "remote-ci", stage: "ci", action: async () => {
        const adapter = remoteCiAdapter ?? new GitHubCiAdapter({ repository: this.config.repository, timeoutMs: remote.ciTimeoutMs, pollIntervalMs: remote.ciPollIntervalMs, requiredContexts: remote.requiredCiContexts });
        return typeof adapter.waitForChecks === "function" ? adapter.waitForChecks({ pullRequest, candidate }) : adapter.verify(candidate);
      } });
      if (remoteCi.status !== "passed") return { terminalState: "blocked_ci", status: "blocked_ci", candidate, remotePush, pullRequest, remoteCi: { ...remoteCi, candidateSha: candidate.sha }, reason: remoteCi.reason ?? "Final merge requires green remote CI for the exact candidate SHA.", recovery: { action: "Read the persisted CI failure summary. The candidate and evidence are retained without a forced merge." } };
      if (!autonomy.autoMerge && !confirmRemotePush) return { terminalState: "completed_candidate_ready", status: "completed_candidate_ready", candidate, remotePush, pullRequest, remoteCi };
      const acceptance = acceptanceReportId ? this.store.productAcceptanceReport(acceptanceReportId) : null;
      if (!acceptance || !acceptance.passing || acceptance.report.deliveryRunId !== run.id || acceptance.report.integrationManifestId !== manifest.id || acceptance.report.candidateSha.toLowerCase() !== candidate.sha.toLowerCase()) return { terminalState: "awaiting_final_acceptance", status: "awaiting_final_acceptance", candidate, remotePush, pullRequest, remoteCi: { ...remoteCi, candidateSha: candidate.sha }, reason: "Green candidate CI is available; a matching persisted passing ProductAcceptanceReport is required before merge." };
      const mergeKey = `merge:${pullRequest.number}:${candidate.sha}`;
      const merge = await runAction({ key: mergeKey, kind: "pull-request-merge", stage: "merge", action: () => (mergeAdapter ?? new GitHubMergeAdapter({ repository: this.config.repository, mergeMethod: remote.mergeMethod })).merge({ pullRequest, candidate, base: candidate.base, idempotencyKey: mergeKey }) });
      if (merge.status !== "merged" || !merge.mainSha || merge.targetVerified !== true) throw new RemoteAdapterError("merge_verify_failed", "Merge adapter did not verify the target branch after merge.");
      return { terminalState: "merge_verified", status: "merge_verified", candidate, remotePush, pullRequest, remoteCi: { ...remoteCi, candidateSha: candidate.sha }, merge, acceptanceReportId };
    } catch (error) {
      return failure(error, error?.code?.startsWith("ci") ? "ci" : error?.code?.startsWith("pr") ? "pull-request" : error?.code?.startsWith("merge") || error?.code === "branch_protection" ? "merge" : "push");
    }
  }

  async runToIntegration({ alreadyIdle = false, deliveryRunId = this.activeDeliveryRunId } = {}) {
    if (deliveryRunId) { this.#assertRunSourceCompleteness(this.store.deliveryRun(deliveryRunId)); this.#assertRepositoryBaseline(this.store.deliveryRun(deliveryRunId)); }
    if (deliveryRunId && this.store.hasEffectiveInvalidatedWork(deliveryRunId)) throw new Error("Run-to-integration is blocked while scoped replan recovery is active");
    const gates = this.store.listTasks().filter((task) => (!deliveryRunId || task.deliveryRunId === deliveryRunId) && ["awaiting_human", "awaiting_approval"].includes(task.status));
    if (gates.length) throw new Error(`Run-to-integration refuses to bypass human gates: ${gates.map((task) => task.id).join(", ")}`);
    if (!alreadyIdle) await this.runUntilIdle();
    const allTasks = this.store.listTasks().filter((task) => (!deliveryRunId || task.deliveryRunId === deliveryRunId) && !this.store.isReplannedHistoricalTask(task.id));
    const activeWave = deliveryRunId ? Math.max(...this.store.planBatches(deliveryRunId).map((batch) => batch.wave), 0) : null;
    const tasks = activeWave ? allTasks.filter((task) => !task.planBatchId || task.wave === activeWave) : allTasks;
    const unfinished = tasks.filter((task) => ENGINEERING_DOMAINS.has(task.role) && task.status !== "done");
    if (unfinished.length) throw new Error(`Run-to-integration stopped before completion: ${unfinished.map((task) => `${task.id}:${task.status}`).join(", ")}`);
    const writers = tasks.filter((task) => this.config.roles[task.role]?.sandbox === "workspace-write" && task.status === "done");
    const writerIds = writers.filter((task) => !writers.some((other) => other.id !== task.id && other.dependencies.includes(task.id))).map((task) => task.id);
    if (!writerIds.length) throw new Error("Run-to-integration found no finalized writer artifacts");
    const missingReviews = writers.filter((writer) => !this.#writerReviewPassed(writer.id));
    if (missingReviews.length) throw new Error(`Run-to-integration requires a passed Security and QA report for every final artifact chain: ${missingReviews.map((task) => task.id).join(", ")}`);
    const result = await this.integrateFinalized(writerIds);
    if (result.manifest.status === "candidate_ready") this.#persistGlobalWaveCheckpoint(deliveryRunId, result);
    return { writerArtifacts: writerIds.map((id) => this.store.workerArtifact(id)), integration: result, nextAction: result.manifest.status === "candidate_ready" ? "Autonomous remote publication will push the verified candidate, create a PR, wait for CI, and merge when green." : "Resolve the blocked integration and retry." };
  }

  startProject() {
    const inventory = join(this.config.repository, this.config.project.documentationDir, "inventory.json");
    if (!existsSync(inventory)) throw new Error(`Project documentation has not been imported: ${inventory}`);
    // Direct legacy diagnostic tasks remain readable for historical fixtures.
    // Autonomous coordinator intake always calls sourceClaimManifestIdentity()
    // before creating its run and therefore cannot enter this compatibility path.
    try { this.store.recordSourceClaimManifest(this.#currentSourceClaimManifest()); }
    catch (error) { if (!/(?:source_claim_contract|source_provenance):/.test(String(error.message))) throw error; }
    const existingBootstrap = this.store.listTasks().find((task) => task.role === "bootstrap" && !task.parentTaskId && !["done", "failed", "cancelled", "blocked_budget", "blocked_specification", "interrupted"].includes(task.status));
    if (existingBootstrap) return existingBootstrap;
    const activeTasks = this.store.listTasks().filter((task) => !["done", "failed", "cancelled", "blocked_budget", "blocked_specification", "interrupted"].includes(task.status));
    if (activeTasks.length) throw new Error("This instance already has active orchestration tasks; recover or wait for the active delivery before starting another run");
    const activeRun = this.store.currentDeliveryRun();
    const admittedManifestPath = activeRun?.sourceClaimManifestId && activeRun?.sourceClaimAuditId
      ? join(this.config.project.generatedDir, "source-claim-manifests", `${activeRun.sourceClaimManifestId}.json`).split("\\").join("/")
      : null;
    return this.enqueue({
      role: "bootstrap",
      title: `Bootstrap ${this.config.project.name}`,
      prompt: `Read ${this.config.project.documentationDir}/inventory.json and the Markdown files the inventory lists${admittedManifestPath ? `, plus the controller-admitted immutable manifest ${admittedManifestPath}` : ""}. Produce the required structured blueprint for project '${this.config.project.name}'. The controller has already admitted one immutable SourceClaimManifest for this delivery; every admitted claim must have exactly one explicit sourceClaimIds disposition. For every requirement, sourceClaimIds and sourceRefs are an immutable pair: choose its admitted claim IDs, then copy every sourceRefs object from exactly those claims verbatim (same documentId, startLine, endLine, and excerptDigest); do not cite a subrange, superset, paraphrased reference, or unclaimed source reference. A mandatory claim must be closed by one mandatory requirement with acceptance criteria, or explicitly represented as an unresolved question or contradiction when the specification genuinely cannot be resolved.`,
    });
  }

  approveHumanGate(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === "awaiting_approval") {
      this.store.transition(task.id, "queued", { humanApproved: true, error: "Human resumed task after denied App Server approval request" });
      return { task: this.store.getTask(task.id), next: null, shouldRun: true, resumedApproval: true };
    }
    if (task.status !== "awaiting_human") throw new Error(`Task ${taskId} is not awaiting human approval`);
    if (task.role === "planner") {
      const readiness = this.executionReadiness();
      const override = this.store.budgetOverride(task.id);
      if (readiness.localP90ProjectedTokens > readiness.localBudget.weeklyTokenLimit && !override) throw new Error(`P90 local forecast ${readiness.localP90ProjectedTokens} exceeds local policy ${readiness.localBudget.weeklyTokenLimit}; record a separate budget override with a reason before approving`);
      this.store.transition(task.id, "done");
      return { task: this.store.getTask(task.id), next: null, readiness, override, shouldRun: true };
    }
    if (task.role !== "bootstrap") {
      this.store.transition(task.id, "queued", { humanApproved: true });
      return { task: this.store.getTask(task.id), next: null, budget: this.budgetSummary(), forecast: this.implementationForecast(), account: this.accountSummary(), shouldRun: true };
    }
    this.store.transition(task.id, "done");
    const planner = this.#enqueuePlanner(task);
    return { task: this.store.getTask(task.id), next: planner, shouldRun: true };
  }

  overrideBudgetGate(taskId, reason) {
    const task = this.store.getTask(taskId);
    if (!task || task.role !== "planner" || task.status !== "awaiting_human") throw new Error("Budget override is allowed only for a Planner task awaiting human approval");
    if (typeof reason !== "string" || reason.trim().length < 8) throw new Error("Budget override requires a specific human reason of at least 8 characters");
    const readiness = this.executionReadiness();
    if (readiness.localP90ProjectedTokens <= readiness.localBudget.weeklyTokenLimit) throw new Error("P90 local forecast does not exceed the configured local policy limit; no override is needed");
    this.store.recordBudgetOverride({ taskId, reason: reason.trim(), forecast: readiness });
    return { task, override: this.store.budgetOverride(taskId), readiness };
  }

  async runUntilIdle({ deliveryRunId = this.activeDeliveryRunId } = {}) {
    // Selection validation is a pre-worker admission barrier, but never
    // creates an Overlay here: existing worker admission intentionally
    // verifies that its controller-generated Overlay is already present.
    if (this.stackAdapterAdmissionError) {
      const error = new Error(this.stackAdapterAdmissionError);
      if (deliveryRunId) return this.store.blockDeliveryForSpecification(deliveryRunId, { reason: this.#safeStackAdapterReason(error), recovery: { action: "Declare one supported controller-owned ArchitectureBlueprint stack and start a fresh delivery." } });
      throw error;
    }
    // No scheduler admission may race startup reconciliation. This includes
    // direct `run` callers that did not go through DeliveryCoordinator.
    try { await this.recoverStaleDeliveries(); }
    catch (error) { return { blockedQuota: false, blockedBudget: false, failed: true, interrupted: false, integrityBlocked: true, reconciliation: error.reconciliation ?? this.reconciliationState.outcome, quota: this.quotaThrottleStatus() }; }
    // Ownership is the first operation: a second controller must fail before
    // repository preflight, App Server launch, thread creation, or turn start.
    const sessionId = deliveryRunId && this.activeDeliveryRunId === deliveryRunId && this.activeDeliverySessionId ? this.activeDeliverySessionId : (deliveryRunId ? randomUUID() : null);
    if (deliveryRunId) {
      const run = this.store.deliveryRun(deliveryRunId);
      const sourceControlledDelivery = Boolean(run?.source || run?.sourceClaimManifestId || run?.blueprintId);
      if (sourceControlledDelivery) {
      try {
        if (run?.blueprintId) { this.#assertRunSourceCompleteness(run); this.#assertRepositoryBaseline(run); }
        else { this.#assertBootstrapSourceIntake(run); this.#assertRepositoryBaseline(run, { requireFinal: false }); }
      } catch (error) {
        if (/^repository_baseline:/.test(String(error?.message))) {
          this.blockRunForRepositoryBaseline(run, error);
          return { blockedQuota: false, blockedBudget: false, failed: false, interrupted: false, repositoryBaselineBlocked: true, quota: this.quotaThrottleStatus() };
        }
        this.blockRunForSourceCompleteness(run, error);
        return { blockedQuota: false, blockedBudget: false, failed: false, interrupted: false, sourceBlocked: true, quota: this.quotaThrottleStatus() };
      }
      }
    }
    if (deliveryRunId) this.store.claimDeliveryLease(deliveryRunId, { ownerPid: process.pid, ownerSessionId: sessionId });
    this.activeDeliveryRunId = deliveryRunId ?? null;
    this.activeDeliverySessionId = sessionId;
    await this.worktrees.verifyRepository();
    this.#validateWorkerOverlays();
    const client = this.config.executionProviderFactory?.({ cwd: this.config.repository })
      ?? new AppServerExecutionProvider({ cwd: this.config.repository });
    this.activeClient = client;
    this.stopRequested = false;
    this.expectedClientShutdown = false;
    this.budgetInterruptedTasks.clear();
    this.pendingBudgetWatchdogs.clear();
    this.activeTurns.clear();
    client.on?.("lifecycle", (event) => this.#onProviderLifecycle(event));
    const onSigint = () => { this.requestShutdown("interrupted_controller_exit: SIGINT received").catch(() => {}); };
    process.once("SIGINT", onSigint);
    const heartbeat = deliveryRunId ? setInterval(() => this.store.heartbeatDeliveryLease(deliveryRunId, this.activeDeliverySessionId), this.config.delivery?.leaseHeartbeatMs ?? 5_000) : null;
    try {
      const handshake = await this.#provider(client, "handshake", {}, ["providerRunId"]);
      assertCapabilities(handshake, client);
      this.#lifecycle("execution provider connected", { contractVersion: EXECUTION_PROVIDER_VERSION });
      const account = await this.#provider(client, "account_read", {});
      const snapshot = this.account.normalize({ account: account.account, usage: account.usage, rateLimits: account.rateLimits, previous: this.store.latestAccountSnapshot() });
      this.store.recordAccountSnapshot(snapshot);
      this.#lifecycle(snapshot.diagnostics?.length ? "account read failed" : "account read completed", { diagnostics: snapshot.diagnostics?.length ?? 0 });
      const scheduler = { active: 0, blockedQuota: false, blockedBudget: false, failed: false, dependencyDeadlock: null };
      const workers = Array.from({ length: this.config.router.maxConcurrentTasks }, () => this.#worker(client, scheduler));
      await Promise.all(workers);
      // Notification handlers are intentionally non-blocking, but a terminal
      // scheduler result must not race a just-started budget interrupt.
      await Promise.allSettled([...this.pendingBudgetWatchdogs]);
      return { blockedQuota: scheduler.blockedQuota, blockedBudget: scheduler.blockedBudget || this.budgetInterruptedTasks.size > 0, failed: scheduler.failed, interrupted: this.stopRequested, integrityBlocked: Boolean(scheduler.dependencyDeadlock), dependencyDeadlock: scheduler.dependencyDeadlock, quota: this.quotaThrottleStatus() };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      process.removeListener("SIGINT", onSigint);
      try { this.lastAppServerDiagnostics = (await this.#provider(client, "diagnostics", {})).diagnostics ?? null; } catch { this.lastAppServerDiagnostics = null; }
      this.expectedClientShutdown = true;
      try { await this.#provider(client, "shutdown", {}); } catch {}
      if (this.activeClient === client) this.activeClient = null;
      this.activeTurns.clear();
      // Provider teardown between waves must not discard this controller's
      // delivery lease. A different router instance has no in-memory session
      // and will still fail the compare-and-set ownership check.
      if (!deliveryRunId) this.activeDeliverySessionId = null;
    }
  }

  async #worker(client, scheduler) {
    while (true) {
      if (this.stopRequested || scheduler.failed || this.budgetInterruptedTasks.size) { scheduler.blockedBudget ||= this.budgetInterruptedTasks.size > 0; return; }
      if (this.quotaThrottleStatus().throttled) { scheduler.blockedQuota = true; return; }
      this.#resumeScopedReplans();
      const barriersRan = await this.#runReadyIntegrationBarriers();
      const task = this.store.claimNext();
      if (!task) {
        if (barriersRan) continue;
        if (!scheduler.active) {
          const diagnosis = this.#diagnoseDependencyDeadlock();
          if (diagnosis) scheduler.dependencyDeadlock ??= this.#persistDependencyDeadlock(diagnosis);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      scheduler.active += 1;
      try { await this.#runTask(client, task); }
      catch (error) {
        const current = this.store.getTask(task.id);
        if (current && !["awaiting_approval", "cancelled", "blocked_budget", "blocked_specification", "interrupted"].includes(current.status)) {
          let recovery = null;
          if (current.worktree) {
            try { recovery = await this.worktrees.recovery(current.worktree); }
            catch { recovery = null; }
          }
          const detail = recovery ? `${error.message} Recovery worktree: ${recovery.worktree} (${recovery.clean ? "clean" : "dirty"}). ${recovery.action}` : error.message;
          if (/(?:specification_gap|source_provenance|source_claim_contract|specification_authority)/i.test(detail)) {
            const reason = /source_claim_contract/i.test(detail) ? this.#safeSpecificationReason(error) : detail;
            this.store.transition(task.id, "blocked_specification", { error: reason });
            if (task.deliveryRunId) {
              if (/source_claim_contract/i.test(detail)) this.blockRunForSourceCompleteness(this.store.deliveryRun(task.deliveryRunId), error);
              else this.store.updateDeliveryRun(task.deliveryRunId, { state: "blocked_specification", publish: { reason } });
            }
            const replan = this.store.scopedReplans(task.deliveryRunId).find((item) => item.plannerTaskId === task.id);
            if (replan) this.store.blockScopedReplan(replan.id, "blocked_specification", reason);
          } else {
            this.store.transition(task.id, "failed", { error: detail });
            const replan = this.store.scopedReplans(task.deliveryRunId).find((item) => item.plannerTaskId === task.id);
            if (replan) this.store.blockScopedReplan(replan.id, replan.attempt >= replan.maxAttempts ? "abandoned" : "fatal", detail);
            else this.#recordScopedFailure(task, detail, this.#failureKind(task, detail));
          }
        }
      } finally { this.#forgetTaskTurn(task.id); scheduler.active -= 1; }
    }
  }

  async #runTask(client, task) {
    const roleConfig = this.config.roles[task.role];
    const localBudget = this.#localBudgetDecision(task);
    if (this.#enforcesLocalBudget() && !localBudget.allowed) {
      this.store.transition(task.id, "blocked_budget", { error: `Local scheduler hard cap blocks this task: projected ${localBudget.projected} exceeds ${localBudget.limit}` });
      this.#blockScopedPlanner(task, "blocked_budget", "Local scheduler hard cap blocks scoped recovery planning");
      this.#lifecycle("budget preflight blocked", { taskId: task.id, scope: localBudget.scope, projected: localBudget.projected, limit: localBudget.limit, reservation: task.tokenBudget });
      return;
    }
    let overlayContext = ENGINEERING_DOMAINS.has(task.role) ? this.#workerOverlayContext() : null;
    const rootId = this.#rootId(task);
    const usage = this.store.usageForRoot(rootId);
    const decision = this.governor.canStart({ task, alreadyUsed: usage.used, alreadyReserved: Math.max(0, usage.reserved - task.tokenBudget), parentBudget: this.config.router.defaultParentBudget });
    if (this.#enforcesLocalBudget() && !decision.allowed) {
      this.store.transition(task.id, "blocked_budget", { error: `Projected ${decision.projected} exceeds budget ${decision.budget}` });
      this.#blockScopedPlanner(task, "blocked_budget", "Projected scoped recovery planning usage exceeds budget");
      return;
    }
    const runtimeBudget = this.#runtimeBudgetFor(task, localBudget);
    if (this.#enforcesLocalBudget() && runtimeBudget.interruptThresholdTokens < 1) {
      this.store.transition(task.id, "blocked_budget", { error: "Local scheduler hard cap leaves no runtime token budget for this task" });
      this.#blockScopedPlanner(task, "blocked_budget", "No local runtime token budget remains for scoped recovery planning");
      return;
    }
    // Admission is rechecked immediately before an App Server turn.  A
    // persisted planner/worker task never gets to rely on yesterday's intake.
    const taskRun = task.deliveryRunId ? this.store.deliveryRun(task.deliveryRunId) : null;
    const sourceControlledDelivery = Boolean(taskRun && (taskRun.source || taskRun.sourceClaimManifestId || taskRun.blueprintId || task.blueprintId));
    if (task.role === "bootstrap" && sourceControlledDelivery) this.#assertBootstrapSourceIntake(taskRun);
    else if ((task.role === "planner" || ENGINEERING_DOMAINS.has(task.role)) && sourceControlledDelivery) this.#assertRunSourceCompleteness(taskRun);
    if (taskRun?.repositoryMode === "brownfield") {
      const baseline = this.#assertRepositoryBaseline(taskRun, { requireFinal: task.role !== "bootstrap" });
      if (baseline && ENGINEERING_DOMAINS.has(task.role)) validateTaskBaselineBehaviorIds(task, baseline);
    }

    let worktree = task.worktree;
    let branch = task.branch;
    if (roleConfig.sandbox === "workspace-write") this._assertWriterArtifactLineage(task);
    if (task.artifactBaseSha && roleConfig.sandbox === "workspace-write") {
      const adopted = await this.worktrees.adoptPreparedWorker(task);
      ({ worktree, branch } = adopted ? { worktree: adopted.canonicalPath, branch: adopted.branch } : await this.worktrees.create(task.id, { baseSha: task.artifactBaseSha, task, sessionId: this.activeDeliverySessionId }));
    } else if (task.sourceWriterTaskId) {
      const writer = this.store.getTask(task.sourceWriterTaskId);
      if (!writer?.worktree || !writer?.branch) throw new Error(`Review task ${task.id} has no finalized writer worktree`);
      ({ worktree, branch } = writer);
    } else if (roleConfig.usesWorktree) {
      const inherited = this.#inheritedWorktree(task);
      if (inherited) ({ worktree, branch } = inherited);
      else {
        const adopted = await this.worktrees.adoptPreparedWorker(task);
        ({ worktree, branch } = adopted ? { worktree: adopted.canonicalPath, branch: adopted.branch } : await this.worktrees.create(task.id, { task, sessionId: this.activeDeliverySessionId }));
      }
    }
    this.store.transition(task.id, "running", { worktree, branch });
    this.store.setRuntimeBudget(task.id, runtimeBudget);

    if (this.#isScaffoldTask(task)) {
      await this.#runDeterministicScaffold(task, { worktree, branch, overlayContext });
      return;
    }

    const sourceDir = fileURLToPath(new URL(".", import.meta.url));
    const developerInstructions = this.#developerInstructions(sourceDir, task.role);
    const threadResult = await this.#provider(client, "start_thread", {
      model: this.config.model,
      cwd: worktree ?? this.config.repository,
      sandbox: roleConfig.sandbox,
      approvalPolicy: roleConfig.approvalPolicy,
      developerInstructions,
      serviceName: "codex-swarm-router"
    });
    const threadId = threadResult.threadId;
    this.threadTasks.set(threadId, task.id);
    this.#lifecycle("thread started", { taskId: task.id, threadId });
    const goal = { threadId, objective: `${task.title}\n\n${task.prompt}`, status: "active" };
    // Delivery workers in tracking-only mode must not receive a token cap: it
    // turns the forecast into an agent-visible execution limit. Bootstrap and
    // Planner are deliberately bounded planning conversations, not product
    // workers; their soft goal budget keeps a malformed planning turn from
    // consuming the full delivery allowance before any code is written.
    if (this.#enforcesLocalBudget() || ["bootstrap", "planner"].includes(task.role)) goal.tokenBudget = task.tokenBudget;
    await this.#provider(client, "set_goal", goal, ["threadId"]);
    const turnOptions = { threadId, input: [{ type: "text", text: this.#taskPrompt(task, worktree, overlayContext?.snapshot) }] };
    // The generated App Server schema explicitly allows `effort`; it does not
    // expose any server-side max-token field for turn/start.
    if (["bootstrap", "planner"].includes(task.role)) turnOptions.effort = "low";
    // Establish controller ownership before the adapter can accept a
    // task-scoped lifecycle signal. The same opaque correlation binds all turn
    // lifecycle aliases, usage, approval, and terminal observations.
    const turnCorrelationId = randomUUID();
    this.activeTurns.set(task.id, { taskId: task.id, threadId, turnId: null, requestedTurnId: null, correlationId: turnCorrelationId, permittedTurnIds: new Set(), completion: null });
    const turnResult = await this.#provider(client, "start_turn", turnOptions, ["threadId", "turnId"], turnCorrelationId);
    const turnId = turnResult.turnId;
    this.store.setThread(task.id, { threadId, turnId });
    const completion = this.#provider(client, "observe_terminal", { threadId, turnId, timeoutMs: this.config.router.turnTimeoutMs }, ["threadId", "turnId", "terminalClass"], turnCorrelationId);
    this.activeTurns.set(task.id, { taskId: task.id, threadId, turnId, requestedTurnId: turnId, correlationId: turnCorrelationId, permittedTurnIds: new Set([turnId]), completion });
    this.#lifecycle("turn started", { taskId: task.id, threadId, turnId });
    const terminal = await completion;
    if (terminal.threadId !== threadId) throw new ExecutionProviderError("protocol_violation", "terminal thread mismatch");
    const watched = { turn: { id: terminal.turnId, status: terminal.terminalClass, usage: terminal.usage ?? null } };
    const turn = watched.turn;
    const resolvedTurnId = turn.id ?? turnId;
    this.#adoptResolvedTurnId(task.id, threadId, resolvedTurnId);
    this.activeTurns.delete(task.id);
    const current = this.store.getTask(task.id);
    if (this.budgetInterruptedTasks.has(task.id) && current.status === "running") this.store.transition(task.id, "blocked_budget", { error: "budget_interrupt confirmed before result processing" });
    // Lifecycle policy may already have made this turn terminal (for example,
    // an approval request or a task-scoped protocol violation).  A late,
    // otherwise valid terminal result must never re-enter normal finalization.
    if (["awaiting_approval", "blocked_budget", "interrupted", "failed", "cancelled"].includes(this.store.getTask(task.id).status)) return;
    if (turn.status === "completed") {
      let resultText = watched.resultText ?? await this.#readAgentResult(client, threadId, resolvedTurnId);
      if (watched.overlayContext) overlayContext = watched.overlayContext;
      let resultPath;
      if (task.role === "bootstrap") {
        // Direct, non-project bootstrap tasks are retained for scheduler
        // diagnostics; Product intake always comes through startProject(),
        // which requires the source inventory below.
        if (!existsSync(join(this.config.repository, this.config.project.documentationDir, "inventory.json"))) {
          resultPath = this.#saveAgentResult(task, resultText);
          this.store.setResultPath(task.id, resultPath);
        } else {
        const sourceResolver = this.#sourceEvidenceResolver();
        const manifestRequired = Boolean(task.deliveryRunId);
        const sourceClaimManifest = manifestRequired ? this.#manifestForRun(this.store.deliveryRun(task.deliveryRunId)) : null;
        const blueprint = validateBootstrap(extractOrchestrationJson(resultText), { sourceResolver, policyRegistry: this.#controllerPolicyRegistry(), sourceClaimManifest });
        if (task.deliveryRunId) blueprint.projectMode = this.#assertProjectMode(this.store.deliveryRun(task.deliveryRunId));
        const persisted = this.#persistBlueprint(task, blueprint);
        this.store.setResultPath(task.id, persisted.artifactPath);
        if (task.deliveryRunId) {
          this.store.linkBlueprintToDelivery(task.deliveryRunId, blueprint.blueprintId);
          if (persisted.sourceClaimManifestId) this.store.linkSourceClaimManifestToDelivery(task.deliveryRunId, persisted.sourceClaimManifestId);
        }
        const blockers = [...specificationBlockers(blueprint), ...(sourceClaimManifest ? sourceClaimBlockers(blueprint, sourceClaimManifest) : [])];
        if (blockers.length) {
          const reason = `blocked_specification: ${blockers.join(", ")}`;
          this.store.transition(task.id, "blocked_specification", { error: reason });
          if (task.deliveryRunId) this.store.updateDeliveryRun(task.deliveryRunId, { state: "blocked_specification", publish: { reason, recovery: { action: "Resolve the source-document contradiction or missing mandatory fact, then start a fresh delivery." } } });
          this.#lifecycle("specification blocked", { taskId: task.id, blueprintId: blueprint.blueprintId, blockers });
          return;
        }
        }
      }
      if (task.role === "planner") resultText = await this.#materializePlannerWithRepair(client, task, threadId, resultText);
      if (task.role === "security") {
        const report = validateSecurityGateReport(extractOrchestrationJson(resultText));
        resultPath = this.#saveSecurityReport(task, report);
        this.store.setResultPath(task.id, resultPath);
        this.store.recordSecurityReport({ securityTaskId: task.id, writerTaskId: task.sourceWriterTaskId, reportPath: resultPath, report });
        await this.#handleSecurityGate(task, report);
        return;
      }
      if (task.role === "qa") {
        const report = validateQualityGateReport(extractOrchestrationJson(resultText));
        const artifact = this.store.workerArtifact(task.sourceWriterTaskId);
        const checks = await this.#runDeclaredVerification(worktree, overlayContext.overlay, artifact?.changedPaths ?? []);
        report.executedChecks = [...report.executedChecks, ...checks.passed];
        report.notRunChecks = [...report.notRunChecks, ...checks.notRun];
        if (checks.failed.length) {
          report.verdict = "blocked";
          report.summary = "Controller verification failed; autonomous remediation cannot safely continue without valid scoped findings.";
        }
        resultPath = this.#saveQualityReport(task, report);
        this.store.setResultPath(task.id, resultPath);
        this.store.recordQualityReport({ qaTaskId: task.id, writerTaskId: task.sourceWriterTaskId, reportPath: resultPath, report });
        await this.#handleQualityGate(task, report);
        return;
      }
      resultPath = this.#saveAgentResult(task, resultText);
      this.store.setResultPath(task.id, resultPath);
      if (roleConfig.sandbox === "workspace-write") {
        let finalizedArtifact;
        resultPath = this.#saveAgentResult(task, resultText);
        this.store.setResultPath(task.id, resultPath);
        ({ overlayContext, resultText, finalized: finalizedArtifact } = await this.#finalizeWriterWithRepair(client, task, threadId, worktree, branch, overlayContext, resultText));
        const finalized = finalizedArtifact;
        await this.config.faultHooks?.artifact_file_before_db_persistence?.({ taskId: task.id, path: finalized.path, artifact: finalized.artifact });
        this.store.recordWorkerArtifact(task.id, finalized.path, finalized.artifact);
        await this.config.faultHooks?.artifact_db_persisted_before_task_completion?.({ taskId: task.id, path: finalized.path, artifact: finalized.artifact });
        this.#finalizeManagedWorker(task.id, finalized.artifact.headSha);
        this.#connectArtifactDependents(task, finalized.artifact);
      }
      this.store.transition(task.id, finalStatusForRole(task.role, { autonomous: this.isAutonomous() }));
      if (task.role === "bootstrap" && this.isAutonomous() && this.store.productBlueprintForBootstrap(task.id)) this.#enqueuePlanner(task);
    }
    else if (turn.status === "interrupted") this.store.transition(task.id, "interrupted", { error: "Turn interrupted" });
    else {
      const detail = turn.error?.message ?? "Turn failed";
      this.store.transition(task.id, "failed", { error: detail });
      this.#recordScopedFailure(task, detail, "worker_failure");
    }
  }

  async buildProductAcceptanceReport({ integration, remoteCi, productEvidence = null }) {
    const manifest = integration?.manifest; const run = this.activeDeliveryRunId ? this.store.deliveryRun(this.activeDeliveryRunId) : null;
    const stored = run?.blueprintId ? this.store.productBlueprint(run.blueprintId) : null;
    if (!run || !stored || !manifest || !integration.path || run.candidate?.sha?.toLowerCase() !== manifest.candidateSha?.toLowerCase()) throw new Error("Final acceptance requires the persisted run, blueprint, manifest, and candidate.");
    // A later wave is integrated from the prior verified global checkpoint,
    // so its manifest applies only the current-wave leaves.  Reconstruct the
    // immutable checkpoint ancestry by SHA before judging requirement lineage:
    // earlier artifacts remain part of this exact candidate, but only through
    // a persisted, verified checkpoint whose output is the next base.
    const applied = new Set(manifest.appliedArtifacts ?? []);
    for (const node of manifest.effectiveLineage ?? []) if (node.kind === "artifact") applied.add(node.id);
    const seenCheckpointOutputs = new Set(); let ancestorBase = manifest.baseSha;
    while (ancestorBase && !seenCheckpointOutputs.has(ancestorBase)) {
      const checkpoint = this.store.planBatches(run.id)
        .map((batch) => this.store.globalWaveCheckpoint(run.id, batch.wave))
        .find((item) => item?.status === "passed" && item.outputSha === ancestorBase);
      if (!checkpoint) break;
      seenCheckpointOutputs.add(checkpoint.outputSha);
      for (const node of checkpoint.effectiveLineage ?? []) if (node.kind === "artifact") applied.add(node.id);
      for (const input of checkpoint.inputArtifacts ?? []) applied.add(input.artifactId);
      ancestorBase = checkpoint.baseSha;
    }
    const tasks = this.list().filter((task) => task.deliveryRunId === run.id);
    const statusFor = (requirementId) => {
      const writers = tasks.filter((task) => task.requirementIds.includes(requirementId) && ENGINEERING_DOMAINS.has(task.role) && !["qa", "security"].includes(task.role));
      const artifacts = writers.map((task) => this.store.workerArtifact(task.id)).filter(Boolean);
      const linked = artifacts.length > 0 && artifacts.every((artifact) => applied.has(artifact.taskId));
      const qa = tasks.filter((task) => task.role === "qa" && task.requirementIds.includes(requirementId)).map((task) => this.store.qualityReport(task.id)).filter(Boolean);
      const security = tasks.filter((task) => task.role === "security" && task.requirementIds.includes(requirementId)).map((task) => this.store.securityReport(task.id)).filter(Boolean);
      const writerIds = new Set(writers.map((task) => task.id));
      const reviewed = qa.length && security.length && qa.every((item) => writerIds.has(item.writerTaskId) && applied.has(item.writerTaskId) && item.report.verdict === "pass") && security.every((item) => writerIds.has(item.writerTaskId) && applied.has(item.writerTaskId) && item.report.verdict === "pass");
      return linked && reviewed ? "pass" : linked ? "partial" : "missing";
    };
    const criteria = stored.blueprint.requirements.flatMap((requirement) => requirement.acceptanceCriteria.map((criterion) => ({ requirementId: requirement.requirementId, criterionId: criterion.criterionId })));
    const knownCriteria = new Set(criteria.map((criterion) => `${criterion.requirementId}:${criterion.criterionId}`));
    const exactCandidate = (value) => typeof value === "string" && value.toLowerCase() === manifest.candidateSha.toLowerCase();
    const stable = (value) => typeof value === "string" && value.trim().length > 0;
    const productStatuses = new Set(["pass", "failed", "not_verified"]);
    const evidenceByCriterion = new Map();
    let productEvidenceValid = Boolean(productEvidence && typeof productEvidence === "object" && exactCandidate(productEvidence.candidateSha) && Array.isArray(productEvidence.results));
    if (productEvidenceValid) {
      for (const item of productEvidence.results) {
        const key = `${item?.requirementId}:${item?.criterionId}`;
        if (!item || typeof item !== "object" || !knownCriteria.has(key) || evidenceByCriterion.has(key) || !productStatuses.has(item.status) || !stable(item.testId) || !stable(item.reference) || !exactCandidate(item.candidateSha)) { productEvidenceValid = false; break; }
        evidenceByCriterion.set(key, item);
      }
    }
    if (!productEvidenceValid || criteria.some((criterion) => !evidenceByCriterion.has(`${criterion.requirementId}:${criterion.criterionId}`))) productEvidenceValid = false;
    const productStatus = !productEvidenceValid ? "not_verified" : criteria.every((criterion) => evidenceByCriterion.get(`${criterion.requirementId}:${criterion.criterionId}`).status === "pass") ? "pass" : criteria.some((criterion) => evidenceByCriterion.get(`${criterion.requirementId}:${criterion.criterionId}`).status === "failed") ? "failed" : "not_verified";
    const product = { status: productStatus, reference: productEvidenceValid ? `criterion-evidence:${criteria.length}` : "criterion-evidence-incomplete", candidateSha: manifest.candidateSha, kind: "product-e2e-summary" };
    const qaPass = tasks.filter((task) => task.role === "qa").every((task) => this.store.qualityReport(task.id)?.report?.verdict === "pass");
    const securityPass = tasks.filter((task) => task.role === "security").every((task) => this.store.securityReport(task.id)?.report?.verdict === "pass");
    const repositoryBaseline = run.repositoryMode === "brownfield" ? this.#assertRepositoryBaseline(run) : null;
    const activeBehaviorIds = repositoryBaseline ? [...new Set(tasks.flatMap((task) => task.baselineBehaviorIds ?? []))].sort() : [];
    const behaviorEvidence = repositoryBaseline ? await this.#runRepositoryBaselineVerification(repositoryBaseline, manifest, activeBehaviorIds) : null;
    const report = { schemaVersion: PRODUCT_ACCEPTANCE_SCHEMA_VERSION, kind: PRODUCT_ACCEPTANCE_KIND, deliveryRunId: run.id, blueprintId: stored.blueprint.blueprintId, blueprintDigest: stored.digest, documentSetDigest: stored.documentSetDigest, integrationManifestPath: integration.path, integrationManifestId: manifest.id, candidateSha: manifest.candidateSha, generatedAt: new Date().toISOString(), ...(repositoryBaseline ? { repositoryBaselineDigest: repositoryBaseline.digest, behaviorEvidence } : {}), evidence: { integration: { status: manifest.localVerification?.status === "passed" ? "pass" : "missing", reference: integration.path, candidateSha: manifest.candidateSha, kind: "integration-manifest" }, qa: { status: qaPass ? "pass" : "missing", reference: "quality_reports", candidateSha: manifest.candidateSha, kind: "qa-lineage" }, security: { status: securityPass ? "pass" : "missing", reference: "security_reports", candidateSha: manifest.candidateSha, kind: "security-lineage" }, productE2e: product, ci: { status: remoteCi?.status === "passed" && remoteCi?.candidateSha?.toLowerCase() === manifest.candidateSha.toLowerCase() ? "pass" : "not_verified", reference: remoteCi?.idempotencyKey ?? "remote-ci", candidateSha: manifest.candidateSha, kind: "remote-ci" } }, results: [] };
    for (const requirement of stored.blueprint.requirements) {
      const lineageStatus = statusFor(requirement.requirementId); const evidence = [{ kind: "artifact-lineage", reference: `requirement:${requirement.requirementId}`, status: lineageStatus, candidateSha: manifest.candidateSha }];
      const criterionResults = requirement.acceptanceCriteria.map((criterion) => {
        const item = productEvidenceValid ? evidenceByCriterion.get(`${requirement.requirementId}:${criterion.criterionId}`) : null;
        const criterionEvidence = item
          ? { kind: "product-e2e", requirementId: item.requirementId, criterionId: item.criterionId, status: item.status, testId: item.testId, reference: item.reference, candidateSha: manifest.candidateSha }
          : { kind: "product-e2e", requirementId: requirement.requirementId, criterionId: criterion.criterionId, status: "not_verified", testId: "product-e2e-unavailable", reference: "criterion-evidence-incomplete", candidateSha: manifest.candidateSha };
        const status = lineageStatus === "pass" ? criterionEvidence.status : lineageStatus;
        return { requirementId: requirement.requirementId, criterionId: criterion.criterionId, status, evidence: [...evidence, criterionEvidence] };
      });
      const criterionStatuses = criterionResults.map((result) => result.status);
      const status = lineageStatus !== "pass" ? lineageStatus : criterionStatuses.every((value) => value === "pass") ? "pass" : criterionStatuses.includes("failed") ? "failed" : criterionStatuses.includes("not_verified") ? "not_verified" : "partial";
      report.results.push({ requirementId: requirement.requirementId, criterionId: null, status, evidence });
      report.results.push(...criterionResults);
    }
    return report;
  }

  async #runRepositoryBaselineVerification(baseline, manifest, activeBehaviorIds) {
    const { overlay } = loadProjectOverlay(this.config.repository, this.config.project.generatedDir);
    const commands = new Map((overlay.verificationCommands ?? []).map((command) => [command.id, command]));
    const results = new Map();
    const behaviors = baseline.behaviors.filter((behavior) => activeBehaviorIds.includes(behavior.behaviorId));
    for (const commandId of [...new Set(behaviors.map((behavior) => behavior.verificationCommandId))]) {
      const command = commands.get(commandId); const started = Date.now();
      if (!command || !manifest.worktree) { results.set(commandId, { classification: "not-run", durationMs: 0, exitClassification: "not-run" }); continue; }
      try {
        await this.processRunner({ executable: command.executable, args: command.args, cwd: commandCwd(manifest.worktree, command), timeoutMs: command.timeoutMs ?? 120_000 });
        results.set(commandId, { classification: "pass", durationMs: Date.now() - started, exitClassification: "passed" });
      } catch {
        results.set(commandId, { classification: "failed", durationMs: Date.now() - started, exitClassification: "failed" });
      }
    }
    return behaviors.map((behavior) => ({ behaviorId: behavior.behaviorId, commandId: behavior.verificationCommandId, baselineDigest: baseline.digest, candidateSha: manifest.candidateSha, ...results.get(behavior.verificationCommandId), safeReference: `repository-baseline:${behavior.behaviorId}` }));
  }

  async #interruptAndAwaitTurn(client, { taskId, threadId, turnId }, reason, { timeoutMs = 3_000 } = {}) {
    if (!client || typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId) {
      this.#lifecycle("turn interrupt forced client shutdown", { taskId, threadId: threadId ?? null, turnId: turnId ?? null, reason: `${reason}: missing turn identity` });
      if (client) { try { await this.#provider(client, "shutdown", {}); } catch {} }
      return { terminal: null, forced: true };
    }
    this.#lifecycle("turn interrupt requested", { taskId, threadId, turnId, reason, tokenUsed: this.store.getTask(taskId)?.tokenUsed ?? null });
    try { await this.#provider(client, "interrupt_turn", { threadId, turnId }, ["threadId", "turnId"]); }
    catch (error) { this.#lifecycle("turn interrupt request failed", { taskId, threadId, turnId, reason, error: String(error.message).slice(0, 300) }); }
    let terminal = null;
    try {
      const active = taskId ? this.activeTurns.get(taskId) : null;
      terminal = await Promise.race([
        active?.completion ?? this.#provider(client, "observe_terminal", { threadId, turnId, timeoutMs }, ["threadId", "turnId", "terminalClass"]),
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
      ]);
    } catch { terminal = null; }
    if (terminal && ["completed", "failed", "interrupted", "cancelled"].includes(terminal.terminalClass)) {
      const normalized = { id: terminal.turnId, status: terminal.terminalClass };
      this.#lifecycle("turn interrupt terminal confirmed", { taskId, threadId, turnId: normalized.id ?? turnId, reason, terminalStatus: normalized.status, tokenUsed: this.store.getTask(taskId)?.tokenUsed ?? null });
      return { terminal: normalized, forced: false };
    }
    this.#lifecycle("turn interrupt forced client shutdown", { taskId, threadId, turnId, reason, tokenUsed: this.store.getTask(taskId)?.tokenUsed ?? null });
    const task = this.store.getTask(taskId);
    if (task?.status === "running") this.store.transition(taskId, "interrupted", { error: `${reason}: terminal confirmation timed out` });
    try { await this.#provider(client, "shutdown", {}); } catch {}
    return { terminal: null, forced: true };
  }

  #forgetTaskTurn(taskId) {
    this.activeTurns.delete(taskId);
    for (const [threadId, mappedTaskId] of this.threadTasks.entries()) if (mappedTaskId === taskId) this.threadTasks.delete(threadId);
  }

  async #provider(provider, operation, data, requiredIds = [], correlationId = randomUUID()) {
    const names = { handshake: "handshake", account_read: "accountRead", start_thread: "startThread", set_goal: "setGoal", start_turn: "startTurn", observe_terminal: "observeTerminal", read_final_result: "readFinalResult", interrupt_turn: "interruptTurn", approval_response: "approvalResponse", shutdown: "shutdown", diagnostics: "diagnostics" };
    const method = provider?.[names[operation]];
    if (typeof method !== "function") throw new ExecutionProviderError("unsupported_capability", `provider does not implement ${operation}`);
    let result;
    try { result = await method.call(provider, { contractVersion: EXECUTION_PROVIDER_VERSION, correlationId, data }); }
    catch (error) { throw new ExecutionProviderError("transport_failure", String(error?.message ?? error), { errorClass: "transport" }); }
    return validateEnvelope(result, { operation, correlationId, requiredIds });
  }

  async #runDeterministicScaffold(task, { worktree, branch, overlayContext }) {
    if (!worktree || !branch) throw new Error("Deterministic scaffold requires an isolated workspace-write worktree");
    this.#lifecycle("deterministic scaffold started", { taskId: task.id, worktree });
    const provision = provisionDeterministicScaffold({ worktree, productRoots: this.config.project.productRoots });
    const refreshed = await this.#refreshProjectOverlayFromWorktree(worktree);
    const incomplete = (refreshed.overlay.components ?? []).filter((component) => component.state !== "scaffolded").map((component) => component.root);
    if (incomplete.length) throw new Error(`Deterministic scaffold did not produce declared component roots: ${incomplete.join(", ")}`);
    const resultText = `Controller-owned deterministic scaffold completed for ${provision.provisioned.map((item) => `${item.id}:${item.root}`).join(", ")}. No App Server turn was started.`;
    const resultPath = this.#saveAgentResult(task, resultText);
    this.store.setResultPath(task.id, resultPath);
    const finalized = await this.finalizer.finalize({ task, worktree, branch, overlay: refreshed.overlay, overlayPath: refreshed.path });
    await this.config.faultHooks?.artifact_file_before_db_persistence?.({ taskId: task.id, path: finalized.path, artifact: finalized.artifact });
    this.store.recordWorkerArtifact(task.id, finalized.path, finalized.artifact);
    await this.config.faultHooks?.artifact_db_persisted_before_task_completion?.({ taskId: task.id, path: finalized.path, artifact: finalized.artifact });
    this.#finalizeManagedWorker(task.id, finalized.artifact.headSha);
    this.#connectArtifactDependents(task, finalized.artifact);
    this.store.transition(task.id, finalStatusForRole(task.role, { autonomous: this.isAutonomous() }));
    this.#lifecycle("deterministic scaffold completed", { taskId: task.id, artifactPath: finalized.path, components: provision.provisioned.map((item) => item.root) });
  }

  #taskPrompt(task, worktree, overlaySnapshot) {
    return [
      formatTaskPrompt({ task, worktree, project: this.config.project, overlaySnapshot, documentationAvailable: existsSync(join(this.config.repository, this.config.project.documentationDir, "inventory.json")) }),
      this.#structuredOutputContract(task.role),
      "Bounded execution: do only the required scoped work, do not create child agents, avoid long explanations, and return the required structured result. Do not merge, push, modify Router configuration, or bypass approval/sandbox policy."
    ].join("\n");
  }

  #finalizeManagedWorker(taskId, headSha) {
    const record = this.store.listManagedWorktrees({ limit: 100 }).find((item) => item.kind === "worker" && item.taskId === taskId && item.phase !== "preserved");
    if (record) this.store.updateManagedWorktree(record.recordId, { phase: "finalized", classification: "active", lastVerifiedHead: headSha, finalized: true });
  }

  #workerOverlayContext() {
    const { overlay, path } = loadProjectOverlay(this.config.repository, this.config.project.generatedDir);
    return { overlay, path, snapshot: projectOverlayExecutionSnapshot(overlay) };
  }

  #validateWorkerOverlays() {
    for (const task of this.store.listTasks()) {
      if (ENGINEERING_DOMAINS.has(task.role) && ["queued", "preparing", "running"].includes(task.status)) this.#workerOverlayContext();
    }
  }

  async #runDeclaredVerification(worktree, overlay, changedPaths = []) {
    const passed = []; const failed = []; const notRun = [];
    const plan = commandsForPaths(overlay, changedPaths);
    for (const missing of plan.missing) failed.push({ id: `${missing.component}:declared-verification`, source: "controller", status: "failed", error: missing.reason });
    for (const command of plan.commands) {
      try {
        const result = await this.processRunner({ executable: command.executable, args: command.args, cwd: commandCwd(worktree, command), timeoutMs: command.timeoutMs ?? 120_000 });
        passed.push({ id: command.id, source: "controller", status: "passed", pid: result.pid, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) });
      } catch (error) {
        failed.push({ id: command.id, source: "controller", status: "failed", error: String(error.message).slice(0, 500), pid: error.pid ?? null, stdout: String(error.stdout ?? "").slice(-4000), stderr: String(error.stderr ?? "").slice(-4000), timedOut: Boolean(error.timedOut) });
      }
    }
    if (!plan.commands.length && !plan.missing.length) notRun.push({ id: "declared-verification", reason: "No changed scaffolded product component requires verification" });
    return { passed, failed, notRun };
  }

  #enqueuePlanner(bootstrapTask) {
    const existing = this.store.listTasks().find((task) => task.role === "planner" && task.parentTaskId === bootstrapTask.id && !["done", "failed", "cancelled", "blocked_budget", "blocked_specification", "interrupted"].includes(task.status));
    if (existing) return existing;
    const stored = this.store.productBlueprintForBootstrap(bootstrapTask.id);
    if (!stored) throw new Error(`Bootstrap task ${bootstrapTask.id} has no persisted ProductBlueprint`);
    if (bootstrapTask.deliveryRunId) { this.#assertRunSourceCompleteness(this.store.deliveryRun(bootstrapTask.deliveryRunId)); this.#assertRepositoryBaseline(this.store.deliveryRun(bootstrapTask.deliveryRunId)); }
    this.#assertStoredBlueprintSourceIntegrity(stored, { requireManifest: Boolean(bootstrapTask.deliveryRunId) });
    const prior = bootstrapTask.deliveryRunId ? this.store.currentCheckpoint(bootstrapTask.deliveryRunId) : null;
    const wave = prior ? prior.wave + 1 : 1;
    const baseSha = prior?.outputSha ?? gitSha(this.config.repository, this.config.baseRef);
    const baseline = bootstrapTask.deliveryRunId ? this.store.repositoryBaselineForRun(bootstrapTask.deliveryRunId) : null;
    const greenfieldInstruction = this.projectMode?.mode === "greenfield" ? " This is greenfield work: include a devops writer task with id scaffold-product that creates every declared product root before any task writing under a declared product root." : "";
    const baselineInstruction = baseline ? ` This is brownfield preservation work: generic scaffold-product is forbidden even when productRoots are declared. Every task must include baselineBehaviorIds exactly equal to the protected behaviors whose declared impact surfaces intersect its allowedPaths; use [] when no surface intersects. The controller rejects missing, unknown, duplicate, or out-of-scope ids. Protected behavior ids: ${baseline.behaviors.map((item) => item.behaviorId).join(", ")}.` : "";
    return this.enqueue({
      role: "planner",
      parentTaskId: bootstrapTask.id,
      title: `Plan ${this.config.project.name}`,
      prompt: `Use the immutable ProductBlueprint '${stored.blueprint.blueprintId}' at ${stored.artifactPath}. The immutable ProjectMode is ${JSON.stringify(this.projectMode)}. Produce one bounded PlanBatch wave only: id '${randomUUID()}', deliveryRunId '${bootstrapTask.deliveryRunId}', wave ${wave}, basedOnCheckpointSha '${baseSha}', and non-empty requirementIds on every implementation task. Cover only unresolved mandatory requirements; do not repeat ownership that a prior verified wave closed.${greenfieldInstruction}${baselineInstruction}`,
      dependencies: [bootstrapTask.id], estimatedTokens: this.config.roles.planner.tokenBudget,
      blueprintId: stored.blueprint.blueprintId,
    });
  }

  enqueueNextPlannerWave(deliveryRunId) {
    const run = this.store.deliveryRun(deliveryRunId);
    const bootstrap = run?.bootstrapTaskId ? this.store.getTask(run.bootstrapTaskId) : null;
    if (!run || !bootstrap || bootstrap.status !== "done") throw new Error("Next Planner wave requires the original completed Bootstrap task");
    const checkpoint = this.store.currentCheckpoint(deliveryRunId);
    if (!checkpoint) throw new Error("Next Planner wave requires a reconciled GlobalWaveCheckpoint");
    if (checkpoint.wave >= (this.config.delivery?.maxWaves ?? 8)) throw new Error(`max_waves_exhausted:${checkpoint.wave}`);
    return this.#enqueuePlanner(bootstrap);
  }

  isAutonomous() { return this.config.autonomy?.mode !== "manual"; }

  #localBudgetDecision(task) {
    const since = new Date(Date.now() - this.config.budget.weeklyWindowDays * 86_400_000).toISOString();
    const usage = this.store.weeklyUsageSince(since);
    const reservedWithoutCurrent = Math.max(0, usage.reserved - task.tokenBudget);
    const weeklyProjected = usage.used + reservedWithoutCurrent + task.tokenBudget;
    if (weeklyProjected > this.config.budget.weeklyTokenLimit) return { allowed: false, scope: "weekly", projected: weeklyProjected, limit: this.config.budget.weeklyTokenLimit, used: usage.used, reservedWithoutCurrent };
    const hardRunTokenLimit = this.config.budget.hardRunTokenLimit ?? this.config.budget.weeklyTokenLimit;
    const runUsage = task.deliveryRunId ? this.store.usageForDeliveryRun(task.deliveryRunId) : { used: 0, reserved: 0 };
    const runReservedWithoutCurrent = Math.max(0, runUsage.reserved - task.tokenBudget);
    const runProjected = runUsage.used + runReservedWithoutCurrent + task.tokenBudget;
    if (runProjected > hardRunTokenLimit) return { allowed: false, scope: "run", projected: runProjected, limit: hardRunTokenLimit, used: runUsage.used, reservedWithoutCurrent: runReservedWithoutCurrent };
    return { allowed: true, scope: "run", projected: runProjected, limit: hardRunTokenLimit, used: runUsage.used, reservedWithoutCurrent: runReservedWithoutCurrent, weeklyUsed: usage.used, weeklyProjected };
  }

  async #materializePlannerWithRepair(client, task, threadId, initialResultText) {
    let resultText = initialResultText;
    const maxRepairTurns = 2;
    for (let attempt = 0; attempt <= maxRepairTurns; attempt += 1) {
      try {
        const parsed = extractOrchestrationJson(resultText);
        if (parsed?.outcome === "specification_gap") throw new Error(`specification_gap: ${parsed.reason ?? "planner identified a required missing or contradictory specification"}`);
        this.#materializePlan(task, parsed);
        return resultText;
      } catch (error) {
        if (attempt === maxRepairTurns) throw error;
        const reason = String(error.message).slice(0, 1000);
        this.#lifecycle("planner validation retry", { taskId: task.id, threadId, attempt: attempt + 1, reason });
        const turnCorrelationId = randomUUID();
        this.activeTurns.set(task.id, { taskId: task.id, threadId, turnId: null, requestedTurnId: null, correlationId: turnCorrelationId, permittedTurnIds: new Set(), completion: null });
        const retry = await this.#provider(client, "start_turn", {
          threadId,
          effort: "low",
          input: [{ type: "text", text: `Your previous execution DAG was rejected by the deterministic controller: ${reason}\nReturn a corrected replacement JSON only. Preserve the requested project scope. The controller will normalize declared frontend/backend scaffold paths and direct scaffold dependencies; do not invent risk-flag names.` }]
        }, [], turnCorrelationId);
        const requestedTurnId = retry.turnId;
        this.store.setThread(task.id, { threadId, turnId: requestedTurnId });
        const completion = this.#provider(client, "observe_terminal", { threadId, turnId: requestedTurnId, timeoutMs: this.config.router.turnTimeoutMs }, ["threadId", "turnId", "terminalClass"], turnCorrelationId);
        this.activeTurns.set(task.id, { taskId: task.id, threadId, turnId: requestedTurnId, correlationId: turnCorrelationId, permittedTurnIds: new Set([requestedTurnId]), completion });
        this.#lifecycle("planner repair turn started", { taskId: task.id, threadId, turnId: requestedTurnId, attempt: attempt + 1 });
        const terminal = await completion;
        if (terminal.threadId !== threadId) throw new ExecutionProviderError("protocol_violation", "planner terminal thread mismatch");
        const turn = { id: terminal.turnId, status: terminal.terminalClass };
        const resolvedTurnId = turn.id ?? requestedTurnId;
        this.#adoptResolvedTurnId(task.id, threadId, resolvedTurnId);
        this.activeTurns.delete(task.id);
        if (turn.status !== "completed") throw new Error(`Planner corrective turn did not complete: ${turn.error?.message ?? turn.status}`);
        resultText = await this.#readAgentResult(client, threadId, resolvedTurnId);
      }
    }
    throw new Error("Planner validation retry loop terminated unexpectedly");
  }

  async #finalizeWriterWithRepair(client, task, threadId, worktree, branch, initialOverlayContext, initialResultText) {
    let overlayContext = initialOverlayContext;
    let resultText = initialResultText;
    const maxRepairTurns = 2;
    for (let attempt = 0; attempt <= maxRepairTurns; attempt += 1) {
      try {
        const finalized = await this.finalizer.finalize({ task, worktree, branch, overlay: overlayContext.overlay, overlayPath: overlayContext.path });
        return { overlayContext, resultText, finalized };
      } catch (error) {
        if (attempt === maxRepairTurns) throw error;
        const reason = String(error.message).slice(0, 1600);
        this.#lifecycle("writer verification retry", { taskId: task.id, threadId, attempt: attempt + 1, reason });
        const turnCorrelationId = randomUUID();
        this.activeTurns.set(task.id, { taskId: task.id, threadId, turnId: null, requestedTurnId: null, correlationId: turnCorrelationId, permittedTurnIds: new Set(), completion: null });
        const retry = await this.#provider(client, "start_turn", {
          threadId,
          input: [{ type: "text", text: `The controller could not finalize your work because deterministic validation failed: ${reason}\nFix this failure now inside the existing worktree. Keep all edits within the assigned allowed paths. Run the required checks. Do not explain or plan; make the correction and finish.` }]
        }, [], turnCorrelationId);
        const requestedTurnId = retry.turnId;
        this.store.setThread(task.id, { threadId, turnId: requestedTurnId });
        const completion = this.#provider(client, "observe_terminal", { threadId, turnId: requestedTurnId, timeoutMs: this.config.router.turnTimeoutMs }, ["threadId", "turnId", "terminalClass"], turnCorrelationId);
        this.activeTurns.set(task.id, { taskId: task.id, threadId, turnId: requestedTurnId, correlationId: turnCorrelationId, permittedTurnIds: new Set([requestedTurnId]), completion });
        this.#lifecycle("writer repair turn started", { taskId: task.id, threadId, turnId: requestedTurnId, attempt: attempt + 1 });
        const terminal = await completion;
        if (terminal.threadId !== threadId) throw new ExecutionProviderError("protocol_violation", "writer terminal thread mismatch");
        const turn = { id: terminal.turnId, status: terminal.terminalClass };
        const resolvedTurnId = turn.id ?? requestedTurnId;
        this.#adoptResolvedTurnId(task.id, threadId, resolvedTurnId);
        this.activeTurns.delete(task.id);
        if (turn.status !== "completed") throw new Error(`Writer corrective turn did not complete: ${turn.error?.message ?? turn.status}`);
        resultText = await this.#readAgentResult(client, threadId, resolvedTurnId);
      }
    }
    throw new Error("Writer verification retry loop terminated unexpectedly");
  }

  #enforcesLocalBudget() { return this.config.budget?.enforceLocalLimits === true; }

  #runtimeBudgetFor(task, localBudget) {
    if (!this.#enforcesLocalBudget()) return { interruptThresholdTokens: null, configuredBudgetCap: null };
    const safetyMargin = this.config.budget.interruptSafetyMarginTokens ?? 0;
    const configuredBudgetCap = task.tokenBudget;
    const configuredThreshold = this.config.roles[task.role].interruptThresholdTokens ?? Math.max(1, configuredBudgetCap - safetyMargin);
    const runRemaining = Math.max(0, localBudget.limit - localBudget.used - localBudget.reservedWithoutCurrent);
    return { interruptThresholdTokens: Math.min(configuredThreshold, runRemaining), configuredBudgetCap };
  }

  #writerReviewPassed(writerId) {
    const tasks = this.store.listTasks();
    const descendants = new Set([writerId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (this.config.roles[task.role]?.sandbox !== "workspace-write" || descendants.has(task.id)) continue;
        if (this.#effectiveWriterPredecessorIds(task).some((dependency) => descendants.has(dependency))) { descendants.add(task.id); changed = true; }
      }
    }
    return [...descendants].some((candidate) => {
      const security = tasks.find((task) => task.role === "security" && task.sourceWriterTaskId === candidate);
      const quality = tasks.find((task) => task.role === "qa" && task.sourceWriterTaskId === candidate);
      return security?.status === "done" && quality?.status === "done"
        && this.store.securityReport(security.id)?.report.verdict === "pass"
        && this.store.qualityReport(quality.id)?.report.verdict === "pass";
    });
  }

  #executionBlocker(task) {
    if (task.status !== "queued" || task.executionTopologyVersion !== 1) return null;
    const blockedExecution = (task.executionDependencies ?? []).find((id) => this.store.getTask(id)?.executionReleaseState !== "released");
    if (blockedExecution) return `awaiting safe controller release of execution predecessor ${blockedExecution}`;
    if (task.executionIsWriter) {
      const blockedWriter = this.#effectiveWriterPredecessorIds(task).find((id) => this.store.getTask(id)?.executionReleaseState !== "released");
      if (blockedWriter) return `awaiting safe controller release of effective writer predecessor ${blockedWriter}`;
      if (task.executionReleaseState !== "pending") return `writer execution release is ${task.executionReleaseState}`;
    }
    return null;
  }

  #saveQualityReport(task, report) {
    const root = join(this.config.repository, this.config.project.generatedDir, "quality-reports");
    mkdirSync(root, { recursive: true });
    const path = join(root, `${task.id}.v${report.schemaVersion}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return relative(this.config.repository, path).split("\\").join("/");
  }

  #saveSecurityReport(task, report) {
    const root = join(this.config.repository, this.config.project.generatedDir, "security-reports");
    mkdirSync(root, { recursive: true });
    const path = join(root, `${task.id}.v${report.schemaVersion}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return relative(this.config.repository, path).split("\\").join("/");
  }

  async #handleQualityGate(task, report) {
    const writer = this.store.getTask(task.sourceWriterTaskId);
    if (!writer) throw new Error(`Quality task ${task.id} has no source writer`);
    const maxRounds = this.config.delivery?.maxRemediationRounds ?? 2;
    const nextRound = (writer.remediationRound ?? 0) + 1;
    if (report.verdict === "pass") {
      this.store.transition(task.id, "done");
      this.store.releaseWriterAfterPassedReviews(writer.id, task.id);
      this.#lifecycle("quality gate passed", { taskId: task.id, writerTaskId: writer.id });
      return;
    }
    this.store.blockWriterRelease(writer.id, `quality gate verdict: ${report.verdict}`);
    const terminal = report.verdict === "blocked" || (report.verdict === "remediation_required" && nextRound > maxRounds);
    if (terminal) {
      const reason = report.verdict === "blocked" ? "Quality gate blocked; verification or findings are not safely remediable." : `Quality remediation limit (${maxRounds}) exhausted.`;
      this.store.transition(task.id, this.isAutonomous() ? "failed" : "awaiting_human", { error: reason });
      if (this.isAutonomous()) this.#recordScopedFailure(task, reason, "quality_gate_failure");
      this.#lifecycle(this.isAutonomous() ? "quality gate terminal" : "quality gate awaiting human", { taskId: task.id, writerTaskId: writer.id, verdict: report.verdict, reason });
      return;
    }
    if (!this.isAutonomous() || this.config.autonomy?.autoRemediate === false) {
      this.store.transition(task.id, "awaiting_human", { error: "Quality findings require manual remediation in manual mode." });
      return;
    }
    const predecessor = this.store.workerArtifactRecord(writer.id);
    if (!predecessor?.artifact) throw new Error(`Quality remediation requires finalized artifact for ${writer.id}`);
    const allowedPaths = remediationScope(report, writer);
    const remediation = this.enqueue({
      role: writer.role,
      parentTaskId: task.id,
      title: `Remediate ${writer.title} (round ${nextRound})`,
      prompt: `Apply only these validated QualityGate findings. Do not expand scope or risk: ${JSON.stringify(report.findings.map((finding) => ({ id: finding.id, path: finding.path, requiredFix: finding.requiredFix, verification: finding.verification })))}.`,
      allowedPaths,
      acceptanceChecks: report.findings.map((finding) => finding.verification),
      dependencies: [task.id],
      estimatedTokens: Math.min(this.config.roles[writer.role].tokenBudget, writer.estimatedTokens),
      riskFlags: writer.riskFlags,
      supportingDomains: ["security", "qa"],
      artifactBaseSha: predecessor.artifact.headSha,
      artifactDependencies: [writer.id],
      remediationRound: nextRound,
      sourceWriterTaskId: null,
      blueprintId: writer.blueprintId,
      requirementIds: writer.requirementIds, baselineBehaviorIds: writer.baselineBehaviorIds,
      deliveryRunId: writer.deliveryRunId
    });
    const security = this.enqueue({
      role: "security", parentTaskId: remediation.id, title: `Security review: ${remediation.title}`,
      prompt: `Review the finalized remediation artifact for '${writer.title}'. Do not expand scope; report only concrete security findings.`,
      allowedPaths, acceptanceChecks: report.findings.map((finding) => finding.verification), dependencies: [remediation.id],
      estimatedTokens: Math.min(this.config.roles.security.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.35))),
      riskFlags: writer.riskFlags, supportingDomains: ["security"], sourceWriterTaskId: remediation.id, blueprintId: writer.blueprintId, requirementIds: writer.requirementIds, baselineBehaviorIds: writer.baselineBehaviorIds, deliveryRunId: writer.deliveryRunId
    });
    this.enqueue({
      role: "qa", parentTaskId: security.id, title: `QA: ${remediation.title}`,
      prompt: `Verify the finalized remediation artifact for '${writer.title}'. Return the required QualityGateReport only.`,
      allowedPaths, acceptanceChecks: report.findings.map((finding) => finding.verification), dependencies: [security.id],
      estimatedTokens: Math.min(this.config.roles.qa.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.4))),
      riskFlags: writer.riskFlags, supportingDomains: ["qa"], sourceWriterTaskId: remediation.id, blueprintId: writer.blueprintId, requirementIds: writer.requirementIds, baselineBehaviorIds: writer.baselineBehaviorIds, deliveryRunId: writer.deliveryRunId
    });
    this.store.transition(task.id, "done");
    this.#lifecycle("remediation queued", { taskId: remediation.id, writerTaskId: writer.id, remediationRound: nextRound });
  }

  async #handleSecurityGate(task, report) {
    const writer = this.store.getTask(task.sourceWriterTaskId);
    if (!writer) throw new Error(`Security task ${task.id} has no source writer`);
    const maxRounds = this.config.delivery?.maxRemediationRounds ?? 2;
    const nextRound = (writer.remediationRound ?? 0) + 1;
    if (report.verdict === "pass") {
      this.store.transition(task.id, "done");
      this.#lifecycle("security gate passed", { taskId: task.id, writerTaskId: writer.id });
      return;
    }
    this.store.blockWriterRelease(writer.id, `security gate verdict: ${report.verdict}`);
    const terminal = report.verdict === "blocked" || (report.verdict === "remediation_required" && nextRound > maxRounds);
    if (terminal) {
      const reason = report.verdict === "blocked" ? "Security gate blocked; findings are not safely remediable." : `Security remediation limit (${maxRounds}) exhausted.`;
      this.store.transition(task.id, this.isAutonomous() ? "failed" : "awaiting_human", { error: reason });
      if (this.isAutonomous()) this.#recordScopedFailure(task, reason, "security_gate_failure");
      this.#lifecycle(this.isAutonomous() ? "security gate terminal" : "security gate awaiting human", { taskId: task.id, writerTaskId: writer.id, verdict: report.verdict, reason });
      return;
    }
    if (!this.isAutonomous() || this.config.autonomy?.autoRemediate === false) {
      this.store.transition(task.id, "awaiting_human", { error: "Security findings require manual remediation in manual mode." });
      return;
    }
    const predecessor = this.store.workerArtifactRecord(writer.id);
    if (!predecessor?.artifact) throw new Error(`Security remediation requires finalized artifact for ${writer.id}`);
    const allowedPaths = remediationScope(report, writer);
    const remediation = this.enqueue({ role: writer.role, parentTaskId: task.id, title: `Remediate ${writer.title} (security round ${nextRound})`, prompt: `Apply only these validated SecurityGate findings. Do not expand scope or risk: ${JSON.stringify(report.findings.map((finding) => ({ id: finding.id, path: finding.path, requiredFix: finding.requiredFix, verification: finding.verification })))}.`, allowedPaths, acceptanceChecks: report.findings.map((finding) => finding.verification), dependencies: [task.id, writer.id], estimatedTokens: Math.min(this.config.roles[writer.role].tokenBudget, writer.estimatedTokens), riskFlags: writer.riskFlags, supportingDomains: ["security", "qa"], artifactBaseSha: predecessor.artifact.headSha, artifactDependencies: [writer.id], remediationRound: nextRound, blueprintId: writer.blueprintId, requirementIds: writer.requirementIds, baselineBehaviorIds: writer.baselineBehaviorIds, deliveryRunId: writer.deliveryRunId });
    const security = this.enqueue({ role: "security", parentTaskId: remediation.id, title: `Security review: ${remediation.title}`, prompt: `Review the finalized security remediation artifact for '${writer.title}'. Return the required SecurityGateReport only.`, allowedPaths, acceptanceChecks: remediation.acceptanceChecks, dependencies: [remediation.id], estimatedTokens: Math.min(this.config.roles.security.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.35))), riskFlags: writer.riskFlags, supportingDomains: ["security"], sourceWriterTaskId: remediation.id, blueprintId: writer.blueprintId, requirementIds: writer.requirementIds, baselineBehaviorIds: writer.baselineBehaviorIds, deliveryRunId: writer.deliveryRunId });
    this.enqueue({ role: "qa", parentTaskId: security.id, title: `QA: ${remediation.title}`, prompt: `Verify the finalized security remediation artifact for '${writer.title}'. Return the required QualityGateReport only.`, allowedPaths, acceptanceChecks: remediation.acceptanceChecks, dependencies: [security.id], estimatedTokens: Math.min(this.config.roles.qa.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.4))), riskFlags: writer.riskFlags, supportingDomains: ["qa"], sourceWriterTaskId: remediation.id, blueprintId: writer.blueprintId, requirementIds: writer.requirementIds, baselineBehaviorIds: writer.baselineBehaviorIds, deliveryRunId: writer.deliveryRunId });
    this.store.transition(task.id, "done");
    this.#lifecycle("security remediation queued", { taskId: remediation.id, writerTaskId: writer.id, remediationRound: nextRound });
  }

  #structuredOutputContract(role) {
    if (role === "bootstrap") {
      const policies = (this.#controllerPolicyRegistry()?.policies ?? []).map(({ policyId, version, digest, scope, affectedRequirementIds, resolvedValue }) => ({ policyId, version, digest, scope, affectedRequirementIds, resolvedValue }));
      const policyInstruction = policies.length
        ? ` Trusted controller policy proposals available for an exactly matching unresolved question are: ${JSON.stringify(policies)}. You may propose one only when its questionId, affected requirement IDs, and (when present) claim IDs exactly match the question. Copy its policyId, version, digest, and resolvedValue verbatim into proposedPolicyId, proposedPolicyVersion, proposedPolicyDigest, and proposedResolution; do not invent or alter a policy.`
        : " No trusted controller policy proposals are available.";
      return `Return only one fenced JSON ProductBlueprint v1 claim set. Include the exact controller-provided ProjectMode from the task prompt as projectMode; it is lifecycle identity, not source evidence. Required exact top-level fields: {"schemaVersion":1,"kind":"ProductBlueprint","blueprintId":"stable-kebab-id","createdAt":"ISO-8601","documentSetDigest":"sha256","sourceDocuments":[{"documentId":"doc-id","path":"path","sha256":"sha256"}],"requirements":[{"requirementId":"stable-kebab-id","type":"functional|nfr|data|integration|constraint","priority":"must|should|could","mandatory":true,"description":"string","sourceRefs":[{"documentId":"doc-id","startLine":120,"endLine":127,"excerptDigest":"lowercase-sha256"}],"acceptanceCriteria":[{"criterionId":"stable-kebab-id","description":"string","verificationHint":"optional"}],"constraints":[]}],"nfrs":[],"modules":[],"integrations":[],"dataModel":{},"constraints":[],"assumptions":[],"decisions":[{"adrId":"stable-kebab-id","decision":"string","rationale":"string","sourceRefs":[{"documentId":"doc-id","startLine":120,"endLine":127,"excerptDigest":"lowercase-sha256"}]}],"unresolvedQuestions":[{"questionId":"stable-kebab-id","description":"string","requiredForRequirementIds":["requirement-id"],"proposedPolicyId":"optional-controller-policy-id","proposedPolicyVersion":"optional-version","proposedPolicyDigest":"optional-sha256","proposedResolution":"optional-proposed-value","sourceRefs":[]}],"contradictions":[{"contradictionId":"stable-kebab-id","requirementIds":["requirement-id"],"sourceRefs":[{"documentId":"doc-id","startLine":120,"endLine":127,"excerptDigest":"lowercase-sha256"}],"description":"string"}]}. Bootstrap claims are never authorization: do not emit final resolution statuses, policy defaults, or authoritative resolutions. The controller alone validates configured trusted policy evidence and creates any ADR. sourceDocuments must exactly match inventory.json. A SourceRef is controller-verified evidence only: read imported UTF-8 source, normalize CRLF/CR to LF, use inclusive 1-based lines, join the selected lines with LF, and hash that exact fragment with SHA-256. Do not use locator fields; do not invent ranges or digests. Do not invent resolutions: a missing mandatory fact or unresolved contradiction stays unresolved.${policyInstruction}`;
    }
    if (role === "planner") return `Return only one fenced JSON PlanBatch v1 with exact fields {"schemaVersion":1,"kind":"PlanBatch","id":"new-immutable-id","deliveryRunId":"controller-provided-run-id","blueprintId":"persisted-blueprint-id","wave":1,"basedOnCheckpointSha":"controller-provided-verified-git-sha","tasks":[{"id":"safe-kebab-id","title":"string","prompt":"specific implementation instruction","primaryDomain":"backend|frontend|database|qa|security|devops","supportingDomains":["qa","security"],"riskFlags":["public_api_change"],"humanApprovalRequired":false,"estimatedTokens":8000,"dependsOn":["other-task-id"],"allowedPaths":["path"],"acceptanceChecks":["test or check"],"requirementIds":["ProductBlueprint requirement id"],"baselineBehaviorIds":[]}],"createdAt":"ISO-8601"}. The controller-provided id/run/wave/base are authoritative. Every implementation task must have non-empty requirementIds from the immutable ProductBlueprint. This is one bounded wave: cover only unresolved mandatory requirements and never duplicate prior ownership. Include baselineBehaviorIds only when controller brownfield context requires them; it is a preservation obligation and never changes allowedPaths. A writer with two writer predecessors is valid: the controller creates the fan-in barrier. Do not create implementation tasks for ambiguity; return {"outcome":"specification_gap","reason":"..."} instead.`;
    if (role === "qa") return `Return only one fenced JSON QualityGateReport: {"verdict":"pass|remediation_required|blocked","summary":"string","findings":[{"id":"stable-id","severity":"low|medium|high|critical","path":"relative/path","evidence":"concrete safe evidence","requiredFix":"specific fix","verification":"specific verification"}],"executedChecks":[],"notRunChecks":[]}. Never include secrets or raw command output. A pass requires no findings.`;
    if (role === "security") return `Return only one fenced JSON SecurityGateReport: {"verdict":"pass|remediation_required|blocked","summary":"string","findings":[{"id":"stable-id","severity":"low|medium|high|critical","path":"relative/path","evidence":"concrete safe evidence","requiredFix":"specific fix","verification":"specific verification"}],"executedChecks":[],"notRunChecks":[]}. Never include secrets or raw command output. A pass requires no findings.`;
    return "Return a concise Markdown report with evidence; do not return orchestration JSON.";
  }

  #developerInstructions(sourceDir, role) {
    const root = join(sourceDir, "..");
    const files = [join(root, "policies", "core.md"), join(root, "policies", `${role}.md`), join(root, "roles", `${role}.md`)];
    return files.filter((path) => existsSync(path)).map((path) => readFileSync(path, "utf8")).join("\n\n");
  }

  async #readAgentResult(client, threadId, turnId) {
    return (await this.#provider(client, "read_final_result", { threadId, turnId }, ["threadId", "turnId", "resultText"])).resultText;
  }

  #saveAgentResult(task, resultText) {
    const generatedRoot = join(this.config.repository, this.config.project.generatedDir, "results");
    mkdirSync(generatedRoot, { recursive: true });
    const absolutePath = join(generatedRoot, `${task.id}.md`);
    writeFileSync(absolutePath, resultText, "utf8");
    return relative(this.config.repository, absolutePath).split("\\").join("/");
  }

  #sourceEvidenceResolver() {
    return createImportedSourceResolver({ repository: this.config.repository, documentationDir: this.config.project.documentationDir });
  }

  #currentSourceClaimManifest() {
    return compileImportedSourceClaimManifest({ repository: this.config.repository, documentationDir: this.config.project.documentationDir });
  }

  #manifestForRun(run) {
    if (!run?.sourceClaimManifestId) throw new Error("source_claim_contract:persisted_audited_manifest_missing");
    if (!run.sourceClaimAuditId && run.sourceClaimInputMode === "supplied") this.admitPersistedSuppliedManifestForRun(run);
    run = this.store.deliveryRun(run.id);
    if (!run?.sourceClaimAuditId) throw new Error("source_claim_contract:persisted_audited_manifest_missing");
    const persisted = this.store.sourceClaimManifest(run.sourceClaimManifestId);
    const storedAudit = this.store.sourceClaimAudit(run.sourceClaimAuditId);
    if (!persisted?.manifest || !storedAudit?.audit || storedAudit.deliveryRunId !== run.id) throw new Error("source_claim_contract:persisted_audit_or_manifest_missing");
    const resolver = this.#sourceEvidenceResolver(); const manifest = persisted.manifest;
    const legacySuppliedManifest = run.sourceClaimInputMode === "supplied" && !manifest.audit;
    if (manifest.digest !== persisted.digest || manifest.documentSetDigest !== storedAudit.documentSetDigest || (!legacySuppliedManifest && (manifest.audit?.auditId !== storedAudit.audit.auditId || manifest.audit?.digest !== storedAudit.digest || manifest.audit?.candidateId !== storedAudit.candidateId || manifest.audit?.candidateDigest !== storedAudit.candidateDigest))) throw new Error("source_claim_contract:audited_manifest_lineage_mismatch");
    if (JSON.stringify(manifest.sourceDocuments) !== JSON.stringify(resolver.sourceDocuments) || manifest.documentSetDigest !== documentSetDigest(resolver.sourceDocuments)) throw new Error("source_claim_contract:audited_manifest_source_identity_mismatch");
    for (const claim of manifest.claims ?? []) for (const ref of claim.sourceRefs ?? []) resolver.verify(ref, `audited source claim '${claim.claimId}'`);
    // Re-validate the immutable audit against the current controller inventory.
    let subject;
    if (run.sourceClaimInputMode === "raw") {
      const extraction = this.store.sourceClaimExtraction(run.sourceClaimExtractionId);
      if (!extraction || extraction.deliveryRunId !== run.id) throw new Error("source_claim_contract:audited_extraction_lineage_mismatch");
      subject = auditSubjectFromExtraction(validateSourceClaimExtraction(extraction.extraction, { sourceResolver: resolver }));
    } else subject = auditSubjectFromManifest(this.#currentSourceClaimManifest());
    const audit = validateSourceClaimAudit(storedAudit.audit, { subject, sourceResolver: resolver, policyRegistry: this.#controllerPolicyRegistry() });
    if (audit.digest !== storedAudit.digest) throw new Error("source_claim_contract:audited_manifest_digest_mismatch");
    const rebuilt = admitAuditedSourceClaims({ subject, audit });
    if (!legacySuppliedManifest && (rebuilt.manifestId !== manifest.manifestId || rebuilt.digest !== persisted.digest)) throw new Error("source_claim_contract:audited_manifest_rebuild_mismatch");
    if (legacySuppliedManifest && (subject.candidateId !== manifest.manifestId || subject.candidateDigest !== manifest.digest)) throw new Error("source_claim_contract:audited_manifest_rebuild_mismatch");
    return manifest;
  }

  #safeSpecificationReason(error) {
    const message = String(error?.message ?? error);
    const auditCode = message.match(/source_claim_audit:[a-z_:-]+/)?.[0];
    if (auditCode) return auditCode.slice(0, 160);
    if (message.includes("source_claim_contract:persisted_audited_manifest_missing")) return "source_claim_contract:persisted_run_manifest_missing";
    const codes = [
      "source_claim_contract:persisted_run_manifest_missing",
      "source_claim_contract:persisted_manifest_missing_or_stale",
      "source_claim_contract:persisted_blueprint_manifest_mismatch",
      "source_claim_contract:persisted_blueprint_manifest_missing",
      "source_claim_contract:blueprint_manifest_digest_mismatch",
      "source_claim_contract:current_manifest_mismatch",
      "source_claim_contract:current_manifest_unavailable",
      "source_claim_contract:persisted_blueprint_source_validation_failed",
      "source_claim_contract:audited_manifest_lineage_mismatch",
      "source_claim_contract:audited_manifest_source_identity_mismatch",
      "source_claim_contract:audited_manifest_digest_mismatch",
      "source_claim_contract:audited_manifest_rebuild_mismatch"
    ];
    return codes.find((code) => message.includes(code)) ?? "source_claim_contract:source_completeness_validation_failed";
  }

  #safeStackAdapterReason(error) {
    const code = String(error?.message ?? error).match(/(?:unsupported_stack|ambiguous_stack):[a-z0-9_:-]+/i)?.[0];
    return code ? code.slice(0, 220) : "unsupported_stack:architecture_blueprint_integrity_invalid";
  }

  #safeRepositoryBaselineReason(error) {
    const message = String(error?.message ?? error);
    const code = message.match(/repository_baseline:([a-z_]+)/)?.[1];
    return `repository_baseline:${code ?? "validation_failed"}`;
  }

  #assertProjectMode(run) {
    // Programmatic diagnostic fixtures without a configured contract remain
    // outside autonomous delivery. Config-loaded projects always have one.
    if (!this.projectMode) return null;
    let persisted;
    try { persisted = validateProjectMode(run?.projectMode); }
    catch { throw new Error("project_mode:persisted_record_missing"); }
    if (!sameProjectMode(this.projectMode, persisted) || run.repositoryMode !== persisted.mode) throw new Error("project_mode:run_mismatch");
    if (run?.blueprintId) {
      const blueprint = this.store.productBlueprint(run.blueprintId)?.blueprint;
      if (blueprint?.projectMode && !sameProjectMode(blueprint.projectMode, persisted)) throw new Error("project_mode:blueprint_mismatch");
    }
    return persisted;
  }

  #assertRepositoryBaseline(run, { requireFinal = true } = {}) {
    const projectMode = this.#assertProjectMode(run);
    const mode = projectMode?.mode ?? run?.repositoryMode ?? "legacy";
    if (this.projectMode?.mode === "brownfield" && mode !== "brownfield") throw new Error("repository_baseline:legacy_record_missing");
    if (mode === "legacy" || mode === "greenfield") return null;
    if (mode !== "brownfield" || !run?.repositoryBaseSha) throw new Error("repository_baseline:run_mode_invalid");
    const { overlay } = loadProjectOverlay(this.config.repository, this.config.project.generatedDir);
    const declarationPath = join(this.config.repository, this.config.project.repositoryBaselineDeclaration);
    const final = this.store.repositoryBaselineForRun(run.id);
    if (!final) {
      if (requireFinal) throw new Error("repository_baseline:final_missing");
      const draft = this.store.repositoryBaselineDraft(run.id);
      if (!draft) throw new Error("repository_baseline:draft_missing");
      const current = captureRepositoryBaselineDraft({ repository: this.config.repository, baseRef: this.config.baseRef, declarationPath, overlay });
      if (JSON.stringify(current) !== JSON.stringify(draft)) throw new Error("repository_baseline:baseline_stale");
      return draft;
    }
    if (run.repositoryBaselineId !== final.baselineId || final.baseSha !== run.repositoryBaseSha) throw new Error("repository_baseline:run_link_mismatch");
    const stored = run.blueprintId ? this.store.productBlueprint(run.blueprintId) : null;
    return assertRepositoryBaselineCurrent({ repository: this.config.repository, baseRef: this.config.baseRef, declarationPath, overlay, baseline: final, blueprintId: stored?.blueprint?.blueprintId, blueprintDigest: stored?.digest });
  }

  #assertBootstrapSourceIntake(run) {
    if (!run?.sourceClaimManifestId) throw new Error("source_claim_contract:persisted_run_manifest_missing");
    try { return this.#manifestForRun(run); }
    catch (error) { if (/^source_claim_contract:/.test(String(error.message))) throw error; throw new Error("source_claim_contract:current_manifest_unavailable"); }
  }

  #assertRunSourceCompleteness(run) {
    if (!run?.blueprintId || !run.sourceClaimManifestId) throw new Error("source_claim_contract:persisted_run_manifest_missing");
    this.#assertBootstrapSourceIntake(run);
    const stored = this.store.productBlueprint(run.blueprintId);
    if (!stored || stored.sourceClaimManifestId !== run.sourceClaimManifestId) throw new Error("source_claim_contract: persisted_blueprint_manifest_mismatch");
    return this.#assertStoredBlueprintSourceIntegrity(stored);
  }

  #controllerPolicyRegistry() {
    return this.config.specificationResolution?.policyRegistry ?? null;
  }

  #assertStoredBlueprintSourceIntegrity(stored, { requireManifest = true } = {}) {
    if (!requireManifest) {
      try {
        return validateControllerAuthorizedBlueprint(stored.blueprint, { sourceResolver: this.#sourceEvidenceResolver(), policyRegistry: this.#controllerPolicyRegistry(), persistedResolutionAuthority: stored.resolutionAuthority });
      } catch {
        throw new Error("source_claim_contract:persisted_blueprint_source_validation_failed");
      }
    }
    if (!stored?.sourceClaimManifestId) throw new Error("source_claim_contract:persisted_blueprint_manifest_missing");
    let sourceClaimManifest;
    try { sourceClaimManifest = this.#manifestForRun(this.store.deliveryRun(stored.deliveryRunId)); }
    catch { throw new Error("source_claim_contract:current_manifest_unavailable"); }
    if (stored.sourceClaimManifestId !== sourceClaimManifest.manifestId) throw new Error("source_claim_contract:current_manifest_mismatch");
    if (stored.blueprint.sourceClaimManifest?.digest !== sourceClaimManifest.digest) throw new Error("source_claim_contract:blueprint_manifest_digest_mismatch");
    try {
      return validateControllerAuthorizedBlueprint(stored.blueprint, { sourceResolver: this.#sourceEvidenceResolver(), policyRegistry: this.#controllerPolicyRegistry(), persistedResolutionAuthority: stored.resolutionAuthority, sourceClaimManifest });
    } catch {
      throw new Error("source_claim_contract:persisted_blueprint_source_validation_failed");
    }
  }

  #persistBlueprint(task, blueprint) {
    const root = join(this.config.repository, this.config.project.generatedDir, "blueprints");
    mkdirSync(root, { recursive: true });
    const artifactPath = join(this.config.project.generatedDir, "blueprints", `${blueprint.blueprintId}.v${blueprint.schemaVersion}.json`).split("\\").join("/");
    const absolutePath = join(this.config.repository, artifactPath);
    const serialized = `${JSON.stringify(blueprint, null, 2)}\n`;
    const digest = createHash("sha256").update(serialized).digest("hex");
    if (existsSync(absolutePath)) throw new Error(`ProductBlueprint artifact already exists and is immutable: ${artifactPath}`);
    writeFileSync(absolutePath, serialized, { encoding: "utf8", flag: "wx" });
    const run = task.deliveryRunId ? this.store.deliveryRun(task.deliveryRunId) : null;
    const sourceClaimManifest = run?.sourceClaimManifestId ? this.#manifestForRun(run) : null;
    if (sourceClaimManifest) this.store.recordSourceClaimManifest(sourceClaimManifest);
    const persisted = this.store.recordProductBlueprint({ blueprint, artifactPath, digest, bootstrapTaskId: task.id, deliveryRunId: task.deliveryRunId ?? null, sourceClaimManifestId: sourceClaimManifest?.manifestId ?? null });
    if (task.deliveryRunId) {
      const run = this.store.deliveryRun(task.deliveryRunId);
      if (run?.repositoryMode === "brownfield") {
        this.store.linkBlueprintToDelivery(task.deliveryRunId, blueprint.blueprintId);
        const draft = this.#assertRepositoryBaseline(run, { requireFinal: false });
        this.store.recordRepositoryBaseline(task.deliveryRunId, finalizeRepositoryBaseline({ draft, blueprintId: blueprint.blueprintId, blueprintDigest: persisted.digest }));
      }
    }
    return persisted;
  }

  #materializePlan(plannerTask, parsedPlan) {
    const stored = this.store.productBlueprint(plannerTask.blueprintId);
    if (!stored) throw new Error(`Planner task ${plannerTask.id} has no persisted ProductBlueprint`);
    if (plannerTask.deliveryRunId) { this.#assertRunSourceCompleteness(this.store.deliveryRun(plannerTask.deliveryRunId)); this.#assertRepositoryBaseline(this.store.deliveryRun(plannerTask.deliveryRunId)); }
    this.#assertStoredBlueprintSourceIntegrity(stored, { requireManifest: Boolean(plannerTask.deliveryRunId) });
    const planRunId = plannerTask.deliveryRunId ?? `standalone:${plannerTask.id}`;
    const scopedReplan = this.store.scopedReplans(planRunId).find((item) => item.plannerTaskId === plannerTask.id);
    const previous = this.store.currentCheckpoint(planRunId);
    // Read-only historical fixtures and already-recorded planner responses can
    // be upgraded at this boundary, but persistence is always PlanBatch v1.
    const priorBatch = scopedReplan?.priorPlanBatchId ? this.store.planBatch(scopedReplan.priorPlanBatchId) : null;
    const existingBatches = this.store.planBatches(planRunId);
    const controllerWave = scopedReplan ? Math.max(0, ...existingBatches.map((batch) => batch.wave)) + 1 : (previous ? previous.wave + 1 : 1);
    const controllerBase = scopedReplan ? (previous?.outputSha ?? scopedReplan.priorCheckpointSha ?? priorBatch?.basedOnCheckpointSha ?? gitSha(this.config.repository, this.config.baseRef)) : (previous?.outputSha ?? gitSha(this.config.repository, this.config.baseRef));
    const runProjectMode = plannerTask.deliveryRunId ? this.#assertProjectMode(this.store.deliveryRun(plannerTask.deliveryRunId)) : this.projectMode;
    const batchInput = { ...(parsedPlan ?? {}), schemaVersion: 1, kind: "PlanBatch", id: scopedReplan?.replacementPlanBatchId ?? scopedReplan?.id ?? randomUUID(), deliveryRunId: planRunId, blueprintId: stored.blueprint.blueprintId, projectMode: runProjectMode, wave: controllerWave, basedOnCheckpointSha: controllerBase, createdAt: new Date().toISOString() };
    const repositoryBaseline = plannerTask.deliveryRunId ? this.store.repositoryBaselineForRun(plannerTask.deliveryRunId) : null;
    const productRoots = runProjectMode?.mode === "greenfield" && !scopedReplan ? this.config.project.productRoots : [];
    const plan = validatePlan(normalizePlannerPlanForProject(batchInput, productRoots, runProjectMode), { maxTasks: this.config.router.maxPlanTasks, productRoots, blueprint: stored.blueprint, requirePlanBatch: true, allowPartialRequirementCoverage: true, recovery: Boolean(scopedReplan), repositoryBaseline, projectMode: runProjectMode });
    const executionTopology = compileWriteSurfaceTopology(plan.tasks, { isWorkspaceWriter: (item) => this.config.roles[item.primaryDomain]?.sandbox === "workspace-write" });
    if (plan.deliveryRunId !== planRunId) throw new Error("PlanBatch deliveryRunId must match Planner delivery run");
    if (scopedReplan) {
      // Scoped recovery receives its controller-owned wave and baseline above.
      // It deliberately does not satisfy the greenfield wave-one invariant.
    } else if (existingBatches.length) {
      const checkpoint = this.store.currentCheckpoint(plan.deliveryRunId);
      if (!checkpoint || plan.wave !== checkpoint.wave + 1 || plan.basedOnCheckpointSha !== checkpoint.outputSha) throw new Error("Next PlanBatch requires successful reconciliation of the current verified checkpoint");
      if (plan.wave > (this.config.delivery?.maxWaves ?? 8)) throw new Error("max_waves_exhausted");
    } else if (plan.wave !== 1 || plan.basedOnCheckpointSha !== gitSha(this.config.repository, this.config.baseRef)) {
      throw new Error("PlanBatch wave 1 must use the controller verified repository baseline");
    }
    const orderedPlanIds = new Map();
    const pending = [...plan.tasks];
    const dispatch = [];
    while (pending.length) {
      const readyIndex = pending.findIndex((item) => item.dependsOn.every((dependency) => orderedPlanIds.has(dependency)));
      if (readyIndex === -1) throw new Error("Unable to topologically order the validated plan");
      const [item] = pending.splice(readyIndex, 1);
      const securityRequired = item.supportingDomains.includes("security") || item.riskFlags.some((flag) => ["auth_or_authorization", "secret_handling", "sensitive_data", "network_exposure", "permission_change", "dependency_supply_chain"].includes(flag));
      const elevatedGate = !this.isAutonomous() && (item.humanApprovalRequired || securityRequired || item.riskFlags.some((flag) => ["schema_change", "destructive_data_change", "irreversible_operation", "permission_change"].includes(flag)));
      if (!this.config.roles[item.primaryDomain]) throw new Error(`No role configuration for planned domain ${item.primaryDomain}`);
      dispatch.push({ item, securityRequired, elevatedGate, dependencyPlanIds: [...item.dependsOn] });
      orderedPlanIds.set(item.id, true);
    }
    const needsSupport = dispatch.some(({ item, securityRequired }) => this.config.roles[item.primaryDomain]?.sandbox === "workspace-write" || (securityRequired && item.primaryDomain !== "security") || (item.supportingDomains.includes("qa") && item.primaryDomain !== "qa"));
    const plannerDepth = depthOf(plannerTask, (id) => this.store.getTask(id));
    if (plannerDepth + 1 > this.config.router.maxDelegationDepth || (needsSupport && plannerDepth + 2 > this.config.router.maxDelegationDepth)) throw new Error("Validated plan exceeds delegation depth limit");
    if (this.store.childCount(plannerTask.id) + dispatch.length > this.config.router.maxChildrenPerTask) throw new Error("Validated plan exceeds child task limit");
    if (needsSupport && this.config.router.maxChildrenPerTask < 1) throw new Error("Validated plan requires support tasks but child task limit is zero");

    const assertRoute = (role, estimatedTokens) => {
      const roleConfig = this.config.roles[role];
      if (!roleConfig) throw new Error(`No role configuration for routed domain ${role}`);
      if (!Number.isInteger(estimatedTokens) || estimatedTokens < 1 || estimatedTokens > roleConfig.tokenBudget) throw new Error(`Invalid routed token estimate for ${role}`);
      return roleConfig;
    };
    const primaryIds = new Map(dispatch.map(({ item }) => [item.id, randomUUID()]));
    const scaffoldTaskId = primaryIds.get("scaffold-product") ?? null;
    const primaryRoleByTaskId = new Map(dispatch.map(({ item }) => [primaryIds.get(item.id), item.primaryDomain]));
    const specs = [];
    // Build and validate the whole dispatch graph before making one atomic
    // StateStore write. This prevents a rejected route from leaving a partial DAG.
    for (const { item, elevatedGate, securityRequired, dependencyPlanIds } of dispatch) {
      const primary = assertRoute(item.primaryDomain, item.estimatedTokens);
      const primaryId = primaryIds.get(item.id);
      const dependencies = [plannerTask.id, ...dependencyPlanIds.map((dependency) => primaryIds.get(dependency))];
      if (scaffoldTaskId && item.id !== "scaffold-product" && primary.sandbox === "workspace-write" && !dependencies.includes(scaffoldTaskId)) dependencies.push(scaffoldTaskId);
      const executionDependencies = executionTopology.get(item.id)?.executionDependencies.map((dependency) => primaryIds.get(dependency)) ?? [];
      const writerPredecessors = this.#effectiveWriterPredecessorIds({ dependencies: dependencies.filter((dependency) => dependency !== plannerTask.id), executionDependencies }, { taskForId: (id) => ({ role: primaryRoleByTaskId.get(id) }) });
      const fanIn = writerPredecessors.length > 1;
      const prompt = item.id === "scaffold-product" && runProjectMode?.mode === "greenfield"
        ? "[[product-scaffold]]\nController-owned scaffold contract: create every declared product root now. frontend/ must be a runnable Next.js application with package.json, npm lockfile, build and test scripts. backend/ must be an ASP.NET Core Web API solution with an xUnit test project. Do not create placeholders, plans, or a partial root. Run the declared checks after files are written."
        : item.prompt;
      specs.push({ id: primaryId, role: item.primaryDomain, parentTaskId: plannerTask.id, title: item.title, prompt, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, baselineBehaviorIds: item.baselineBehaviorIds ?? [], dependencies, executionDependencies, executionTopologyVersion: 1, executionIsWriter: primary.sandbox === "workspace-write", executionReleaseState: primary.sandbox === "workspace-write" ? "pending" : null, estimatedTokens: item.estimatedTokens, tokenBudget: primary.tokenBudget, maxAttempts: 1, humanApprovalRequired: elevatedGate, riskFlags: item.riskFlags, supportingDomains: item.supportingDomains, artifactBaseSha: primary.sandbox === "workspace-write" ? plan.basedOnCheckpointSha : null, artifactDependencies: fanIn ? [] : writerPredecessors, integrationBarrierId: fanIn ? `pending:${primaryId}` : null, blueprintId: stored.blueprint.blueprintId, requirementIds: item.requirementIds, deliveryRunId: planRunId, planBatchId: plan.id, wave: plan.wave });
      let predecessorId = primaryId;
      const mandatoryReview = primary.sandbox === "workspace-write";
      if (mandatoryReview || securityRequired) {
        const estimate = Math.min(this.config.roles.security?.tokenBudget ?? 0, Math.max(1000, Math.ceil(item.estimatedTokens * 0.35)));
        const security = assertRoute("security", estimate);
        predecessorId = randomUUID();
        specs.push({ id: predecessorId, role: "security", parentTaskId: primaryId, title: `Security review: ${item.title}`, prompt: `Review finalized writer artifact '${item.title}' for declared risk flags: ${item.riskFlags.join(", ") || "none"}. Return the required SecurityGateReport only.`, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, baselineBehaviorIds: item.baselineBehaviorIds ?? [], dependencies: [primaryId], executionDependencies: [], executionTopologyVersion: 1, executionIsWriter: false, estimatedTokens: estimate, tokenBudget: security.tokenBudget, maxAttempts: 1, humanApprovalRequired: false, riskFlags: item.riskFlags, supportingDomains: ["security"], sourceWriterTaskId: primaryId, blueprintId: stored.blueprint.blueprintId, requirementIds: item.requirementIds, deliveryRunId: planRunId, planBatchId: plan.id, wave: plan.wave });
      }
      if (mandatoryReview || item.supportingDomains.includes("qa")) {
        const estimate = Math.min(this.config.roles.qa?.tokenBudget ?? 0, Math.max(1000, Math.ceil(item.estimatedTokens * 0.4)));
        const qa = assertRoute("qa", estimate);
        specs.push({ id: randomUUID(), role: "qa", parentTaskId: predecessorId, title: `QA: ${item.title}`, prompt: `Verify finalized writer artifact '${item.title}' against acceptance checks. Return the required QualityGateReport only.`, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, baselineBehaviorIds: item.baselineBehaviorIds ?? [], dependencies: [predecessorId], executionDependencies: [], executionTopologyVersion: 1, executionIsWriter: false, estimatedTokens: estimate, tokenBudget: qa.tokenBudget, maxAttempts: 1, humanApprovalRequired: false, riskFlags: item.riskFlags, supportingDomains: ["qa"], sourceWriterTaskId: primaryId, blueprintId: stored.blueprint.blueprintId, requirementIds: item.requirementIds, deliveryRunId: planRunId, planBatchId: plan.id, wave: plan.wave });
      }
    }
    const replacements = scopedReplan ? scopedReplan.affectedTaskIds.map((oldTaskId) => {
      const old = this.store.getTask(oldTaskId);
      const replacement = specs.find((candidate) => candidate.role === old?.role && candidate.requirementIds.some((id) => old.requirementIds.includes(id))) ?? specs.find((candidate) => candidate.role === old?.role);
      return { oldTaskId, replacementTaskId: replacement?.id ?? null, kind: old?.integrationBarrierId ? "barrier-consumer" : "task" };
    }) : [];
    this.store.createPlanBatch(plan, specs, scopedReplan ? { replanId: scopedReplan.id, replacements } : undefined);
  }

  async #refreshProjectOverlayFromWorktree(worktree) {
    return generateProjectOverlay({ repository: this.config.repository, inspectionRoot: worktree, baseRef: this.config.baseRef, generatedDir: this.config.project.generatedDir, project: this.config.project });
  }

  #isScaffoldTask(task) { return task.prompt.startsWith("[[product-scaffold]]") && this.store.deliveryRun(task.deliveryRunId)?.projectMode?.mode === "greenfield"; }

  // This is the controller's sole writer-lineage derivation. Keep logical
  // order first, then topology order: both are immutable controller inputs
  // and this preserves the existing effective integration traversal order.
  #effectiveWriterPredecessorIds(task, { taskForId = (id) => this.store.getTask(id) } = {}) {
    const seen = new Set();
    const ids = [];
    for (const id of [...(task.dependencies ?? []), ...(task.executionDependencies ?? [])]) {
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      seen.add(id);
      const predecessor = taskForId(id);
      if (predecessor && this.config.roles[predecessor.role]?.sandbox === "workspace-write") ids.push(id);
    }
    return ids;
  }

  #diagnoseDependencyDeadlock() {
    const tasks = this.store.listTasks();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const problems = [];
    const add = (task, code, predecessorId = null) => {
      if (problems.some((item) => item.taskId === task.id && item.code === code && item.predecessorId === predecessorId)) return;
      problems.push({ taskId: task.id, code, ...(predecessorId ? { predecessorId } : {}) });
    };
    const hasCycle = (startId, id, visiting = new Set(), seen = new Set()) => {
      if (id === startId && visiting.size) return true;
      if (visiting.has(id) || seen.has(id)) return false;
      visiting.add(id);
      const node = byId.get(id);
      const cycle = Boolean(node && this.#effectiveWriterPredecessorIds(node, { taskForId: (candidate) => byId.get(candidate) }).some((parent) => hasCycle(startId, parent, visiting, seen)));
      visiting.delete(id); seen.add(id);
      return cycle;
    };
    for (const task of tasks) {
      if (task.status !== "queued" || !ENGINEERING_DOMAINS.has(task.role)) continue;
      const rawIds = [...(task.dependencies ?? []), ...(task.executionDependencies ?? [])];
      for (const id of rawIds) if (!byId.has(id)) add(task, "missing_predecessor", id);
      if (task.planBatchId && (task.executionTopologyVersion !== 1 || !Array.isArray(task.executionDependencies))) add(task, "legacy_execution_topology");
      const parents = this.#effectiveWriterPredecessorIds(task, { taskForId: (id) => byId.get(id) });
      if (!parents.length) continue;
      if (hasCycle(task.id, task.id)) add(task, "cyclic_writer_predecessor");
      for (const id of parents) {
        const predecessor = byId.get(id);
        if (!predecessor || ["failed", "cancelled", "blocked_budget", "blocked_specification", "interrupted"].includes(predecessor.status)) add(task, "unreachable_writer_predecessor", id);
        // A non-terminal predecessor can be waiting for its own review or a
        // controller fan-in barrier. That is normal scheduler progress, not a
        // deadlock; only immutable absence/terminal failure is integrity-blocked.
        else if (predecessor.status !== "done" || predecessor.executionReleaseState !== "released") continue;
        else if (!this.store.workerArtifact(id)) add(task, "missing_writer_artifact", id);
      }
      if (parents.length > 1) {
        const barrier = String(task.integrationBarrierId ?? "").startsWith("pending:") ? null : this.store.integrationBarrier(task.integrationBarrierId);
        if (!task.integrationBarrierId || (!barrier && !String(task.integrationBarrierId).startsWith("pending:"))) add(task, "missing_integration_barrier");
        else if (barrier && barrier.status === "failed") add(task, "unreachable_integration_barrier");
      }
    }
    if (!problems.length) return null;
    const bounded = problems.slice(0, 25);
    return { outcome: "dependency_deadlock", classification: "integrity-blocked", taskIds: [...new Set(bounded.map((item) => item.taskId))], reasons: bounded };
  }

  #persistDependencyDeadlock(outcome) {
    const stored = this.store.recordDependencyDeadlock({ id: randomUUID(), deliveryRunId: this.activeDeliveryRunId, outcome });
    if (this.activeDeliveryRunId) this.store.updateDeliveryRun(this.activeDeliveryRunId, { state: "failed", publish: { reason: "dependency_deadlock", classification: "integrity-blocked", taskIds: outcome.taskIds, reasons: outcome.reasons } });
    this.#lifecycle("dependency deadlock", { taskIds: outcome.taskIds, reasons: outcome.reasons });
    return { ...outcome, recordId: stored.id };
  }

  async #failFastAfterTaskFailure(client, scheduler, failedTaskId, error) {
    if (scheduler.failed) return;
    scheduler.failed = true;
    const active = [...this.activeTurns.values()].filter((item) => item.taskId !== failedTaskId);
    this.#lifecycle("delivery fail-fast", { taskId: failedTaskId, error: String(error).slice(0, 300), interruptedTasks: active.map((item) => item.taskId) });
    await Promise.allSettled(active.map((turn) => this.#interruptAndAwaitTurn(client, turn, "delivery_fail_fast", { timeoutMs: this.config.delivery?.shutdownGraceMs ?? 3_000 })));
  }

  #connectArtifactDependents(predecessor, artifact) {
    for (const task of this.store.listTasks()) {
      if (task.id === predecessor.id || !this.#effectiveWriterPredecessorIds(task).includes(predecessor.id) || this.config.roles[task.role]?.sandbox !== "workspace-write") continue;
      const writerPredecessors = this.#effectiveWriterPredecessorIds(task);
      if (writerPredecessors.length === 1 && !task.integrationBarrierId) this.store.setArtifactLineage(task.id, { artifactBaseSha: artifact.headSha, artifactDependencies: writerPredecessors });
    }
  }
  _assertWriterArtifactLineage(task) {
    const writerPredecessors = this.#effectiveWriterPredecessorIds(task);
    if (writerPredecessors.length > 1) {
      const barrier = this.store.integrationBarrier(task.integrationBarrierId);
      const checkpoint = task.localCheckpointId ? this.store.integrationCheckpoint(task.localCheckpointId) : null;
      if (!barrier || barrier.status !== "passed" || !checkpoint) throw new Error(`Writer task ${task.id} has a missing, legacy, invalid IntegrationBarrier checkpoint`);
      const expectedInputs = writerPredecessors.map((id) => {
        const artifact = this.store.workerArtifact(id);
        return artifact ? { artifactId: id, headSha: artifact.headSha } : null;
      });
      validateLocalIntegrationCheckpoint(checkpoint);
      if (expectedInputs.some((input) => !input) || JSON.stringify(barrier.inputArtifacts) !== JSON.stringify(expectedInputs) || JSON.stringify(checkpoint.inputArtifacts) !== JSON.stringify(expectedInputs) || checkpoint.barrierId !== barrier.id || !checkpoint.consumerTaskIds.includes(task.id) || task.artifactBaseSha !== checkpoint.outputSha || (task.artifactDependencies ?? []).length) throw new Error(`Writer task ${task.id} has incomplete local checkpoint lineage`);
      return;
    }
    if (!writerPredecessors.length) {
      if ((task.artifactDependencies ?? []).length) throw new Error(`Writer task ${task.id} has unexpected artifact lineage without an effective writer predecessor`);
      return;
    }
    const predecessorId = writerPredecessors[0];
    const predecessor = this.store.workerArtifact(predecessorId);
    if (!predecessor) throw new Error(`Writer task ${task.id} cannot start before predecessor ${predecessorId} has a WorkerArtifact`);
    if (task.artifactBaseSha !== predecessor.headSha || task.artifactDependencies.length !== 1 || task.artifactDependencies[0] !== predecessorId) {
      throw new Error(`Writer task ${task.id} is missing artifact lineage from predecessor ${predecessorId}`);
    }
  }

  async #runReadyIntegrationBarriers() {
    let progressed = false;
    const tasks = this.store.listTasks();
    for (const task of tasks) {
      if (this.config.roles[task.role]?.sandbox !== "workspace-write" || !String(task.integrationBarrierId ?? "").startsWith("pending:") || task.status !== "queued") continue;
      const parentIds = this.#effectiveWriterPredecessorIds(task);
      if (parentIds.length < 2) continue;
      const artifacts = parentIds.map((id) => this.store.workerArtifact(id));
      if (artifacts.some((artifact) => !artifact)) continue;
      const barrier = { schemaVersion: 1, kind: "IntegrationBarrier", id: randomUUID(), deliveryRunId: task.deliveryRunId, blueprintId: task.blueprintId, wave: task.wave, baseSha: task.artifactBaseSha, inputArtifacts: artifacts.map((artifact) => ({ artifactId: artifact.taskId, headSha: artifact.headSha })), status: "pending", createdAt: new Date().toISOString() };
      this.store.createIntegrationBarrier(barrier);
      this.store.setIntegrationBarrier(task.id, barrier.id);
      progressed = true;
    }
    for (const pending of this.store.readyIntegrationBarriers(this.activeDeliveryRunId)) {
      const barrier = this.store.claimIntegrationBarrier(pending.id);
      if (!barrier) continue;
      progressed = true;
      const consumers = this.store.listTasks().filter((item) => item.integrationBarrierId === barrier.id && item.status === "queued");
      const consumer = consumers[0];
      // A persisted barrier can be independently valid at a crash boundary
      // before it is linked to a fan-in consumer. Its immutable inputs remain
      // the authoritative lineage in that case; do not bypass the integrator
      // (or its managed-worktree ownership record) merely because no consumer
      // is present yet.
      const parentIds = consumer ? this.#effectiveWriterPredecessorIds(consumer) : barrier.inputArtifacts.map((input) => input.artifactId);
      const artifacts = parentIds.map((id) => this.store.workerArtifact(id));
      const expectedInputs = artifacts.map((artifact) => ({ artifactId: artifact?.taskId, headSha: artifact?.headSha }));
      if ((consumer && parentIds.length < 2) || artifacts.some((artifact) => !artifact) || JSON.stringify(barrier.inputArtifacts) !== JSON.stringify(expectedInputs)) {
        this.store.failIntegrationBarrier(barrier.id, "integration_barrier_input_integrity");
        continue;
      }
      const resolved = this.#resolveEffectiveLineage(parentIds, { baseSha: barrier.baseSha });
      const result = await new Integrator({ ...this.config, processRunner: this.processRunner, worktrees: this.worktrees, deliveryRunId: barrier.deliveryRunId }).integrateBarrier({ barrier, artifacts, effectiveArtifacts: resolved.artifacts, effectiveLineage: resolved.lineage, allowedBaseShas: resolved.allowedBaseShas, overlay: this.#workerOverlayContext().overlay });
      if (result.status !== "passed") {
        this.store.failIntegrationBarrier(barrier.id, result.error);
        const consumer = this.store.listTasks().find((item) => item.integrationBarrierId === barrier.id);
        if (consumer) this.#recordScopedFailure(consumer, result.error, "barrier_failure", { barrierId: barrier.id, inputArtifacts: barrier.inputArtifacts });
        continue;
      }
      const checkpoint = { schemaVersion: 2, kind: "LocalIntegrationCheckpoint", id: randomUUID(), deliveryRunId: barrier.deliveryRunId, blueprintId: barrier.blueprintId, wave: barrier.wave, baseSha: barrier.baseSha, inputArtifacts: expectedInputs, outputSha: result.outputSha, verificationResults: result.verificationResults, status: "passed", barrierId: barrier.id, effectiveLineage: resolved.lineage, consumerTaskIds: consumers.map((task) => task.id), createdAt: new Date().toISOString() };
      this.store.recordLocalIntegrationCheckpoint(checkpoint);
      this.#lifecycle("integration barrier checkpointed", { barrierId: barrier.id, checkpointId: checkpoint.id, outputSha: checkpoint.outputSha });
    }
    return progressed;
  }

  #resolveEffectiveLineage(taskIds, { baseSha = null } = {}) {
    const tasks = new Map(this.store.listTasks().map((task) => [task.id, task]));
    const artifacts = [], lineage = [], seenArtifacts = new Set(), seenCheckpoints = new Set(), visitingTasks = new Set(), allowedBaseShas = new Set();
    let resolvedBase = baseSha;
    const addCheckpoint = (checkpointId) => {
      if (seenCheckpoints.has(checkpointId)) return;
      const checkpoint = this.store.integrationCheckpoint(checkpointId);
      if (!checkpoint || checkpoint.kind !== "LocalIntegrationCheckpoint") throw new Error(`Local checkpoint ${checkpointId} is missing, legacy, or invalid`);
      const barrier = this.store.integrationBarrier(checkpoint.barrierId);
      if (!barrier || barrier.status !== "passed" || barrier.checkpointId !== checkpoint.id || barrier.deliveryRunId !== checkpoint.deliveryRunId || JSON.stringify(barrier.inputArtifacts) !== JSON.stringify(checkpoint.inputArtifacts)) throw new Error(`Local checkpoint ${checkpointId} has mismatched barrier linkage`);
      for (const node of checkpoint.effectiveLineage) {
        const evidence = node.kind === "artifact" ? this.store.workerArtifact(node.id) : this.store.integrationCheckpoint(node.id);
        const evidenceSha = node.kind === "artifact" ? evidence?.headSha : evidence?.outputSha;
        if (!evidence || evidenceSha !== node.sha) throw new Error(`Local checkpoint ${checkpointId} has missing or tampered effective lineage evidence`);
      }
      seenCheckpoints.add(checkpointId); allowedBaseShas.add(checkpoint.outputSha);
      for (const input of checkpoint.inputArtifacts) {
        const artifact = this.store.workerArtifact(input.artifactId);
        if (!artifact || artifact.headSha !== input.headSha) throw new Error(`Local checkpoint ${checkpointId} has a missing or tampered input`);
        visit(input.artifactId);
      }
      lineage.push({ kind: "checkpoint", id: checkpoint.id, sha: checkpoint.outputSha });
    };
    const visit = (taskId) => {
      if (seenArtifacts.has(taskId)) return;
      if (visitingTasks.has(taskId)) throw new Error("Effective lineage contains a cycle");
      const task = tasks.get(taskId), artifact = this.store.workerArtifact(taskId);
      if (!task || !artifact || task.status !== "done") throw new Error(`Effective lineage input ${taskId} is missing or unfinished`);
      visitingTasks.add(taskId);
      if (this.config.roles[task.role]?.sandbox === "workspace-write") this._assertWriterArtifactLineage(task);
      if (task.localCheckpointId) {
        const checkpoint = this.store.integrationCheckpoint(task.localCheckpointId);
        if (!checkpoint || !checkpoint.consumerTaskIds.includes(task.id) || task.artifactBaseSha !== checkpoint.outputSha) throw new Error(`Task ${task.id} has incomplete local checkpoint lineage`);
        addCheckpoint(task.localCheckpointId);
      }
      for (const dependency of this.#effectiveWriterPredecessorIds(task)) visit(dependency);
      if (!resolvedBase) resolvedBase = task.planBatchId ? this.store.planBatch(task.planBatchId)?.basedOnCheckpointSha : artifact.baseSha;
      seenArtifacts.add(taskId); artifacts.push(artifact); lineage.push({ kind: "artifact", id: artifact.taskId, sha: artifact.headSha }); visitingTasks.delete(taskId);
    };
    for (const id of taskIds) visit(id);
    if (!resolvedBase || !artifacts.length) throw new Error("Effective lineage has no immutable baseline or artifacts");
    return { artifacts, lineage, baseSha: resolvedBase, allowedBaseShas: [...allowedBaseShas] };
  }

  #persistGlobalWaveCheckpoint(deliveryRunId, result) {
    if (!deliveryRunId) return;
    const wave = Math.max(...this.store.planBatches(deliveryRunId).map((batch) => batch.wave), 0);
    const writers = this.store.listTasks().filter((task) => task.deliveryRunId === deliveryRunId && task.wave === wave && this.config.roles[task.role]?.sandbox === "workspace-write" && task.status === "done");
    if (!wave || !writers.length || this.store.globalWaveCheckpoint(deliveryRunId, wave)) return;
    const batch = this.store.planBatch(writers[0]?.planBatchId);
    const checkpoint = { schemaVersion: 2, kind: "GlobalWaveCheckpoint", id: randomUUID(), deliveryRunId, blueprintId: writers[0]?.blueprintId, wave, baseSha: batch?.basedOnCheckpointSha ?? result.manifest.baseSha, inputArtifacts: result.manifest.effectiveLineage.filter((item) => item.kind === "artifact").map((item) => ({ artifactId: item.id, headSha: item.sha })), outputSha: result.manifest.candidateSha, verificationResults: result.manifest.verificationResults, status: "passed", effectiveLineage: result.manifest.effectiveLineage, createdAt: new Date().toISOString() };
    this.store.recordGlobalWaveCheckpoint(checkpoint);
  }

  #failureKind(task, detail) {
    if (/verification failed|finalize/i.test(String(detail))) return "verification_failure";
    if (task.role === "qa") return "quality_gate_failure";
    if (task.role === "security") return "security_gate_failure";
    return "worker_failure";
  }

  #blockScopedPlanner(task, status, detail) {
    const replan = task.deliveryRunId ? this.store.scopedReplans(task.deliveryRunId).find((item) => item.plannerTaskId === task.id) : null;
    if (replan) this.store.blockScopedReplan(replan.id, status, detail);
  }

  // Controller-facing typed entry point for adapters that detect an immutable
  // dependency contract drift after planning.  It deliberately has no generic
  // adapter policy: callers supply the task that owns the contract.
  recordDependencyContractChange(taskId, detail) {
    const task = this.store.getTask(taskId); if (!task) throw new Error(`Task not found: ${taskId}`);
    if (["running", "preparing", "awaiting_review", "awaiting_approval"].includes(task.status)) this.store.transition(task.id, "failed", { error: String(detail).slice(0, 1200) });
    return this.#recordScopedFailure(task, detail, "dependency_contract_change");
  }

  #resumeScopedReplans() {
    if (!this.activeDeliveryRunId) return;
    for (const active of this.store.activeScopedReplans(this.activeDeliveryRunId)) {
      const claimed = active.status === "pending" ? this.store.claimScopedReplan(active.id) : active;
      if (!claimed || claimed.status !== "planning" || claimed.plannerTaskId) continue;
      const stored = this.store.productBlueprint(claimed.blueprintId);
      if (!stored) { this.store.blockScopedReplan(claimed.id, "fatal", "Persisted ProductBlueprint is unavailable"); continue; }
      const run = this.store.deliveryRun(claimed.deliveryRunId);
      try { this.#assertRunSourceCompleteness(run); }
      catch (error) {
        const reason = this.#safeSpecificationReason(error);
        this.store.blockScopedReplan(claimed.id, "blocked_specification", reason);
        if (run) this.blockRunForSourceCompleteness(run, error);
        continue;
      }
      try { this.#assertRepositoryBaseline(run); }
      catch (error) { this.store.blockScopedReplan(claimed.id, "fatal", this.#safeRepositoryBaselineReason(error)); this.blockRunForRepositoryBaseline(run, error); continue; }
      const planner = this.enqueue({
        role: "planner", title: `Scoped recovery plan ${claimed.id.slice(0, 8)}`,
        prompt: this.#scopedPlannerPrompt(claimed), blueprintId: claimed.blueprintId, deliveryRunId: claimed.deliveryRunId,
        // Planner is allowed to carry no direct requirements; it plans the
        // controller-provided remaining immutable requirement subset.
        requirementIds: []
      });
      this.store.attachScopedReplanPlanner(claimed.id, planner.id);
      this.#lifecycle("scoped replan planner queued", { replanId: claimed.id, plannerTaskId: planner.id, attempt: claimed.attempt });
    }
  }

  #scopedPlannerPrompt(replan) {
    return `Scoped recovery only. Do not create Bootstrap or re-plan the entire product DAG. Controller-owned recovery context follows; it is authoritative and sanitized:\n${JSON.stringify({ replanId: replan.id, failedTaskId: replan.failedTaskId, failureKind: replan.failureKind, failureDetail: replan.failureDetail, affectedTaskIds: replan.affectedTaskIds, invalidatedTaskIds: replan.invalidatedTaskIds, preservedArtifacts: replan.preservedArtifacts, priorCheckpointId: replan.priorCheckpointId, priorCheckpointSha: replan.priorCheckpointSha, remainingRequirementIds: replan.remainingRequirementIds, priorContext: replan.priorContext, maxAttempts: replan.maxAttempts })}\nReturn only the replacement PlanBatch JSON. Include only work needed for the affected scope. The controller assigns the immutable batch id, delivery run, wave, and base SHA.`;
  }

  #recordScopedFailure(task, detail, failureKind = "worker_failure", context = {}) {
    if (!task.deliveryRunId || !task.blueprintId) { this.#lifecycle("scoped replan required", { failedTaskId: task.id, failureKind, invalidatedTaskIds: [], reason: String(detail).slice(0, 300), unavailable: "missing immutable delivery/blueprint contract" }); return null; }
    const tasks = this.store.listTasks().filter((item) => item.deliveryRunId === task.deliveryRunId);
    const affected = new Set([task.id]);
    // Dependency edges are not the only execution edges: reviews, remediation
    // parent chains and fan-in barrier consumers must be replaced together.
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of tasks) {
        const touches = candidate.dependencies.some((id) => affected.has(id)) || (candidate.executionDependencies ?? []).some((id) => affected.has(id)) || affected.has(candidate.sourceWriterTaskId) || (candidate.parentTaskId && affected.has(candidate.parentTaskId)) || (candidate.integrationBarrierId && context.barrierId === candidate.integrationBarrierId);
        if (!affected.has(candidate.id) && touches) { affected.add(candidate.id); changed = true; }
      }
    }
    const affectedTaskIds = [...affected];
    const invalidatedTaskIds = affectedTaskIds.filter((id) => id !== task.id);
    const preservedArtifacts = tasks.filter((item) => !affected.has(item.id)).map((item) => this.store.workerArtifact(item.id)).filter(Boolean).map((artifact) => ({ taskId: artifact.taskId, headSha: artifact.headSha, baseSha: artifact.baseSha }));
    const checkpoint = this.store.currentCheckpoint(task.deliveryRunId);
    const priorBatch = task.planBatchId ? this.store.planBatch(task.planBatchId) : null;
    const remainingRequirementIds = [...new Set(tasks.filter((item) => affected.has(item.id)).flatMap((item) => item.requirementIds))];
    const keySource = `${task.deliveryRunId}:${task.id}:${failureKind}:${task.planBatchId ?? "none"}:${context.barrierId ?? ""}`;
    const idempotencyKey = createHash("sha256").update(keySource).digest("hex");
    const id = randomUUID();
    const replanId = this.store.recordScopedReplan({ id, deliveryRunId: task.deliveryRunId, blueprintId: task.blueprintId, failedTaskId: task.id, failureKind, failureDetail: detail, affectedTaskIds, invalidatedTaskIds, preservedArtifacts, priorPlanBatchId: task.planBatchId, priorCheckpointId: checkpoint?.checkpointId ?? null, priorCheckpointSha: checkpoint?.outputSha ?? priorBatch?.basedOnCheckpointSha ?? null, remainingRequirementIds, priorContext: { failureReference: context, priorPlanBatchId: task.planBatchId ?? null }, maxAttempts: this.config.delivery?.maxScopedReplanAttempts ?? 2, idempotencyKey, status: "pending", createdAt: new Date().toISOString() });
    this.#lifecycle("scoped replan required", { replanId, failedTaskId: task.id, failureKind, affectedTaskIds, invalidatedTaskIds, reason: String(detail).slice(0, 300) });
    return this.store.scopedReplan(replanId);
  }
  #inheritedWorktree(task) {
    let parent = task.parentTaskId ? this.store.getTask(task.parentTaskId) : null;
    while (parent) {
      if (parent.worktree) return { worktree: parent.worktree, branch: parent.branch };
      parent = parent.parentTaskId ? this.store.getTask(parent.parentTaskId) : null;
    }
    return null;
  }

  #validateDependencies(dependencies) {
    if (!Array.isArray(dependencies)) throw new Error("dependencies must be an array");
    for (const taskId of dependencies) {
      if (typeof taskId !== "string" || !this.store.getTask(taskId)) throw new Error(`Dependency task not found: ${taskId}`);
    }
  }

  #onProviderLifecycle(event) {
    let normalized;
    try { normalized = validateLifecycleEvent(event); }
    catch (error) { this.#lifecycle("execution provider protocol violation", { errorCode: error.errorCode ?? "protocol_violation" }); return; }
    if (normalized.providerGlobal) {
      if (normalized.kind === "account_updated" && normalized.success) this.account.onRateLimitsUpdated({ rateLimits: normalized.data.rateLimits ?? {} });
      else if (normalized.kind === "process_exit") {
        this.#lifecycle("execution provider lifecycle failure", { errorCode: normalized.errorCode ?? "process_exit" });
        if (!this.stopRequested && !this.expectedClientShutdown && this.activeDeliveryRunId) this.#markInterrupted("interrupted_controller_exit: execution provider process exited");
      }
      return;
    }
    const data = normalized.data;
    const mappedTaskId = this.threadTasks.get(data.threadId);
    const mappedActive = mappedTaskId ? this.activeTurns.get(mappedTaskId) : null;
    // A mismatched thread cannot be looked up through threadTasks.  Correlation
    // is nevertheless controller-issued and identifies the active turn that
    // must be stopped.  This is deliberately only used for active ownership;
    // unknown/stale events remain diagnostics-only.
    const correlatedActive = [...this.activeTurns.values()].find((candidate) => candidate.correlationId === normalized.correlationId) ?? null;
    const active = mappedActive ?? correlatedActive;
    const taskId = mappedTaskId ?? active?.taskId ?? null;
    const task = taskId ? this.store.getTask(taskId) : null;
    const permitted = normalized.kind === "turn_alias"
      ? active?.permittedTurnIds?.has(data.requestedTurnId)
      : active?.permittedTurnIds?.has(data.turnId) || active?.turnId === data.turnId;
    const validActiveEvent = Boolean(taskId && active && task?.status === "running" && active.correlationId === normalized.correlationId && active.threadId === data.threadId && permitted);
    if (!validActiveEvent) {
      if (active && task?.status === "running") this.#handleActiveProtocolViolation(active);
      else {
        this.#lifecycle("execution provider protocol violation", { errorCode: "protocol_violation" });
        if (normalized.kind === "approval_requested" && !taskId) this.#settleUnownedApproval(data);
      }
      return;
    }
    if (normalized.kind === "turn_alias") {
      if (!active.permittedTurnIds.has(data.requestedTurnId) || data.turnId !== data.resolvedTurnId) { this.#handleActiveProtocolViolation(active); return; }
      active.permittedTurnIds.add(data.resolvedTurnId);
      this.activeTurns.set(taskId, { ...active, turnId: data.resolvedTurnId, permittedTurnIds: active.permittedTurnIds });
      this.#adoptResolvedTurnId(taskId, data.threadId, data.resolvedTurnId);
      return;
    }
    if (normalized.kind === "usage_updated") {
      const reportedTokenUsed = this.governor.normalizeUsage({ tokenUsage: { last: data.usage } });
      this.store.setTokenUsage(taskId, reportedTokenUsed, { source: "turn_last" });
      const tokenUsed = this.store.getTask(taskId)?.tokenUsed ?? reportedTokenUsed;
      const watchdog = this.#enforceUsageBudget(taskId, tokenUsed)
        .catch((error) => this.#lifecycle("budget watchdog failed", { taskId, error: String(error.message).slice(0, 300) }))
        .finally(() => this.pendingBudgetWatchdogs.delete(watchdog));
      this.pendingBudgetWatchdogs.add(watchdog);
      this.#lifecycle("token usage updated", { taskId, threadId: data.threadId, turnId: data.turnId });
      return;
    }
    if (normalized.kind === "approval_requested") { this.#handleApprovalRequest(taskId, data, normalized.correlationId).catch((error) => this.#lifecycle("approval response failed", { taskId, errorCode: error.errorCode ?? "transport_failure" })); return; }
    if (["item_started", "item_completed", "turn_completed"].includes(normalized.kind)) this.#lifecycle(normalized.kind.replace("_", " "), { taskId, threadId: data.threadId, turnId: data.turnId, itemType: data.itemType ?? null, itemStatus: data.itemStatus ?? data.terminalClass ?? null });
  }

  #handleActiveProtocolViolation(active) {
    const task = this.store.getTask(active.taskId);
    if (!task || task.status !== "running" || active.protocolViolationHandled) return;
    // Transition before awaiting provider work so a racing completion cannot
    // persist output, gate evidence, artifacts, or a final task success.
    active.protocolViolationHandled = true;
    this.activeTurns.set(active.taskId, active);
    this.store.transition(active.taskId, "interrupted", { error: "protocol_violation: task lifecycle identity mismatch" });
    this.#lifecycle("execution provider protocol violation", { taskId: active.taskId, errorCode: "protocol_violation" });
    this.#interruptAndAwaitTurn(this.activeClient, active, "protocol_violation", { timeoutMs: this.config.delivery?.shutdownGraceMs ?? 3_000 }).catch(() => {});
  }

  #settleUnownedApproval(data) {
    // The controller owns no task for this request.  Still settle the
    // provider-side request and stop the identifiable orphan without creating
    // a task or storing any raw approval payload.
    const client = this.activeClient;
    if (!client || typeof data?.requestId !== "string") return;
    this.#provider(client, "approval_response", { requestId: data.requestId, response: { decision: "cancel" } }, ["requestId"])
      .catch(() => {})
      .finally(() => this.#interruptAndAwaitTurn(client, { taskId: null, threadId: data.threadId, turnId: data.turnId }, "unowned_approval", { timeoutMs: this.config.delivery?.shutdownGraceMs ?? 3_000 }).catch(() => {}));
  }

  async #handleApprovalRequest(taskId, data, correlationId) {
    const task = this.store.getTask(taskId); if (!task || task.status !== "running") return;
    const method = data.approvalKind ?? "unknown";
    this.store.recordApproval({ requestId: data.requestId, taskId, method, payload: { threadId: data.threadId, turnId: data.turnId, kind: method }, decision: "deny" });
    this.#lifecycle("approval requested", { taskId, threadId: data.threadId, turnId: data.turnId, method });
    const response = method === "permissions" ? { permissions: {}, scope: "turn" } : { decision: "cancel" };
    // Close the controller success path before provider I/O.  A terminal that
    // races a delayed approval response is therefore unable to finalize this
    // task, while the normalized response/interrupt still settle the turn.
    if (this.store.getTask(taskId)?.status === "running") this.store.transition(taskId, this.isAutonomous() ? "failed" : "awaiting_approval", { error: this.isAutonomous() ? "Unexpected execution approval request in autonomous mode" : "Approval requested by execution provider" });
    let responseError = null;
    try { await this.#provider(this.activeClient, "approval_response", { requestId: data.requestId, response }, ["requestId"]); }
    catch (error) { responseError = error; }
    // A denied request ends this concrete turn in both modes.  Non-autonomous
    // mode remains resumable through approveHumanGate(), which starts a fresh
    // controlled turn; autonomous mode is terminally failed.
    this.#interruptAndAwaitTurn(this.activeClient, { taskId, threadId: data.threadId, turnId: data.turnId }, "approval_denied", { timeoutMs: this.config.delivery?.shutdownGraceMs ?? 3_000 }).catch(() => {});
    if (responseError) throw responseError;
  }

  #adoptResolvedTurnId(taskId, threadId, resolvedTurnId) {
    if (typeof resolvedTurnId !== "string" || !resolvedTurnId) return this.store.getTask(taskId);
    const task = this.store.getTask(taskId);
    if (!task || task.threadId !== threadId || task.turnId === resolvedTurnId) return task;
    const requestedTurnId = task.turnId;
    this.store.setThread(taskId, { threadId, turnId: resolvedTurnId });
    if (this.activeTurns.has(taskId)) {
      const active = this.activeTurns.get(taskId);
      active.permittedTurnIds?.add(resolvedTurnId);
      this.activeTurns.set(taskId, { ...active, taskId, threadId, turnId: resolvedTurnId, permittedTurnIds: active.permittedTurnIds });
    }
    this.#lifecycle("turn id alias resolved", { taskId, threadId, requestedTurnId, resolvedTurnId });
    return this.store.getTask(taskId);
  }

  async #enforceUsageBudget(taskId, actualTokens) {
    if (!this.#enforcesLocalBudget()) return;
    const task = this.store.getTask(taskId);
    if (!task?.threadId || !task.turnId || task.status !== "running") return;
    const threshold = task.interruptThresholdTokens;
    if (!Number.isInteger(threshold) || actualTokens < threshold) return;
    if (this.budgetInterruptedTasks.has(taskId) || this.store.budgetInterruption(taskId)) return;
    this.budgetInterruptedTasks.add(taskId);
    const interruption = this.store.recordBudgetInterruption({
      taskId, deliveryRunId: task.deliveryRunId, threadId: task.threadId, turnId: task.turnId,
      actualTokens, interruptThresholdTokens: threshold, configuredBudgetCap: task.configuredBudgetCap ?? task.tokenBudget,
      reason: "budget_interrupt"
    });
    this.#lifecycle("budget interrupt requested", { taskId, threadId: task.threadId, turnId: task.turnId, actualTokens, threshold, configuredCap: task.configuredBudgetCap ?? task.tokenBudget, overshoot: interruption.capOvershootTokens });
    const confirmation = await this.#interruptAndAwaitTurn(this.activeClient, { taskId, threadId: task.threadId, turnId: task.turnId }, "budget_interrupt", { timeoutMs: this.config.delivery?.shutdownGraceMs ?? 3_000 });
    if (this.store.getTask(taskId)?.status === "running") this.store.transition(taskId, "blocked_budget", { error: `budget_interrupt: actual ${actualTokens}, threshold ${threshold}, configured cap ${task.configuredBudgetCap ?? task.tokenBudget}${confirmation.forced ? "; forced client shutdown" : ""}` });
    if (task.deliveryRunId) this.store.updateDeliveryRun(task.deliveryRunId, { state: "blocked_budget", publish: { reason: "budget_interrupt", taskId, interruption, recovery: { action: "Inspect persisted budget interruption and begin a fresh delivery run after increasing limits or reducing scope." } } });
  }

  #lifecycle(type, details = {}) {
    const event = { timestamp: new Date().toISOString(), type, ...details };
    this.lifecycleTrace.push(event);
    if (this.lifecycleTrace.length > 100) this.lifecycleTrace.splice(0, this.lifecycleTrace.length - 100);
    // The child process can emit its final exit event after the delivery CLI has
    // closed SQLite. Keep that late event in memory, but never touch a closed
    // store or turn a completed/blocked delivery into a launcher crash.
    if (this.closed) return event;
    // SQLite is the source of truth; JSONL is an operationally convenient
    // append-only mirror. Neither stores prompts, agent text, or payloads.
    this.store.recordEvent(details.taskId ?? null, `lifecycle/${type}`, event);
    mkdirSync(this.config.runtimeDir, { recursive: true });
    appendFileSync(this.lifecyclePath, `${JSON.stringify(event)}\n`, "utf8");
    this.emit("lifecycle", event);
    return event;
  }

  #validateChild(parentTaskId) {
    const parent = this.store.getTask(parentTaskId);
    if (!parent) throw new Error(`Parent task not found: ${parentTaskId}`);
    const depth = depthOf(parent, (id) => this.store.getTask(id));
    if (depth + 1 > this.config.router.maxDelegationDepth) throw new Error("Delegation depth limit reached");
    if (this.store.childCount(parentTaskId) >= this.config.router.maxChildrenPerTask) throw new Error("Child task limit reached");
  }

  #rootId(task) {
    let cursor = task;
    while (cursor.parentTaskId) cursor = this.store.getTask(cursor.parentTaskId);
    return cursor.id;
  }

  #plannerAncestor(task) {
    let cursor = task.parentTaskId ? this.store.getTask(task.parentTaskId) : null;
    while (cursor) {
      if (cursor.role === "planner") return cursor;
      cursor = cursor.parentTaskId ? this.store.getTask(cursor.parentTaskId) : null;
    }
    return null;
  }
}
