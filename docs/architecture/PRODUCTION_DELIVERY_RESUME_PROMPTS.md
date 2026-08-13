# Production delivery resume prompts

These prompts are intentionally bounded.  Run them in order after the current
refactor commits are pushed.  They preserve the separation between controller
correctness and Codex worker execution.

## Prompt 1 — G1 writer production parity

```text
Work only in D:\Projects\Рой Агентів\ai_orchestration_template on
refactor/codex-app-server-simplification.

Implement G1 from docs/architecture/PRODUCTION_DELIVERY_ROADMAP.md.  Inspect
current code first.  Make CodexAppServerRuntime the single writer path for
frontend/backend/database/devops; do not migrate Bootstrap, Planner, Security
or QA in this task.  Retire the legacy writer fallback only when deterministic
parity is proven.

Preserve controller authority over task state, readiness/capacity, exact
worktree/base SHA, terminal receipt persistence, Git-derived artifacts,
Security/QA, checkpoints and integration.  Simplify the writer path so Router
consumes runtime observations rather than independently modelling raw App
Server turn lifecycle.

Add deterministic coverage for two independent writer tasks at configured
capacity two, exact isolated cwd/base SHA, alias-safe terminal receipts,
Security->QA release, fan-in integration and restart/no-duplicate behavior.
Prepare one bounded live disposable acceptance command, but do not run it.

Run focused tests, npm test, npm run test:app-server-schema, git diff --check
and git show --check HEAD.  Create one local atomic commit only.  Do not push,
run live quota tests, edit runtime/** or temp/**, or touch
docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md.
```

## Prompt 2 — G2/G3 documentation-to-candidate audit

```text
Work only in D:\Projects\Рой Агентів\ai_orchestration_template on
refactor/codex-app-server-simplification.  Perform a read-only audit of G2 and
G3 in docs/architecture/PRODUCTION_DELIVERY_ROADMAP.md.

Confirm from code/tests whether a user can provide documentation alone, source
claims are created automatically, required claims/criteria/contradictions are
validated, Planner produces a requirement-linked wave DAG, and one command
can reach a monitored local candidate through parallel writers, Security, QA
and integration.

Do not modify files, commit, push, run live E2E or spend quota.  Return only:
(1) confirmed gaps with file/function evidence and severity; (2) a single
implementation prompt for the smallest G2/G3 closure; (3) exact deterministic
and one explicitly-gated live acceptance test required afterwards.
```

## Prompt 3 — G4 remote publication acceptance

```text
Work only in D:\Projects\Рой Агентів\ai_orchestration_template on
refactor/codex-app-server-simplification.  After G1-G3 are green, audit and
implement G4 from docs/architecture/PRODUCTION_DELIVERY_ROADMAP.md.

Use allowlisted authenticated GitHub operations only.  Require candidate SHA,
successful required CI, branch-protection compatibility and idempotency before
PR merge.  Never force-push, bypass protection or deploy.  Add deterministic
adapter tests and a separately confirmed disposable remote acceptance command.

Do not run the remote acceptance command, push, create a PR or merge in this
task.  Run local verification and create one local atomic commit only.
```
