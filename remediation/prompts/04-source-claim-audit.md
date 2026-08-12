# Stage 04 — independently audit and admit generated source claims

Work only in `D:\Projects\Рой Агентів\ai_orchestration_template` on `main`.

This stage is implementation-only. Do not commit, push, create PRs, run live quota-spending E2E, delete imported/generated documents, or modify `docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md`. The outer pipeline owns verification, commit, and push.

Stage 03 introduced raw-document source-claim extraction and a candidate artifact. Implement the required independent second half before Bootstrap/Planner admission.

Requirements:

1. Add a distinct Specification Auditor role/operation that consumes the immutable candidate extraction plus controller-owned source inventory. It cannot be the same response/operation that created the candidate artifact.
2. Auditor output must make an explicit decision for every candidate claim: admitted, rejected, split-required, contradiction, or unresolved. It must include reason codes and preserve source identity/range/digest binding.
3. The controller constructs the canonical `SourceClaimManifest` only from fully audited admissible claims. Existing strict completeness, exact fragment digests, claim disposition, trusted-policy binding, and publication/resume guards remain fail-closed.
4. Mandatory raw-document facts cannot disappear merely because extraction/audit omitted them. Implement deterministic coverage accounting over normalized source units/segments, with a policy for prose/headers/boilerplate so coverage is meaningful rather than “every line must be exactly one claim”. Unresolved meaningful source material becomes `blocked_specification`.
5. Contradictory or split-required facts block Bootstrap/Planner until resolved by an allowed policy or a later deliberate source update; do not invent a product decision.
6. Bootstrap must start only after a valid audited manifest exists. No App Server Planner/worker/remote call may occur before this admission.
7. Supplied high-assurance manifests go through the same independent validation path, without requiring the extractor, and remain compatible where their data is valid.
8. Persist candidate/audit/admission lineage, use bounded/redacted status reporting, and ensure a restart cannot mix documents, extraction, audit, or manifest from different source identities.

Add deterministic provider-fake tests for independent operations, omitted mandatory source fact, contradiction, split-required source, approved policy disposition, no-planner-before-admission, source mutation/restart invalidation, and supplied-manifest compatibility.

Do not weaken source-integrity checks or add a user approval escape hatch for contradictions. In the final answer list changed files and exact tests.
