@echo off
rem FlowTask - stop the local storage service (kills the process listening on port 5178)
setlocal enabledelayedexpansion
set FOUND=0

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5178" ^| findstr /i "LISTENING"') do (
  echo Stopping FlowTask storage service, PID %%a
  taskkill /F /PID %%a >nul 2>nul
  set FOUND=1
)

if "%FOUND%"=="0" (
  echo FlowTask storage service is not running.
) else (
  echo Done. FlowTask storage service stopped.
  echo Your data is safe in flowtask_data.json
)

timeout /t 3 >nul
endlocal
