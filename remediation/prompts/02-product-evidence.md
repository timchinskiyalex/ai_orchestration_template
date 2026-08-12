# Stage 02 — add a real production product-evidence executor

Work only in `D:\Projects\Рой Агентів\ai_orchestration_template` on `main`.

This stage is implementation-only. Do not commit, push, create a PR, run live quota-spending E2E, remove runtime/generated files, or modify `docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md`. The outer pipeline owns verification, commit, and push.

Confirmed defect: `DeliveryCoordinator.#publishWithAcceptance()` correctly requires criterion-level `productEvidenceAdapter` evidence bound to the exact candidate SHA, but the production CLI constructs no adapter. Only test fixtures inject fake evidence, so ordinary `npm run deliver` safely stops at `blocked_acceptance` and can never reach `completed_merged`.

Implement a controller-owned production ProductEvidenceExecutor. It must be configured through an explicit allowlisted VerificationManifest generated from the ProjectOverlay/stack adapter, not by arbitrary shell text supplied by a worker. It must:

1. Run only from the exact candidate integration worktree and exact candidate SHA.
2. Accept only declared, allowlisted local verification commands and maps each executed test to explicit `(requirementId, criterionId, testId, reference, candidateSha)` evidence.
3. Produce the existing strict evidence shape; no global `pass` shortcut, wildcards, guessed criterion IDs, unknown IDs, duplicate mappings, stale SHA, or worker-supplied command can satisfy acceptance.
4. Persist bounded/redacted command metadata, exit status, output digest/reference, timestamp, candidate SHA, and result. Never persist secrets or unbounded command output.
5. Fail closed: missing manifest, unsupported stack command, missing evidence mapping, nonzero command, or mismatch yields `blocked_acceptance` and makes no remote publication/merge call.
6. Preserve current injected test adapters only as test seams; normal CLI delivery must wire the real executor automatically.
7. Be restart-idempotent: an exact prior successful evidence record can be reused only if all immutable identities still match; otherwise re-run or block safely.

Add deterministic tests that use a fake process runner but exercise the production wiring: successful candidate reaches acceptance/publication gate, missing manifest blocks before command, failed command blocks and does not publish, wrong candidate SHA/missing mapping/duplicate mapping block, and restart safety holds. Preserve existing candidate-SHA, CI, branch protection, and remote idempotency guards.

Use existing contracts where sound; do not weaken them. In the final response list changed files and test results.
