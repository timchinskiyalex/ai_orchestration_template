# Stage 08 — prove the remediation set end-to-end without live quota

Work only in `D:\Projects\Рой Агентів\ai_orchestration_template` on `main`.

This stage is implementation-only. Do not commit, push, create PRs, run live quota-spending E2E, delete runtime/generated/input files, or modify `docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md`. The outer pipeline owns verification, commit, and push.

Perform a final implementation audit and add deterministic acceptance coverage for stages 01–07. Do not merely write a report: fix any local inconsistency you find within those stated contracts, then prove it.

Required end-to-end fake-provider scenario:

`raw Markdown only -> normalized source inventory -> extraction -> independent source audit/admission -> ProductBlueprint/ArchitectureBlueprint -> partial wave 1 -> parallel writers with topology overlap and logical+execution fan-in -> verified local/global checkpoints -> reconciliation wave 2 -> candidate integration -> controller-owned criterion evidence executor on exact candidate SHA -> Security/QA/CI guards -> publication/merge eligibility`.

Also prove:

1. A contradictory mandatory source fact blocks before Planner.
2. Brownfield avoids greenfield scaffold and preserves RepositoryBaseline evidence.
3. No product evidence executor/failed criterion/wrong SHA blocks publication.
4. Effective-predecessor deadlock is structured and cannot silently claim completion.
5. Restart at extraction, audit, checkpoint, reconciliation, and evidence boundaries preserves valid progress and fails closed on identity mismatch.
6. Unsupported stack is rejected before a worker starts.

The test must use local fake execution/process/remote adapters only: no Codex App Server, quota, GitHub, CI service, or remote mutation. Ensure the test demonstrates actual controller wiring rather than directly constructing a desired final record.

Update `docs/remediation/FINAL_ACCEPTANCE.md` with the exact scope that is now proven and explicit exclusions. If the code still cannot meet an item, fail the stage with a precise explanation instead of weakening the test or claiming success.

In the final answer list every changed file and exact results.
