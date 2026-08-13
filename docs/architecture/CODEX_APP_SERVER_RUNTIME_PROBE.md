# Codex App Server Runtime live compatibility probe

## Run deliberately

This command spends Codex quota and is opt-in. Do not use it as part of the normal test suite:

```powershell
npm run e2e:codex-runtime-probe -- --confirm-spend-quota
```

Without the exact confirmation flag, it fails before constructing or connecting an App Server runtime.

## What it proves

The probe creates a disposable local Git repository, resolves its exact base SHA, and creates one detached isolated worktree from that SHA. It then gives that exact worktree path to one `CodexAppServerRuntime`, starts one thread and one real writer turn, and requires a durable terminal reconciliation of `completed`.

The writer receives a narrow prompt to create exactly `src/codex-runtime-probe-output.mjs`, with no worker Git commit. The controller inspects the real Git diff, accepts only that path, and uses `WorktreeFinalizer` to make the authoritative commit and persist a `WorkerArtifact`. Success requires the artifact's expected base SHA, final head SHA, changed path, and diff checksum.

The successful disposable repository is removed only after its external JSON report is persisted. A failed repository is preserved. Its report contains bounded/redacted diagnostics, requested and resolved turn IDs, lifecycle candidate and durable terminal status, process state, stderr/protocol tails, and an inspection recovery command.

## What it does not prove

This is intentionally not full project-delivery E2E. It does not invoke Bootstrap, Planner, source extraction or audit, Security, QA, integration, CI, GitHub, merge, multiple workers, or scheduler waves. It does not prove project-level acceptance, remote publication, review gates, or multi-worker topology.

Full project-delivery E2E is a separate next step after this focused runtime compatibility boundary has sustained evidence.
