# Architecture

`DeliveryCoordinator` is the persisted lifecycle owner. `SwarmRouter` schedules bounded parallel tasks and `StateStore` persists SQLite events, tasks, artifacts, review reports, integration manifests, delivery state, and idempotent external actions.

Writer agents run in isolated worktrees. Each writer must be finalized by the controller into a SHA-bound `WorkerArtifact`. Security and QA are structured controller-validated reports. Greenfield deterministic scaffold is the explicit exception to provider-owned review: its Security → QA tasks are controller-local, preserve the same persisted report/release chain, consume no App Server turn, and run declared component verification before any dependent writer may start. A remediation writer starts from the predecessor artifact SHA and must pass Security and QA again. Exhausting the configured remediation limit is terminal `failed`; it never waits for a human in autonomous mode.

On an App Server `process_exit`, the controller retains bounded, redacted process code/signal, stderr, protocol tail, active task/thread/turn IDs, and terminal thread/read summary. For each active turn it performs one bounded read-only terminal fallback. A verified terminal turn is accepted and never overwritten; an unresolved turn persists `execution_provider_process_exit` as the primary failure and remains fail-closed.

`ProjectOverlay` is controller-owned, evidence-backed repository metadata. Multi-stack overlays discover only configured product roots. Root controller metadata is never treated as frontend/backend product metadata.

`RemoteGitAdapter`, `GitHubPullRequestAdapter`, `GitHubCiAdapter`, and `GitHubMergeAdapter` use the authenticated local Git/GitHub CLI environment. Candidate push is exact-SHA verified and never force-pushed. PR/CI/merge external actions use stable idempotency keys persisted in SQLite. Merge checks local verification, Security, QA, and CI before invoking GitHub; protection rejection is returned as a terminal blocker.
