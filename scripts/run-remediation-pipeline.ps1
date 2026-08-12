param(
  [string]$FromStage,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$planPath = Join-Path $projectRoot 'remediation\remediation-plan.json'
$runtimeRoot = Join-Path $projectRoot 'runtime\remediation-pipeline'
$statePath = Join-Path $runtimeRoot 'state.json'
$forbiddenPrefixes = @('runtime/', 'docs/orchestration-generated/', 'docs/orchestration-input/')
$forbiddenExact = @('docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md')
$allowedPrefixes = @('src/', 'test/', 'scripts/', 'remediation/', 'docs/remediation/', 'config/', '.github/')
$allowedExact = @('README.md', 'package.json', '.gitignore', 'START_REMEDIATION_PIPELINE.cmd')

function Normalize-Path([string]$Path) { return $Path.Replace('\', '/').TrimStart('/') }
function Test-Forbidden([string]$Path) {
  $normalized = Normalize-Path $Path
  return ($forbiddenExact -contains $normalized) -or ($forbiddenPrefixes | Where-Object { $normalized.StartsWith($_) })
}
function Test-Allowed([string]$Path) {
  $normalized = Normalize-Path $Path
  return ($allowedExact -contains $normalized) -or ($allowedPrefixes | Where-Object { $normalized.StartsWith($_) })
}
function Get-ChangedPaths {
  $tracked = @(& git -C $projectRoot diff --name-only; & git -C $projectRoot diff --cached --name-only) |
    ForEach-Object { Normalize-Path $_ } |
    Where-Object { $_ } |
    Sort-Object -Unique
  $untracked = @(& git -C $projectRoot ls-files --others --exclude-standard) |
    ForEach-Object { Normalize-Path $_ } |
    Where-Object { $_ } |
    Sort-Object -Unique
  $all = @()
  $all += $tracked
  $all += $untracked
  return @($all | Sort-Object -Unique)
}
function Invoke-Checked([string]$Label, [scriptblock]$Command) {
  Write-Host "[remediation] $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}
function Save-State($State) {
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  $State.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  $State | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $statePath -Encoding utf8
}

if (-not (Test-Path -LiteralPath $planPath -PathType Leaf)) { throw "Remediation plan is missing: $planPath" }
$plan = Get-Content -LiteralPath $planPath -Raw -Encoding utf8 | ConvertFrom-Json
if (-not $plan.stages -or $plan.stages.Count -eq 0) { throw 'Remediation plan has no stages.' }

Invoke-Checked 'Checking repository identity' { git -C $projectRoot rev-parse --is-inside-work-tree | Out-Null }
$branch = (& git -C $projectRoot branch --show-current).Trim()
if ($branch -ne 'main') { throw "Refusing to run remediation outside template main; current branch is '$branch'." }
Invoke-Checked 'Fetching origin/main' { git -C $projectRoot fetch origin main --quiet }
$behind = [int]((& git -C $projectRoot rev-list --count HEAD..origin/main).Trim())
if ($behind -ne 0) { throw "Local main is $behind commit(s) behind origin/main. Reconcile it before remediation." }

$preexisting = Get-ChangedPaths
$unexpectedPreexisting = @($preexisting | Where-Object { -not (Test-Forbidden $_) })
if ($unexpectedPreexisting) { throw "Refusing to mix remediation with existing changes:`n$($unexpectedPreexisting -join "`n")" }

$state = if (Test-Path -LiteralPath $statePath) {
  Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json
} else {
  [pscustomobject]@{ version = 1; startedAt = (Get-Date).ToUniversalTime().ToString('o'); completedStages = @(); updatedAt = $null }
}

$startFound = [string]::IsNullOrWhiteSpace($FromStage)
foreach ($stage in $plan.stages) {
  if (-not $startFound) {
    if ($stage.id -eq $FromStage) { $startFound = $true } else { continue }
  }
  if ($state.completedStages -contains $stage.id) {
    Write-Host "[remediation] Skipping already completed stage: $($stage.id)"
    continue
  }
  $promptPath = Join-Path $projectRoot $stage.prompt
  if (-not (Test-Path -LiteralPath $promptPath -PathType Leaf)) { throw "Stage prompt is missing: $promptPath" }
  if ($WhatIf) { Write-Host "[remediation] Would run $($stage.id): $promptPath"; continue }

  Write-Host "`n========== REMEDIATION STAGE: $($stage.id) =========="
  $logPath = Join-Path $runtimeRoot ("$($stage.id).log")
  # Start-Process joins ArgumentList before creating the child process. Passing
  # a Unicode path with spaces through -File therefore splits it into several
  # arguments on Windows. Invoke the script through one explicitly quoted
  # PowerShell command instead.
  $stageScript = Join-Path $projectRoot 'scripts\run-remediation-stage.ps1'
  $quote = { param([string]$value) "'" + $value.Replace("'", "''") + "'" }
  $childCommand = "& $(& $quote $stageScript) -PromptPath $(& $quote $promptPath) -StageId $(& $quote $stage.id) -LogPath $(& $quote $logPath)"
  $child = Start-Process -FilePath 'powershell.exe' -WorkingDirectory $projectRoot -PassThru -Wait -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $childCommand
  )
  if ($child.ExitCode -ne 0) { throw "Stage $($stage.id) failed. The pipeline stopped; inspect $logPath." }

  $verificationFailed = $null
  try {
    Invoke-Checked 'Running npm test' { npm.cmd test }
    Invoke-Checked 'Running App Server schema preflight' { npm.cmd run test:app-server-schema }
    Invoke-Checked 'Checking Git diff' { git -C $projectRoot diff --check }
  } catch {
    $verificationFailed = $_.Exception.Message
  }
  if ($verificationFailed) {
    # One bounded corrective pass prevents an implementation agent's focused
    # tests from silently missing a full-suite regression. A second failure is
    # surfaced rather than retried indefinitely.
    $repairPromptPath = Join-Path $runtimeRoot ("$($stage.id).verification-repair.md")
    @"
# Verification repair — $($stage.id)

Work only in `$projectRoot` on `main`. The prior implementation for this stage is uncommitted. Do not commit, push, create a PR, run live quota-spending E2E, remove runtime/generated files, or modify `docs/PROMPT_AUTONOMOUS_DELIVERY_LOOP.md`.

The required full deterministic verification failed after the stage implementation: $verificationFailed

Inspect the current uncommitted diff and failing tests. Repair the defect without discarding the original stage requirements from:
`$promptPath`

Run the affected focused tests. The controller will rerun the complete verification once. Report changed files and exact results.
"@ | Set-Content -LiteralPath $repairPromptPath -Encoding utf8
    $repairLogPath = Join-Path $runtimeRoot ("$($stage.id).verification-repair.log")
    $repairCommand = "& $(& $quote $stageScript) -PromptPath $(& $quote $repairPromptPath) -StageId $(& $quote "$($stage.id)-verification-repair") -LogPath $(& $quote $repairLogPath)"
    Write-Host "[remediation] Full verification failed; starting one corrective Codex pass for $($stage.id)."
    $repairChild = Start-Process -FilePath 'powershell.exe' -WorkingDirectory $projectRoot -PassThru -Wait -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $repairCommand
    )
    if ($repairChild.ExitCode -ne 0) { throw "Stage $($stage.id) and its corrective pass failed. Inspect $repairLogPath." }
    Invoke-Checked 'Re-running npm test after corrective pass' { npm.cmd test }
    Invoke-Checked 'Re-running App Server schema preflight after corrective pass' { npm.cmd run test:app-server-schema }
    Invoke-Checked 'Re-checking Git diff after corrective pass' { git -C $projectRoot diff --check }
  }

  $changes = Get-ChangedPaths
  $newChanges = @($changes | Where-Object { $preexisting -notcontains $_ })
  $forbidden = @($newChanges | Where-Object { Test-Forbidden $_ })
  $outsideAllowlist = @($newChanges | Where-Object { -not (Test-Allowed $_) })
  if ($forbidden) { throw "Stage $($stage.id) changed protected runtime/generated/user-owned paths:`n$($forbidden -join "`n")" }
  if ($outsideAllowlist) { throw "Stage $($stage.id) changed paths outside the remediation allowlist:`n$($outsideAllowlist -join "`n")" }
  if (-not $newChanges) { throw "Stage $($stage.id) produced no versioned change; refusing an empty success." }

  & git -C $projectRoot add -- @newChanges
  if ($LASTEXITCODE -ne 0) { throw "Could not stage changes for $($stage.id)" }
  Invoke-Checked 'Checking staged diff' { git -C $projectRoot diff --cached --check }
  & git -C $projectRoot commit -m $stage.commitMessage
  if ($LASTEXITCODE -ne 0) { throw "Commit failed for $($stage.id)" }
  $head = (& git -C $projectRoot rev-parse HEAD).Trim()
  & git -C $projectRoot push origin main
  if ($LASTEXITCODE -ne 0) { throw "Push failed for $($stage.id). Commit $head is local and can be pushed after resolving the remote problem." }

  $state.completedStages = @($state.completedStages) + @($stage.id)
  Save-State $state
  $preexisting = Get-ChangedPaths
  Write-Host "[remediation] Stage $($stage.id) committed and pushed: $head"
}

if (-not $startFound) { throw "Unknown FromStage '$FromStage'." }
Write-Host "[remediation] All selected stages completed."
