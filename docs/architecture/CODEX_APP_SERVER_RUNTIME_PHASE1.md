# Codex App Server Runtime — Phase 1 boundary

## Current and temporary dual path

The production path remains `legacy`: `SwarmRouter` directly drives the existing `AppServerExecutionProvider` envelope API. It remains the proven path during Phase 1.

`CodexAppServerRuntime` is a new, concrete, target-native wrapper around the existing App Server protocol transport. It is available only through a closed transitional choice: `legacy` or `codex-app-server`. The default is `legacy`; this is an explicit test/migration seam, not a configuration registry, plugin system, or production rollout setting. The switch will be deleted once the router writers have migrated with parity.

## Exact ownership boundary

`CodexAppServerRuntime` may connect/start the App Server; start a thread and its goal/turn; emit the six normalized observations (`worker_started`, `worker_activity`, `worker_terminal_candidate`, `worker_completed`, `worker_failed`, `worker_cancelled`); perform bounded read-only terminal reconciliation; read a final result; cancel; and report shutdown/reconnect diagnostics.

It cannot import or use `StateStore`, `WorktreeManager`, `WorktreeFinalizer`, `Integrator`, or remote adapters. It contains no worker-owned persistence and cannot create a `WorkerArtifact`, validate a Git diff, or mark a task done.

`SwarmRouter` retains readiness/DAG/capacity; ProductBlueprint, RequirementLedger, and PlanningScope; worktree/base-SHA ownership; Git validation and controller commit; artifacts; Security/QA; checkpoints/integration; verification/evidence; CI/merge; and every authoritative `StateStore` transition. In particular, a runtime `worker_completed` observation is only a turn fact. The Router must still reconcile it into finalization and persistence before task completion.

## Legacy removal criteria

Remove the legacy path and the temporary switch only after the Router is migrated to consume the runtime observations, the focused fake-client parity suite proves controller-assigned `cwd`, thread/goal/turn start, terminal reconciliation (including requested/resolved aliases), final-result reads, cancellation/timeouts, and disconnect diagnostics, and existing characterization plus the full test/schema suites pass. Phase 2 performs that Router writer migration; it must preserve all controller ownership listed above.
