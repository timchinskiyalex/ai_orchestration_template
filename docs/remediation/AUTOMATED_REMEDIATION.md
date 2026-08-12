# Automated remediation pipeline

Run this once from the template root:

```powershell
.\START_REMEDIATION_PIPELINE.cmd
```

The pipeline starts one new Codex CLI process per stage. A stage must finish successfully, pass `npm test`, pass `npm run test:app-server-schema`, pass `git diff --check`, create a non-empty allowlisted change, commit, and push to `origin/main` before the next stage starts.

Progress and the final Codex message are saved under `runtime/remediation-pipeline/`. That directory is ignored by Git. Rerunning the command resumes after the last successfully pushed stage. To preview the stage sequence without starting Codex, use:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-remediation-pipeline.ps1 -WhatIf
```

This is intentionally autonomous: each Codex stage uses `--dangerously-bypass-approvals-and-sandbox`. Run it only in this dedicated repository and only after reviewing the prompts in `remediation/prompts/`.

The pipeline stops on the first failure. It never auto-skips a failed stage, never stages runtime/generated/user-owned input paths, and never operates outside the template `main` branch.
