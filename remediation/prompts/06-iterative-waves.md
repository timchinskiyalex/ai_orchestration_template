# Stage 06 — make execution waves and reconciliation the normal delivery path

Work only in `D:\Projects\Рой Агентів\ai_orchestration_template` on `main`.

This stage is implementation-only. Do not commit, push, create PRs, run live quota-spending E2E, remove runtime/generated data, or modify `docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md`. The outer pipeline owns verification, commit, and push.

Confirmed gap: PlanBatch/wave/checkpoint/replan primitives exist, but the ordinary happy path still expects one large complete DAG. Partial requirement coverage is normally forbidden, and successful global checkpoints do not automatically lead to planner reconciliation and the next wave.

Implement controller-owned iterative delivery.

Requirements:

1. Introduce a durable RequirementLedger that records mandatory requirement/criterion coverage state, source blueprint identity, owning task/artifact/checkpoint, verification state, and unresolved reasons.
2. A normal Planner invocation may produce a bounded partial PlanBatch for one wave. The controller validates every included task’s requirement IDs and rejects duplicates, unknown IDs, invalid checkpoint ancestry, and empty-progress batches.
3. After a verified GlobalWaveCheckpoint, controller reconciliation computes remaining/unverified/invalidated requirements and enqueues the next Planner wave from that checkpoint SHA. It must not call a fresh full Bootstrap or discard successful artifacts.
4. Completion is allowed only when every mandatory requirement and criterion has candidate-bound passing verification/evidence, all planned dependencies have closed, final specification audit passes, and no unresolved specification/integrity blocker remains.
5. Scoped failure/replan retains unaffected successful artifacts; it re-enters only the affected subtree/wave with correct checkpoint ancestry.
6. Bound the run with configured max waves, max no-progress reconciliations, and bounded diagnostic state. Exhaustion becomes a precise resumable blocked state, not an infinite loop.
7. Keep current single-wave products working as wave 1 + final reconciliation.

Add deterministic full-flow tests using a fake provider: wave 1 partial requirements -> parallel writers -> barrier/checkpoint -> reconciliation -> wave 2 -> acceptance; no-progress loop blocks; failure in wave 2 preserves wave 1; restart between checkpoint and reconciliation; duplicate/unknown requirement rejection; and final completion refusal for missing criterion evidence.

Do not redesign source extraction or stack adapters here. In the final answer state changed files and exact tests.
