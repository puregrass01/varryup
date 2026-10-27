@echo off
setlocal
title VERY UP VER3 Launcher
rem pushd, not cd /d: cd cannot enter a network share (\\server\share) and would go on in the wrong folder.
pushd "%~dp0" || (pause & exit /b 1)
echo ==========================================================
echo  VERY UP VER3 Starting...
echo ==========================================================

rem A folder from git (clone or Download ZIP) has no node_modules - it is gitignored.
rem The first run installs it once (Node.js LTS + internet: about 190MB download, 500MB on disk).
rem Keep this file ASCII-only: Korean text garbles under the cp949 console, and breaks the whole file with LF line endings.
rem Run inside an unextracted ZIP, npm would climb to a parent folder's project and wipe its node_modules.
if not exist "package.json" (
  echo [ERROR] package.json is not next to this file. If you opened it inside the ZIP, right-click the ZIP, Extract All, and run it from the extracted folder.
  pause
  exit /b 1
)
rem electron's installer writes path.txt last - without it the first install was cut off.
if exist "node_modules\electron\path.txt" if exist "node_modules\electron\dist\electron.exe" goto run
echo First run: installing packages with npm ci. This can take a few minutes...
call npm -v >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install the LTS build from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
rem electron is a devDependency - NODE_ENV=production or omit=dev would skip it.
set "NODE_ENV="
call npm ci --include=dev --no-audit --no-fund
if errorlevel 1 (
  echo [ERROR] npm ci failed - read the npm error above. Usual causes: no internet or a proxy, or an old Node.js - install the current LTS.
  pause
  exit /b 1
)
rem npm 12 and ignore-scripts=true skip electron's postinstall, which downloads electron.exe - run it here.
if not exist "node_modules\electron\path.txt" call node node_modules\electron\install.js
if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] electron.exe is still missing. Delete the node_modules folder and run this file again.
  pause
  exit /b 1
)

:run
echo Servers (admin/AI/coupang) run on the CLOUD - launching app only...
"node_modules\electron\dist\electron.exe" .
if errorlevel 1 pause
