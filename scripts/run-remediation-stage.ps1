param(
  [Parameter(Mandatory = $true)]
  [string]$PromptPath,

  [Parameter(Mandatory = $true)]
  [string]$StageId,

  [Parameter(Mandatory = $true)]
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$codex = Get-Command codex.cmd -ErrorAction SilentlyContinue
if (-not $codex) { $codex = Get-Command codex -ErrorAction SilentlyContinue }
if (-not $codex) { throw 'Codex CLI was not found. Install and authenticate Codex before running remediation.' }
if (-not (Test-Path -LiteralPath $PromptPath -PathType Leaf)) { throw "Prompt is missing: $PromptPath" }

$logDirectory = Split-Path -Parent $LogPath
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$prompt = Get-Content -LiteralPath $PromptPath -Raw -Encoding utf8
$stderrPath = "$LogPath.stderr"
Write-Host "[remediation] Codex stage $StageId started. Output is also saved to $LogPath"

try {
  $prompt | & $codex.Source exec `
    --dangerously-bypass-approvals-and-sandbox `
    --cd $projectRoot `
    --output-last-message "$LogPath.final.txt" `
    --color always 2>$stderrPath | Tee-Object -LiteralPath $LogPath
  $exitCode = $LASTEXITCODE
}
finally {
  # Codex writes informational progress (for example, stdin intake) to stderr.
  # Keep it in the stage log without allowing PowerShell to turn it into a
  # NativeCommandError that masks the process's actual exit code.
  if (Test-Path -LiteralPath $stderrPath) {
    Add-Content -LiteralPath $LogPath -Value "`n--- Codex stderr ---" -Encoding utf8
    Get-Content -LiteralPath $stderrPath -Encoding utf8 | Add-Content -LiteralPath $LogPath -Encoding utf8
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Test-Path -LiteralPath "$LogPath.final.txt" -PathType Leaf)) {
  throw "Codex stage '$StageId' produced no final message (exit code $exitCode). See $LogPath"
}
if ($exitCode -ne 0) {
  # The npm PowerShell shim can return a false non-zero code after a completed
  # Codex run. The final response plus the pipeline's full deterministic test
  # suite is the trustworthy success condition.
  Write-Warning "Codex stage '$StageId' returned $exitCode after writing its final message; continuing to verification."
}
Write-Host "[remediation] Codex stage $StageId completed."
