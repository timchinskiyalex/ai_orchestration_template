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
Write-Host "[remediation] Codex stage $StageId started. Output is also saved to $LogPath"

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $prompt | & $codex.Source exec `
    --dangerously-bypass-approvals-and-sandbox `
    --cd $projectRoot `
    --output-last-message "$LogPath.final.txt" `
    --color always 2>&1 | Tee-Object -LiteralPath $LogPath
  $exitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}

if ($exitCode -ne 0) { throw "Codex stage '$StageId' exited with code $exitCode. See $LogPath" }
Write-Host "[remediation] Codex stage $StageId completed."
