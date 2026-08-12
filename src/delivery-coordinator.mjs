import { randomUUID } from "node:crypto";
import { ingestDocumentation } from "./project-intake.mjs";
import { ENGINEERING_DOMAINS } from "./domain.mjs";
import { specificationBlockers } from "./product-blueprint.mjs";
import { ProductEvidenceExecutor } from "./product-evidence-executor.mjs";

function manualGateFor(tasks) {
  const task = tasks.find((item) => ["awaiting_human", "awaiting_approval"].includes(item.status));
  if (!task) return null;
  return { taskId: task.id, status: task.status, reason: task.error ?? "Explicit manual workflow approval is required", approveCommand: `npm run approve -- --task ${task.id}`, resumeCommand: "npm run deliver -- --resume" };
}

function terminalForTask(task) {
  if (task.status === "blocked_specification") return { state: "blocked_specification", reason: task.error ?? "Product specification is incomplete or contradictory" };
  if (task.status === "blocked_budget") return { state: "blocked_budget", reason: task.error ?? "Local scheduler hard cap blocked task execution" };
  if (task.status === "awaiting_approval") return { state: "failed", reason: task.error ?? "Unexpected App Server approval request" };
  return { state: "failed", reason: task.error ?? task.status };
}

export class DeliveryCoordinator {
  constructor(router) { this.router = router; this.productEvidenceExecutor = new ProductEvidenceExecutor(router); }

  async begin({ source, ...adapters }) {
    await this.router.recoverStaleDeliveries();
    const current = this.router.store.currentDeliveryRun();
    if (current && (["running", "awaiting_human", "awaiting_human_remote_handoff"].includes(current.state) || (this.router.store.activeScopedReplans?.(current.id).length ?? 0))) throw new Error(`A delivery run is already active or recovering: ${current.id}. Use npm run deliver -- --resume.`);
    if (current && ["interrupted", "blocked_credentials", "blocked_ci", "blocked_branch_protection"].includes(current.state)) throw new Error(`A persisted delivery run is resumable: ${current.id}. Use npm run deliver -- --resume instead of creating a new Bootstrap/DAG.`);
    // A terminal controller run can still have never-claimed DAG rows. They are
    // historical work, not a live delivery: retain their evidence but never let
    // them block a deliberately fresh delivery.
    const cancelled = this.router.store.cancelUnfinishedTasks({
      reason: `superseded_by_fresh_delivery${current ? `:${current.id}` : ""}`
    });
    if (cancelled.length) this.router.store.recordEvent(null, "delivery/fresh-start-cleanup", { previousDeliveryRunId: current?.id ?? null, cancelledTaskIds: cancelled.map((task) => task.id) });
    const intake = ingestDocumentation({ source, repository: this.router.config.repository, destinationRelative: this.router.config.project.documentationDir });
    // Raw documents deliberately stop at the candidate handoff. Stage 04 owns
    // independent audit/admission and is the only stage allowed to create the
    // authoritative SourceClaimManifest used by Bootstrap.
    if (intake.sourceClaimInput === "raw") {
      const run = this.router.createDeliveryRun({ id: randomUUID(), source, bootstrapTaskId: null, confirmRemotePush: false, sourceClaimInputMode: "raw", repositoryMode: this.router.config.project.repositoryMode, repositoryBaseSha: null });
      try {
        const candidate = await this.router.extractSourceClaimsForRun(run);
        return this.router.store.updateDeliveryRun(run.id, { state: "awaiting_source_claim_audit", publish: { reason: "source_claim_extraction:candidate_persisted", extractionId: candidate.extraction.extractionId, digest: candidate.digest, recovery: { action: "Stage 04 audit/admission must independently validate and admit this candidate before Bootstrap." } } });
      } catch (error) { return this.router.blockRunForSourceExtraction(run, error); }
    }
    const overlay = await this.router.ensureProjectOverlay();
    // Brownfield identity is captured before Bootstrap creates the ProductBlueprint.
    // The immutable draft is finalized only after that persisted blueprint exists.
    let baselineDraft;
    try { baselineDraft = this.router.captureRepositoryBaselineDraft(overlay); }
    catch (error) {
      // A malformed or missing brownfield declaration must become a persisted,
      // redacted delivery stop.  Queueing Bootstrap is harmless here: the run
      // is blocked before the scheduler can ever create an App Server turn.
      const bootstrap = this.router.startProject();
      const run = this.router.createDeliveryRun({ id: randomUUID(), source, bootstrapTaskId: bootstrap.id, confirmRemotePush: this.router.isAutonomous(), sourceClaimManifestId: this.router.sourceClaimManifestIdentity(), sourceClaimInputMode: "supplied", repositoryMode: this.router.config.project.repositoryMode, repositoryBaseSha: null });
      this.router.store.linkTaskToDelivery(bootstrap.id, run.id);
      return this.router.blockRunForRepositoryBaseline(run, error);
    }
    // Intake is verified before Bootstrap is even queued; no blueprint is
    // required at this phase because Bootstrap is the operation that creates it.
    const sourceClaimManifestId = this.router.sourceClaimManifestIdentity();
    const bootstrap = this.router.startProject();
    const run = this.router.createDeliveryRun({ id: randomUUID(), source, bootstrapTaskId: bootstrap.id, confirmRemotePush: this.router.isAutonomous(), sourceClaimManifestId, sourceClaimInputMode: "supplied", repositoryMode: this.router.config.project.repositoryMode, repositoryBaseSha: baselineDraft?.baseSha ?? null });
    if (baselineDraft) this.router.store.recordRepositoryBaselineDraft(run.id, baselineDraft);
    this.router.store.linkTaskToDelivery(bootstrap.id, run.id);
    return this.#advance(run, { intake, overlayPath: overlay.path, ...adapters });
  }

