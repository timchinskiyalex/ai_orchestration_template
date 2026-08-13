# Production delivery roadmap

## Decision

The next objective is not another narrow demo.  Finish the minimum production
control-plane required to run `First_project` from documentation to a verified
Git integration candidate, then use that run to drive the remaining hardening.

The controller remains the authority for specification truth, planning,
readiness, worktrees, Git artifacts, Security/QA, integration, evidence and
publication.  Codex App Server owns worker turns, tools and its process
lifecycle.

## Current baseline

- Repository: `D:\Projects\Рой Агентів\ai_orchestration_template`
- Branch: `refactor/codex-app-server-simplification`
- Target project: `D:\Projects\Рой Агентів\First_project`
- Last pushed refactor commit: `b67165d`
- Local commits awaiting push:
  - `e7f09d0` — terminal receipts
  - `2d10f80` — alias-safe terminal receipts
  - `2855b63` — shutdown before best-effort probe cleanup

The real isolated probe has already reached all execution-critical stages:

`Codex writer turn -> terminal receipt -> allowed Git diff -> controller finalizer -> WorkerArtifact`.

Its only observed failure happened after artifact creation during Windows
worktree cleanup; `2855b63` makes that cleanup best-effort and preserves a
successful proof/report if it cannot remove a disposable directory.

## Completed foundations

1. Product/source claim integrity, requirement traceability, exact candidate
   evidence, artifact lineage, fan-in checkpoints and scoped recovery.
2. Managed-worktree ownership and preserve-by-default crash reconciliation.
3. Thin `CodexAppServerRuntime` and writer migration for frontend, backend,
   database and devops roles.
4. Versioned `AppServerTerminalReceipt`, including alias-before-terminal race
   handling and fail-closed behavior for uncorrelated events.
5. A quota-free runtime probe harness and one real single-writer proof up to
   controller-owned Git artifact creation.

## Production gates before the First_project run

All gates below are required.  Do not add unrelated template generalization
until the corresponding gate is closed.

### G0 — Publish and freeze the tested runtime baseline

- Push the three local refactor commits.
- Keep `docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md` and `temp/**` untracked.
- Do not merge this branch to `main` until G4 passes.

### G1 — Writer runtime production parity

- Make `codex-app-server` the only supported writer runtime for frontend,
  backend, database and devops work; remove the legacy writer fallback only
  after parity is proved.
- Retain controller authority for capacity, exact worktree/base SHA, receipt
  persistence, Git finalization and gates.
- Simplify writer scheduling to readiness dispatch.  Router must not recreate
  a second App Server turn lifecycle state machine.
- Prove with a bounded live disposable run: two independent writers in
  parallel, then Security/QA, fan-in/integration and a candidate artifact.
- Preserve typed timeout, cancellation, restart and no-duplicate-artifact
  behavior.

### G2 — Documentation-only admission and complete planning

- A user supplies project documentation only.  The controller/Bootstrap must
  create or update source-claim evidence automatically; no hand-authored
  `source-claims.json` is a normal-user prerequisite.
- Validate all mandatory requirements, contradictions, acceptance criteria and
  source references before Planner admission.
- Planner must emit a requirement-linked DAG with explicit allowed paths,
  ownership/topology, verification commands and wave/checkpoint boundaries.
- Ambiguous but policy-resolvable facts can use an Architecture Decision;
  genuine contradictions must reach `blocked_specification`, never invention.

### G3 — Full local delivery acceptance

- One command starts delivery and a durable monitor; monitor shows run/task
  state, active turns, heartbeat, token actual/reserved/forecast and App
  Server quota.
- A fresh disposable project fixture proves documentation -> Blueprint -> Plan
  -> parallel writers -> artifacts -> Security -> QA -> checkpoints -> final
  specification/criterion acceptance.
- Restart after interruption resumes safely without duplicate workers,
  artifacts or publication.
- A completed local candidate means every mandatory requirement and criterion
  has exact candidate-SHA evidence, all required tests pass and no blocker is
  unresolved.

### G4 — Real GitHub publication acceptance

- In a disposable GitHub repository or dedicated pilot branch: candidate
  branch push, PR creation, required CI observation, merge only after all
  gates, and idempotent resume.
- Verify credentials, branch protection and failure codes in advance.
- No force-push, protected-branch bypass or production deploy.

### G5 — First_project production run

- Materialize `First_project` from the exact G4 template revision on a new
  feature branch.
- Import its real documentation without manual source-claim preparation.
- Run the single delivery command with monitor, observe plan/waves and allow
  the autonomous run to complete its candidate/PR/CI/merge lifecycle.
- Treat any failure as a scoped bug report against the relevant gate; preserve
  artifacts and do not restart the entire product unnecessarily.

## Explicitly deferred until after G5

- Python, Go and further stack adapters.
- More than two live parallel writers and throughput/load tuning.
- Migration of non-writer legacy plumbing where it does not affect writers.
- Alternative execution providers or provider registry.
- Dashboard polish, broad analytics and forecast-model refinement.
- Deployment environments and production operations.

## Resume discipline

- Use `docs/architecture/PRODUCTION_DELIVERY_RESUME_PROMPTS.md` for the next
  bounded task; do not invent a broad combined refactor.
- Each implementation task: explicit files, deterministic tests, one local
  atomic commit, no generated/user-owned files, no push unless separately
  requested.
- Each quota-spending live test is run only after its deterministic gate is
  green and has a stated acceptance condition.
