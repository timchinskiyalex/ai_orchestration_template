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
$promptTempPath = "$LogPath.prompt"
$stdoutPath = "$LogPath.stdout"
$stderrPath = "$LogPath.stderr"
Write-Host "[remediation] Codex stage $StageId started. Output is also saved to $LogPath"

try {
  # Do not invoke the npm .cmd shim through a PowerShell pipeline. Windows
  # PowerShell can fabricate NativeCommandError/non-zero wrapper exits after a
  # successful Codex run. cmd.exe owns stdin/stdout/stderr and its exit code.
  [System.IO.File]::WriteAllText($promptTempPath, $prompt, [System.Text.UTF8Encoding]::new($false))
  $quoteCmd = { param([string]$value) '"' + $value.Replace('"', '""') + '"' }
  $command = "$(& $quoteCmd $codex.Source) exec --dangerously-bypass-approvals-and-sandbox --cd $(& $quoteCmd $projectRoot) --output-last-message $(& $quoteCmd "$LogPath.final.txt") --color always < $(& $quoteCmd $promptTempPath) > $(& $quoteCmd $stdoutPath) 2> $(& $quoteCmd $stderrPath)"
  & cmd.exe /d /s /c $command
  $exitCode = $LASTEXITCODE
}
finally {
  if (Test-Path -LiteralPath $stdoutPath) {
    Move-Item -LiteralPath $stdoutPath -Destination $LogPath -Force
  }
  if (Test-Path -LiteralPath $stderrPath) {
    Add-Content -LiteralPath $LogPath -Value "`n--- Codex stderr ---" -Encoding utf8
    Get-Content -LiteralPath $stderrPath -Encoding utf8 | Add-Content -LiteralPath $LogPath -Encoding utf8
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $promptTempPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath "$LogPath.final.txt" -PathType Leaf)) {
  throw "Codex stage '$StageId' produced no final message (exit code $exitCode). See $LogPath"
}
if ($exitCode -ne 0) { throw "Codex stage '$StageId' exited with code $exitCode. See $LogPath" }
Write-Host "[remediation] Codex stage $StageId completed."