  async resume(adapters = {}) {
    await this.router.recoverStaleDeliveries();
    const run = this.router.store.currentDeliveryRun();
    if (!run) throw new Error("No delivery run exists; start with npm run deliver -- --source <docs-dir>");
    if (run.sourceClaimInputMode === "raw") {
      if (run.sourceClaimExtractionId) {
        try { await this.router.extractSourceClaimsForRun(run); }
        catch (error) { return this.router.blockRunForSourceExtraction(run, error); }
        return this.router.store.updateDeliveryRun(run.id, { state: "awaiting_source_claim_audit", publish: { ...(run.publish ?? {}), reason: "source_claim_extraction:candidate_persisted", recovery: { action: "Stage 04 audit/admission must independently validate and admit this candidate before Bootstrap." } } });
      }
      if (["interrupted", "blocked_credentials", "blocked_specification"].includes(run.state)) {
        const resumed = run.state === "blocked_specification" ? this.router.resumeSourceClaimExtractionRun(run.id) : this.router.resumeDeliveryRun(run.id);
        try {
          const candidate = await this.router.extractSourceClaimsForRun(resumed);
          return this.router.store.updateDeliveryRun(resumed.id, { state: "awaiting_source_claim_audit", publish: { reason: "source_claim_extraction:candidate_persisted", extractionId: candidate.extraction.extractionId, digest: candidate.digest, recovery: { action: "Stage 04 audit/admission must independently validate and admit this candidate before Bootstrap." } } });
        } catch (error) { return this.router.blockRunForSourceExtraction(resumed, error); }
      }
      return run;
    }
    if (typeof this.router.assertRepositoryBaseline === "function") {
      try { this.router.assertRepositoryBaseline(run); }
      catch (error) { return this.router.blockRunForRepositoryBaseline(run, error); }
    }
    if (["completed_merged", "completed_candidate_ready", "blocked_budget", "blocked_quota", "blocked_specification", "blocked_acceptance", "conflict_blocked"].includes(run.state)) return run;
    const resumableFailure = run.state === "failed" && (this.router.store.activeScopedReplans?.(run.id).length ?? 0) > 0;
    if (run.state === "failed" && !resumableFailure) throw new Error(`Delivery run is terminally failed: ${run.id}. Start a fresh delivery with --source after correcting its input or runtime condition.`);
    const resumed = ["interrupted", "blocked_credentials", "blocked_ci", "blocked_branch_protection"].includes(run.state) || resumableFailure
      ? this.router.resumeDeliveryRun(run.id)
      : (this.router.activateDeliveryRun(run.id), run);
    const sourceControlledDelivery = Boolean(resumed.source || resumed.sourceClaimManifestId || resumed.blueprintId);
    if (sourceControlledDelivery) {
      try {
        if (resumed.blueprintId) this.router.assertRunSourceCompleteness(resumed);
        else this.router.assertBootstrapSourceIntake(resumed);
      } catch (error) { return this.router.blockRunForSourceCompleteness(resumed, error); }
    }
    if (resumed.integrationPath) return this.#publishPersisted(resumed, adapters);
    // Reconciliation above is the admission barrier: interrupted tasks cannot
    // be requeued before their durable worktree ownership is classified.
    if (run.state === "interrupted") this.router.store.resumeInterruptedTasks(resumed.id);
    return this.#advance(resumed, adapters);
  }

