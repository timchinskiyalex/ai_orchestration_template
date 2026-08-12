param(
  [ValidateRange(250, 60000)]
  [int]$IntervalMs = 1000,
  [switch]$Once
)

$ErrorActionPreference = 'Continue'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$env:NODE_NO_WARNINGS = '1'
$Host.UI.RawUI.WindowTitle = 'AI Orchestration - Live Delivery Monitor'

function Write-Table {
  param([object[]]$Rows, [string[]]$Properties)
  if ($Rows -and $Rows.Count) { $Rows | Select-Object $Properties | Format-Table -AutoSize | Out-String | Write-Host }
  else { Write-Host '  none' -ForegroundColor DarkGray }
}

function Show-Snapshot {
  param($Snapshot)
  Clear-Host
  $run = $Snapshot.deliveryRun
  $budget = $Snapshot.localBudget
  $forecast = $Snapshot.localForecast
  $state = if ($run) { $run.state } else { 'idle' }
  $stateColor = if ($state -eq 'running') { 'Green' } elseif ($state -match '^(completed|idle)') { 'Cyan' } else { 'Yellow' }

  Write-Host 'AI ORCHESTRATION - LIVE DELIVERY MONITOR' -ForegroundColor Cyan
  Write-Host ('Updated: {0}' -f $Snapshot.generatedAt)
  Write-Host ('Delivery: {0}  Run: {1}' -f $state, $(if ($run) { $run.id } else { 'none' })) -ForegroundColor $stateColor
  Write-Host ('Concurrency: {0} active turn(s): {1}' -f $Snapshot.realConcurrency, @($Snapshot.activeTurns).Count)
  Write-Host ''

  Write-Host 'LOCAL TOKEN BUDGET' -ForegroundColor Cyan
  Write-Host ('Actual: {0:N0} | Reserved: {1:N0} | Remaining: {2:N0} / {3:N0} ({4:N1}% used)' -f $budget.usedTokens, $budget.reservedTokens, $budget.remainingTokens, $budget.weeklyTokenLimit, $budget.usedPercent)
  Write-Host ('Forecast: P50 {0:N0} | P90 {1:N0} | samples: {2}' -f $forecast.p50Tokens, $forecast.p90Tokens, $forecast.sampleSize)
  Write-Host ''

  Write-Host 'APP SERVER QUOTA' -ForegroundColor Cyan
  Write-Table @($Snapshot.appServerQuotaWindows) @('limitName', 'window', 'usedPercent', 'windowDurationMins', 'resetsAt')
  Write-Host ''

  Write-Host 'TASKS' -ForegroundColor Cyan
  $tasks = @($Snapshot.tasks | ForEach-Object { [PSCustomObject]@{ role = $_.role; status = $_.status; tokenUsed = $_.tokenUsed; tokenBudget = $_.tokenBudget; title = $_.title; blocker = $_.blocker } })
  Write-Table $tasks @('role', 'status', 'tokenUsed', 'tokenBudget', 'title', 'blocker')
  Write-Host ''

  Write-Host 'LATEST LIFECYCLE EVENTS' -ForegroundColor Cyan
  Write-Table @($Snapshot.lifecycle | Select-Object -Last 8) @('createdAt', 'type', 'taskId')
  if ($run -and $run.publish) {
    Write-Host ''
    Write-Host 'REMOTE PUBLICATION' -ForegroundColor Cyan
    $run.publish | ConvertTo-Json -Depth 4 | Write-Host
  }
}

while ($true) {
  try {
    $raw = & node src/index.mjs status --json
    if ($LASTEXITCODE -ne 0) { throw "status command exited with code $LASTEXITCODE" }
    Show-Snapshot (($raw -join "`n") | ConvertFrom-Json)
  } catch {
    Clear-Host
    Write-Host 'AI ORCHESTRATION - LIVE DELIVERY MONITOR' -ForegroundColor Cyan
    Write-Host ('Monitor read failed: {0}' -f $_.Exception.Message) -ForegroundColor Red
    Write-Host 'The monitor will retry; this does not stop delivery.' -ForegroundColor Yellow
  }
  if ($Once) { break }
  Start-Sleep -Milliseconds $IntervalMs
}
