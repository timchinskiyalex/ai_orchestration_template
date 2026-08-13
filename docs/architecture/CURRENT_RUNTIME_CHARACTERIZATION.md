# Current worker runtime characterization

Phase 0 snapshot for `refactor/codex-app-server-simplification`. This is a factual map of the current controller/runtime boundary; it does not propose a replacement runtime.

## KEEP — controller invariants

- Only `SwarmRouter` claims tasks, owns task-state transitions, owns capacity, and persists the authoritative task/run state (`src/router.mjs`: `runUntilIdle`, `#worker`, `#runTask`; `src/state-store.mjs`).
- A workspace writer is created from the exact controller-authorized base SHA. `WorktreeManager.createManaged` resolves a named ref to a commit before `git worktree add`; its durable record keeps `intendedBaseSha` and `verifyRecord` checks ancestry and exact-base state (`src/worktree-manager.mjs`).
- The controller selects the worker `cwd`: `#runTask` passes the created/inherited worktree into provider `start_thread`; the worker must not select its own repository directory (`src/router.mjs`: `#runTask`).
- A provider terminal observation is not task authority. The router reconciles it by a bounded controller-requested `reconcile_terminal` read before result handling; writer completion remains pending until finalization and persistence (`src/router.mjs`: `#reconcileDurableTerminal`, `#runTask`).
- The finalizer derives the artifact from Git status/staged diff, validates allowed paths and controller verification, creates the commit with runtime identity, and only then writes `WorkerArtifact` (`src/worktree-finalizer.mjs`: `finalize`). Worker prose is not artifact truth.
- A writer artifact is persistently usable only with a `done` task. Crash recovery preserves incomplete/file-only states and does not promote them (`src/state-store.mjs`: `recordWorkerArtifact`; `test/p2-managed-worktree-crash-restart.test.mjs`).
- Security and QA reports are controller-validated/persisted gates. A workspace writer cannot integrate until both reports pass (`src/router.mjs`: `#handleSecurityGate`, `#handleQualityGate`, `#writerReviewPassed`, `integrateFinalized`; `src/security-gate.mjs`; `src/quality-gate.mjs`).
- Integration verifies artifact ancestry, tree, checksum and changed paths, preserves effective order, and emits checkpoints/manifests before CI/merge (`src/integrator.mjs`; `src/router.mjs`: `#runReadyIntegrationBarriers`, `#persistGlobalWaveCheckpoint`, `publishCandidate`).

## CORRECTNESS CRITICAL source of truth

| Fact | Controller authority / verification |
| --- | --- |
| Requirements and source evidence | persisted ProductBlueprint, source-claim manifest/audit, and requirement ledger (`src/router.mjs`, `src/state-store.mjs`) |
| Worker base | exact `intendedBaseSha` durable worktree record and Git ancestry (`src/worktree-manager.mjs`) |
| Changed files and patch | actual Git `diff --name-status`, porcelain status, staged diff and checksum (`src/worktree-finalizer.mjs`) |
| WorkerArtifact | controller finalizer commit + JSON artifact + StateStore record (`src/worktree-finalizer.mjs`, `src/state-store.mjs`) |
| Criterion evidence | controller declared verification plus persisted QA/Security gate reports (`src/router.mjs`: `#runDeclaredVerification`, `#saveQualityReport`, `#saveSecurityReport`) |
| Fan-in/checkpoints | integration barriers, effective lineage, local/global checkpoints, wave reconciliation (`src/router.mjs`, `src/state-store.mjs`, `src/integrator.mjs`) |
| CI/merge | persisted candidate/integration manifest, idempotent remote actions, exact candidate SHA, passing acceptance report (`src/router.mjs`: `publishCandidate`) |

## Current worker path

