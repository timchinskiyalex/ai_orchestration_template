# Codex App Server Runtime — Phase 2 writer migration

## Migrated and legacy roles

The explicit Phase 2 `writerRuntimePath` choice applies only to the closed writer-role set: `frontend`, `backend`, `database`, and `devops`, and only when that role is configured `workspace-write`.

The loaded production configuration defaults that writer-only route to `codex-app-server`. `writerRuntimePath: "legacy"` remains a temporary parity switch for those same writer roles. It is not a provider registry, plugin mechanism, or a general multi-runtime abstraction.

`bootstrap`, `planner`, `security`, `qa`, and every other non-writer remain on the legacy execution path intentionally. Source extraction/audit are unchanged. Security and QA remain controller-owned gates for every writer artifact, including migrated artifacts.

## Controller/runtime ownership

Before a migrated writer starts, `SwarmRouter` still owns readiness: dependency and checkpoint lineage, write-conflict topology, `maxConcurrentTasks` capacity, source/blueprint admission, and baseline validation. The controller creates the managed worktree from the exact authorized base SHA and passes that exact path as the runtime `cwd`.

One `CodexAppServerRuntime` instance is created for exactly one assigned writer worktree/task. It performs only App Server connection, thread creation, goal/turn start, bounded terminal observation and durable read reconciliation, final-result read, cancellation, and shutdown. Runtime observations are thin operational facts; they do not carry task authority or persistent lifecycle state in the Router.

After a durable completed observation, the Router treats result text as non-authoritative evidence. It invokes the existing `WorktreeFinalizer`, inspects the actual Git diff, validates allowed paths and verification, makes the controller-owned commit, persists `WorkerArtifact`, marks the managed worktree finalized, connects dependent lineage, and only then transitions the task to its terminal state. Empty or forbidden diffs, timeout, cancellation, disconnect, or missing durable terminal proof create a typed controller task failure and never an accepted artifact. Existing durable persistence ordering preserves the restart boundary: a file-only artifact cannot become accepted or be duplicated after retry/restart.

The scheduler retains the capacity reservation until this controller finalization and persistence completes. It therefore cannot use runtime completion prose to admit a replacement worker early.

## Phase 3 removal criteria

The legacy writer route and `writerRuntimePath` switch may be removed only when all four migrated roles have sustained parity evidence for exact worktree/base-SHA admission, bounded reconciliation, cancellation/disconnect behavior, Git-derived artifacts, restart idempotency, and controller-owned Security/QA/integration gates. The focused migration suite, current runtime characterization suite, full test suite, App Server schema preflight, and diff hygiene must remain green. Legacy non-writer execution plumbing remains until a separately scoped migration proves the same authority boundary for those roles.

## Known limitations

- The legacy implementation and `executionProviderFactory` remain compatibility seams for legacy roles/tests; they are not extended by this phase.
- A migrated writer still uses the existing finalizer and repair policy, so a finalizer rejection may request a bounded corrective turn in the same assigned runtime/worktree.
- Runtime usage observations are operational only. Scheduler admission and terminal persistence remain controller-owned.
- This phase does not alter source extraction, ProductBlueprint, RequirementLedger, PlanningScope, checkpoints, acceptance evidence, or stack adapters.
