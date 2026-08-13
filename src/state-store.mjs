import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertRole, assertTransition } from "./domain.mjs";
import { validateGlobalWaveCheckpoint, validateIntegrationBarrier, validateIntegrationCheckpoint, validateLocalIntegrationCheckpoint, validatePlan, validateWorkerArtifactContract } from "./workflow-contract.mjs";
import { productAcceptancePasses, validateProductAcceptanceReport } from "./final-acceptance.mjs";
import { validateProjectMode } from "./project-mode.mjs";

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? []);
const parse = (value, fallback) => (value ? JSON.parse(value) : fallback);
const sourceIntakeDiagnostics = (diagnostics) => {
  if (!diagnostics || typeof diagnostics !== "object"
    || !["connect", "start_thread", "start_turn", "observe_terminal", "reconcile_terminal", "result_read"].includes(diagnostics.runtimeStage)
    || !["timeout", "process_exit", "transport_failure", "terminal_receipt_missing", "terminal_alias_unresolved", "terminal_status_missing", "terminal_identity_mismatch", "final_result_unavailable", "malformed_json", "candidate_canonicalization_failed", "candidate_semantics_invalid", "audit_result_invalid"].includes(diagnostics.primaryReason)
    || !["attemptedThreadId", "requestedTurnId"].every((key) => typeof diagnostics[key] === "string" && diagnostics[key].length <= 512)
    || (diagnostics.resolvedTurnId != null && (typeof diagnostics.resolvedTurnId !== "string" || diagnostics.resolvedTurnId.length > 512))
    || (diagnostics.errorClass != null && (typeof diagnostics.errorClass !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/i.test(diagnostics.errorClass)))
    || (diagnostics.processState != null && (typeof diagnostics.processState !== "object" || typeof diagnostics.processState.alive !== "boolean" || typeof diagnostics.processState.exited !== "boolean" || (diagnostics.processState.code != null && !Number.isInteger(diagnostics.processState.code)) || (diagnostics.processState.signal != null && (typeof diagnostics.processState.signal !== "string" || diagnostics.processState.signal.length > 64))))
    || (diagnostics.stderrTail != null && (typeof diagnostics.stderrTail !== "string" || diagnostics.stderrTail.length > 512))
    || (diagnostics.protocolTail != null && (!Array.isArray(diagnostics.protocolTail) || diagnostics.protocolTail.length > 20))) return null;
  const protocolTail = (diagnostics.protocolTail ?? []).map((event) => {
    if (!event || typeof event !== "object") return null;
    const copy = {};
    for (const key of ["direction", "method", "threadId", "turnId", "requestedTurnId", "resolvedTurnId", "itemType", "itemStatus", "errorCode"]) {
      const value = event[key];
      if (value != null && (typeof value !== "string" || value.length > 512)) return null;
      if (value != null) copy[key] = value;
    }
    return copy;
  });
  if (protocolTail.some((event) => event === null)) return null;
  return {
    attemptedThreadId: diagnostics.attemptedThreadId, requestedTurnId: diagnostics.requestedTurnId,
    resolvedTurnId: diagnostics.resolvedTurnId ?? null, runtimeStage: diagnostics.runtimeStage,
    primaryReason: diagnostics.primaryReason, ...(diagnostics.errorClass ? { errorClass: diagnostics.errorClass } : {}),
    processState: diagnostics.processState ? { alive: diagnostics.processState.alive, exited: diagnostics.processState.exited, code: diagnostics.processState.code ?? null, signal: diagnostics.processState.signal ?? null } : null,
    stderrTail: diagnostics.stderrTail ?? "", protocolTail
  };
};