1. `SwarmRouter.runUntilIdle` first runs durable worktree/run reconciliation, validates repository and controller overlay, connects the execution provider, and performs its capability handshake (`src/router.mjs`: `recoverStaleDeliveries`, `runUntilIdle`).
2. `StateStore.claimNext` supplies only a dependency-ready task. `#runTask` rechecks budget, source/blueprint and baseline admission (`src/router.mjs`: `#worker`, `#runTask`; `src/state-store.mjs`: `claimNext`).
3. For a writer, `WorktreeManager.create` → `createManaged` persists intent before `git worktree add -b ... <exact-base-sha>` and links the verified worktree to the task (`src/worktree-manager.mjs`). Review tasks reuse their writer worktree; inherited tasks use their declared predecessor (`src/router.mjs`: `#runTask`, `#inheritedWorktree`).
4. The router transitions task to `running`, calls provider `start_thread` with controller-assigned `cwd`, calls `set_goal`, starts a turn, and persists thread/turn IDs (`src/router.mjs`: `#runTask`; `src/app-server-execution-provider.mjs`: `startThread`, `setGoal`, `startTurn`).
5. `AppServerExecutionProvider.observeTerminal` waits for the App Server turn. The router then calls `#reconcileDurableTerminal`, which uses provider `reconcileTerminal` and an independent/bounded `thread/read` authority before terminal result processing (`src/router.mjs`; `src/app-server-execution-provider.mjs`; `src/app-server-client.mjs`).
6. Bootstrap/planner output is schema-validated and persisted. Security/QA output is schema-validated; QA additionally runs controller-declared verification. Writers pass to `#finalizeWriterWithRepair` and `WorktreeFinalizer.finalize` (`src/router.mjs`).
7. The finalizer rejects empty, unauthorized, generated, unverified, pre-committed, or non-descendant changes. It computes `WorkerArtifact.changedPaths`, `diffChecksum`, `treeSha`, and `headSha` from Git; router persists artifact, links dependents, then transitions the task (`src/worktree-finalizer.mjs`; `src/router.mjs`: `#finalizeManagedWorker`, `#connectArtifactDependents`).
8. `integrateFinalized` requires a `done` artifact and a passed Security/QA chain. `Integrator` validates artifact integrity and effective lineage, runs integration, and router records barrier/global checkpoints. Publication is separately idempotent and requires matching candidate SHA, CI, acceptance evidence, and merge verification (`src/router.mjs`, `src/integrator.mjs`, `src/state-store.mjs`).

## SIMPLIFY LATER — execution plumbing only

- The provider envelope/capability facade and operation-by-operation forwarding: `src/execution-provider-contract.mjs` and `src/app-server-execution-provider.mjs`.
- App Server child-process protocol transport, notification normalization, turn-ID alias tracking, polling, independent read probes, and launch invocation: `src/app-server-client.mjs`, `src/app-server-invocation.mjs`, `src/codex-cli-invocation.mjs`.
- Router provider lifecycle bookkeeping: active turn maps, lifecycle trace translation, account forwarding, and terminal reconciliation orchestration in `src/router.mjs`.

These are candidates for later consolidation only if the controller authorities above remain externally observable and the characterization tests remain green.

## Quota-free characterization coverage

- `test/current-worker-runtime-characterization.test.mjs` proves: exact authorized base and assigned `cwd`; provider completion waits for controller Git finalization; Git-derived rather than worker-reported paths; forbidden/empty diff rejection; typed provider timeout with no artifact; file-only crash recovery with no duplicate acceptance; and Security/QA gating before integration.
- Existing focused tests retain the remaining contracts: durable terminal and provider hardening (`test/router-execution-provider-hardening.test.mjs`); restart boundaries (`test/p2-managed-worktree-crash-restart.test.mjs`); finalizer/integrator artifact integrity (`test/finalizer-integrator.test.mjs`); and fan-in/checkpoint effective ordering (`test/checkpoint-effective-order.test.mjs`).

## Known live-E2E failure modes (observed contracts, no proposed fix)

- Live Codex execution is explicitly opt-in (`RUN_REAL_CODEX_E2E=1`) because it spends account quota (`test/real-app-server-e2e.test.mjs`).
- A bounded worker timeout is collected with task/runtime diagnostics and stops the App Server; an unsuccessful disposable root is preserved for inspection (`test/real-app-server-e2e.test.mjs`; `src/e2e-smoke.mjs`).
- App Server process exit, transport closure, missing terminal state, stale/aliased turns, and lifecycle correlation mismatches have dedicated reconciliation/failure paths (`src/app-server-client.mjs`, `src/app-server-execution-provider.mjs`, `test/router-execution-provider-hardening.test.mjs`).
- Failed live runs preserve the disposable repository and report a recovery action instead of assuming cleanup (`test/real-app-server-e2e.test.mjs`).
