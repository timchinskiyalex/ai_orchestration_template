# Stage 01 — close the fan-in topology deadlock

Work only in `D:\Projects\Рой Агентів\ai_orchestration_template` on `main`.

This stage is implementation-only. Do not commit, push, create a PR, run a live Codex/App Server E2E, spend quota, remove generated/runtime files, or modify `docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md`. The outer pipeline will run verification, commit, and push.

Confirmed defect: the materializer computes writer predecessors as the union of logical workspace-writing `dependencies` and topology-derived `executionDependencies`, but `SwarmRouter.#runReadyIntegrationBarriers()` builds fan-in parents from `task.dependencies` only. For a task with one logical writer dependency plus one overlapping execution predecessor, `integrationBarrierId` is assigned but no barrier can run; the task remains queued indefinitely.

Implement one controller-owned canonical `effectiveWriterPredecessorIds(task)` derivation. It must be the only source used for: writer-artifact lineage validation, dependent wiring, barrier eligibility, parent-artifact lookup, checkpoint construction, and the diagnostic path. It must be deterministic, de-duplicated, and include only workspace-writing predecessors.

Required behaviour:

1. `A` and `C` are independent logical writers but overlap in write surface, so topology serializes one after the other.
2. `B` logically depends on `C` and has the other writer as an execution predecessor.
3. The controller creates exactly one local IntegrationBarrier over the effective parents before `B` begins.
4. `B` starts only from that verified checkpoint SHA; no raw multi-parent worker artifact is allowed.
5. Nested fan-in, checkpoint-as-input, restart, and adversarial caller artifact order retain the existing effective topological integration order.
6. If no task can be claimed and queued engineering work has an unsatisfied/missing/cyclic or otherwise unreachable effective writer predecessor, return a persisted bounded `dependency_deadlock` / integrity-blocked outcome with task ids and safe reason codes. Do not report ordinary idle or silently loop.
7. Legacy persisted records cannot bypass the new effective-predecessor integrity checks.

Add deterministic local Git-fixture regressions for the mixed logical+execution predecessor case, barrier creation, downstream candidate readiness, restart at the barrier boundary, and the structured deadlock result. Preserve existing simple fan-in tests.

Inspect the current implementation and make the smallest coherent changes. Run focused tests while implementing. In the final response state changed files, exact test results, and any intentionally retained limitation.
