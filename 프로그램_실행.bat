@echo off
title Antigravity Master Launcher
echo ==========================================================
echo  Antigravity Automation System Starting...
echo ==========================================================

echo [1/2] Starting Python AI FastAPI Server (Port 8000)...
start "Python AI Server" /min cmd /c "cd /d C:\Users\wish\.gemini\antigravity\scratch\auto_image_generator\ai_server && python main.py"

timeout /t 2 /nobreak > nul

echo [2/2] Launching Antigravity Main Application...
cd /d "%~dp0"
"node_modules\electron\dist\electron.exe" .
