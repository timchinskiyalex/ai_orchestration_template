# Stage 05 — separate greenfield and brownfield delivery contracts

Work only in `D:\Projects\Рой Агентів\ai_orchestration_template` on `main`.

This stage is implementation-only. Do not commit, push, create PRs, run live quota-spending E2E, reset/clean repositories, or modify `docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md`. The outer pipeline owns verification, commit, and push.

Confirmed defect: the repository has a Brownfield RepositoryBaseline feature but Bootstrap/Planner/workflow validation still unconditionally impose a greenfield Next/.NET scaffold task whenever `productRoots` exist. This can contaminate an existing product and conflicts with the new baseline contract.

Implement one versioned ProjectMode contract with explicit `greenfield` and `brownfield` behavior.

Requirements:

1. Greenfield preserves current scaffold ordering: the configured stack scaffold is required before product writers and is verified by its declared contract.
2. Brownfield never injects or requires a generic scaffold task solely because `productRoots` exist. Its first plan must instead consume a valid RepositoryBaseline, behavior IDs, architecture/profile facts, and change-impact evidence.
3. Planner prompts, Bootstrap output schema, workflow validation, materialization, replan, remediation, QA/Security, finalization, and status all use the same ProjectMode source of truth.
4. Resolve the current Bootstrap inconsistency: structured output examples and role policy must declare `sourceClaimIds`/source references, requirement IDs, acceptance criteria, ambiguities/contradictions, and project-mode facts exactly as the validators require. Do not rely only on prose instructions.
5. Rename or version the old ambiguous BootstrapClaims/ProductBlueprint terminology only where needed to make contracts unambiguous; preserve additive migration/read compatibility.
6. Brownfield missing/stale/invalid baseline fails closed as `blocked_specification` or `integrity_blocked` before workers, never by silently falling back to greenfield.
7. The existing `next-node` and `dotnet` support remains explicit; do not pretend unsupported stacks are ready.

Add deterministic tests proving greenfield scaffold behavior remains, brownfield with productRoots does not enqueue scaffold, brownfield writers carry baseline behavior evidence through Security/QA/remediation, stale baseline blocks before turns, and legacy runs cannot bypass ProjectMode integrity.

In the final response state changed files, test results, and remaining stack scope.
