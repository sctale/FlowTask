@echo off
rem FlowTask local storage service launcher (Portable)
rem PowerShell preferred (built-in, zero dependency), Node.js fallback.
cd /d "%~dp0"

rem --- 1) Try PowerShell (Windows built-in, zero dependency) ---
where powershell >nul 2>nul
if %errorlevel%==0 (
  echo [1/2] Starting PowerShell storage service (zero dependency)...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0flowtask_server.ps1"
  goto end
)

rem --- 2) Fallback: Node.js ---
where node >nul 2>nul
if %errorlevel%==0 (
  echo [2/2] Starting Node.js storage service...
  node "%~dp0flowtask_server.js"
  goto end
)


echo Neither PowerShell nor Node.js found. This is unusual for Windows 10/11.
pause

:end
pause
