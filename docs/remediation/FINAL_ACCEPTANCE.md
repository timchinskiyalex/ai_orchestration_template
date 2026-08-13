# Stage 08 final acceptance

Stage 08 is proven with deterministic local tests.  The proof uses the real
`DeliveryCoordinator`, `SwarmRouter`, SQLite `StateStore`, worktree finalizer,
integrator, checkpoint/reconciliation path, and controller publication gates.
It does not create a desired final record directly in the state store.

## End-to-end acceptance path

`test/stage08-final-acceptance-e2e.test.mjs` exercises this controller-owned
path from a raw Markdown directory:

1. documentation intake creates normalized inventory;
2. a local fake extraction adapter returns atomic source claims;
3. a separate local fake audit adapter independently admits every meaningful
   source unit;
4. Bootstrap persists a source-bound `ProductBlueprint` and the controller
   selects the architecture/overlay contract;
5. wave 1 is intentionally partial, runs parallel writers, and creates a
   local fan-in checkpoint from one logical and one topology-derived execution
   predecessor;
6. security and QA gates pass for every writer; wave 1 becomes a verified
   global checkpoint and reconciliation schedules wave 2;
7. wave 2 integrates the exact checkpoint base and produces the candidate;
8. the controller-owned `ProductEvidenceExecutor` runs allowlisted local fake
   verification commands in the clean exact candidate worktree, persists
   criterion evidence bound to that candidate SHA, and final acceptance covers
   every mandatory requirement and criterion;
9. fake local remote-git, PR, CI, and merge adapters are admitted only after
   that evidence.  Their calls are asserted exactly once.

The test also proves that earlier-wave writer evidence is accepted only through
the immutable global-checkpoint SHA ancestry of the final candidate.  It does
not treat an earlier artifact as direct final-candidate evidence.

## Invariants covered by the acceptance suite

The following focused tests supplement the controller E2E proof:

- `test/source-claim-audit.test.mjs`: raw extraction/audit lineage; omitted,
  contradictory, and split-required mandatory source facts block before
  Bootstrap/Planner; restart source identity mismatch fails closed.
- `test/repository-baseline.test.mjs` and
  `test/repository-baseline-lifecycle.test.mjs`: brownfield baseline evidence
  is captured and preserved, generic greenfield scaffolding is forbidden, and
  stale baseline/source identity blocks restart before any worker/remote call.
- `test/delivery-coordinator.test.mjs` and `test/final-acceptance.test.mjs`:
  missing executor/verification manifest, failed criterion, malformed
  criterion, incomplete coverage, or wrong candidate SHA blocks publication;
  final report identity is exact and candidate-bound.
- `test/planner-artifact-lineage.test.mjs` and
  `test/checkpoint-effective-order.test.mjs`: topology/execution fan-in,
  checkpoint lineage, deterministic integration order, restart at checkpoint,
  and structured integrity-blocked effective-predecessor deadlock.
- `test/stack-adapter.test.mjs`: unsupported or ambiguous stacks are rejected
  before worker admission; Next and .NET adapter contracts remain covered.
- `test/scoped-replan-recovery.test.mjs` and related lifecycle tests: scoped
  recovery retains its bounded context rather than rebuilding the delivery.

## Local fake adapters

- `LocalFakeDeliveryAdapter` in the Stage 08 E2E test provides local fake
  extraction, audit, Bootstrap, Planner, writer, Security, and QA responses
  through the normal execution-provider contract.
- A local fake process runner returns bounded verification results for writer,
  QA, integration, and the controller-owned product-evidence command.
- Local fake remote-git, pull-request, CI, and merge adapters are injected
  only as deterministic publication seams; no network client is invoked.

## Not run / explicit exclusions

The following were intentionally not run:

- live Codex or App Server E2E;
- quota-consuming turns or quota spend;
- real GitHub operations, CI, PR creation, push, or merge;
- production deployment;
- `START_REMEDIATION_PIPELINE.cmd`.

All Stage 08 tests use disposable local Git repositories and fake adapters.
