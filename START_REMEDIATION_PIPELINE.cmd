@echo off
setlocal
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\run-remediation-pipeline.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Remediation pipeline stopped with exit code %EXIT_CODE%. See runtime\remediation-pipeline for the failing stage log.
)
exit /b %EXIT_CODE%
