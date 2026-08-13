# Thin orchestrator

The isolated first delivery path is intentionally separate from the legacy
runtime: Markdown → plan → up to two independent App Server workers → Git
artifacts → integration test → candidate SHA.

```powershell
npm run thin:deliver -- --docs .\docs --verify "npm test" --confirm-spend-quota
```

Use the quota-free proof before a live run:

```powershell
npm run thin:deliver -- --docs .\docs --fake
```
