# Codex App Server Runtime — G1 writer production parity

## Writer and non-writer roles

`frontend`, `backend`, `database`, and `devops` use `CodexAppServerRuntime`
whenever their configured sandbox is `workspace-write`. There is no
configurable legacy writer route or `writerRuntimePath` fallback.

`bootstrap`, `planner`, `security`, `qa`, and every other non-writer retain
their existing execution path intentionally. Source extraction/audit are
unchanged. Security and QA remain controller-owned gates for every writer
artifact.

## Controller/runtime ownership

Before a writer starts, `SwarmRouter` owns readiness: dependency and checkpoint
lineage, write-conflict topology, `maxConcurrentTasks` capacity,
source/blueprint admission, and baseline validation. The controller creates the
managed worktree from the exact authorized base SHA and passes that exact path
as the runtime `cwd`.

One `CodexAppServerRuntime` instance is created for exactly one assigned writer
worktree/task. It performs only App Server connection, thread creation,
goal/turn start, bounded terminal observation and durable read reconciliation,
final-result read, cancellation, and shutdown. Runtime observations are thin
operational facts; they do not carry task authority or persistent lifecycle
state in the Router.

After a durable completed observation, the Router treats result text as
non-authoritative evidence. It invokes the existing `WorktreeFinalizer`,
inspects the actual Git diff, validates allowed paths and verification, makes
the controller-owned commit, persists `WorkerArtifact`, marks the managed
worktree finalized, connects dependent lineage, and only then transitions the
task to its terminal state. Empty or forbidden diffs, timeout, cancellation,
disconnect, or missing durable terminal proof create a typed controller task
failure and never an accepted artifact. Existing durable persistence ordering
preserves the restart boundary: a file-only artifact cannot become accepted or
be duplicated after retry/restart.

The scheduler retains the capacity reservation until this controller
finalization and persistence completes. It therefore cannot use runtime
completion prose to admit a replacement worker early.

## G1 parity evidence

The deterministic G1 suite covers two independent writers at capacity two,
exact isolated cwd/base SHA, alias-safe receipts, Security→QA release, fan-in
integration, and restart without duplicate writer turns or artifacts. It
supplements the focused runtime parity, timeout/cancellation/disconnect,
finalizer, and schema checks.

The bounded disposable live acceptance command is intentionally
confirmation-gated and must not be run as part of ordinary tests:

```powershell
npm run e2e:g1-writer-parity -- --confirm-spend-quota
```

It fixes capacity at two and executes the disposable deterministic-scaffold
fixture through two writers, Security, QA, fan-in integration, and a local
candidate artifact. Set `CODEX_E2E_TIMEOUT_MS` only when an explicitly bounded
different timeout is required.

## Known limitations

- `executionProviderFactory` remains a compatibility seam for non-writer roles
  and deterministic protocol fakes; it is not a writer-runtime selection
  mechanism.
- A writer still uses the existing finalizer and repair policy, so a finalizer
  rejection may request a bounded corrective turn in the same assigned
  runtime/worktree.
- Runtime usage observations are operational only. Scheduler admission and
  terminal persistence remain controller-owned.
- This phase does not alter source extraction, ProductBlueprint,
  RequirementLedger, PlanningScope, checkpoints, acceptance evidence, or stack
  adapters.