  async #publishPersisted(run, adapters) {
    if (typeof this.router.assertRepositoryBaseline === "function") {
      try { this.router.assertRepositoryBaseline(run); }
      catch (error) { return this.router.blockRunForRepositoryBaseline(run, error); }
    }
    try { this.router.assertRunSourceCompleteness(run); }
    catch (error) { return this.router.blockRunForSourceCompleteness(run, error); }
    const manifest = this.router.store.integrationManifest(run.integrationPath);
    if (!manifest) return this.router.store.updateDeliveryRun(run.id, { state: "failed", publish: { reason: "Persisted delivery integration manifest is missing", recovery: { action: "Restore the generated integration manifest before resuming." } } });
    if (run.candidate && (run.candidate.branch !== manifest.branch || run.candidate.sha.toLowerCase() !== manifest.candidateSha?.toLowerCase())) return this.router.store.updateDeliveryRun(run.id, { state: "failed", publish: { reason: "Persisted candidate identity does not match the integration manifest", recovery: { action: "Do not publish; inspect the preserved candidate and delivery checkpoint." } } });
    this.router.store.updateDeliveryRun(run.id, { state: "running", integrationPath: run.integrationPath, candidate: { branch: manifest.branch, sha: manifest.candidateSha }, publicationCheckpoint: { stage: "publication-ready", candidate: { branch: manifest.branch, sha: manifest.candidateSha }, resumed: true, updatedAt: new Date().toISOString() } });
    return this.#publishWithAcceptance(run, { path: run.integrationPath, manifest }, adapters);
  }

  async #advance(run, context = {}) {
    this.router.activateDeliveryRun(run.id);
    if (typeof this.router.assertRepositoryBaseline === "function") {
      try { this.router.assertRepositoryBaseline(run, { requireFinal: run.repositoryMode === "brownfield" && Boolean(run.blueprintId) }); }
      catch (error) { return this.router.blockRunForRepositoryBaseline(run, error); }
    }
    const sourceControlledDelivery = Boolean(run.source || run.sourceClaimManifestId || run.blueprintId);
    if (sourceControlledDelivery) {
      try {
        if (run.blueprintId) this.router.assertRunSourceCompleteness(run);
        else this.router.assertBootstrapSourceIntake(run);
      } catch (error) { return this.router.blockRunForSourceCompleteness(run, error); }
    }
    if (!this.router.isAutonomous()) {
      const existingGate = manualGateFor(this.router.list());
      if (existingGate) return this.#awaiting(run, existingGate);
    }
    let execution;
    try { execution = await this.router.runUntilIdle(); }
    catch (error) {
      if (/^Delivery already owned/.test(String(error.message))) throw error;
      const current = this.router.store.deliveryRun(run.id);
      if (current?.state === "interrupted") return current;
      return this.router.store.updateDeliveryRun(run.id, { state: "failed", publish: { reason: String(error.message).slice(0, 500), recovery: { action: "Inspect the preserved task worktree and structured task error." } } });
    }
    if (execution?.blockedQuota) return this.router.store.updateDeliveryRun(run.id, { state: "blocked_quota", publish: { reason: execution.quota?.reason ?? "App Server quota policy blocked new turns", quota: execution.quota } });
    if (execution?.interrupted) return this.router.store.deliveryRun(run.id);
    if (execution?.blockedBudget) return this.router.store.deliveryRun(run.id)?.state === "blocked_budget" ? this.router.store.deliveryRun(run.id) : this.router.store.updateDeliveryRun(run.id, { state: "blocked_budget", publish: { reason: "Budget watchdog interrupted an active turn" } });
    this.router.store.completeReadyScopedReplans?.(run.id);
    const activeReplans = this.router.store.activeScopedReplans?.(run.id) ?? [];
    if (activeReplans.length) return this.router.store.updateDeliveryRun(run.id, { state: "running", publish: { reason: "Scoped recovery is still active", replans: activeReplans.map((item) => ({ id: item.id, status: item.status })) } });
    const tasks = this.router.list().filter((task) => task.deliveryRunId === run.id);
    if (!this.router.isAutonomous()) {
      const gate = manualGateFor(tasks);
      if (gate) return this.#awaiting(run, gate);
    }
    const terminalTask = tasks.find((task) => ["failed", "cancelled", "blocked_budget", "blocked_specification", "interrupted", "awaiting_approval"].includes(task.status) && !(this.router.store.isReplannedHistoricalTask?.(task.id) ?? false));
    if (terminalTask) {
      const terminal = terminalForTask(terminalTask);
      return this.router.store.updateDeliveryRun(run.id, { state: terminal.state, publish: { taskId: terminalTask.id, reason: terminal.reason, recovery: { action: "Inspect the task result/report and preserved worktree, correct the source condition, then start a fresh delivery run." } } });
    }
    const unfinishedTask = tasks.find((task) => task.status !== "done");
    if (unfinishedTask) return this.router.store.updateDeliveryRun(run.id, { state: "failed", publish: { taskId: unfinishedTask.id, reason: `Delivery cannot complete while task ${unfinishedTask.id} remains ${unfinishedTask.status}`, recovery: { action: "The scheduler retained the task state; start a fresh delivery only after its recorded terminal condition is resolved." } } });
    const engineering = tasks.filter((task) => ENGINEERING_DOMAINS.has(task.role));
    if (!engineering.length || engineering.some((task) => task.status !== "done")) return this.router.store.updateDeliveryRun(run.id, { state: "failed", publish: { reason: "Delivery stopped without a completed engineering DAG", recovery: { action: "Inspect the persisted scheduler state and task dependencies." } } });
    let integration;
    try { integration = await this.router.runToIntegration({ alreadyIdle: true, deliveryRunId: run.id }); }
    catch (error) { return this.router.store.updateDeliveryRun(run.id, { state: "conflict_blocked", publish: { reason: String(error.message).slice(0, 500), recovery: { action: "Inspect the retained candidate/worktree and verification results." } } }); }
    if (integration.integration.manifest.status !== "candidate_ready") return this.router.store.updateDeliveryRun(run.id, { state: "conflict_blocked", integrationPath: integration.integration.path, publish: { reason: integration.integration.manifest.blockedReason, recovery: integration.integration.manifest.recovery } });
    // This transaction is intentionally before the first remote action.  A
    // crash after a remote side effect can therefore only resume this exact
    // candidate and its idempotency keys, never create a fresh DAG.
    this.router.store.updateDeliveryRun(run.id, { state: "running", integrationPath: integration.integration.path, candidate: { branch: integration.integration.manifest.branch, sha: integration.integration.manifest.candidateSha }, publicationCheckpoint: { stage: "publication-ready", candidate: { branch: integration.integration.manifest.branch, sha: integration.integration.manifest.candidateSha }, updatedAt: new Date().toISOString() } });
    return this.#publishWithAcceptance(run, integration.integration, context);
  }

  async #publishWithAcceptance(run, integration, adapters) {
    const existing = this.router.store.productAcceptanceForRun(run.id, { candidateSha: integration.manifest.candidateSha, manifestId: integration.manifest.id });
    let acceptance = existing;
    if (!acceptance) {
      // Product verification is a pre-publication controller gate.  In normal
      // CLI delivery this is the manifest-backed executor; injected adapters
      // remain a narrowly scoped test seam only.
      const adapter = adapters.productEvidenceAdapter;
      const candidate = { branch: integration.manifest.branch, sha: integration.manifest.candidateSha };
      const productEvidence = adapter
        ? (typeof adapter.verify === "function" ? await adapter.verify({ candidate, manifest: integration.manifest, deliveryRunId: run.id }) : await adapter({ candidate, manifest: integration.manifest, deliveryRunId: run.id }))
        : await this.productEvidenceExecutor.verify({ candidate, manifest: integration.manifest, deliveryRunId: run.id });
      const productReady = this.#productEvidenceReady(run, candidate, productEvidence);
      if (!productReady) {
        acceptance = this.router.store.recordProductAcceptanceReport(await this.router.buildProductAcceptanceReport({ integration, remoteCi: null, productEvidence }));
        return this.#blockedAcceptance(run, integration, acceptance, { reason: "Final product evidence did not pass before publication; candidate and evidence are retained." });
      }
      const preliminary = await this.router.publishCandidate(integration, adapters);
      if (preliminary.terminalState !== "awaiting_final_acceptance") return this.router.store.updateDeliveryRun(run.id, { state: preliminary.terminalState, integrationPath: integration.path, publish: preliminary, confirmRemotePush: this.router.isAutonomous() });
      acceptance = this.router.store.recordProductAcceptanceReport(await this.router.buildProductAcceptanceReport({ integration, remoteCi: preliminary.remoteCi, productEvidence }));
    }
    if (!acceptance.passing) {
      return this.#blockedAcceptance(run, integration, acceptance, { reason: "Final acceptance did not pass; candidate and evidence are retained." });
    }
    const merged = await this.router.publishCandidate(integration, { ...adapters, acceptanceReportId: acceptance.id });
    if (merged.terminalState !== "merge_verified") return this.router.store.updateDeliveryRun(run.id, { state: merged.terminalState, integrationPath: integration.path, publish: merged, confirmRemotePush: this.router.isAutonomous() });
    return this.router.store.completeDeliveryWithAcceptance({ deliveryRunId: run.id, reportId: acceptance.id, merge: merged.merge, publish: merged });
  }

  #blockedAcceptance(run, integration, acceptance, { reason }) {
    const report = acceptance.report;
    const specification = specificationBlockers(this.router.store.productBlueprint(report.blueprintId)?.blueprint ?? []).length > 0;
    return this.router.store.updateDeliveryRun(run.id, { state: specification ? "blocked_specification" : "blocked_acceptance", integrationPath: integration.path, publish: { acceptanceReportId: acceptance.id, reason: specification ? "Final acceptance is blocked by a source/specification condition." : reason }, confirmRemotePush: this.router.isAutonomous() });
  }

  #productEvidenceReady(run, candidate, evidence) {
    const current = this.router.store.deliveryRun(run.id);
    const blueprint = this.router.store.productBlueprint(current?.blueprintId)?.blueprint;
    const criteria = blueprint?.requirements?.flatMap((requirement) => requirement.acceptanceCriteria.map((criterion) => `${requirement.requirementId}:${criterion.criterionId}`)) ?? [];
    if (!criteria.length || evidence?.candidateSha?.toLowerCase() !== candidate.sha.toLowerCase() || !Array.isArray(evidence?.results) || evidence.results.length !== criteria.length) return false;
    const expected = new Set(criteria); const seen = new Set();
    return evidence.results.every((item) => {
      const key = `${item?.requirementId}:${item?.criterionId}`;
      if (!expected.has(key) || seen.has(key) || item?.status !== "pass" || typeof item?.testId !== "string" || !item.testId.trim() || typeof item?.reference !== "string" || !item.reference.trim() || item?.candidateSha?.toLowerCase() !== candidate.sha.toLowerCase()) return false;
      seen.add(key); return true;
    }) && seen.size === expected.size;
  }

  #awaiting(run, gate) {
    const updated = this.router.store.updateDeliveryRun(run.id, { state: "awaiting_human", confirmRemotePush: false });
    return { ...updated, terminalState: "awaiting_human", currentGate: gate };
  }
}
