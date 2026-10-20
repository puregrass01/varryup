@echo off
title VERY UP VER3 Launcher
echo ==========================================================
echo  VERY UP VER3 Starting...
echo ==========================================================

echo Servers (admin/AI/coupang) run on the CLOUD - launching app only...
cd /d "%~dp0"
"node_modules\electron\dist\electron.exe" .
