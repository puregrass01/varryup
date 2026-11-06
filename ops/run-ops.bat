@echo off
rem VERY UP order alert worker (read-only). Task Scheduler runs this at logon.
rem Settings: OPS_ROOM, OPS_IMWEB_PROFILES in %APPDATA%\very-up-ver2\veryup.env
rem Admin server login: run ops\setup-login.ps1 once.
rem With arguments (--once, --preview, --dry-run) it runs once; without, it restarts the worker if it exits.
cd /d "%~dp0"
if not exist "%APPDATA%\veryup-ops" mkdir "%APPDATA%\veryup-ops"
:again
rem ponytail: log grows forever; rotate if it ever gets big.
node --env-file-if-exists="%APPDATA%\very-up-ver2\veryup.env" notify.mjs %* >> "%APPDATA%\veryup-ops\ops.log" 2>&1
if not "%~1"=="" exit /b
timeout /t 60 /nobreak >nul
goto again
