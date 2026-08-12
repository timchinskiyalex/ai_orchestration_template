# Stage 03 — accept raw documentation and generate source claims autonomously

Work only in `D:\Projects\Рой Агентів\ai_orchestration_template` on `main`.

This stage is implementation-only. Do not commit, push, create PRs, run live quota-spending E2E, delete imported/generated documents, or modify `docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md`. The outer pipeline owns verification, commit, and push.

Product requirement: a user provides ordinary project documentation only. The system, not the user, must produce the technical source-claim manifest needed for strict source-to-requirement traceability.

Current fail-closed `source-claims.json` validation and digest/source-fragment integrity are valuable and must remain. Add a controller-owned first intake phase:

`raw Markdown documents -> normalized inventory/hashes -> source-claim extraction task -> candidate SourceClaimManifest -> independent audit/admission phase`.

This stage implements only the first half: safe normalization and candidate manifest extraction.

Requirements:

1. `deliver --source <docs>` accepts raw Markdown without a user-created `source-claims.json`.
2. Preserve imported source files and current normalized document identity/digest algorithm. The extractor receives controlled source references/inventory, not arbitrary filesystem access.
3. Introduce a versioned, controller-owned `SourceClaimExtraction` contract. A candidate claim is atomic and includes stable claimId, document identity, precise line range, source digest, claim type, normalized statement, confidence, and source quote digest/reference. Multiple atomic claims may originate from one source span; do not encode “one line equals one claim”.
4. The extraction role writes a structured candidate artifact only. It must not authorize facts, bypass source integrity, plan engineering work, or expose full sensitive text in logs/status.
5. Existing user-provided `source-claims.json` remains supported as high-assurance supplied input, but raw-doc mode is the normal path. Both routes converge into one audited/admitted manifest contract.
6. Extraction failure, malformed JSON, ambiguous document identity/range/digest, or unavailable extraction provider must be persisted as a bounded, resumable `blocked_specification` state — never generic success and never silent fallback.
7. Add additive persistence/migration and restart compatibility. Legacy source-controlled runs retain their fail-closed restrictions.

Add deterministic tests with a fake execution provider for raw docs -> normalized inventory -> candidate extraction persistence; multiple atomic claims from one span; sensitive redaction; malformed/unknown/changed source blocking; supplied-manifest compatibility; and restart after candidate persistence before audit.

Do not implement acceptance/admission authorization in this stage except the necessary handoff contract. That is stage 04. In the final answer report changed files and tests.
