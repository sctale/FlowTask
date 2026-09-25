@echo off
rem ============================================================
rem  FlowTask one-click environment check & deploy (portable)
rem  Run this on a NEW computer after copying the whole folder.
rem  - checks runtime (PowerShell / Node), data files, port 5178
rem  - then hands over to the launcher (starts service, creates
rem    the logo shortcut, opens the browser)
rem  Chinese output lives in deploy_check.ps1 (UTF-8) so this
rem  bat stays ASCII-safe on any codepage.
rem ============================================================
setlocal
cd /d "%~dp0"
echo.
echo  FlowTask 环境检查与部署...
echo  (正在运行检查，请稍候)
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy_check.ps1"
set CHECKERR=%errorlevel%
echo.
if not "%CHECKERR%"=="0" (
  echo  [X] 环境检查发现问题，请按上方提示处理后重新运行本脚本。
) else (
  echo  [OK] 环境就绪。如浏览器未自动打开，请访问 http://127.0.0.1:5178
  echo  提示：桌面/文件夹里的 FlowTask.lnk 快捷方式已按本机路径重建。
)
echo.
pause
endlocal
