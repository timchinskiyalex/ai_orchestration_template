# Thin orchestrator

The isolated first delivery path is intentionally separate from the legacy
runtime: Markdown → plan → up to two independent App Server workers → Git
artifacts → integration test → candidate SHA.

```powershell
npm run thin:deliver -- --docs .\docs --verify "npm test" --confirm-spend-quota
```

When the final integration verification fails, repair is disabled by default.
Enable one bounded repair attempt only by declaring its exact controller-owned
write surface:

```powershell
npm run thin:deliver -- --docs .\docs --verify "npm test" --repair-surface "src,test" --confirm-spend-quota
```

The repair path creates one planner turn and one worker turn at the failed
candidate. The controller rejects paths outside `--repair-surface`, finalizes
the repair diff itself, then reruns the same verification exactly once. A
failed repair or failed retry preserves the integration worktree for recovery.

Use the quota-free proof before a live run:

```powershell
npm run thin:deliver -- --docs .\docs --fake
```
