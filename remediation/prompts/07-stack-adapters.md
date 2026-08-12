# Stage 07 — make stack support blueprint-driven and explicit

Work only in `D:\Projects\Рой Агентів\ai_orchestration_template` on `main`.

This stage is implementation-only. Do not commit, push, create PRs, run live quota-spending E2E, install global toolchains, delete files, or modify `docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md`. The outer pipeline owns verification, commit, and push.

Confirmed scope gap: current core is hard-wired around `next-node` and `dotnet`; Python/Go adapters are marked unavailable. The reusable template must not represent this as a generic multi-stack factory until adapters and verification contracts exist.

Implement a versioned StackAdapter boundary driven by the admitted ArchitectureBlueprint/ProjectMode, not generic conditionals spread through Router/Overlay/Scaffold.

Requirements:

1. Define a strict controller-owned stack adapter contract: detection, supported project modes, scaffold contract, component roots, declared verification commands, package/toolchain fingerprints, safe write surfaces, and product-evidence mappings.
2. Migrate `next-node` and `dotnet` into concrete adapters without behavior regression.
3. Add concrete allowlisted adapters for Python and Go only if deterministic local fixture tests can verify them without installing tools globally. Otherwise retain them as explicitly unsupported with precise diagnostics — never an optimistic placeholder.
4. Unsupported or ambiguous stack inference blocks before Planner/worker with a bounded `blocked_specification`/unsupported-stack reason, and asks neither workers nor arbitrary shell commands to guess.
5. Greenfield scaffolding, Brownfield overlay discovery, QA verification, and ProductEvidenceExecutor all derive from the same selected adapter.
6. Keep adapter registration closed/allowlisted. No worker-provided adapter code, plugin auto-loading, external registry, or arbitrary executable path.

Add deterministic tests for adapter selection, ambiguity/unsupported refusal, Next/.NET compatibility, a fixture-driven Python/Go adapter if implemented, and exact verification-manifest propagation into product evidence.

Update scope documentation honestly. In the final response state supported stacks proven by tests and unsupported stacks.