export class StateStore {
  constructor(filePath, { readOnly = false, faultHooks = {} } = {}) {
    this.faultHooks = faultHooks;
    const isNewDatabase = !existsSync(filePath);
    if (!readOnly) mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath, { readOnly });
    // `status`/`watch` deliberately open old runtime databases read-only.  A
    // pre-migration database must remain observable rather than throwing on a
    // column added by a newer controller.
    this.hasTokenUsageSource = this.#hasColumn("tasks", "token_usage_source");
    this.hasResolutionAuthorityEvidence = this.#hasTable("specification_resolution_evidence");
    this.hasSourceClaimManifests = this.#hasTable("source_claim_manifests");
    this.hasSourceClaimExtractions = this.#hasTable("source_claim_extractions");
    this.hasSourceClaimAudits = this.#hasTable("source_claim_audits");
    this.hasSourceIntakeTerminalReceipts = this.#hasTable("source_intake_terminal_receipts");
    this.hasSourceIntakeFailures = this.#hasTable("source_intake_failures");
    this.hasSourceIntakeAttempts = this.#hasTable("source_intake_attempts");
    this.hasRepositoryBaselines = this.#hasTable("repository_baselines") && this.#hasColumn("delivery_runs", "repository_mode");
    this.hasManagedWorktrees = this.#hasTable("managed_worktrees");
    if (readOnly) return;
    // Switching journal mode takes an exclusive SQLite lock. Do it once at
    // database creation, never in every short-lived status/watch reader.
    if (isNewDatabase) this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT REFERENCES tasks(id),
        role TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        allowed_paths_json TEXT NOT NULL,
        acceptance_checks_json TEXT NOT NULL,
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        human_approval_required INTEGER NOT NULL DEFAULT 0,
        human_approved INTEGER NOT NULL DEFAULT 0,
        worktree TEXT,
        branch TEXT,
        thread_id TEXT,
        turn_id TEXT,
        token_budget INTEGER NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        token_used INTEGER NOT NULL DEFAULT 0,
        token_usage_source TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT,
        result_path TEXT,
        risk_flags_json TEXT NOT NULL DEFAULT '[]',
        supporting_domains_json TEXT NOT NULL DEFAULT '[]',
        artifact_base_sha TEXT,
        artifact_dependencies_json TEXT NOT NULL DEFAULT '[]',
        remediation_round INTEGER NOT NULL DEFAULT 0,
        source_writer_task_id TEXT,
        delivery_run_id TEXT,
        blueprint_id TEXT,
        requirement_ids_json TEXT NOT NULL DEFAULT '[]',
        interrupt_threshold_tokens INTEGER,
        configured_budget_cap INTEGER
        ,plan_batch_id TEXT
        ,wave INTEGER
        ,integration_barrier_id TEXT
        ,execution_dependencies_json TEXT
        ,execution_topology_version INTEGER NOT NULL DEFAULT 0
        ,execution_is_writer INTEGER NOT NULL DEFAULT 0
        ,execution_release_state TEXT
        ,execution_release_artifact_task_id TEXT
        ,baseline_behavior_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        request_id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        method TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        decision TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS account_snapshots (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_artifacts (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        schema_version INTEGER NOT NULL,
        artifact_path TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integration_manifests (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        manifest_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budget_overrides (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        reason TEXT NOT NULL,
        forecast_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quality_reports (
        qa_task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        writer_task_id TEXT NOT NULL REFERENCES tasks(id),
        schema_version INTEGER NOT NULL,
        report_path TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_reports (
        security_task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        writer_task_id TEXT NOT NULL REFERENCES tasks(id),
        schema_version INTEGER NOT NULL,
        report_path TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_runs (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        state TEXT NOT NULL,
        source TEXT,
        bootstrap_task_id TEXT REFERENCES tasks(id),
        integration_path TEXT,
        candidate_branch TEXT,
        candidate_sha TEXT,
        publication_checkpoint_json TEXT,
        publish_json TEXT,
        confirm_remote_push INTEGER NOT NULL DEFAULT 0,
        owner_pid INTEGER,
        owner_session_id TEXT,
        heartbeat_at TEXT,
        interrupted_at TEXT,
        recovery_json TEXT,
        blueprint_id TEXT,
        completion_contract_version INTEGER NOT NULL DEFAULT 0,
        repository_mode TEXT NOT NULL DEFAULT 'legacy',
        repository_base_sha TEXT,
        repository_baseline_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dependency_deadlocks (
        id TEXT PRIMARY KEY,
        delivery_run_id TEXT REFERENCES delivery_runs(id),
        outcome_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_actions (
        idempotency_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budget_interruptions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        delivery_run_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        actual_tokens INTEGER NOT NULL,
        interrupt_threshold_tokens INTEGER NOT NULL,
        configured_budget_cap INTEGER NOT NULL,
        threshold_overshoot_tokens INTEGER NOT NULL,
        cap_overshoot_tokens INTEGER NOT NULL,
        reason TEXT NOT NULL,
        interrupted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS product_blueprints (
        blueprint_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        artifact_path TEXT NOT NULL,
        digest TEXT NOT NULL,
        document_set_digest TEXT NOT NULL,
        bootstrap_task_id TEXT REFERENCES tasks(id),
        delivery_run_id TEXT REFERENCES delivery_runs(id),
        blueprint_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS specification_resolution_evidence (
        blueprint_id TEXT PRIMARY KEY REFERENCES product_blueprints(blueprint_id),
        schema_version INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_claim_manifests (
        manifest_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, digest TEXT NOT NULL,
        document_set_digest TEXT NOT NULL, manifest_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_claim_extractions (
        extraction_id TEXT PRIMARY KEY, delivery_run_id TEXT NOT NULL REFERENCES delivery_runs(id),
        schema_version INTEGER NOT NULL, digest TEXT NOT NULL, document_set_digest TEXT NOT NULL,
        artifact_path TEXT NOT NULL, extraction_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_claim_audits (
        audit_id TEXT PRIMARY KEY, delivery_run_id TEXT NOT NULL REFERENCES delivery_runs(id),
        schema_version INTEGER NOT NULL, digest TEXT NOT NULL, document_set_digest TEXT NOT NULL,
        candidate_id TEXT NOT NULL, candidate_digest TEXT NOT NULL, artifact_path TEXT NOT NULL,
        audit_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_intake_terminal_receipts (
        delivery_run_id TEXT NOT NULL REFERENCES delivery_runs(id), role TEXT NOT NULL,
        schema_version INTEGER NOT NULL, thread_id TEXT NOT NULL, requested_turn_id TEXT NOT NULL,
        resolved_turn_id TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (delivery_run_id, role)
      );
      CREATE TABLE IF NOT EXISTS source_intake_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_run_id TEXT NOT NULL REFERENCES delivery_runs(id),
        schema_version INTEGER NOT NULL, role TEXT NOT NULL, phase TEXT NOT NULL, code TEXT NOT NULL,
        receipt_identity_json TEXT, diagnostics_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_intake_attempts (
        delivery_run_id TEXT NOT NULL REFERENCES delivery_runs(id), role TEXT NOT NULL,
        schema_version INTEGER NOT NULL, attempted_thread_id TEXT NOT NULL,
        requested_turn_id TEXT NOT NULL, resolved_turn_id TEXT,
        runtime_stage TEXT NOT NULL, lifecycle_state TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY (delivery_run_id, role)
      );
      CREATE TABLE IF NOT EXISTS repository_baseline_drafts (
        delivery_run_id TEXT PRIMARY KEY REFERENCES delivery_runs(id),
        schema_version INTEGER NOT NULL, draft_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repository_baselines (
        baseline_id TEXT PRIMARY KEY, delivery_run_id TEXT UNIQUE NOT NULL REFERENCES delivery_runs(id),
        schema_version INTEGER NOT NULL, digest TEXT NOT NULL, base_sha TEXT NOT NULL,
        blueprint_id TEXT NOT NULL, blueprint_digest TEXT NOT NULL, baseline_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS traceability_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        requirement_id TEXT NOT NULL,
        blueprint_id TEXT NOT NULL REFERENCES product_blueprints(blueprint_id),
        task_id TEXT REFERENCES tasks(id),
        artifact_path TEXT,
        verification_path TEXT,
        checkpoint TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS product_acceptance_reports (
        id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, delivery_run_id TEXT NOT NULL REFERENCES delivery_runs(id),
        blueprint_id TEXT NOT NULL, blueprint_digest TEXT NOT NULL, manifest_id TEXT NOT NULL, manifest_path TEXT NOT NULL,
        candidate_sha TEXT NOT NULL, report_json TEXT NOT NULL, passing INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_acceptance_identity ON product_acceptance_reports(delivery_run_id, manifest_id, candidate_sha);
      CREATE TABLE IF NOT EXISTS product_evidence_executions (
        id TEXT PRIMARY KEY, delivery_run_id TEXT NOT NULL REFERENCES delivery_runs(id), integration_manifest_id TEXT NOT NULL,
        candidate_sha TEXT NOT NULL, blueprint_id TEXT NOT NULL, blueprint_digest TEXT NOT NULL,
        verification_manifest_id TEXT NOT NULL, verification_manifest_digest TEXT NOT NULL, worktree TEXT NOT NULL,
        execution_json TEXT NOT NULL, success INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_product_evidence_identity ON product_evidence_executions(delivery_run_id, integration_manifest_id, candidate_sha, verification_manifest_id);
      CREATE TABLE IF NOT EXISTS plan_batches (
        id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, kind TEXT NOT NULL,
        delivery_run_id TEXT NOT NULL, blueprint_id TEXT NOT NULL, wave INTEGER NOT NULL,
        based_on_checkpoint_sha TEXT NOT NULL, tasks_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integration_barriers (
        id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, kind TEXT NOT NULL,
        delivery_run_id TEXT NOT NULL, blueprint_id TEXT NOT NULL, wave INTEGER NOT NULL,
        base_sha TEXT NOT NULL, input_artifacts_json TEXT NOT NULL, status TEXT NOT NULL,
        checkpoint_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integration_checkpoints (
        id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, kind TEXT NOT NULL,
        delivery_run_id TEXT NOT NULL, blueprint_id TEXT NOT NULL, wave INTEGER NOT NULL,
        base_sha TEXT NOT NULL, input_artifacts_json TEXT NOT NULL, output_sha TEXT NOT NULL,
        verification_results_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wave_reconciliations (
        delivery_run_id TEXT NOT NULL, wave INTEGER NOT NULL, checkpoint_id TEXT NOT NULL,
        checkpoint_sha TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER, diagnostics_json TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(delivery_run_id, wave)
      );
      CREATE TABLE IF NOT EXISTS requirement_ledger (
        delivery_run_id TEXT NOT NULL REFERENCES delivery_runs(id),
        blueprint_id TEXT NOT NULL REFERENCES product_blueprints(blueprint_id),
        requirement_id TEXT NOT NULL,
        criterion_id TEXT NOT NULL DEFAULT '',
        source_blueprint_identity TEXT NOT NULL,
        coverage_state TEXT NOT NULL,
        owner_task_id TEXT,
        artifact_task_id TEXT,
        checkpoint_id TEXT,
        candidate_sha TEXT,
        evidence_state TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        unresolved_reason TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(delivery_run_id, requirement_id, criterion_id)
      );
      CREATE TABLE IF NOT EXISTS scoped_replans (
        id TEXT PRIMARY KEY, delivery_run_id TEXT, blueprint_id TEXT, failed_task_id TEXT NOT NULL,
        invalidated_task_ids_json TEXT NOT NULL, prior_plan_batch_id TEXT, replacement_plan_batch_id TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_replacements (
        replan_id TEXT NOT NULL, old_task_id TEXT NOT NULL, replacement_task_id TEXT,
        kind TEXT NOT NULL DEFAULT 'task', created_at TEXT NOT NULL,
        PRIMARY KEY(replan_id, old_task_id),
        FOREIGN KEY(replan_id) REFERENCES scoped_replans(id)
      );
      -- v2 ownership is deliberately independent from the old tasks.worktree
      -- columns.  Old paths remain audit evidence and are never inferred to be
      -- controller-owned by this migration.
      CREATE TABLE IF NOT EXISTS managed_worktrees (
        record_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        repository_common_dir TEXT NOT NULL,
        repository_root TEXT NOT NULL,
        canonical_path TEXT,
        intended_path TEXT NOT NULL,
        task_id TEXT,
        delivery_run_id TEXT,
        plan_batch_id TEXT,
        barrier_id TEXT,
        candidate_id TEXT,
        branch TEXT NOT NULL,
        intended_base_sha TEXT NOT NULL,
        last_verified_head TEXT,
        creation_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        protocol_version INTEGER NOT NULL,
        owner_version TEXT NOT NULL,
        phase TEXT NOT NULL,
        classification TEXT NOT NULL,
        verification_json TEXT NOT NULL DEFAULT '{}',
        linked_at TEXT,
        finalized_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_worktrees_canonical_path ON managed_worktrees(canonical_path) WHERE canonical_path IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_managed_worktrees_controller ON managed_worktrees(task_id, barrier_id, candidate_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, sequence);
    `);
    this.hasResolutionAuthorityEvidence = true;
    this.hasSourceClaimManifests = true;
    this.hasSourceClaimExtractions = true;
    this.hasSourceClaimAudits = true;
    this.hasSourceIntakeTerminalReceipts = true;
    this.hasSourceIntakeFailures = true;
    this.hasSourceIntakeAttempts = true;
    this.hasRepositoryBaselines = true;
    this.hasManagedWorktrees = true;
    this.#addColumnIfMissing("tasks", "dependencies_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumnIfMissing("tasks", "result_path", "TEXT");
    this.#addColumnIfMissing("tasks", "estimated_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "human_approval_required", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "human_approved", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "risk_flags_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumnIfMissing("tasks", "supporting_domains_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumnIfMissing("tasks", "artifact_base_sha", "TEXT");
    this.#addColumnIfMissing("tasks", "artifact_dependencies_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumnIfMissing("tasks", "remediation_round", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "source_writer_task_id", "TEXT");
    this.#addColumnIfMissing("tasks", "delivery_run_id", "TEXT");
    this.#addColumnIfMissing("tasks", "blueprint_id", "TEXT");
    this.#addColumnIfMissing("tasks", "requirement_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumnIfMissing("tasks", "interrupt_threshold_tokens", "INTEGER");
    this.#addColumnIfMissing("tasks", "configured_budget_cap", "INTEGER");
    this.#addColumnIfMissing("tasks", "token_usage_source", "TEXT");
    this.#addColumnIfMissing("tasks", "plan_batch_id", "TEXT");
    this.#addColumnIfMissing("tasks", "wave", "INTEGER");
    this.#addColumnIfMissing("tasks", "integration_barrier_id", "TEXT");
    this.#addColumnIfMissing("tasks", "local_checkpoint_id", "TEXT");
    this.#addColumnIfMissing("tasks", "execution_dependencies_json", "TEXT");
    this.#addColumnIfMissing("tasks", "execution_topology_version", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "execution_is_writer", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "execution_release_state", "TEXT");
    this.#addColumnIfMissing("tasks", "execution_release_artifact_task_id", "TEXT");
    this.#addColumnIfMissing("tasks", "baseline_behavior_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumnIfMissing("integration_checkpoints", "checkpoint_type", "TEXT");
    this.#addColumnIfMissing("integration_checkpoints", "barrier_id", "TEXT");
    this.#addColumnIfMissing("integration_checkpoints", "effective_lineage_json", "TEXT");
    this.#addColumnIfMissing("integration_checkpoints", "consumer_task_ids_json", "TEXT");
    this.#addColumnIfMissing("wave_reconciliations", "progress", "INTEGER");
    this.#addColumnIfMissing("wave_reconciliations", "diagnostics_json", "TEXT");
    // Version-one checkpoints did not distinguish local fan-in from the global
    // baseline.  Keep them as audit evidence but never promote them on restart.
    this.db.prepare("UPDATE wave_reconciliations SET status = 'legacy_ambiguous' WHERE status = 'reconciled' AND checkpoint_id IN (SELECT id FROM integration_checkpoints WHERE COALESCE(checkpoint_type, '') NOT IN ('GlobalWaveCheckpoint'))").run();
    // Scoped recovery v2 is deliberately additive: old rows are evidence, not
    // safe autonomous work items.  New records carry all context needed to
    // claim a single recovery planner after a restart.
    this.#addColumnIfMissing("scoped_replans", "schema_version", "INTEGER NOT NULL DEFAULT 1");
    this.#addColumnIfMissing("scoped_replans", "failure_kind", "TEXT");
    this.#addColumnIfMissing("scoped_replans", "failure_detail", "TEXT");
    this.#addColumnIfMissing("scoped_replans", "affected_task_ids_json", "TEXT");
    this.#addColumnIfMissing("scoped_replans", "preserved_artifacts_json", "TEXT");
    this.#addColumnIfMissing("scoped_replans", "prior_checkpoint_id", "TEXT");
    this.#addColumnIfMissing("scoped_replans", "prior_checkpoint_sha", "TEXT");
    this.#addColumnIfMissing("scoped_replans", "remaining_requirement_ids_json", "TEXT");
    this.#addColumnIfMissing("scoped_replans", "prior_context_json", "TEXT");
    this.#addColumnIfMissing("scoped_replans", "attempt", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("scoped_replans", "max_attempts", "INTEGER NOT NULL DEFAULT 2");
    this.#addColumnIfMissing("scoped_replans", "idempotency_key", "TEXT");
    this.#addColumnIfMissing("scoped_replans", "planner_task_id", "TEXT");
    this.#addColumnIfMissing("scoped_replans", "updated_at", "TEXT");
    this.#addColumnIfMissing("scoped_replans", "completed_at", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_replans_idempotency ON scoped_replans(idempotency_key); CREATE INDEX IF NOT EXISTS idx_scoped_replans_run_status ON scoped_replans(delivery_run_id, status);");
    this.db.prepare("UPDATE scoped_replans SET status = 'legacy_manual', updated_at = COALESCE(updated_at, created_at) WHERE schema_version < 2 OR failure_kind IS NULL OR idempotency_key IS NULL").run();
    this.hasTokenUsageSource = true;
    this.#addColumnIfMissing("delivery_runs", "owner_pid", "INTEGER");
    this.#addColumnIfMissing("delivery_runs", "owner_session_id", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "heartbeat_at", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "interrupted_at", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "recovery_json", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "candidate_branch", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "candidate_sha", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "publication_checkpoint_json", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "blueprint_id", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "completion_contract_version", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("delivery_runs", "source_claim_manifest_id", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "source_claim_extraction_id", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "source_claim_audit_id", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "source_claim_input_mode", "TEXT NOT NULL DEFAULT 'supplied'");
    this.#addColumnIfMissing("delivery_runs", "repository_mode", "TEXT NOT NULL DEFAULT 'legacy'");
    this.#addColumnIfMissing("delivery_runs", "repository_base_sha", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "repository_baseline_id", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "project_mode_json", "TEXT");
    this.#addColumnIfMissing("product_blueprints", "source_claim_manifest_id", "TEXT");
    // Older resumable runs have no immutable intake contract. Preserve every
    // row, but prevent them from silently continuing under the new semantics.
    this.#blockLegacyRunsWithoutBlueprint();
    this.#blockLegacyRunsWithoutProjectMode();
    // A PlanBatch persisted before execution topology existed cannot safely be
    // resumed: it may contain overlapping writers with no controller lane.
    this.#blockLegacyPlanTasksWithoutExecutionTopology();
  }

  close() { this.db.close(); }

  // ManagedWorktreeRecord v2 is a durable ownership claim, not a convenient
  // reconstruction of a pathname.  Every update is explicit so a crash can be
  // reconciled from this record and Git's registered-worktree facts.
  recordManagedWorktreeIntent(record) {
    if (!this.hasManagedWorktrees) throw new Error("Managed worktree records are unavailable in this legacy read-only database");
    const required = ["recordId", "kind", "repositoryCommonDir", "repositoryRoot", "intendedPath", "branch", "intendedBaseSha", "creationSessionId"];
    if (required.some((key) => typeof record[key] !== "string" || !record[key])) throw new Error("Managed worktree intent is incomplete");
    if (!["worker", "integration_barrier", "candidate_integration"].includes(record.kind)) throw new Error("Managed worktree intent has an invalid kind");
    const timestamp = now();
    this.db.prepare(`INSERT INTO managed_worktrees (
      record_id, schema_version, kind, repository_common_dir, repository_root, canonical_path, intended_path,
      task_id, delivery_run_id, plan_batch_id, barrier_id, candidate_id, branch, intended_base_sha, last_verified_head,
      creation_session_id, created_at, attempt, protocol_version, owner_version, phase, classification, verification_json, linked_at, finalized_at, updated_at
    ) VALUES (?, 2, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 2, ?, 'intent_recorded', 'active', '{}', NULL, NULL, ?)`)
      .run(record.recordId, record.kind, record.repositoryCommonDir, record.repositoryRoot, record.intendedPath,
        record.taskId ?? null, record.deliveryRunId ?? null, record.planBatchId ?? null, record.barrierId ?? null, record.candidateId ?? null,
        record.branch, record.intendedBaseSha, record.creationSessionId, timestamp, record.attempt ?? 1, record.ownerVersion ?? "managed-worktree/v2", timestamp);
    return this.managedWorktree(record.recordId);
  }

  managedWorktree(recordId) {
    if (!this.hasManagedWorktrees) return null;
    const row = this.db.prepare("SELECT * FROM managed_worktrees WHERE record_id = ?").get(recordId);
    return row ? this.#mapManagedWorktree(row) : null;
  }

  listManagedWorktrees({ limit = 100 } = {}) {
    if (!this.hasManagedWorktrees) return [];
    return this.db.prepare("SELECT * FROM managed_worktrees ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(100, limit))).map((row) => this.#mapManagedWorktree(row));
  }

  linkManagedWorktree(recordId, { canonicalPath, lastVerifiedHead, verification = {}, taskId = undefined, phase = "linked", classification = "active" } = {}) {
    const current = this.managedWorktree(recordId); if (!current) throw new Error("Managed worktree record not found");
    const timestamp = now();
    let committed = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE managed_worktrees SET canonical_path = ?, last_verified_head = ?, verification_json = ?, phase = ?, classification = ?, linked_at = COALESCE(linked_at, ?), updated_at = ? WHERE record_id = ?")
        .run(canonicalPath ?? current.canonicalPath, lastVerifiedHead ?? current.lastVerifiedHead, json(verification), phase, classification, timestamp, timestamp, recordId);
      this.faultHooks?.managed_worktree_record_linked_before_task_linkage?.({ recordId, taskId: taskId === undefined ? current.taskId : taskId });
      const effectiveTaskId = taskId === undefined ? current.taskId : taskId;
      if (effectiveTaskId) this.db.prepare("UPDATE tasks SET worktree = ?, branch = ?, updated_at = ? WHERE id = ?").run(canonicalPath ?? current.canonicalPath, current.branch, timestamp, effectiveTaskId);
      this.db.exec("COMMIT");
      committed = true;
      this.faultHooks?.managed_worktree_task_linked?.({ recordId, taskId: effectiveTaskId });
    } catch (error) { if (!committed) this.db.exec("ROLLBACK"); throw error; }
    return this.managedWorktree(recordId);
  }

  updateManagedWorktree(recordId, { phase, classification, lastVerifiedHead, verification, canonicalPath, finalized = false } = {}) {
    const current = this.managedWorktree(recordId); if (!current) throw new Error("Managed worktree record not found");
    const timestamp = now();
    this.db.prepare("UPDATE managed_worktrees SET phase = ?, classification = ?, last_verified_head = ?, canonical_path = ?, verification_json = ?, finalized_at = ?, updated_at = ? WHERE record_id = ?")
      .run(phase ?? current.phase, classification ?? current.classification, lastVerifiedHead ?? current.lastVerifiedHead, canonicalPath ?? current.canonicalPath, verification === undefined ? json(current.verification) : json(verification), finalized ? timestamp : current.finalizedAt, timestamp, recordId);
    return this.managedWorktree(recordId);
  }

  createTask(task) {
    assertRole(task.role);
    this.#validateTaskBlueprint(task);
    const timestamp = now();
    const initialStatus = task.humanApprovalRequired ? "awaiting_human" : "queued";
    this.#mutate(task.id, `task/${initialStatus}`, { role: task.role, title: task.title, humanApprovalRequired: Boolean(task.humanApprovalRequired) }, () => {
      this.db.prepare(`INSERT INTO tasks (
      id, parent_task_id, role, title, prompt, status, allowed_paths_json,
      acceptance_checks_json, dependencies_json, human_approval_required, token_budget, estimated_tokens, max_attempts, created_at, updated_at,
      risk_flags_json, supporting_domains_json, artifact_base_sha, artifact_dependencies_json, remediation_round, source_writer_task_id, delivery_run_id, blueprint_id, requirement_ids_json, plan_batch_id, wave, integration_barrier_id, execution_dependencies_json, execution_topology_version, execution_is_writer, execution_release_state, execution_release_artifact_task_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      task.id, task.parentTaskId ?? null, task.role, task.title, task.prompt,
      initialStatus, json(task.allowedPaths), json(task.acceptanceChecks), json(task.dependencies), task.humanApprovalRequired ? 1 : 0, task.tokenBudget, task.estimatedTokens ?? task.tokenBudget,
      task.maxAttempts, timestamp, timestamp, json(task.riskFlags), json(task.supportingDomains), task.artifactBaseSha ?? null,
      json(task.artifactDependencies), task.remediationRound ?? 0, task.sourceWriterTaskId ?? null, task.deliveryRunId ?? null, task.blueprintId ?? null, json(task.requirementIds), task.planBatchId ?? null, task.wave ?? null, task.integrationBarrierId ?? null, task.executionDependencies === undefined ? null : json(task.executionDependencies), task.executionTopologyVersion ?? 0, task.executionIsWriter ? 1 : 0, task.executionReleaseState ?? null, task.executionReleaseArtifactTaskId ?? null
      );
      this.db.prepare("UPDATE tasks SET baseline_behavior_ids_json = ? WHERE id = ?").run(json(task.baselineBehaviorIds), task.id);
    });
    return this.getTask(task.id);
  }

  // Materialized plans are a single controller decision: persist every task
  // and its append-only creation event, or persist none of them.
  createTasks(tasks) {
    if (!Array.isArray(tasks) || !tasks.length) throw new Error("createTasks requires at least one task");
    const ids = new Set();
    for (const task of tasks) {
      assertRole(task.role);
      this.#validateTaskBlueprint(task);
      if (!task.id || ids.has(task.id) || this.getTask(task.id)) throw new Error("Batch task ids must be unique and unused");
      ids.add(task.id);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const task of tasks) {
        const timestamp = now();
        const initialStatus = task.humanApprovalRequired ? "awaiting_human" : "queued";
        this.db.prepare(`INSERT INTO tasks (
          id, parent_task_id, role, title, prompt, status, allowed_paths_json,
          acceptance_checks_json, dependencies_json, human_approval_required, token_budget, estimated_tokens, max_attempts, created_at, updated_at,
          risk_flags_json, supporting_domains_json, artifact_base_sha, artifact_dependencies_json, remediation_round, source_writer_task_id, delivery_run_id, blueprint_id, requirement_ids_json, plan_batch_id, wave, integration_barrier_id, execution_dependencies_json, execution_topology_version, execution_is_writer, execution_release_state, execution_release_artifact_task_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(
          task.id, task.parentTaskId ?? null, task.role, task.title, task.prompt,
          initialStatus, json(task.allowedPaths), json(task.acceptanceChecks), json(task.dependencies), task.humanApprovalRequired ? 1 : 0,
          task.tokenBudget, task.estimatedTokens ?? task.tokenBudget, task.maxAttempts ?? 1, timestamp, timestamp,
          json(task.riskFlags), json(task.supportingDomains), task.artifactBaseSha ?? null, json(task.artifactDependencies), task.remediationRound ?? 0, task.sourceWriterTaskId ?? null, task.deliveryRunId ?? null, task.blueprintId ?? null, json(task.requirementIds), task.planBatchId ?? null, task.wave ?? null, task.integrationBarrierId ?? null, task.executionDependencies === undefined ? null : json(task.executionDependencies), task.executionTopologyVersion ?? 0, task.executionIsWriter ? 1 : 0, task.executionReleaseState ?? null, task.executionReleaseArtifactTaskId ?? null
        );
        this.db.prepare("UPDATE tasks SET baseline_behavior_ids_json = ? WHERE id = ?").run(json(task.baselineBehaviorIds), task.id);
        this.#insertEvent(task.id, `task/${initialStatus}`, { role: task.role, title: task.title, humanApprovalRequired: Boolean(task.humanApprovalRequired) });
        for (const requirementId of task.requirementIds ?? []) this.#insertTraceability({ requirementId, blueprintId: task.blueprintId, taskId: task.id, checkpoint: "planned", payload: { role: task.role, parentTaskId: task.parentTaskId ?? null } });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return tasks.map((task) => this.getTask(task.id));
  }

  getTask(id) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? this.#mapTask(row) : null;
  }

  setArtifactLineage(taskId, { artifactBaseSha, artifactDependencies }) {
    if (!this.getTask(taskId)) throw new Error(`Task not found: ${taskId}`);
    if (!Array.isArray(artifactDependencies) || artifactDependencies.length > 1) throw new Error("WorkerArtifact may have exactly zero or one parent artifact ID");
    if (!/^[a-f0-9]{40,64}$/i.test(artifactBaseSha ?? "")) throw new Error("WorkerArtifact lineage requires a verified Git SHA");
    this.db.prepare("UPDATE tasks SET artifact_base_sha = ?, artifact_dependencies_json = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(artifactBaseSha, json(artifactDependencies), now(), taskId);
    return this.getTask(taskId);
  }
  listTasks() {
    return this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all().map((row) => this.#mapTask(row));
  }

  cancelUnfinishedTasks({ reason, deliveryRunId = null } = {}) {
    const cancellable = ["queued", "preparing", "running", "awaiting_approval", "awaiting_review", "awaiting_human", "blocked_budget"];
    const tasks = this.db.prepare(`SELECT * FROM tasks WHERE status IN (${cancellable.map(() => "?").join(", ")})${deliveryRunId ? " AND delivery_run_id = ?" : ""} ORDER BY created_at`).all(...cancellable, ...(deliveryRunId ? [deliveryRunId] : []));
    if (!tasks.length) return [];
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const task of tasks) {
        this.db.prepare("UPDATE tasks SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ?").run(reason ?? "cancelled", timestamp, task.id);
        this.#insertEvent(task.id, "task/status", { from: task.status, to: "cancelled", error: reason ?? "cancelled", recovery: "historical task retained; it will not be resumed" });
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return tasks.map((task) => this.getTask(task.id));
  }

  childCount(parentTaskId) {
    return this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ?").get(parentTaskId).count;
  }

  claimNext() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidates = this.db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at").all();
      const row = candidates.find((candidate) => this.#claimable(candidate));
      if (!row) { this.db.exec("COMMIT"); return null; }
      const timestamp = now();
      this.db.prepare("UPDATE tasks SET status = 'preparing', attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'queued'").run(timestamp, row.id);
      this.#insertEvent(row.id, "task/claimed", { attempt: row.attempt + 1 });
      this.db.exec("COMMIT");
      return this.getTask(row.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  transition(id, nextStatus, patch = {}) {
    const current = this.getTask(id);
    if (!current) throw new Error(`Task not found: ${id}`);
    if (current.status === nextStatus) return current;
    assertTransition(current.status, nextStatus);
    const fields = ["status = ?", "updated_at = ?"];
    const values = [nextStatus, now()];
    for (const [column, value] of Object.entries({
      worktree: patch.worktree,
      branch: patch.branch,
      thread_id: patch.threadId,
      turn_id: patch.turnId,
      error: patch.error,
      human_approved: patch.humanApproved === undefined ? undefined : (patch.humanApproved ? 1 : 0)
    })) {
      if (value !== undefined) { fields.push(`${column} = ?`); values.push(value); }
    }
    values.push(id);
    this.#mutate(id, "task/status", { from: current.status, to: nextStatus, ...patch }, () => this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values));
    return this.getTask(id);
  }

  setThread(taskId, { threadId, turnId }) {
    this.#mutate(taskId, "thread/linked", { threadId, turnId }, () => this.db.prepare("UPDATE tasks SET thread_id = ?, turn_id = ?, updated_at = ? WHERE id = ?").run(threadId, turnId ?? null, now(), taskId));
  }

  setTokenUsage(taskId, tokenUsed, { source = "turn_last" } = {}) {
    const current = this.getTask(taskId);
    const measured = Math.max(current?.tokenUsed ?? 0, Number(tokenUsed) || 0);
    this.#mutate(taskId, "thread/tokenUsage", { tokenUsed: measured, source }, () => this.db.prepare("UPDATE tasks SET token_used = ?, token_usage_source = ?, updated_at = ? WHERE id = ?").run(measured, source, now(), taskId));
  }

  setRuntimeBudget(taskId, { interruptThresholdTokens, configuredBudgetCap }) {
    this.#mutate(taskId, "budget/runtime-configured", { interruptThresholdTokens, configuredBudgetCap }, () => this.db.prepare("UPDATE tasks SET interrupt_threshold_tokens = ?, configured_budget_cap = ?, updated_at = ? WHERE id = ?").run(interruptThresholdTokens, configuredBudgetCap, now(), taskId));
  }

  linkTaskToDelivery(taskId, deliveryRunId) {
    this.#mutate(taskId, "delivery/task-linked", { deliveryRunId }, () => this.db.prepare("UPDATE tasks SET delivery_run_id = ?, updated_at = ? WHERE id = ?").run(deliveryRunId, now(), taskId));
    return this.getTask(taskId);
  }

  attachBootstrapTaskToDelivery(taskId, deliveryRunId) {
    const task = this.getTask(taskId); const run = this.deliveryRun(deliveryRunId);
    if (!task || task.role !== "bootstrap") throw new Error("Delivery Bootstrap linkage requires a Bootstrap task");
    if (!run) throw new Error(`Delivery run not found: ${deliveryRunId}`);
    if (run.bootstrapTaskId && run.bootstrapTaskId !== taskId) throw new Error("Delivery run already has a different Bootstrap task");
    if (task.deliveryRunId && task.deliveryRunId !== deliveryRunId) throw new Error("Bootstrap task is already linked to a different delivery run");
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE tasks SET delivery_run_id = ?, updated_at = ? WHERE id = ?").run(deliveryRunId, timestamp, taskId);
      this.db.prepare("UPDATE delivery_runs SET bootstrap_task_id = ?, updated_at = ? WHERE id = ? AND (bootstrap_task_id IS NULL OR bootstrap_task_id = ?)").run(taskId, timestamp, deliveryRunId, taskId);
      this.#insertEvent(taskId, "delivery/bootstrap-linked", { deliveryRunId, bootstrapTaskId: taskId });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(deliveryRunId);
  }

  recordBudgetInterruption({ taskId, deliveryRunId = null, threadId, turnId, actualTokens, interruptThresholdTokens, configuredBudgetCap, reason = "budget_interrupt" }) {
    const interruptedAt = now();
    const thresholdOvershootTokens = Math.max(0, actualTokens - interruptThresholdTokens);
    const capOvershootTokens = Math.max(0, actualTokens - configuredBudgetCap);
    const payload = { taskId, deliveryRunId, threadId, turnId, actualTokens, interruptThresholdTokens, configuredBudgetCap, thresholdOvershootTokens, capOvershootTokens, reason, interruptedAt };
    this.#mutate(taskId, "budget/interrupt", payload, () => this.db.prepare(`INSERT OR IGNORE INTO budget_interruptions(
      task_id, delivery_run_id, thread_id, turn_id, actual_tokens, interrupt_threshold_tokens, configured_budget_cap, threshold_overshoot_tokens, cap_overshoot_tokens, reason, interrupted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(taskId, deliveryRunId, threadId, turnId, actualTokens, interruptThresholdTokens, configuredBudgetCap, thresholdOvershootTokens, capOvershootTokens, reason, interruptedAt));
    return this.budgetInterruption(taskId);
  }

  budgetInterruption(taskId) {
    const row = this.db.prepare("SELECT * FROM budget_interruptions WHERE task_id = ?").get(taskId);
    return row ? { taskId: row.task_id, deliveryRunId: row.delivery_run_id, threadId: row.thread_id, turnId: row.turn_id, actualTokens: row.actual_tokens, interruptThresholdTokens: row.interrupt_threshold_tokens, configuredBudgetCap: row.configured_budget_cap, thresholdOvershootTokens: row.threshold_overshoot_tokens, capOvershootTokens: row.cap_overshoot_tokens, reason: row.reason, interruptedAt: row.interrupted_at } : null;
  }

  setResultPath(taskId, resultPath) {
    this.#mutate(taskId, "task/result", { resultPath }, () => this.db.prepare("UPDATE tasks SET result_path = ?, updated_at = ? WHERE id = ?").run(resultPath, now(), taskId));
  }

  usageForRoot(rootTaskId) {
    return this.db.prepare(`WITH RECURSIVE family(id) AS (
      SELECT id FROM tasks WHERE id = ?
      UNION ALL SELECT t.id FROM tasks t JOIN family f ON t.parent_task_id = f.id
    ) SELECT COALESCE(SUM(${this.#measuredUsageSql()}), 0) AS used,
      COALESCE(SUM(CASE WHEN status IN ('queued','preparing','running','awaiting_approval') THEN token_budget ELSE 0 END), 0) AS reserved
      FROM tasks WHERE id IN family`).get(rootTaskId);
  }

  weeklyUsageSince(since) {
    return this.db.prepare(`SELECT
      COALESCE(SUM(${this.#measuredUsageSql()}), 0) AS used,
      COALESCE(SUM(estimated_tokens), 0) AS estimate,
      COALESCE(SUM(CASE WHEN status IN ('queued','preparing','running','awaiting_approval','awaiting_human') THEN token_budget ELSE 0 END), 0) AS reserved
      FROM tasks WHERE created_at >= ?`).get(since);
  }

  usageForDeliveryRun(deliveryRunId) {
    return this.db.prepare(`SELECT COALESCE(SUM(${this.#measuredUsageSql()}), 0) AS used,
      COALESCE(SUM(CASE WHEN status IN ('queued','preparing','running','awaiting_approval','awaiting_human') THEN token_budget ELSE 0 END), 0) AS reserved
      FROM tasks WHERE delivery_run_id = ?`).get(deliveryRunId);
  }

  recordEvent(taskId, type, payload) {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.#insertEvent(taskId, type, payload); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  recordAppServerTerminalReceipt(taskId, receipt) {
    if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== "AppServerTerminalReceipt") throw new Error("AppServerTerminalReceipt must be versioned");
    if (!["turn_completed", "same_provider_thread_read", "same_provider_thread_read_result_equivalence"].includes(receipt.source)) throw new Error("AppServerTerminalReceipt source is not accepted");
    if (!["completed", "failed", "interrupted", "cancelled"].includes(receipt.terminalClass)) throw new Error("AppServerTerminalReceipt terminal class is not explicit");
    for (const key of ["threadId", "requestedTurnId", "resolvedTurnId", "correlationId", "providerConnectionId", "capturedAt"]) if (typeof receipt[key] !== "string" || !receipt[key]) throw new Error(`AppServerTerminalReceipt lacks ${key}`);
    this.#mutate(taskId, "app-server/terminal-receipt", receipt, () => {});
  }

  recordSourceIntakeTerminalReceipt({ deliveryRunId, role, receipt }) {
    if (!this.hasSourceIntakeTerminalReceipts || !this.deliveryRun(deliveryRunId)) throw new Error("Source intake terminal receipt requires a delivery run");
    if (!new Set(["source_claim_extraction", "source_claim_audit"]).has(role)) throw new Error("Source intake terminal receipt role is invalid");
    if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== "AppServerTerminalReceipt") throw new Error("Source intake terminal receipt must be versioned");
    if (!["turn_completed", "same_provider_thread_read", "same_provider_thread_read_result_equivalence"].includes(receipt.source) || receipt.terminalClass !== "completed") throw new Error("Source intake terminal receipt requires an explicit completed terminal status");
    for (const key of ["threadId", "requestedTurnId", "resolvedTurnId", "correlationId", "providerConnectionId", "capturedAt"]) if (typeof receipt[key] !== "string" || !receipt[key]) throw new Error(`Source intake terminal receipt lacks ${key}`);
    const serialized = JSON.stringify(receipt); const existing = this.db.prepare("SELECT receipt_json FROM source_intake_terminal_receipts WHERE delivery_run_id = ? AND role = ?").get(deliveryRunId, role);
    if (existing && existing.receipt_json !== serialized) throw new Error("Source intake terminal receipt is immutable and mismatched");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!existing) this.db.prepare("INSERT INTO source_intake_terminal_receipts(delivery_run_id,role,schema_version,thread_id,requested_turn_id,resolved_turn_id,receipt_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(deliveryRunId, role, receipt.schemaVersion, receipt.threadId, receipt.requestedTurnId, receipt.resolvedTurnId, serialized, now());
      this.#insertEvent(null, "source-intake/terminal-receipt", { deliveryRunId, role, receipt });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.sourceIntakeTerminalReceipt({ deliveryRunId, role });
  }

  sourceIntakeTerminalReceipt({ deliveryRunId, role }) {
    if (!this.hasSourceIntakeTerminalReceipts) return null;
    const row = this.db.prepare("SELECT receipt_json,created_at FROM source_intake_terminal_receipts WHERE delivery_run_id = ? AND role = ?").get(deliveryRunId, role);
    return row ? { receipt: JSON.parse(row.receipt_json), createdAt: row.created_at } : null;
  }

  recordSourceIntakeAttempt({ deliveryRunId, schemaVersion = 1, role, attemptedThreadId, requestedTurnId, resolvedTurnId = null, runtimeStage, lifecycleState }) {
    if (!this.hasSourceIntakeAttempts || !this.deliveryRun(deliveryRunId) || schemaVersion !== 1 || !["extraction", "audit"].includes(role)
      || !["connect", "start_thread", "start_turn", "observe_terminal", "reconcile_terminal", "result_read"].includes(runtimeStage)
      || !/^[a-z][a-z0-9_]{0,63}$/.test(lifecycleState)
      || ![attemptedThreadId, requestedTurnId].every((value) => typeof value === "string" && value && value.length <= 512)
      || (resolvedTurnId != null && (typeof resolvedTurnId !== "string" || !resolvedTurnId || resolvedTurnId.length > 512))) throw new Error("SourceIntakeAttempt is invalid");
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT attempted_thread_id,requested_turn_id,created_at FROM source_intake_attempts WHERE delivery_run_id = ? AND role = ?").get(deliveryRunId, role);
      if (existing && (existing.attempted_thread_id !== attemptedThreadId || existing.requested_turn_id !== requestedTurnId)) throw new Error("SourceIntakeAttempt correlation is immutable and mismatched");
      if (existing) this.db.prepare("UPDATE source_intake_attempts SET resolved_turn_id = ?,runtime_stage = ?,lifecycle_state = ?,updated_at = ? WHERE delivery_run_id = ? AND role = ?").run(resolvedTurnId, runtimeStage, lifecycleState, timestamp, deliveryRunId, role);
      else this.db.prepare("INSERT INTO source_intake_attempts(delivery_run_id,role,schema_version,attempted_thread_id,requested_turn_id,resolved_turn_id,runtime_stage,lifecycle_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(deliveryRunId, role, schemaVersion, attemptedThreadId, requestedTurnId, resolvedTurnId, runtimeStage, lifecycleState, timestamp, timestamp);
      const attempt = this.sourceIntakeAttemptForRun({ deliveryRunId, role });
      this.#insertEvent(null, "source-intake/attempt", { deliveryRunId, ...attempt });
      this.db.exec("COMMIT"); return attempt;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  sourceIntakeAttemptForRun({ deliveryRunId, role }) {
    if (!this.hasSourceIntakeAttempts) return null;
    const row = this.db.prepare("SELECT * FROM source_intake_attempts WHERE delivery_run_id = ? AND role = ?").get(deliveryRunId, role);
    return row ? { schemaVersion: row.schema_version, role: row.role, attemptedThreadId: row.attempted_thread_id, requestedTurnId: row.requested_turn_id, resolvedTurnId: row.resolved_turn_id, runtimeStage: row.runtime_stage, lifecycleState: row.lifecycle_state, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  recordSourceIntakeFailure({ deliveryRunId, schemaVersion = 1, role, phase, code, receiptIdentity = null, diagnostics = null }) {
    if (!this.hasSourceIntakeFailures || !this.deliveryRun(deliveryRunId) || schemaVersion !== 1 || !["extraction", "audit"].includes(role) || !["terminal", "result_read", "parse", "canonicalize", "validate", "persist"].includes(phase) || !/^[a-z][a-z0-9_]{0,95}$/.test(code)) throw new Error("SourceIntakeFailure is invalid");
    const identity = receiptIdentity && typeof receiptIdentity === "object" && ["threadId", "requestedTurnId", "resolvedTurnId"].every((key) => typeof receiptIdentity[key] === "string" && receiptIdentity[key] && receiptIdentity[key].length <= 512)
      ? { threadId: receiptIdentity.threadId, requestedTurnId: receiptIdentity.requestedTurnId, resolvedTurnId: receiptIdentity.resolvedTurnId }
      : null;
    const safeDiagnostics = sourceIntakeDiagnostics(diagnostics)
      ?? (typeof diagnostics?.errorClass === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(diagnostics.errorClass) ? { errorClass: diagnostics.errorClass } : null);
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("INSERT INTO source_intake_failures(delivery_run_id,schema_version,role,phase,code,receipt_identity_json,diagnostics_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(deliveryRunId, schemaVersion, role, phase, code, identity ? JSON.stringify(identity) : null, safeDiagnostics ? JSON.stringify(safeDiagnostics) : null, timestamp);
      const failure = { id: Number(result.lastInsertRowid), schemaVersion, role, phase, code, receiptIdentity: identity, diagnostics: safeDiagnostics, createdAt: timestamp };
      this.#insertEvent(null, "source-intake/failure", { deliveryRunId, ...failure });
      this.db.exec("COMMIT"); return failure;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  sourceIntakeFailureForRun({ deliveryRunId, role = null }) {
    if (!this.hasSourceIntakeFailures) return null;
    const row = role
      ? this.db.prepare("SELECT * FROM source_intake_failures WHERE delivery_run_id = ? AND role = ? ORDER BY id DESC LIMIT 1").get(deliveryRunId, role)
      : this.db.prepare("SELECT * FROM source_intake_failures WHERE delivery_run_id = ? ORDER BY id DESC LIMIT 1").get(deliveryRunId);
    return row ? { id: row.id, schemaVersion: row.schema_version, role: row.role, phase: row.phase, code: row.code, receiptIdentity: parse(row.receipt_identity_json, null), diagnostics: parse(row.diagnostics_json, null), createdAt: row.created_at } : null;
  }

  events({ after = 0, limit = 500 } = {}) {
    return this.db.prepare("SELECT sequence, task_id, type, payload_json, created_at FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?").all(after, limit)
      .map((row) => ({ sequence: row.sequence, taskId: row.task_id, type: row.type, payload: parse(row.payload_json, {}), createdAt: row.created_at }));
  }

  recentEvents(limit = 20) {
    return this.db.prepare("SELECT sequence, task_id, type, payload_json, created_at FROM events ORDER BY sequence DESC LIMIT ?").all(limit)
      .reverse().map((row) => ({ sequence: row.sequence, taskId: row.task_id, type: row.type, payload: parse(row.payload_json, {}), createdAt: row.created_at }));
  }

  recordApproval({ requestId, taskId, method, payload, decision = null }) {
    this.#mutate(taskId, "approval/requested", { requestId, method, decision }, () => {
      this.db.prepare(`INSERT OR REPLACE INTO approvals(request_id, task_id, method, payload_json, decision, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(String(requestId), taskId, method, JSON.stringify(payload), decision, now(), decision ? now() : null);
    });
  }

  recordAccountSnapshot(snapshot) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO account_snapshots(schema_version, snapshot_json, captured_at) VALUES (?, ?, ?)").run(snapshot.schemaVersion, JSON.stringify(snapshot), snapshot.capturedAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  latestAccountSnapshot() {
    const row = this.db.prepare("SELECT snapshot_json FROM account_snapshots ORDER BY sequence DESC LIMIT 1").get();
    return row ? JSON.parse(row.snapshot_json) : null;
  }

  completedTelemetry() {
    return this.db.prepare("SELECT role, estimated_tokens AS estimatedTokens, token_used AS tokenUsed FROM tasks WHERE status = 'done' AND token_used > 0").all();
  }

  recordWorkerArtifact(taskId, artifactPath, artifact) {
    const task = this.getTask(taskId);
    validateWorkerArtifactContract(artifact);
    if (artifact.taskId !== taskId) throw new Error("WorkerArtifact taskId does not match persistence target");
    if (this.workerArtifact(taskId)) throw new Error(`WorkerArtifact for ${taskId} is immutable and already persisted`);
    if ((artifact.dependencies ?? []).length > 1) throw new Error("WorkerArtifact may have exactly zero or one parent artifact ID");
    this.#mutate(taskId, "worker/artifact", { artifactPath, schemaVersion: artifact.schemaVersion }, () => {
      this.db.prepare(`INSERT INTO worker_artifacts(task_id, schema_version, artifact_path, artifact_json, created_at)
        VALUES (?, ?, ?, ?, ?)` ).run(taskId, artifact.schemaVersion, artifactPath, JSON.stringify(artifact), now());
      for (const requirementId of task?.requirementIds ?? []) this.#insertTraceability({ requirementId, blueprintId: task.blueprintId, taskId, artifactPath, checkpoint: "artifact", payload: { artifactTaskId: taskId } });
    });
  }

  workerArtifact(taskId) {
    const row = this.db.prepare("SELECT artifact_json FROM worker_artifacts WHERE task_id = ?").get(taskId);
    if (!row) return null;
    const artifact = JSON.parse(row.artifact_json);
    try { validateWorkerArtifactContract(artifact); return artifact; }
    catch { return null; } // legacy evidence remains in SQLite but is never trusted as a baseline
  }

  workerArtifactRecord(taskId) {
    const row = this.db.prepare("SELECT artifact_path, artifact_json FROM worker_artifacts WHERE task_id = ?").get(taskId);
    if (!row) return null;
    const artifact = JSON.parse(row.artifact_json);
    try { validateWorkerArtifactContract(artifact); return { path: row.artifact_path, artifact }; }
    catch { return { path: row.artifact_path, artifact, trusted: false }; }
  }

  recordQualityReport({ qaTaskId, writerTaskId, reportPath, report }) {
    const task = this.getTask(qaTaskId);
    this.#mutate(qaTaskId, "quality/report", { writerTaskId, reportPath, verdict: report.verdict }, () => {
      this.db.prepare(`INSERT OR REPLACE INTO quality_reports(qa_task_id, writer_task_id, schema_version, report_path, report_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)` ).run(qaTaskId, writerTaskId, report.schemaVersion, reportPath, JSON.stringify(report), now());
      for (const requirementId of task?.requirementIds ?? []) this.#insertTraceability({ requirementId, blueprintId: task.blueprintId, taskId: qaTaskId, verificationPath: reportPath, checkpoint: "verification", payload: { kind: "qa", verdict: report.verdict } });
    });
  }

  qualityReport(qaTaskId) {
    const row = this.db.prepare("SELECT writer_task_id, report_path, report_json FROM quality_reports WHERE qa_task_id = ?").get(qaTaskId);
    return row ? { writerTaskId: row.writer_task_id, path: row.report_path, report: JSON.parse(row.report_json) } : null;
  }

  recordSecurityReport({ securityTaskId, writerTaskId, reportPath, report }) {
    const task = this.getTask(securityTaskId);
    this.#mutate(securityTaskId, "security/report", { writerTaskId, reportPath, verdict: report.verdict }, () => {
      this.db.prepare(`INSERT OR REPLACE INTO security_reports(security_task_id, writer_task_id, schema_version, report_path, report_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)` ).run(securityTaskId, writerTaskId, report.schemaVersion, reportPath, JSON.stringify(report), now());
      for (const requirementId of task?.requirementIds ?? []) this.#insertTraceability({ requirementId, blueprintId: task.blueprintId, taskId: securityTaskId, verificationPath: reportPath, checkpoint: "verification", payload: { kind: "security", verdict: report.verdict } });
    });
  }

  securityReport(securityTaskId) {
    const row = this.db.prepare("SELECT writer_task_id, report_path, report_json FROM security_reports WHERE security_task_id = ?").get(securityTaskId);
    return row ? { writerTaskId: row.writer_task_id, path: row.report_path, report: JSON.parse(row.report_json) } : null;
  }

  createDeliveryRun({ id, source = null, bootstrapTaskId = null, confirmRemotePush = false, ownerPid, ownerSessionId, sourceClaimManifestId = null, sourceClaimInputMode = "supplied", repositoryMode = "legacy", repositoryBaseSha = null, projectMode = null }) {
    if (!Number.isInteger(ownerPid) || ownerPid < 1 || typeof ownerSessionId !== "string" || !ownerSessionId) throw new Error("Delivery run requires an initial owner lease");
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db.prepare("SELECT id FROM delivery_runs WHERE state IN ('running','awaiting_human','awaiting_human_remote_handoff') LIMIT 1").get();
      if (active) throw new Error(`Delivery already owned by active run: ${active.id}`);
      const validatedProjectMode = projectMode ? validateProjectMode(projectMode) : null;
      if (validatedProjectMode && repositoryMode !== validatedProjectMode.mode) throw new Error("ProjectMode and repositoryMode must match");
      this.db.prepare("INSERT INTO delivery_runs(id, schema_version, state, source, bootstrap_task_id, confirm_remote_push, owner_pid, owner_session_id, heartbeat_at, completion_contract_version, source_claim_manifest_id, source_claim_input_mode, repository_mode, repository_base_sha, project_mode_json, created_at, updated_at) VALUES (?, 1, 'running', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)").run(id, source, bootstrapTaskId, confirmRemotePush ? 1 : 0, ownerPid, ownerSessionId, timestamp, sourceClaimManifestId, sourceClaimInputMode, repositoryMode, repositoryBaseSha, validatedProjectMode ? JSON.stringify(validatedProjectMode) : null, timestamp, timestamp);
      this.#insertEvent(bootstrapTaskId, "delivery/created", { deliveryRunId: id, confirmRemotePush: Boolean(confirmRemotePush), ownerPid, ownerSessionId, heartbeatAt: timestamp });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(id);
  }

  recordRepositoryBaselineDraft(deliveryRunId, draft) {
    if (!this.hasRepositoryBaselines || !draft || draft.kind !== "RepositoryBaselineDraft" || !draft.baseSha) throw new Error("Repository baseline draft is invalid");
    const run = this.deliveryRun(deliveryRunId); if (!run || run.repositoryMode !== "brownfield" || run.repositoryBaseSha !== draft.baseSha) throw new Error("Repository baseline draft delivery identity mismatch");
    const existing = this.repositoryBaselineDraft(deliveryRunId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(draft)) throw new Error("Repository baseline draft is immutable and mismatched");
    if (!existing) this.db.prepare("INSERT INTO repository_baseline_drafts(delivery_run_id,schema_version,draft_json,created_at) VALUES (?,?,?,?)").run(deliveryRunId, draft.schemaVersion, JSON.stringify(draft), now());
    return this.repositoryBaselineDraft(deliveryRunId);
  }

  repositoryBaselineDraft(deliveryRunId) {
    if (!this.hasRepositoryBaselines) return null;
    const row = this.db.prepare("SELECT draft_json FROM repository_baseline_drafts WHERE delivery_run_id = ?").get(deliveryRunId);
    return row ? JSON.parse(row.draft_json) : null;
  }

  recordRepositoryBaseline(deliveryRunId, baseline) {
    if (!this.hasRepositoryBaselines || !baseline || baseline.kind !== "RepositoryBaseline" || !baseline.baselineId || !baseline.digest) throw new Error("Repository baseline is invalid");
    const run = this.deliveryRun(deliveryRunId); const draft = this.repositoryBaselineDraft(deliveryRunId);
    if (!run || run.repositoryMode !== "brownfield" || !draft || draft.baseSha !== baseline.baseSha || run.repositoryBaseSha !== baseline.baseSha || baseline.productBlueprintId !== run.blueprintId) throw new Error("Repository baseline finalization identity mismatch");
    const existing = this.repositoryBaselineForRun(deliveryRunId);
    if (existing && existing.digest !== baseline.digest) throw new Error("Repository baseline is immutable and mismatched");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!existing) this.db.prepare("INSERT INTO repository_baselines(baseline_id,delivery_run_id,schema_version,digest,base_sha,blueprint_id,blueprint_digest,baseline_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(baseline.baselineId, deliveryRunId, baseline.schemaVersion, baseline.digest, baseline.baseSha, baseline.productBlueprintId, baseline.productBlueprintDigest, JSON.stringify(baseline), now());
      this.db.prepare("UPDATE delivery_runs SET repository_baseline_id = ?, updated_at = ? WHERE id = ? AND repository_baseline_id IS NULL").run(baseline.baselineId, now(), deliveryRunId);
      this.#insertEvent(run.bootstrapTaskId, "repository-baseline/finalized", { deliveryRunId, baselineId: baseline.baselineId, digest: baseline.digest, baseSha: baseline.baseSha });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.repositoryBaselineForRun(deliveryRunId);
  }

  repositoryBaselineForRun(deliveryRunId) {
    if (!this.hasRepositoryBaselines) return null;
    const row = this.db.prepare("SELECT baseline_json FROM repository_baselines WHERE delivery_run_id = ?").get(deliveryRunId);
    return row ? JSON.parse(row.baseline_json) : null;
  }

  deliveryRun(id) {
    const row = this.db.prepare("SELECT * FROM delivery_runs WHERE id = ?").get(id);
    return row ? this.#mapDeliveryRun(row) : null;
  }

  currentDeliveryRun() {
    const row = this.db.prepare("SELECT * FROM delivery_runs ORDER BY created_at DESC LIMIT 1").get();
    return row ? this.#mapDeliveryRun(row) : null;
  }

  updateDeliveryRun(id, { state, integrationPath, publish, confirmRemotePush, candidate, publicationCheckpoint } = {}) {
    const current = this.deliveryRun(id); if (!current) throw new Error(`Delivery run not found: ${id}`);
    if (state === "completed_merged") throw new Error("completed_merged may only be set by completeDeliveryWithAcceptance");
    const next = { state: state ?? current.state, integrationPath: integrationPath ?? current.integrationPath, publish: publish ?? current.publish, confirmRemotePush: confirmRemotePush ?? current.confirmRemotePush, candidate: candidate ?? current.candidate, publicationCheckpoint: publicationCheckpoint ?? current.publicationCheckpoint };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const terminal = !["running", "awaiting_human", "awaiting_human_remote_handoff"].includes(next.state);
      if (!terminal) {
        const active = this.db.prepare("SELECT id FROM delivery_runs WHERE state IN ('running','awaiting_human','awaiting_human_remote_handoff') AND id != ? LIMIT 1").get(id);
        if (active) throw new Error(`Delivery already owned by active run: ${active.id}`);
      }
      this.db.prepare("UPDATE delivery_runs SET state = ?, integration_path = ?, candidate_branch = ?, candidate_sha = ?, publication_checkpoint_json = ?, publish_json = ?, confirm_remote_push = ?, owner_pid = CASE WHEN ? THEN NULL ELSE owner_pid END, owner_session_id = CASE WHEN ? THEN NULL ELSE owner_session_id END, heartbeat_at = CASE WHEN ? THEN NULL ELSE heartbeat_at END, updated_at = ? WHERE id = ?").run(next.state, next.integrationPath, next.candidate?.branch ?? null, next.candidate?.sha ?? null, next.publicationCheckpoint ? JSON.stringify(next.publicationCheckpoint) : null, next.publish ? JSON.stringify(next.publish) : null, next.confirmRemotePush ? 1 : 0, terminal ? 1 : 0, terminal ? 1 : 0, terminal ? 1 : 0, now(), id);
      this.#insertEvent(current.bootstrapTaskId, "delivery/state", { deliveryRunId: id, state: next.state, confirmRemotePush: next.confirmRemotePush });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(id);
  }

  recordDependencyDeadlock({ id, deliveryRunId = null, outcome }) {
    if (!id || !outcome || outcome.outcome !== "dependency_deadlock") throw new Error("Dependency deadlock requires an immutable structured outcome");
    if (this.db.prepare("SELECT id FROM dependency_deadlocks WHERE id = ?").get(id)) return this.dependencyDeadlock(id);
    this.db.prepare("INSERT INTO dependency_deadlocks (id, delivery_run_id, outcome_json, created_at) VALUES (?, ?, ?, ?)").run(id, deliveryRunId, JSON.stringify(outcome), now());
    return this.dependencyDeadlock(id);
  }

  dependencyDeadlock(id) {
    const row = this.db.prepare("SELECT * FROM dependency_deadlocks WHERE id = ?").get(id);
    return row ? { id: row.id, deliveryRunId: row.delivery_run_id, outcome: JSON.parse(row.outcome_json), createdAt: row.created_at } : null;
  }

  blockDeliveryForSpecification(id, { reason, recovery } = {}) {
    const current = this.deliveryRun(id); if (!current) throw new Error(`Delivery run not found: ${id}`);
    const safeReason = String(reason ?? "source_claim_contract:source_completeness_validation_failed").slice(0, 160);
    const publish = { reason: safeReason, codes: [safeReason], recovery: recovery ?? { action: "Start a fresh documentation intake and Bootstrap delivery; historical records remain readable." } };
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE delivery_runs SET state = 'blocked_specification', publish_json = ?, owner_pid = NULL, owner_session_id = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(publish), timestamp, id);
      this.db.prepare("UPDATE tasks SET status = 'blocked_specification', error = ?, updated_at = ? WHERE delivery_run_id = ? AND status IN ('queued','preparing','running','awaiting_approval','awaiting_human','interrupted')").run(safeReason, timestamp, id);
      this.db.prepare("UPDATE scoped_replans SET status = 'blocked_specification', failure_detail = ?, updated_at = ?, completed_at = ? WHERE delivery_run_id = ? AND status IN ('pending','planning','materialized')").run(safeReason, timestamp, timestamp, id);
      this.#insertEvent(current.bootstrapTaskId, "delivery/blocked_specification", { deliveryRunId: id, reason: safeReason });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(id);
  }

  blockDeliveryForRepositoryBaseline(id, { reason = "repository_baseline:validation_failed", recovery } = {}) {
    const current = this.deliveryRun(id); if (!current) throw new Error(`Delivery run not found: ${id}`);
    const safeReason = String(reason).match(/^repository_baseline:[a-z_]+$/)?.[0] ?? "repository_baseline:validation_failed";
    const publish = { reason: safeReason, codes: [safeReason], recovery: recovery ?? { action: "Start a fresh brownfield delivery from a valid repository baseline; historical records remain readable." } };
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE delivery_runs SET state = 'blocked_repository_baseline', publish_json = ?, owner_pid = NULL, owner_session_id = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(publish), timestamp, id);
      this.db.prepare("UPDATE tasks SET status = 'blocked_repository_baseline', error = ?, updated_at = ? WHERE delivery_run_id = ? AND status IN ('queued','preparing','running','awaiting_approval','awaiting_human','interrupted')").run(safeReason, timestamp, id);
      this.db.prepare("UPDATE scoped_replans SET status = 'fatal', failure_detail = ?, updated_at = ?, completed_at = ? WHERE delivery_run_id = ? AND status IN ('pending','planning','materialized')").run(safeReason, timestamp, timestamp, id);
      this.#insertEvent(current.bootstrapTaskId, "delivery/blocked_repository_baseline", { deliveryRunId: id, reason: safeReason });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(id);
  }

  claimDeliveryLease(id, { ownerPid, ownerSessionId }) {
    const timestamp = now();
    if (!Number.isInteger(ownerPid) || ownerPid < 1 || typeof ownerSessionId !== "string" || !ownerSessionId) throw new Error("Delivery lease requires owner pid and session");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.deliveryRun(id); if (!current) throw new Error(`Delivery run not found: ${id}`);
      if (!["running", "awaiting_human", "awaiting_human_remote_handoff"].includes(current.state)) throw new Error(`Delivery run is terminal: ${id}`);
      if (current.ownerSessionId && current.ownerSessionId !== ownerSessionId) throw new Error(`Delivery already owned: ${id}`);
      this.db.prepare("UPDATE delivery_runs SET owner_pid = ?, owner_session_id = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND (owner_session_id IS NULL OR owner_session_id = ?)").run(ownerPid, ownerSessionId, timestamp, timestamp, id, ownerSessionId);
      this.#insertEvent(current.bootstrapTaskId, "delivery/lease-claimed", { deliveryRunId: id, ownerPid, ownerSessionId, heartbeatAt: timestamp });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(id);
  }

  createPlanBatch(batch, tasks = [], { replanId = null, replacements = [] } = {}) {
    validatePlan(batch, { maxTasks: Math.max(batch.tasks?.length ?? 0, 1) });
    const persisted = this.db.prepare("SELECT id FROM plan_batches WHERE id = ?").get(batch.id);
    if (persisted) {
      if (replanId && this.scopedReplan(replanId)?.replacementPlanBatchId === batch.id) return this.planBatch(batch.id);
      throw new Error(`PlanBatch ${batch.id} is immutable and already persisted`);
    }
    if (!Array.isArray(tasks) || tasks.length < batch.tasks.length) throw new Error("PlanBatch task materialization must include every planned writer");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#claimRequirementLedgerOwnership(batch, tasks, { replanId });
      this.db.prepare("INSERT INTO plan_batches(id, schema_version, kind, delivery_run_id, blueprint_id, wave, based_on_checkpoint_sha, tasks_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(batch.id, batch.schemaVersion, batch.kind, batch.deliveryRunId, batch.blueprintId, batch.wave, batch.basedOnCheckpointSha, JSON.stringify({ projectMode: batch.projectMode ?? null, tasks: batch.tasks }), batch.createdAt);
      // Inline version of createTasks keeps the batch row and task DAG one decision.
      for (const task of tasks) {
        assertRole(task.role); this.#validateTaskBlueprint(task);
        if (this.getTask(task.id)) throw new Error("PlanBatch task ids must be unused");
        const timestamp = now(), initialStatus = task.humanApprovalRequired ? "awaiting_human" : "queued";
        if (task.executionTopologyVersion !== 1 || !Array.isArray(task.executionDependencies) || typeof task.executionIsWriter !== "boolean") throw new Error("PlanBatch task is missing controller-owned execution topology");
        this.db.prepare(`INSERT INTO tasks (id,parent_task_id,role,title,prompt,status,allowed_paths_json,acceptance_checks_json,dependencies_json,human_approval_required,token_budget,estimated_tokens,max_attempts,created_at,updated_at,risk_flags_json,supporting_domains_json,artifact_base_sha,artifact_dependencies_json,remediation_round,source_writer_task_id,delivery_run_id,blueprint_id,requirement_ids_json,plan_batch_id,wave,integration_barrier_id,execution_dependencies_json,execution_topology_version,execution_is_writer,execution_release_state,execution_release_artifact_task_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(task.id, task.parentTaskId ?? null, task.role, task.title, task.prompt, initialStatus, json(task.allowedPaths), json(task.acceptanceChecks), json(task.dependencies), task.humanApprovalRequired ? 1 : 0, task.tokenBudget, task.estimatedTokens ?? task.tokenBudget, task.maxAttempts ?? 1, timestamp, timestamp, json(task.riskFlags), json(task.supportingDomains), task.artifactBaseSha ?? null, json(task.artifactDependencies), task.remediationRound ?? 0, task.sourceWriterTaskId ?? null, task.deliveryRunId ?? null, task.blueprintId ?? null, json(task.requirementIds), batch.id, batch.wave, task.integrationBarrierId ?? null, json(task.executionDependencies), task.executionTopologyVersion, task.executionIsWriter ? 1 : 0, task.executionIsWriter ? (task.executionReleaseState ?? "pending") : null, task.executionReleaseArtifactTaskId ?? null);
        this.db.prepare("UPDATE tasks SET baseline_behavior_ids_json = ? WHERE id = ?").run(json(task.baselineBehaviorIds), task.id);
        this.#insertEvent(task.id, `task/${initialStatus}`, { role: task.role, title: task.title, planBatchId: batch.id, wave: batch.wave });
        for (const requirementId of task.requirementIds ?? []) this.#insertTraceability({ requirementId, blueprintId: task.blueprintId, taskId: task.id, checkpoint: "planned", payload: { planBatchId: batch.id, wave: batch.wave } });
      }
      if (replanId) {
        const replan = this.scopedReplan(replanId);
        if (!replan || !["planning", "pending"].includes(replan.status)) throw new Error(`Scoped replan ${replanId} is not materializable`);
        this.db.prepare("UPDATE scoped_replans SET replacement_plan_batch_id = ?, status = 'materialized', updated_at = ? WHERE id = ? AND replacement_plan_batch_id IS NULL").run(batch.id, now(), replanId);
        for (const item of replacements) this.db.prepare(`INSERT INTO task_replacements(replan_id,old_task_id,replacement_task_id,kind,created_at) VALUES (?,?,?,?,?)
          ON CONFLICT(replan_id,old_task_id) DO UPDATE SET replacement_task_id = excluded.replacement_task_id, kind = excluded.kind
          WHERE task_replacements.replacement_task_id IS NULL`).run(replanId, item.oldTaskId, item.replacementTaskId ?? null, item.kind ?? "task", now());
        this.#insertEvent(replan.plannerTaskId, "scoped-replan/materialized", { replanId, replacementPlanBatchId: batch.id, replacementTaskIds: tasks.map((task) => task.id) });
      }
      this.#insertEvent(null, "plan-batch/persisted", { planBatchId: batch.id, deliveryRunId: batch.deliveryRunId, wave: batch.wave, basedOnCheckpointSha: batch.basedOnCheckpointSha });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.planBatch(batch.id);
  }

  planBatch(id) {
    const row = this.db.prepare("SELECT * FROM plan_batches WHERE id = ?").get(id);
    if (!row) return null;
    const stored = parse(row.tasks_json, []); const tasks = Array.isArray(stored) ? stored : stored.tasks ?? [];
    return { schemaVersion: row.schema_version, kind: row.kind, id: row.id, deliveryRunId: row.delivery_run_id, blueprintId: row.blueprint_id, projectMode: Array.isArray(stored) ? null : stored.projectMode ?? null, wave: row.wave, basedOnCheckpointSha: row.based_on_checkpoint_sha, tasks, createdAt: row.created_at };
  }
  planBatches(deliveryRunId) { return this.db.prepare("SELECT id FROM plan_batches WHERE delivery_run_id = ? ORDER BY wave, created_at").all(deliveryRunId).map((row) => this.planBatch(row.id)); }

  requirementLedger(deliveryRunId) {
    return this.db.prepare("SELECT * FROM requirement_ledger WHERE delivery_run_id = ? ORDER BY requirement_id, criterion_id").all(deliveryRunId).map((row) => ({
      deliveryRunId: row.delivery_run_id, blueprintId: row.blueprint_id, requirementId: row.requirement_id, criterionId: row.criterion_id || null,
      sourceBlueprintIdentity: row.source_blueprint_identity, coverageState: row.coverage_state, ownerTaskId: row.owner_task_id,
      artifactTaskId: row.artifact_task_id, checkpointId: row.checkpoint_id, candidateSha: row.candidate_sha,
      evidenceState: row.evidence_state, evidence: parse(row.evidence_json, []), unresolvedReason: row.unresolved_reason, updatedAt: row.updated_at
    }));
  }

  reconcileRequirementLedger({ deliveryRunId, checkpointId, diagnosticsLimit = 25 }) {
    const checkpoint = this.integrationCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.kind !== "GlobalWaveCheckpoint" || checkpoint.deliveryRunId !== deliveryRunId) throw new Error("RequirementLedger reconciliation requires a verified GlobalWaveCheckpoint");
    const before = this.requirementLedger(deliveryRunId);
    const diagnostics = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of before) {
        if (!entry.ownerTaskId || entry.coverageState === "covered") continue;
        const owner = this.getTask(entry.ownerTaskId);
        const artifact = owner && this.workerArtifact(owner.id);
        const qa = owner && this.listTasks().find((task) => task.sourceWriterTaskId === owner.id && task.role === "qa");
        const security = owner && this.listTasks().find((task) => task.sourceWriterTaskId === owner.id && task.role === "security");
        const verified = owner?.wave === checkpoint.wave && owner.status === "done" && artifact?.headSha && this.qualityReport(qa?.id)?.report?.verdict === "pass" && this.securityReport(security?.id)?.report?.verdict === "pass";
        if (verified) {
          this.db.prepare("UPDATE requirement_ledger SET coverage_state = 'covered', artifact_task_id = ?, checkpoint_id = ?, evidence_state = CASE WHEN evidence_state = 'passing' THEN evidence_state ELSE 'awaiting_candidate' END, unresolved_reason = NULL, updated_at = ? WHERE delivery_run_id = ? AND requirement_id = ? AND criterion_id = ?")
            .run(owner.id, checkpoint.id, now(), deliveryRunId, entry.requirementId, entry.criterionId ?? "");
        } else if (diagnostics.length < diagnosticsLimit) diagnostics.push({ requirementId: entry.requirementId, criterionId: entry.criterionId, ownerTaskId: entry.ownerTaskId, reason: owner ? `owner_${owner.status}` : "owner_missing" });
      }
      this.reconcileWave({ deliveryRunId, wave: checkpoint.wave, checkpointId });
      const progressed = this.db.prepare("SELECT COUNT(*) AS count FROM requirement_ledger WHERE delivery_run_id = ? AND coverage_state = 'covered'").get(deliveryRunId).count > before.filter((item) => item.coverageState === "covered").length;
      this.db.prepare("UPDATE wave_reconciliations SET progress = ?, diagnostics_json = ? WHERE delivery_run_id = ? AND wave = ?").run(progressed ? 1 : 0, json(diagnostics), deliveryRunId, checkpoint.wave);
      this.#insertEvent(null, "requirement-ledger/reconciled", { deliveryRunId, wave: checkpoint.wave, checkpointId, diagnostics });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    const entries = this.requirementLedger(deliveryRunId);
    const required = entries.filter((item) => item.criterionId === null);
    const remainingRequirementIds = required.filter((item) => item.coverageState !== "covered").map((item) => item.requirementId);
    const unverified = entries.filter((item) => item.coverageState === "covered" && item.evidenceState !== "passing").map((item) => ({ requirementId: item.requirementId, criterionId: item.criterionId }));
    const invalidated = entries.filter((item) => item.coverageState === "invalidated").map((item) => ({ requirementId: item.requirementId, criterionId: item.criterionId, reason: item.unresolvedReason }));
    const progressed = entries.filter((item) => item.coverageState === "covered").length > before.filter((item) => item.coverageState === "covered").length;
    return { checkpoint, entries, remainingRequirementIds, unverified, invalidated, progressed, diagnostics, wave: checkpoint.wave };
  }

  reconcileRequirementLedgerCandidate({ deliveryRunId, reportId }) {
    const stored = this.productAcceptanceReport(reportId); if (!stored) throw new Error("RequirementLedger candidate reconciliation requires a persisted acceptance report");
    const report = stored.report;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of this.requirementLedger(deliveryRunId)) {
        const result = report.results.find((item) => item.requirementId === entry.requirementId && (item.criterionId ?? null) === entry.criterionId);
        const passing = result?.status === "pass";
        this.db.prepare("UPDATE requirement_ledger SET candidate_sha = ?, evidence_state = ?, evidence_json = ?, unresolved_reason = ?, updated_at = ? WHERE delivery_run_id = ? AND requirement_id = ? AND criterion_id = ?")
          .run(report.candidateSha, passing ? "passing" : "not_verified", json(result?.evidence ?? []), passing ? null : `candidate_evidence_${result?.status ?? "missing"}`, now(), deliveryRunId, entry.requirementId, entry.criterionId ?? "");
      }
      this.#insertEvent(null, "requirement-ledger/candidate-reconciled", { deliveryRunId, reportId, candidateSha: report.candidateSha });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.requirementLedger(deliveryRunId);
  }

  assertRequirementLedgerCompletion(deliveryRunId) {
    const entries = this.requirementLedger(deliveryRunId);
    if (!entries.length) return true; // legacy runs retain their former acceptance contract.
    const incomplete = entries.filter((item) => item.coverageState !== "covered" || item.evidenceState !== "passing" || !item.candidateSha);
    if (incomplete.length) throw new Error(`Completion requires candidate-bound passing evidence for every ledger entry: ${incomplete.slice(0, 10).map((item) => `${item.requirementId}:${item.criterionId ?? "@requirement"}`).join(", ")}`);
    const open = this.listTasks().filter((task) => task.deliveryRunId === deliveryRunId && task.planBatchId && !this.isReplannedHistoricalTask(task.id) && task.status !== "done");
    if (open.length) throw new Error("Completion requires every planned dependency to be closed");
    return true;
  }

  createIntegrationBarrier(barrier) {
    validateIntegrationBarrier(barrier);
    if (this.db.prepare("SELECT id FROM integration_barriers WHERE id = ?").get(barrier.id)) throw new Error(`IntegrationBarrier ${barrier.id} is immutable and already persisted`);
    this.db.prepare("INSERT INTO integration_barriers(id,schema_version,kind,delivery_run_id,blueprint_id,wave,base_sha,input_artifacts_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(barrier.id, barrier.schemaVersion, barrier.kind, barrier.deliveryRunId, barrier.blueprintId, barrier.wave, barrier.baseSha, JSON.stringify(barrier.inputArtifacts), barrier.status, barrier.createdAt, barrier.createdAt);
    return this.integrationBarrier(barrier.id);
  }
  integrationBarrier(id) { const row = this.db.prepare("SELECT * FROM integration_barriers WHERE id = ?").get(id); return row ? { schemaVersion: row.schema_version, kind: row.kind, id: row.id, deliveryRunId: row.delivery_run_id, blueprintId: row.blueprint_id, wave: row.wave, baseSha: row.base_sha, inputArtifacts: parse(row.input_artifacts_json, []), status: row.status, checkpointId: row.checkpoint_id, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
  setIntegrationBarrier(taskId, barrierId) { this.db.prepare("UPDATE tasks SET integration_barrier_id = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(barrierId, now(), taskId); return this.getTask(taskId); }
  readyIntegrationBarriers(deliveryRunId = null) { const sql = deliveryRunId ? "SELECT id FROM integration_barriers WHERE delivery_run_id = ? AND status = 'pending' ORDER BY created_at" : "SELECT id FROM integration_barriers WHERE status = 'pending' ORDER BY created_at"; return this.db.prepare(sql).all(...(deliveryRunId ? [deliveryRunId] : [])).map((row) => this.integrationBarrier(row.id)).filter((barrier) => barrier.inputArtifacts.every((item) => Boolean(this.workerArtifact(item.artifactId)))); }
  claimIntegrationBarrier(id) { const result = this.db.prepare("UPDATE integration_barriers SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'").run(now(), id); return result.changes === 1 ? this.integrationBarrier(id) : null; }
  failIntegrationBarrier(id, error) { this.db.prepare("UPDATE integration_barriers SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(error, now(), id); return this.integrationBarrier(id); }
  recordIntegrationCheckpoint(checkpoint, { barrierId } = {}) {
    validateIntegrationCheckpoint(checkpoint);
    if (this.db.prepare("SELECT id FROM integration_checkpoints WHERE id = ?").get(checkpoint.id)) throw new Error(`IntegrationCheckpoint ${checkpoint.id} is immutable and already persisted`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO integration_checkpoints(id,schema_version,kind,delivery_run_id,blueprint_id,wave,base_sha,input_artifacts_json,output_sha,verification_results_json,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(checkpoint.id, checkpoint.schemaVersion, checkpoint.kind, checkpoint.deliveryRunId, checkpoint.blueprintId, checkpoint.wave, checkpoint.baseSha, JSON.stringify(checkpoint.inputArtifacts), checkpoint.outputSha, JSON.stringify(checkpoint.verificationResults), checkpoint.status, checkpoint.createdAt);
      if (barrierId) this.db.prepare("UPDATE integration_barriers SET status = 'passed', checkpoint_id = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(checkpoint.id, now(), barrierId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.integrationCheckpoint(checkpoint.id);
  }
  integrationCheckpoint(id) {
    const row = this.db.prepare("SELECT * FROM integration_checkpoints WHERE id = ?").get(id); if (!row) return null;
    const checkpoint = { schemaVersion: row.schema_version, kind: row.kind, id: row.id, deliveryRunId: row.delivery_run_id, blueprintId: row.blueprint_id, wave: row.wave, baseSha: row.base_sha, inputArtifacts: parse(row.input_artifacts_json, []), outputSha: row.output_sha, verificationResults: parse(row.verification_results_json, []), status: row.status, createdAt: row.created_at, barrierId: row.barrier_id, effectiveLineage: parse(row.effective_lineage_json, []), consumerTaskIds: parse(row.consumer_task_ids_json, []) };
    try {
      if (row.checkpoint_type === "LocalIntegrationCheckpoint") validateLocalIntegrationCheckpoint(checkpoint);
      else if (row.checkpoint_type === "GlobalWaveCheckpoint") validateGlobalWaveCheckpoint(checkpoint);
      else return null;
      return checkpoint;
    } catch { return null; }
  }
  recordLocalIntegrationCheckpoint(checkpoint) {
    validateLocalIntegrationCheckpoint(checkpoint);
    const barrier = this.integrationBarrier(checkpoint.barrierId);
    if (!barrier || barrier.status !== "running" || barrier.deliveryRunId !== checkpoint.deliveryRunId || barrier.wave !== checkpoint.wave || barrier.baseSha !== checkpoint.baseSha || JSON.stringify(barrier.inputArtifacts) !== JSON.stringify(checkpoint.inputArtifacts)) throw new Error("LocalIntegrationCheckpoint barrier linkage is missing or mismatched");
    for (const input of checkpoint.inputArtifacts) { const artifact = this.workerArtifact(input.artifactId); if (!artifact || artifact.headSha !== input.headSha) throw new Error("LocalIntegrationCheckpoint included input is missing or mismatched"); }
    const consumers = checkpoint.consumerTaskIds.map((id) => this.getTask(id));
    if (consumers.some((task) => !task || task.integrationBarrierId !== checkpoint.barrierId || task.status !== "queued")) throw new Error("LocalIntegrationCheckpoint consumer linkage is missing or mismatched");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT id FROM integration_checkpoints WHERE id = ?").get(checkpoint.id)) throw new Error("LocalIntegrationCheckpoint is immutable and already persisted");
      this.db.prepare("INSERT INTO integration_checkpoints(id,schema_version,kind,delivery_run_id,blueprint_id,wave,base_sha,input_artifacts_json,output_sha,verification_results_json,status,created_at,checkpoint_type,barrier_id,effective_lineage_json,consumer_task_ids_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(checkpoint.id, checkpoint.schemaVersion, checkpoint.kind, checkpoint.deliveryRunId, checkpoint.blueprintId, checkpoint.wave, checkpoint.baseSha, json(checkpoint.inputArtifacts), checkpoint.outputSha, json(checkpoint.verificationResults), checkpoint.status, checkpoint.createdAt, checkpoint.kind, checkpoint.barrierId, json(checkpoint.effectiveLineage), json(checkpoint.consumerTaskIds));
      this.db.prepare("UPDATE integration_barriers SET status = 'passed', checkpoint_id = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(checkpoint.id, now(), checkpoint.barrierId);
      for (const task of consumers) this.db.prepare("UPDATE tasks SET artifact_base_sha = ?, artifact_dependencies_json = '[]', local_checkpoint_id = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(checkpoint.outputSha, checkpoint.id, now(), task.id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.integrationCheckpoint(checkpoint.id);
  }
  recordGlobalWaveCheckpoint(checkpoint) {
    validateGlobalWaveCheckpoint(checkpoint);
    const batch = this.planBatches(checkpoint.deliveryRunId).find((item) => item.wave === checkpoint.wave);
    if (!batch || batch.blueprintId !== checkpoint.blueprintId || batch.basedOnCheckpointSha !== checkpoint.baseSha) throw new Error("GlobalWaveCheckpoint must bind its immutable PlanBatch baseline");
    if (checkpoint.wave > 1) {
      const prior = this.currentCheckpoint(checkpoint.deliveryRunId);
      if (!prior || prior.wave !== checkpoint.wave - 1 || prior.outputSha !== checkpoint.baseSha) throw new Error("GlobalWaveCheckpoint ancestry must extend the prior reconciled checkpoint");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM integration_checkpoints WHERE delivery_run_id = ? AND wave = ? AND checkpoint_type = 'GlobalWaveCheckpoint'").get(checkpoint.deliveryRunId, checkpoint.wave)) throw new Error("GlobalWaveCheckpoint is immutable and already persisted");
      this.db.prepare("INSERT INTO integration_checkpoints(id,schema_version,kind,delivery_run_id,blueprint_id,wave,base_sha,input_artifacts_json,output_sha,verification_results_json,status,created_at,checkpoint_type,effective_lineage_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(checkpoint.id, checkpoint.schemaVersion, checkpoint.kind, checkpoint.deliveryRunId, checkpoint.blueprintId, checkpoint.wave, checkpoint.baseSha, json(checkpoint.inputArtifacts), checkpoint.outputSha, json(checkpoint.verificationResults), checkpoint.status, checkpoint.createdAt, checkpoint.kind, json(checkpoint.effectiveLineage));
      this.#insertEvent(null, "global-wave-checkpoint/verified", { deliveryRunId: checkpoint.deliveryRunId, wave: checkpoint.wave, checkpointId: checkpoint.id, checkpointSha: checkpoint.outputSha });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.currentCheckpoint(checkpoint.deliveryRunId);
  }
  globalWaveCheckpoint(deliveryRunId, wave) { const row = this.db.prepare("SELECT id FROM integration_checkpoints WHERE delivery_run_id = ? AND wave = ? AND checkpoint_type = 'GlobalWaveCheckpoint'").get(deliveryRunId, wave); return row ? this.integrationCheckpoint(row.id) : null; }
  unreconciledGlobalWaveCheckpoint(deliveryRunId) {
    const row = this.db.prepare("SELECT id FROM integration_checkpoints WHERE delivery_run_id = ? AND checkpoint_type = 'GlobalWaveCheckpoint' AND id NOT IN (SELECT checkpoint_id FROM wave_reconciliations WHERE status = 'reconciled') ORDER BY wave LIMIT 1").get(deliveryRunId);
    return row ? this.integrationCheckpoint(row.id) : null;
  }
  reconcileWave({ deliveryRunId, wave, checkpointId }) {
    const checkpoint = this.integrationCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.kind !== "GlobalWaveCheckpoint" || checkpoint.deliveryRunId !== deliveryRunId || checkpoint.wave !== wave) throw new Error("Wave reconciliation requires a verified GlobalWaveCheckpoint");
    if (this.db.prepare("SELECT 1 FROM wave_reconciliations WHERE delivery_run_id = ? AND wave = ? AND status = 'reconciled'").get(deliveryRunId, wave)) return this.currentCheckpoint(deliveryRunId);
    this.db.prepare("INSERT INTO wave_reconciliations(delivery_run_id,wave,checkpoint_id,checkpoint_sha,status,created_at) VALUES (?,?,?,?,?,?)").run(deliveryRunId, wave, checkpointId, checkpoint.outputSha, "reconciled", now());
    return this.currentCheckpoint(deliveryRunId);
  }
  currentCheckpoint(deliveryRunId) { const row = this.db.prepare("SELECT checkpoint_id, checkpoint_sha, wave FROM wave_reconciliations WHERE delivery_run_id = ? AND status = 'reconciled' ORDER BY wave DESC LIMIT 1").get(deliveryRunId); const checkpoint = row ? this.integrationCheckpoint(row.checkpoint_id) : null; return checkpoint?.kind === "GlobalWaveCheckpoint" && checkpoint.outputSha === row.checkpoint_sha ? { checkpointId: row.checkpoint_id, outputSha: row.checkpoint_sha, wave: row.wave } : null; }
  reconciliationHistory(deliveryRunId) { return this.db.prepare("SELECT * FROM wave_reconciliations WHERE delivery_run_id = ? ORDER BY wave").all(deliveryRunId).map((row) => ({ wave: row.wave, checkpointId: row.checkpoint_id, checkpointSha: row.checkpoint_sha, status: row.status, progressed: row.progress === null ? null : Boolean(row.progress), diagnostics: parse(row.diagnostics_json, []), createdAt: row.created_at })); }
  recordScopedReplan(value) {
    const timestamp = value.createdAt ?? now();
    if (!value.idempotencyKey || !value.failureKind || !value.deliveryRunId || !value.blueprintId) throw new Error("Scoped replan v2 requires delivery, blueprint, failure taxonomy, and idempotency key");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT id FROM scoped_replans WHERE idempotency_key = ?").get(value.idempotencyKey);
      if (existing) { this.db.exec("COMMIT"); return existing.id; }
      this.db.prepare(`INSERT INTO scoped_replans(
        id,schema_version,delivery_run_id,blueprint_id,failed_task_id,failure_kind,failure_detail,
        affected_task_ids_json,invalidated_task_ids_json,preserved_artifacts_json,prior_plan_batch_id,
        prior_checkpoint_id,prior_checkpoint_sha,remaining_requirement_ids_json,prior_context_json,
        attempt,max_attempts,idempotency_key,planner_task_id,replacement_plan_batch_id,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        value.id, 2, value.deliveryRunId, value.blueprintId, value.failedTaskId, value.failureKind, String(value.failureDetail ?? "").slice(0, 1200),
        json(value.affectedTaskIds), json(value.invalidatedTaskIds), JSON.stringify(value.preservedArtifacts ?? []), value.priorPlanBatchId ?? null,
        value.priorCheckpointId ?? null, value.priorCheckpointSha ?? null, json(value.remainingRequirementIds), JSON.stringify(value.priorContext ?? {}),
        value.attempt ?? 0, value.maxAttempts ?? 2, value.idempotencyKey, value.plannerTaskId ?? null, null, value.status ?? "pending", timestamp, timestamp
      );
      for (const oldTaskId of value.invalidatedTaskIds ?? []) {
        const task = this.getTask(oldTaskId); if (!task) continue;
        if (["queued", "preparing", "awaiting_human", "awaiting_approval"].includes(task.status)) this.db.prepare("UPDATE tasks SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ? AND status IN ('queued','preparing','awaiting_human','awaiting_approval')").run(`invalidated_by_scoped_replan:${value.id}`, timestamp, oldTaskId);
        this.db.prepare("INSERT OR IGNORE INTO task_replacements(replan_id,old_task_id,replacement_task_id,kind,created_at) VALUES (?,?,?,?,?)").run(value.id, oldTaskId, null, "invalidated", timestamp);
      }
      this.db.prepare("INSERT OR IGNORE INTO task_replacements(replan_id,old_task_id,replacement_task_id,kind,created_at) VALUES (?,?,?,?,?)").run(value.id, value.failedTaskId, null, "failed", timestamp);
      this.#insertEvent(value.failedTaskId, "scoped-replan/pending", { replanId: value.id, failureKind: value.failureKind, invalidatedTaskIds: value.invalidatedTaskIds ?? [] });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return value.id;
  }

  scopedReplan(id) { const row = this.db.prepare("SELECT * FROM scoped_replans WHERE id = ?").get(id); return row ? this.#mapScopedReplan(row) : null; }
  scopedReplans(deliveryRunId = null) { const rows = this.db.prepare(deliveryRunId ? "SELECT * FROM scoped_replans WHERE delivery_run_id = ? ORDER BY created_at" : "SELECT * FROM scoped_replans ORDER BY created_at").all(...(deliveryRunId ? [deliveryRunId] : [])); return rows.map((row) => this.#mapScopedReplan(row)); }
  activeScopedReplans(deliveryRunId) { return this.scopedReplans(deliveryRunId).filter((item) => ["pending", "planning", "materialized"].includes(item.status)); }
  claimScopedReplan(id) { const changed = this.db.prepare("UPDATE scoped_replans SET status = 'planning', attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'pending' AND attempt < max_attempts").run(now(), id); return changed.changes ? this.scopedReplan(id) : null; }
  attachScopedReplanPlanner(id, plannerTaskId) { this.db.prepare("UPDATE scoped_replans SET planner_task_id = ?, updated_at = ? WHERE id = ? AND status = 'planning' AND planner_task_id IS NULL").run(plannerTaskId, now(), id); return this.scopedReplan(id); }
  blockScopedReplan(id, status, detail = "") { if (!["blocked_specification", "blocked_quota", "blocked_budget", "fatal", "abandoned", "legacy_manual"].includes(status)) throw new Error("Invalid scoped replan terminal status"); this.db.prepare("UPDATE scoped_replans SET status = ?, failure_detail = ?, updated_at = ?, completed_at = ? WHERE id = ?").run(status, String(detail).slice(0, 1200), now(), now(), id); return this.scopedReplan(id); }
  completeReadyScopedReplans(deliveryRunId) { const completed = []; for (const replan of this.activeScopedReplans(deliveryRunId).filter((item) => item.status === "materialized")) { const replacements = this.db.prepare("SELECT replacement_task_id FROM task_replacements WHERE replan_id = ? AND replacement_task_id IS NOT NULL").all(replan.id); if (replacements.length && replacements.every((item) => this.getTask(item.replacement_task_id)?.status === "done")) { this.db.prepare("UPDATE scoped_replans SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'materialized'").run(now(), now(), replan.id); completed.push(replan.id); } } return completed; }
  hasEffectiveInvalidatedWork(deliveryRunId) { return this.activeScopedReplans(deliveryRunId).length > 0; }
  isHistoricalInvalidatedTask(taskId) { return Boolean(this.db.prepare("SELECT 1 FROM task_replacements WHERE old_task_id = ? AND kind IN ('invalidated','task','barrier-consumer') LIMIT 1").get(taskId)); }
  isReplannedHistoricalTask(taskId) { return Boolean(this.db.prepare("SELECT 1 FROM task_replacements WHERE old_task_id = ? LIMIT 1").get(taskId)); }

  recordSourceClaimManifest(manifest) {
    if (!manifest?.manifestId || !manifest?.digest || !manifest?.documentSetDigest) throw new Error("SourceClaimManifest identity is invalid");
    const existing = this.db.prepare("SELECT digest FROM source_claim_manifests WHERE manifest_id = ?").get(manifest.manifestId);
    if (existing && existing.digest !== manifest.digest) throw new Error(`SourceClaimManifest '${manifest.manifestId}' is immutable and mismatched`);
    if (!existing) this.db.prepare("INSERT INTO source_claim_manifests(manifest_id,schema_version,digest,document_set_digest,manifest_json,created_at) VALUES (?,?,?,?,?,?)").run(manifest.manifestId, manifest.schemaVersion, manifest.digest, manifest.documentSetDigest, JSON.stringify(manifest), now());
    return this.sourceClaimManifest(manifest.manifestId);
  }

  sourceClaimManifest(manifestId) {
    if (!this.hasSourceClaimManifests) return null;
    const row = this.db.prepare("SELECT digest,document_set_digest,manifest_json,created_at FROM source_claim_manifests WHERE manifest_id = ?").get(manifestId);
    return row ? { manifest: JSON.parse(row.manifest_json), digest: row.digest, documentSetDigest: row.document_set_digest, createdAt: row.created_at } : null;
  }

  recordSourceClaimExtraction({ deliveryRunId, extraction, artifactPath }) {
    if (!this.hasSourceClaimExtractions || !this.deliveryRun(deliveryRunId) || !extraction?.extractionId || !extraction?.digest || !extraction?.documentSetDigest || typeof artifactPath !== "string" || !artifactPath) throw new Error("SourceClaimExtraction identity is invalid");
    const recordId = `${extraction.extractionId}@${deliveryRunId}`;
    const existing = this.db.prepare("SELECT digest, delivery_run_id FROM source_claim_extractions WHERE extraction_id = ?").get(recordId);
    if (existing && (existing.digest !== extraction.digest || existing.delivery_run_id !== deliveryRunId)) throw new Error(`SourceClaimExtraction '${extraction.extractionId}' is immutable and mismatched`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!existing) this.db.prepare("INSERT INTO source_claim_extractions(extraction_id,delivery_run_id,schema_version,digest,document_set_digest,artifact_path,extraction_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(recordId, deliveryRunId, extraction.schemaVersion, extraction.digest, extraction.documentSetDigest, artifactPath, JSON.stringify(extraction), now());
      this.db.prepare("UPDATE delivery_runs SET source_claim_extraction_id = ?, updated_at = ? WHERE id = ? AND source_claim_extraction_id IS NULL").run(recordId, now(), deliveryRunId);
      this.#insertEvent(null, "source-claim-extraction/persisted", { deliveryRunId, extractionId: extraction.extractionId, digest: extraction.digest, claimCount: extraction.claims.length });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.sourceClaimExtraction(recordId);
  }

  sourceClaimExtraction(extractionId) {
    if (!this.hasSourceClaimExtractions) return null;
    const row = this.db.prepare("SELECT * FROM source_claim_extractions WHERE extraction_id = ?").get(extractionId);
    return row ? { id: row.extraction_id, extraction: JSON.parse(row.extraction_json), artifactPath: row.artifact_path, digest: row.digest, documentSetDigest: row.document_set_digest, deliveryRunId: row.delivery_run_id, createdAt: row.created_at } : null;
  }

  recordSourceClaimAudit({ deliveryRunId, audit, artifactPath }) {
    if (!this.hasSourceClaimAudits || !this.deliveryRun(deliveryRunId) || !audit?.auditId || !audit?.digest || !audit?.documentSetDigest || !audit?.candidateId || !audit?.candidateDigest || typeof artifactPath !== "string" || !artifactPath) throw new Error("SourceClaimAudit identity is invalid");
    const recordId = `${audit.auditId}@${deliveryRunId}`;
    const existing = this.db.prepare("SELECT digest, delivery_run_id FROM source_claim_audits WHERE audit_id = ?").get(recordId);
    if (existing && (existing.digest !== audit.digest || existing.delivery_run_id !== deliveryRunId)) throw new Error(`SourceClaimAudit '${audit.auditId}' is immutable and mismatched`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!existing) this.db.prepare("INSERT INTO source_claim_audits(audit_id,delivery_run_id,schema_version,digest,document_set_digest,candidate_id,candidate_digest,artifact_path,audit_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(recordId, deliveryRunId, audit.schemaVersion, audit.digest, audit.documentSetDigest, audit.candidateId, audit.candidateDigest, artifactPath, JSON.stringify(audit), now());
      this.db.prepare("UPDATE delivery_runs SET source_claim_audit_id = ?, updated_at = ? WHERE id = ? AND source_claim_audit_id IS NULL").run(recordId, now(), deliveryRunId);
      this.#insertEvent(null, "source-claim-audit/persisted", { deliveryRunId, auditId: audit.auditId, digest: audit.digest, candidateId: audit.candidateId, decisionCount: audit.decisions.length });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.sourceClaimAudit(recordId);
  }

  sourceClaimAudit(auditId) {
    if (!this.hasSourceClaimAudits) return null;
    const row = this.db.prepare("SELECT * FROM source_claim_audits WHERE audit_id = ?").get(auditId);
    return row ? { id: row.audit_id, audit: JSON.parse(row.audit_json), artifactPath: row.artifact_path, digest: row.digest, documentSetDigest: row.document_set_digest, candidateId: row.candidate_id, candidateDigest: row.candidate_digest, deliveryRunId: row.delivery_run_id, createdAt: row.created_at } : null;
  }

  recordProductBlueprint({ blueprint, artifactPath, digest, bootstrapTaskId = null, deliveryRunId = null, sourceClaimManifestId = null }) {
    const existing = this.db.prepare("SELECT artifact_path FROM product_blueprints WHERE blueprint_id = ?").get(blueprint.blueprintId);
    if (existing) throw new Error(`ProductBlueprint '${blueprint.blueprintId}' is immutable and already persisted at ${existing.artifact_path}`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO product_blueprints(blueprint_id, schema_version, artifact_path, digest, document_set_digest, bootstrap_task_id, delivery_run_id, source_claim_manifest_id, blueprint_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(blueprint.blueprintId, blueprint.schemaVersion, artifactPath, digest, blueprint.documentSetDigest, bootstrapTaskId, deliveryRunId, sourceClaimManifestId, JSON.stringify(blueprint), now());
      if (deliveryRunId) this.#initializeRequirementLedger(deliveryRunId, blueprint, digest);
      if (blueprint.resolutionAuthority) this.db.prepare("INSERT INTO specification_resolution_evidence(blueprint_id, schema_version, evidence_json, created_at) VALUES (?, ?, ?, ?)").run(blueprint.blueprintId, blueprint.resolutionAuthority.schemaVersion, JSON.stringify(blueprint.resolutionAuthority), now());
      this.#insertEvent(bootstrapTaskId, "blueprint/persisted", { blueprintId: blueprint.blueprintId, artifactPath, digest, deliveryRunId });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.productBlueprint(blueprint.blueprintId);
  }

  productBlueprint(blueprintId) {
    const row = this.db.prepare("SELECT artifact_path, digest, document_set_digest, bootstrap_task_id, delivery_run_id, source_claim_manifest_id, blueprint_json, created_at FROM product_blueprints WHERE blueprint_id = ?").get(blueprintId);
    if (!row) return null;
    const authority = this.hasResolutionAuthorityEvidence ? this.db.prepare("SELECT schema_version, evidence_json FROM specification_resolution_evidence WHERE blueprint_id = ?").get(blueprintId) : null;
    return { blueprint: JSON.parse(row.blueprint_json), artifactPath: row.artifact_path, digest: row.digest, documentSetDigest: row.document_set_digest, bootstrapTaskId: row.bootstrap_task_id, deliveryRunId: row.delivery_run_id, sourceClaimManifestId: row.source_claim_manifest_id ?? null, createdAt: row.created_at, resolutionAuthority: authority ? { schemaVersion: authority.schema_version, ...JSON.parse(authority.evidence_json) } : null };
  }

  productBlueprintForBootstrap(bootstrapTaskId) {
    const row = this.db.prepare("SELECT blueprint_id FROM product_blueprints WHERE bootstrap_task_id = ? ORDER BY created_at DESC LIMIT 1").get(bootstrapTaskId);
    return row ? this.productBlueprint(row.blueprint_id) : null;
  }

  linkBlueprintToDelivery(deliveryRunId, blueprintId) {
    if (!this.productBlueprint(blueprintId)) throw new Error(`ProductBlueprint '${blueprintId}' was not persisted`);
    this.#mutate(null, "delivery/blueprint-linked", { deliveryRunId, blueprintId }, () => this.db.prepare("UPDATE delivery_runs SET blueprint_id = ?, updated_at = ? WHERE id = ? AND blueprint_id IS NULL").run(blueprintId, now(), deliveryRunId));
    return this.deliveryRun(deliveryRunId);
  }

  linkSourceClaimManifestToDelivery(deliveryRunId, manifestId) {
    if (!this.sourceClaimManifest(manifestId)) throw new Error(`SourceClaimManifest '${manifestId}' was not persisted`);
    this.db.prepare("UPDATE delivery_runs SET source_claim_manifest_id = ?, updated_at = ? WHERE id = ? AND source_claim_manifest_id IS NULL").run(manifestId, now(), deliveryRunId);
    return this.deliveryRun(deliveryRunId);
  }

  recordTraceability({ requirementId, blueprintId, taskId = null, artifactPath = null, verificationPath = null, checkpoint = null, payload = {} }) {
    if (!this.productBlueprint(blueprintId)) throw new Error(`Traceability requires persisted ProductBlueprint '${blueprintId}'`);
    this.#mutate(taskId, "traceability/recorded", { requirementId, blueprintId, artifactPath, verificationPath, checkpoint }, () => this.#insertTraceability({ requirementId, blueprintId, taskId, artifactPath, verificationPath, checkpoint, payload }));
  }

  traceabilityForRequirement(requirementId) {
    return this.db.prepare("SELECT * FROM traceability_records WHERE requirement_id = ? ORDER BY sequence").all(requirementId).map((row) => ({ sequence: row.sequence, requirementId: row.requirement_id, blueprintId: row.blueprint_id, taskId: row.task_id, artifactPath: row.artifact_path, verificationPath: row.verification_path, checkpoint: row.checkpoint, payload: parse(row.payload_json, {}), createdAt: row.created_at }));
  }

  resumeDeliveryRun(id, { ownerPid, ownerSessionId }) {
    if (!Number.isInteger(ownerPid) || ownerPid < 1 || typeof ownerSessionId !== "string" || !ownerSessionId) throw new Error("Delivery resume requires owner pid and session");
    const resumable = ["interrupted", "blocked_credentials", "blocked_ci", "blocked_branch_protection", "blocked_reconciliation"];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.deliveryRun(id); if (!current) throw new Error(`Delivery run not found: ${id}`);
      const recoverableFailure = current.state === "failed" && this.activeScopedReplans(id).length > 0;
      if (!resumable.includes(current.state) && !recoverableFailure) throw new Error(`Delivery run is not resumable: ${id} (${current.state})`);
      const timestamp = now();
      const changed = this.db.prepare("UPDATE delivery_runs SET state = 'running', owner_pid = ?, owner_session_id = ?, heartbeat_at = ?, interrupted_at = NULL, updated_at = ? WHERE id = ? AND owner_session_id IS NULL").run(ownerPid, ownerSessionId, timestamp, timestamp, id);
      if (!changed.changes) throw new Error(`Delivery already owned: ${id}`);
      this.#insertEvent(current.bootstrapTaskId, "delivery/resumed", { deliveryRunId: id, previousState: current.state, ownerPid, ownerSessionId, publicationCheckpoint: current.publicationCheckpoint });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(id);
  }

  resumeSourceClaimExtractionRun(id, { ownerPid, ownerSessionId }) {
    if (!Number.isInteger(ownerPid) || ownerPid < 1 || typeof ownerSessionId !== "string" || !ownerSessionId) throw new Error("Source claim extraction resume requires owner pid and session");
    const run = this.deliveryRun(id);
    if (!run || run.sourceClaimInputMode !== "raw" || run.sourceClaimExtractionId || run.state !== "blocked_specification" || !String(run.publish?.reason ?? "").startsWith("source_claim_extraction:")) throw new Error("Delivery run is not a resumable raw source claim extraction");
    const timestamp = now();
    this.db.prepare("UPDATE delivery_runs SET state = 'running', owner_pid = ?, owner_session_id = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND state = 'blocked_specification'").run(ownerPid, ownerSessionId, timestamp, timestamp, id);
    this.#insertEvent(null, "source-claim-extraction/resumed", { deliveryRunId: id });
    return this.deliveryRun(id);
  }

  resumeInterruptedTasks(deliveryRunId) {
    const tasks = this.db.prepare("SELECT * FROM tasks WHERE delivery_run_id = ? AND status = 'interrupted' ORDER BY created_at").all(deliveryRunId);
    if (!tasks.length) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = now();
      for (const task of tasks) {
        this.db.prepare("UPDATE tasks SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?").run(timestamp, task.id);
        this.#insertEvent(task.id, "task/resumed", { from: "interrupted", to: "queued", recovery: "same_delivery_run" });
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return tasks.map((task) => this.getTask(task.id));
  }

  heartbeatDeliveryLease(id, ownerSessionId) {
    const timestamp = now();
    const current = this.deliveryRun(id); if (!current || current.ownerSessionId !== ownerSessionId) return null;
    this.db.prepare("UPDATE delivery_runs SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND owner_session_id = ?").run(timestamp, timestamp, id, ownerSessionId);
    return this.deliveryRun(id);
  }

  interruptDeliveryRun(id, { reason, recovery = null } = {}) {
    const current = this.deliveryRun(id); if (!current) throw new Error(`Delivery run not found: ${id}`);
    const timestamp = now();
    const nextRecovery = { ...(current.recovery ?? {}), reason, ...(recovery ?? {}), interruptedAt: timestamp };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE delivery_runs SET state = 'interrupted', interrupted_at = ?, recovery_json = ?, owner_pid = NULL, owner_session_id = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ?").run(timestamp, JSON.stringify(nextRecovery), timestamp, id);
      const active = this.db.prepare("SELECT id, status, thread_id, turn_id, token_used FROM tasks WHERE (delivery_run_id = ? OR id = ?) AND status IN ('preparing','running','awaiting_approval')").all(id, current.bootstrapTaskId);
      for (const task of active) {
        this.db.prepare("UPDATE tasks SET status = 'interrupted', error = ?, updated_at = ? WHERE id = ?").run(reason, timestamp, task.id);
        this.#insertEvent(task.id, "task/status", { from: task.status, to: "interrupted", error: reason, threadId: task.thread_id, turnId: task.turn_id, tokenUsed: task.token_used });
      }
      this.#insertEvent(current.bootstrapTaskId, "delivery/interrupted", { deliveryRunId: id, reason, recovery: nextRecovery, interruptedTasks: active.map((task) => task.id) });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(id);
  }

  recoverStaleDeliveryRuns({ isProcessAlive, staleAfterMs }) {
    const cutoff = Date.now() - staleAfterMs;
    const candidates = this.db.prepare("SELECT * FROM delivery_runs WHERE state IN ('running','awaiting_human','awaiting_human_remote_handoff') ORDER BY created_at ASC").all();
    const recovered = [];
    for (const row of candidates) {
      const run = this.#mapDeliveryRun(row);
      const heartbeat = run.heartbeatAt ? Date.parse(run.heartbeatAt) : 0;
      const ownerAlive = Number.isInteger(run.ownerPid) && isProcessAlive(run.ownerPid);
      if (ownerAlive && heartbeat > cutoff) continue;
      const reason = !run.ownerPid ? "interrupted_controller_exit: missing owner lease" : ownerAlive ? "interrupted_controller_exit: stale owner heartbeat" : "interrupted_controller_exit: owner process is not alive";
      recovered.push(this.interruptDeliveryRun(run.id, { reason, recovery: { previousOwnerPid: run.ownerPid, previousOwnerSessionId: run.ownerSessionId, previousHeartbeatAt: run.heartbeatAt, staleAfterMs } }));
    }
    return recovered;
  }

  recordExternalAction({ idempotencyKey, kind, status, payload = {} }) {
    const existing = this.db.prepare("SELECT payload_json, status FROM external_actions WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return { duplicate: true, status: existing.status, payload: JSON.parse(existing.payload_json) };
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO external_actions(idempotency_key, kind, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(idempotencyKey, kind, status, JSON.stringify(payload), timestamp, timestamp);
      this.#insertEvent(null, "external/action", { kind, status, idempotencyKey });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { duplicate: false, status, payload };
  }

  externalAction(idempotencyKey) {
    const row = this.db.prepare("SELECT kind, status, payload_json, created_at, updated_at FROM external_actions WHERE idempotency_key = ?").get(idempotencyKey);
    return row ? { kind: row.kind, status: row.status, payload: JSON.parse(row.payload_json), createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  updateExternalAction(idempotencyKey, { status, payload }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE external_actions SET status = ?, payload_json = ?, updated_at = ? WHERE idempotency_key = ?").run(status, JSON.stringify(payload ?? {}), now(), idempotencyKey);
      this.#insertEvent(null, "external/action", { idempotencyKey, status });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.externalAction(idempotencyKey);
  }

  recordIntegrationManifest(manifestPath, manifest) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR REPLACE INTO integration_manifests(id, schema_version, manifest_path, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(manifest.id, manifest.schemaVersion, manifestPath, JSON.stringify(manifest), now());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  integrationManifest(manifestPath) {
    const row = this.db.prepare("SELECT manifest_json FROM integration_manifests WHERE manifest_path = ?").get(manifestPath);
    return row ? JSON.parse(row.manifest_json) : null;
  }
  integrationManifestForCandidate(candidateSha) {
    const rows = this.db.prepare("SELECT manifest_path, manifest_json FROM integration_manifests ORDER BY created_at DESC").all();
    const row = rows.find((item) => parse(item.manifest_json, null)?.candidateSha?.toLowerCase() === candidateSha?.toLowerCase());
    return row ? { path: row.manifest_path, manifest: parse(row.manifest_json, null) } : null;
  }

  recordBudgetOverride({ taskId, reason, forecast }) {
    this.#mutate(taskId, "budget/override", { reason, forecast }, () => this.db.prepare(`INSERT OR REPLACE INTO budget_overrides(task_id, reason, forecast_json, created_at)
      VALUES (?, ?, ?, ?)`).run(taskId, reason, JSON.stringify(forecast), now()));
  }

  budgetOverride(taskId) {
    const row = this.db.prepare("SELECT reason, forecast_json, created_at FROM budget_overrides WHERE task_id = ?").get(taskId);
    return row ? { reason: row.reason, forecast: JSON.parse(row.forecast_json), createdAt: row.created_at } : null;
  }

  #mapTask(row) {
    return {
      id: row.id, parentTaskId: row.parent_task_id, role: row.role, title: row.title,
      prompt: row.prompt, status: row.status, allowedPaths: parse(row.allowed_paths_json, []), humanApprovalRequired: Boolean(row.human_approval_required), humanApproved: Boolean(row.human_approved),
      acceptanceChecks: parse(row.acceptance_checks_json, []), dependencies: parse(row.dependencies_json, []), worktree: row.worktree,
      branch: row.branch, threadId: row.thread_id, turnId: row.turn_id,
      tokenBudget: row.token_budget, tokenUsed: row.token_used, tokenUsageSource: row.token_usage_source, attempt: row.attempt,
      estimatedTokens: row.estimated_tokens,
      maxAttempts: row.max_attempts, createdAt: row.created_at, updatedAt: row.updated_at,
      error: row.error, resultPath: row.result_path,
      riskFlags: parse(row.risk_flags_json, []), supportingDomains: parse(row.supporting_domains_json, []),
      artifactBaseSha: row.artifact_base_sha, artifactDependencies: parse(row.artifact_dependencies_json, []),
      planBatchId: row.plan_batch_id, wave: row.wave, integrationBarrierId: row.integration_barrier_id, localCheckpointId: row.local_checkpoint_id,
      executionDependencies: row.execution_dependencies_json === null ? null : parse(row.execution_dependencies_json, []), executionTopologyVersion: row.execution_topology_version ?? 0, executionIsWriter: Boolean(row.execution_is_writer), executionReleaseState: row.execution_release_state, executionReleaseArtifactTaskId: row.execution_release_artifact_task_id,
      remediationRound: row.remediation_round, sourceWriterTaskId: row.source_writer_task_id,
      deliveryRunId: row.delivery_run_id, blueprintId: row.blueprint_id, requirementIds: parse(row.requirement_ids_json, []), baselineBehaviorIds: parse(row.baseline_behavior_ids_json, []), interruptThresholdTokens: row.interrupt_threshold_tokens, configuredBudgetCap: row.configured_budget_cap,
      budgetInterrupt: this.budgetInterruption(row.id)
    };
  }

  #mapManagedWorktree(row) {
    return {
      recordId: row.record_id, schemaVersion: row.schema_version, kind: row.kind,
      repositoryCommonDir: row.repository_common_dir, repositoryRoot: row.repository_root,
      canonicalPath: row.canonical_path, intendedPath: row.intended_path, taskId: row.task_id,
      deliveryRunId: row.delivery_run_id, planBatchId: row.plan_batch_id, barrierId: row.barrier_id, candidateId: row.candidate_id,
      branch: row.branch, intendedBaseSha: row.intended_base_sha, lastVerifiedHead: row.last_verified_head,
      creationSessionId: row.creation_session_id, createdAt: row.created_at, attempt: row.attempt,
      protocolVersion: row.protocol_version, ownerVersion: row.owner_version, phase: row.phase,
      classification: row.classification, verification: parse(row.verification_json, {}), linkedAt: row.linked_at,
      finalizedAt: row.finalized_at, updatedAt: row.updated_at
    };
  }

  #mapDeliveryRun(row) {
    return { id: row.id, schemaVersion: row.schema_version, state: row.state, source: row.source, bootstrapTaskId: row.bootstrap_task_id, blueprintId: row.blueprint_id, sourceClaimManifestId: row.source_claim_manifest_id ?? null, sourceClaimExtractionId: row.source_claim_extraction_id ?? null, sourceClaimAuditId: row.source_claim_audit_id ?? null, sourceClaimInputMode: row.source_claim_input_mode ?? "supplied", repositoryMode: row.repository_mode ?? "legacy", projectMode: parse(row.project_mode_json, null), repositoryBaseSha: row.repository_base_sha ?? null, repositoryBaselineId: row.repository_baseline_id ?? null, completionContractVersion: row.completion_contract_version ?? 0, integrationPath: row.integration_path, candidate: row.candidate_branch && row.candidate_sha ? { branch: row.candidate_branch, sha: row.candidate_sha } : null, publicationCheckpoint: parse(row.publication_checkpoint_json, null), publish: parse(row.publish_json, null), confirmRemotePush: Boolean(row.confirm_remote_push), ownerPid: row.owner_pid, ownerSessionId: row.owner_session_id, heartbeatAt: row.heartbeat_at, interruptedAt: row.interrupted_at, recovery: parse(row.recovery_json, null), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  #mapScopedReplan(row) {
    return {
      schemaVersion: row.schema_version, id: row.id, deliveryRunId: row.delivery_run_id, blueprintId: row.blueprint_id,
      priorPlanBatchId: row.prior_plan_batch_id, failedTaskId: row.failed_task_id, failureKind: row.failure_kind,
      failureDetail: row.failure_detail, affectedTaskIds: parse(row.affected_task_ids_json, []), invalidatedTaskIds: parse(row.invalidated_task_ids_json, []),
      preservedArtifacts: parse(row.preserved_artifacts_json, []), priorCheckpointId: row.prior_checkpoint_id, priorCheckpointSha: row.prior_checkpoint_sha,
      remainingRequirementIds: parse(row.remaining_requirement_ids_json, []), priorContext: parse(row.prior_context_json, {}),
      attempt: row.attempt, maxAttempts: row.max_attempts, idempotencyKey: row.idempotency_key, plannerTaskId: row.planner_task_id,
      replacementPlanBatchId: row.replacement_plan_batch_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at
    };
  }

  recordProductAcceptanceReport(report) {
    const run = this.deliveryRun(report.deliveryRunId); if (!run) throw new Error("Final acceptance report requires an existing delivery run");
    const blueprint = this.productBlueprint(report.blueprintId); const manifest = this.integrationManifest(report.integrationManifestPath);
    if (!blueprint || !manifest) throw new Error("Final acceptance report requires persisted blueprint and integration manifest");
    const repositoryBaseline = run.repositoryMode === "brownfield" ? this.repositoryBaselineForRun(run.id) : null;
    const activeBehaviorIds = repositoryBaseline ? [...new Set(this.listTasks().filter((task) => task.deliveryRunId === run.id).flatMap((task) => task.baselineBehaviorIds ?? []))].sort() : null;
    validateProductAcceptanceReport(report, { blueprint: blueprint.blueprint, blueprintDigest: blueprint.digest, manifest, manifestPath: report.integrationManifestPath, repositoryBaseline, activeBehaviorIds });
    if (run.blueprintId !== report.blueprintId || run.candidate?.sha?.toLowerCase() !== report.candidateSha.toLowerCase()) throw new Error("Final acceptance report identity does not match delivery run");
    const id = report.id ?? `${report.deliveryRunId}:${report.integrationManifestId}:${report.candidateSha}`;
    if (this.db.prepare("SELECT id FROM product_acceptance_reports WHERE id = ?").get(id)) return this.productAcceptanceReport(id);
    const passing = productAcceptancePasses(report, { blueprint: blueprint.blueprint, repositoryBaseline, activeBehaviorIds }) ? 1 : 0;
    this.#mutate(run.bootstrapTaskId, "acceptance/persisted", { reportId: id, candidateSha: report.candidateSha, passing: Boolean(passing) }, () => {
      this.db.prepare("INSERT INTO product_acceptance_reports(id,schema_version,delivery_run_id,blueprint_id,blueprint_digest,manifest_id,manifest_path,candidate_sha,report_json,passing,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, report.schemaVersion, report.deliveryRunId, report.blueprintId, report.blueprintDigest, report.integrationManifestId, report.integrationManifestPath, report.candidateSha, JSON.stringify(report), passing, now());
      for (const result of report.results) this.#insertTraceability({ requirementId: result.requirementId, blueprintId: report.blueprintId, verificationPath: id, checkpoint: "final-acceptance", payload: { criterionId: result.criterionId ?? null, status: result.status, candidateSha: report.candidateSha, manifestId: report.integrationManifestId, evidence: result.evidence } });
    });
    return this.productAcceptanceReport(id);
  }

  productAcceptanceReport(id) {
    const row = this.db.prepare("SELECT * FROM product_acceptance_reports WHERE id = ?").get(id);
    return row ? { id: row.id, report: parse(row.report_json, null), passing: Boolean(row.passing), createdAt: row.created_at } : null;
  }

  productAcceptanceForRun(deliveryRunId, { candidateSha = null, manifestId = null } = {}) {
    const rows = this.db.prepare("SELECT id FROM product_acceptance_reports WHERE delivery_run_id = ? ORDER BY created_at DESC").all(deliveryRunId);
    return rows.map((row) => this.productAcceptanceReport(row.id)).find((item) => (!candidateSha || item.report.candidateSha.toLowerCase() === candidateSha.toLowerCase()) && (!manifestId || item.report.integrationManifestId === manifestId)) ?? null;
  }

  recordProductEvidenceExecution(execution) {
    const required = ["id", "deliveryRunId", "integrationManifestId", "candidateSha", "blueprintId", "blueprintDigest", "verificationManifestId", "verificationManifestDigest", "worktree"];
    if (!execution || required.some((key) => typeof execution[key] !== "string" || !execution[key]) || !Array.isArray(execution.commands) || !execution.evidence || typeof execution.success !== "boolean") throw new Error("Product evidence execution record is incomplete");
    const existing = this.db.prepare("SELECT id FROM product_evidence_executions WHERE id = ?").get(execution.id);
    if (existing) return this.productEvidenceExecution(existing.id);
    this.#mutate(null, "product-evidence/executed", { deliveryRunId: execution.deliveryRunId, integrationManifestId: execution.integrationManifestId, candidateSha: execution.candidateSha, verificationManifestId: execution.verificationManifestId, success: execution.success, commandCount: execution.commands.length }, () => {
      this.db.prepare("INSERT INTO product_evidence_executions(id,delivery_run_id,integration_manifest_id,candidate_sha,blueprint_id,blueprint_digest,verification_manifest_id,verification_manifest_digest,worktree,execution_json,success,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(execution.id, execution.deliveryRunId, execution.integrationManifestId, execution.candidateSha, execution.blueprintId, execution.blueprintDigest, execution.verificationManifestId, execution.verificationManifestDigest, execution.worktree, JSON.stringify(execution), execution.success ? 1 : 0, now());
    });
    return this.productEvidenceExecution(execution.id);
  }

  productEvidenceExecution(id) {
    const row = this.db.prepare("SELECT * FROM product_evidence_executions WHERE id = ?").get(id);
    return row ? { id: row.id, record: parse(row.execution_json, null), success: Boolean(row.success), createdAt: row.created_at } : null;
  }

  productEvidenceExecutionForIdentity(identity) {
    if (!identity || ["deliveryRunId", "integrationManifestId", "candidateSha", "blueprintId", "blueprintDigest", "verificationManifestId", "verificationManifestDigest", "worktree"].some((key) => typeof identity[key] !== "string" || !identity[key])) return null;
    const row = this.db.prepare("SELECT id FROM product_evidence_executions WHERE delivery_run_id = ? AND integration_manifest_id = ? AND candidate_sha = ? AND verification_manifest_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(identity.deliveryRunId, identity.integrationManifestId, identity.candidateSha, identity.verificationManifestId);
    const stored = row ? this.productEvidenceExecution(row.id) : null;
    if (!stored?.success) return null;
    const record = stored.record;
    return record?.deliveryRunId === identity.deliveryRunId && record.integrationManifestId === identity.integrationManifestId && record.candidateSha?.toLowerCase() === identity.candidateSha.toLowerCase() && record.blueprintId === identity.blueprintId && record.blueprintDigest === identity.blueprintDigest && record.verificationManifestId === identity.verificationManifestId && record.verificationManifestDigest === identity.verificationManifestDigest && record.worktree === identity.worktree ? stored : null;
  }

  completeDeliveryWithAcceptance({ deliveryRunId, reportId, merge, publish = {} }) {
    const run = this.deliveryRun(deliveryRunId); const stored = this.productAcceptanceReport(reportId);
    if (!run || !stored?.passing) throw new Error("Completion requires a persisted passing ProductAcceptanceReport");
    const report = stored.report; const blueprint = this.productBlueprint(report.blueprintId); const manifest = this.integrationManifest(report.integrationManifestPath);
    if (!blueprint || !manifest || run.blueprintId !== report.blueprintId || run.candidate?.sha?.toLowerCase() !== report.candidateSha.toLowerCase() || manifest.id !== report.integrationManifestId || manifest.candidateSha?.toLowerCase() !== report.candidateSha.toLowerCase()) throw new Error("Completion acceptance identity mismatch");
    this.assertRequirementLedgerCompletion(deliveryRunId);
    if (merge?.status !== "merged" || !merge.mainSha || merge.targetVerified !== true) throw new Error("Completion requires a verified merge result");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE delivery_runs SET state = 'completed_merged', publish_json = ?, completion_contract_version = 2, owner_pid = NULL, owner_session_id = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...publish, merge, acceptanceReportId: reportId, candidate: run.candidate }), now(), deliveryRunId);
      this.#insertEvent(run.bootstrapTaskId, "delivery/completed-merged", { deliveryRunId, reportId, candidateSha: report.candidateSha, mergeSha: merge.mainSha });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(deliveryRunId);
  }

  completeDeliveryWithLocalAcceptance({ deliveryRunId, reportId, publish = {} }) {
    const run = this.deliveryRun(deliveryRunId); const stored = this.productAcceptanceReport(reportId);
    if (!run || !stored?.passing) throw new Error("Local candidate completion requires a persisted passing ProductAcceptanceReport");
    const report = stored.report; const blueprint = this.productBlueprint(report.blueprintId); const manifest = this.integrationManifest(report.integrationManifestPath);
    if (!blueprint || !manifest || run.blueprintId !== report.blueprintId || run.candidate?.sha?.toLowerCase() !== report.candidateSha.toLowerCase() || manifest.id !== report.integrationManifestId || manifest.candidateSha?.toLowerCase() !== report.candidateSha.toLowerCase()) throw new Error("Local candidate completion acceptance identity mismatch");
    this.assertRequirementLedgerCompletion(deliveryRunId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE delivery_runs SET state = 'completed_candidate_ready', publish_json = ?, completion_contract_version = 2, owner_pid = NULL, owner_session_id = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...publish, acceptanceReportId: reportId, candidate: run.candidate, localCandidate: true, remoteEnabled: false }), now(), deliveryRunId);
      this.#insertEvent(run.bootstrapTaskId, "delivery/completed-local-candidate", { deliveryRunId, reportId, candidateSha: report.candidateSha });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(deliveryRunId);
  }

  #addColumnIfMissing(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  #initializeRequirementLedger(deliveryRunId, blueprint, digest) {
    const sourceBlueprintIdentity = `${blueprint.blueprintId}:${digest}`;
    for (const requirement of blueprint.requirements.filter((item) => item.mandatory)) {
      const rows = [{ criterionId: "" }, ...requirement.acceptanceCriteria.map((criterion) => ({ criterionId: criterion.criterionId }))];
      for (const row of rows) this.db.prepare("INSERT INTO requirement_ledger(delivery_run_id,blueprint_id,requirement_id,criterion_id,source_blueprint_identity,coverage_state,evidence_state,updated_at) VALUES (?,?,?,?,?,'pending','pending',?)")
        .run(deliveryRunId, blueprint.blueprintId, requirement.requirementId, row.criterionId, sourceBlueprintIdentity, now());
    }
  }

  #claimRequirementLedgerOwnership(batch, tasks, { replanId = null } = {}) {
    const entries = this.requirementLedger(batch.deliveryRunId);
    if (!entries.length) return;
    const known = new Map(entries.filter((item) => item.criterionId === null).map((item) => [item.requirementId, item]));
    const writers = tasks.filter((task) => task.executionIsWriter);
    const claimed = new Set();
    const legacyGreenfieldComposite = batch.projectMode?.mode === "greenfield" && batch.wave === 1;
    for (const task of writers) for (const requirementId of task.requirementIds ?? []) {
      const entry = known.get(requirementId);
      if (!entry) throw new Error(`PlanBatch references unknown or non-mandatory RequirementLedger requirement '${requirementId}'`);
      if (claimed.has(requirementId)) {
        // Stage-05 greenfield scaffold plans historically attach the single
        // product requirement to bootstrap infrastructure and both root
        // writers. Keep that immutable compatibility shape confined to wave 1;
        // all iterative waves remain one-owner-per-requirement.
        if (legacyGreenfieldComposite) continue;
        throw new Error(`PlanBatch duplicates RequirementLedger ownership for '${requirementId}'`);
      }
      claimed.add(requirementId);
      if (!replanId && entry.coverageState !== "pending") throw new Error(`PlanBatch repeats RequirementLedger coverage for '${requirementId}'`);
      if (replanId && !["planned", "invalidated", "pending"].includes(entry.coverageState)) throw new Error(`Scoped PlanBatch cannot replace already covered RequirementLedger requirement '${requirementId}'`);
      this.db.prepare("UPDATE requirement_ledger SET coverage_state = 'planned', owner_task_id = ?, artifact_task_id = NULL, checkpoint_id = NULL, evidence_state = 'pending', candidate_sha = NULL, evidence_json = '[]', unresolved_reason = NULL, updated_at = ? WHERE delivery_run_id = ? AND requirement_id = ?")
        .run(task.id, now(), batch.deliveryRunId, requirementId);
    }
    if (!claimed.size) throw new Error("PlanBatch creates no RequirementLedger coverage progress");
  }

  #claimable(candidate) {
    const logicalReady = parse(candidate.dependencies_json, []).every((id) => this.getTask(id)?.status === "done");
    if (!logicalReady || (candidate.integration_barrier_id && this.integrationBarrier(candidate.integration_barrier_id)?.status !== "passed")) return false;
    // Non-PlanBatch tasks retain their historical/manual scheduling contract.
    if (!candidate.plan_batch_id) return true;
    if (candidate.execution_topology_version !== 1 || !candidate.execution_dependencies_json) return false;
    const executionReady = parse(candidate.execution_dependencies_json, []).every((id) => this.getTask(id)?.executionReleaseState === "released");
    if (!executionReady) return false;
    if (!candidate.execution_is_writer) return true;
    if (candidate.execution_release_state !== "pending") return false;
    // Logical planner edges remain logically distinct, but a direct writer
    // dependency must still be safely released before another writer starts.
    return parse(candidate.dependencies_json, []).every((id) => {
      const dependency = this.getTask(id);
      return !dependency?.executionIsWriter || dependency.executionReleaseState === "released";
    });
  }

  releaseWriterAfterPassedReviews(writerTaskId, qaTaskId) {
    const writer = this.getTask(writerTaskId); const qa = this.getTask(qaTaskId);
    if (!writer?.executionIsWriter || writer.executionTopologyVersion !== 1 || writer.executionReleaseState !== "pending") return writer;
    const artifact = this.workerArtifactRecord(writerTaskId);
    const qaReport = qa?.role === "qa" && qa.status === "done" && qa.sourceWriterTaskId === writerTaskId ? this.qualityReport(qaTaskId)?.report : null;
    const security = this.listTasks().find((task) => task.role === "security" && task.sourceWriterTaskId === writerTaskId && task.status === "done");
    const securityReport = security ? this.securityReport(security.id)?.report : null;
    if (writer.status !== "done" || !artifact?.artifact || artifact.trusted === false || !qa?.dependencies.includes(security?.id) || qaReport?.verdict !== "pass" || securityReport?.verdict !== "pass") throw new Error(`Writer ${writerTaskId} cannot be released without a finalized artifact and passed Security/QA evidence`);
    this.#mutate(writerTaskId, "execution/released", { writerTaskId, qaTaskId, securityTaskId: security.id, artifactTaskId: writerTaskId }, () => this.db.prepare("UPDATE tasks SET execution_release_state = 'released', execution_release_artifact_task_id = ?, updated_at = ? WHERE id = ? AND execution_release_state = 'pending'").run(writerTaskId, now(), writerTaskId));
    return this.getTask(writerTaskId);
  }

  blockWriterRelease(writerTaskId, reason) {
    const writer = this.getTask(writerTaskId);
    if (!writer?.executionIsWriter || writer.executionTopologyVersion !== 1 || writer.executionReleaseState !== "pending") return writer;
    this.#mutate(writerTaskId, "execution/release-blocked", { writerTaskId, reason: String(reason).slice(0, 500) }, () => this.db.prepare("UPDATE tasks SET execution_release_state = 'blocked', updated_at = ? WHERE id = ? AND execution_release_state = 'pending'").run(now(), writerTaskId));
    return this.getTask(writerTaskId);
  }

  #validateTaskBlueprint(task) {
    if (!task.blueprintId && !(task.requirementIds?.length)) return;
    if (!task.blueprintId || !Array.isArray(task.requirementIds) || (!task.requirementIds.length && !["bootstrap", "planner"].includes(task.role))) throw new Error("Blueprint-linked task requires blueprintId and non-empty requirementIds");
    const stored = this.productBlueprint(task.blueprintId);
    if (!stored) throw new Error(`Task references unknown ProductBlueprint '${task.blueprintId}'`);
    const known = new Set(stored.blueprint.requirements.map((requirement) => requirement.requirementId));
    for (const requirementId of task.requirementIds) if (!known.has(requirementId)) throw new Error(`Task references unknown ProductBlueprint requirement '${requirementId}'`);
  }

  #blockLegacyRunsWithoutBlueprint() {
    this.db.prepare("UPDATE delivery_runs SET completion_contract_version = 0 WHERE state = 'completed_merged' AND completion_contract_version < 2 AND id NOT IN (SELECT delivery_run_id FROM product_acceptance_reports WHERE passing = 1)").run();
    const states = ["running", "awaiting_human", "awaiting_human_remote_handoff", "interrupted", "blocked_credentials", "blocked_ci", "blocked_branch_protection"];
    const rows = this.db.prepare(`SELECT id, bootstrap_task_id FROM delivery_runs WHERE source_claim_manifest_id IS NULL AND state IN (${states.map(() => "?").join(",")})`).all(...states);
    if (!rows.length) return;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const reason = "source_claim_contract:persisted_run_manifest_missing";
        this.db.prepare("UPDATE delivery_runs SET state = 'blocked_specification', publish_json = ?, owner_pid = NULL, owner_session_id = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify({ reason, recovery: { action: "Start a fresh delivery from source documentation; historical artifacts and tasks remain retained." } }), timestamp, row.id);
        this.db.prepare("UPDATE tasks SET status = 'blocked_specification', error = ?, updated_at = ? WHERE delivery_run_id = ? AND status IN ('queued','preparing','running','awaiting_approval','awaiting_human','interrupted')").run(reason, timestamp, row.id);
        this.#insertEvent(row.bootstrap_task_id, "delivery/blocked_specification", { deliveryRunId: row.id, reason });
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  #blockLegacyRunsWithoutProjectMode() {
    const states = ["running", "awaiting_human", "awaiting_human_remote_handoff", "interrupted", "blocked_credentials", "blocked_ci", "blocked_branch_protection"];
    const rows = this.db.prepare(`SELECT id, bootstrap_task_id FROM delivery_runs WHERE project_mode_json IS NULL AND state IN (${states.map(() => "?").join(",")})`).all(...states);
    if (!rows.length) return;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const reason = "project_mode:persisted_record_missing";
        this.db.prepare("UPDATE delivery_runs SET state = 'blocked_specification', publish_json = ?, owner_pid = NULL, owner_session_id = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify({ reason, recovery: { action: "Start a fresh delivery with a versioned ProjectMode; historical records remain readable." } }), timestamp, row.id);
        this.db.prepare("UPDATE tasks SET status = 'blocked_specification', error = ?, updated_at = ? WHERE delivery_run_id = ? AND status IN ('queued','preparing','running','awaiting_approval','awaiting_human','interrupted')").run(reason, timestamp, row.id);
        this.#insertEvent(row.bootstrap_task_id, "delivery/blocked_specification", { deliveryRunId: row.id, reason });
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  #blockLegacyPlanTasksWithoutExecutionTopology() {
    const statuses = ["queued", "preparing", "running", "awaiting_approval", "awaiting_human", "interrupted"];
    const rows = this.db.prepare(`SELECT id FROM tasks WHERE plan_batch_id IS NOT NULL AND COALESCE(execution_topology_version, 0) != 1 AND status IN (${statuses.map(() => "?").join(",")})`).all(...statuses);
    if (!rows.length) return;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const reason = "legacy_execution_topology_incomplete: replan required before overlapping writers can resume";
        this.db.prepare("UPDATE tasks SET status = 'blocked_specification', error = ?, updated_at = ? WHERE id = ?").run(reason, timestamp, row.id);
        this.#insertEvent(row.id, "execution/topology-blocked", { reason });
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  #insertTraceability({ requirementId, blueprintId, taskId = null, artifactPath = null, verificationPath = null, checkpoint = null, payload = {} }) {
    this.db.prepare("INSERT INTO traceability_records(requirement_id, blueprint_id, task_id, artifact_path, verification_path, checkpoint, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(requirementId, blueprintId, taskId, artifactPath, verificationPath, checkpoint, JSON.stringify(payload), now());
  }

  #hasColumn(table, column) {
    try { return this.db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column); }
    catch { return false; }
  }

  #hasTable(table) {
    try { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)); }
    catch { return false; }
  }

  #measuredUsageSql() {
    return this.hasTokenUsageSource ? "CASE WHEN token_usage_source = 'turn_last' THEN token_used ELSE 0 END" : "0";
  }

  #insertEvent(taskId, type, payload) {
    this.db.prepare("INSERT INTO events(task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(taskId, type, JSON.stringify(payload ?? {}), now());
  }

  #mutate(taskId, type, payload, operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try { operation(); this.#insertEvent(taskId, type, payload); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
