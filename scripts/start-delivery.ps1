param(
  [string]$Source,
  [ValidateRange(250, 60000)]
  [int]$IntervalMs = 1000
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$defaultSource = Join-Path $projectRoot 'docs\project-specifications'
if ([string]::IsNullOrWhiteSpace($Source)) {
  if (-not (Test-Path -LiteralPath $defaultSource -PathType Container)) { throw "Project documentation directory is missing. Provide -Source <requirements-dir>." }
  $source = (Resolve-Path -LiteralPath $defaultSource -ErrorAction Stop).Path
} else {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Project documentation directory is missing: $Source" }
  $source = (Resolve-Path -LiteralPath $Source -ErrorAction Stop).Path
}
$env:NODE_NO_WARNINGS = '1'

$dirty = & git -C $projectRoot status --porcelain
if ($LASTEXITCODE -ne 0) { throw "Cannot inspect Git status for $projectRoot" }
$controllerOwnedPrefixes = @('docs/orchestration-input/', 'docs/orchestration-generated/', 'runtime/')
$blockingDirty = @($dirty | Where-Object {
  $path = if ($_.Length -gt 3) { $_.Substring(3).Replace('\', '/') } else { $_ }
  -not ($controllerOwnedPrefixes | Where-Object { $path -eq $_.TrimEnd('/') -or $path.StartsWith($_) })
})
if ($blockingDirty) { throw "Refusing to start: commit or stash code/product working-tree changes first.`n$($blockingDirty -join "`n")" }

function Get-DeliveryStatus {
  # Windows PowerShell can promote Node's harmless experimental SQLite warning
  # to NativeCommandError when the launcher uses ErrorActionPreference=Stop.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & node src/index.mjs status --json 2>$null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) { throw "Could not read delivery status" }
  return (($raw -join "`n") | ConvertFrom-Json)
}

Write-Host "Checking stale delivery leases before starting."
$recovery = & node src/index.mjs recover
if ($LASTEXITCODE -ne 0) { throw "Could not recover stale delivery state" }
if ($recovery) { Write-Host ($recovery -join "`n") }

$status = Get-DeliveryStatus
$watchCommand = "& '.\scripts\watch-delivery.ps1' -IntervalMs $IntervalMs"
$monitor = Start-Process -FilePath 'powershell.exe' -WorkingDirectory $projectRoot -PassThru -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $watchCommand
)
if (-not $monitor) { throw 'Could not start the live delivery monitor.' }
Start-Sleep -Milliseconds 750
$monitor.Refresh()
if ($monitor.HasExited) { throw 'Live delivery monitor exited during startup; delivery was not started.' }
Write-Host "Live monitor started in a separate PowerShell window (PID $($monitor.Id))."
$terminal = @('completed_merged', 'completed_candidate_ready', 'failed', 'interrupted', 'blocked_budget', 'blocked_quota', 'blocked_credentials', 'blocked_ci', 'blocked_branch_protection', 'conflict_blocked')
$resumable = @('interrupted', 'blocked_credentials', 'blocked_ci', 'blocked_branch_protection', 'running', 'awaiting_human', 'awaiting_human_remote_handoff')
$resume = $status.deliveryRun -and ($resumable -contains $status.deliveryRun.state)
$deliveryArgs = @('src/index.mjs', 'deliver')
if ($resume) { $deliveryArgs += '--resume' } else { $deliveryArgs += @('--source', $source) }

Write-Host "Main window will print stage and budget progress. Starting autonomous delivery."
& node @deliveryArgs
$deliveryExitCode = $LASTEXITCODE
if ($deliveryExitCode -ne 0) { Write-Host "Delivery command ended non-zero; reading persisted final summary before returning." }

$final = Get-DeliveryStatus
if (-not $final.deliveryRun) { throw "Delivery state was not found after execution" }
Write-Host "Delivery state: $($final.deliveryRun.state)"
if ($final.deliveryRun.state -eq 'interrupted') { Write-Host "Ctrl+C or controller exit was recovered. Thread/turn/token history remains in runtime state." }
if ($final.deliveryRun.state -notin $terminal) { throw "Delivery ended without a machine-readable terminal state: $($final.deliveryRun.state)" }
$localCandidateSuccess = $final.deliveryRun.state -eq 'completed_candidate_ready' -and $final.deliveryRun.completionContractVersion -ge 2 -and $final.deliveryRun.publish.localCandidate -eq $true -and $final.deliveryRun.publish.remoteEnabled -eq $false -and $null -ne $final.deliveryRun.candidate.sha -and $null -ne $final.deliveryRun.publish.acceptanceReportId
if ($final.deliveryRun.state -ne 'completed_merged' -and -not $localCandidateSuccess) { exit 1 }
