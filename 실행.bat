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
rem Optional update: a git clone asks before pulling new commits from GitHub. A Download ZIP folder has no .git and skips this.
rem No credential prompt (a private repo without login would hang here) - a failed check just runs this version.
set "NEED_CI="
set "GIT_TERMINAL_PROMPT=0"
if not exist ".git" goto noupdate
git --version >nul 2>&1 || goto noupdate
echo Checking for updates...
git fetch -q origin >nul 2>&1 || (echo Update check skipped - no internet or no access to GitHub. & goto noupdate)
set "BEHIND=0"
for /f %%n in ('git rev-list --count HEAD..@{u} 2^>nul') do set "BEHIND=%%n"
if "%BEHIND%"=="0" goto noupdate
echo A new version is available: %BEHIND% new commit(s).
choice /c YN /t 20 /d N /m "Update now? Y = update, N = run this version (N after 20 seconds)"
if errorlevel 2 goto noupdate
rem Local edits to tracked files are never overwritten - the update is skipped instead.
for /f %%s in ('git status --porcelain -uno') do (echo [WARN] Files in this folder were edited - update skipped so the edits are not lost. Run: git status & goto noupdate)
git pull -q --ff-only || (echo [WARN] Update failed - running the current version. & goto noupdate)
rem New or changed packages: reinstall below.
git diff --quiet HEAD@{1} HEAD -- package.json package-lock.json || set "NEED_CI=1"
echo Updated to the latest version.
:noupdate

rem electron's installer writes path.txt last - without it the first install was cut off.
if not defined NEED_CI if exist "node_modules\electron\path.txt" if exist "node_modules\electron\dist\electron.exe" goto run
echo First run: installing packages with npm ci. This can take a few minutes...
call npm -v >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install the LTS build from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
rem electron is a devDependency - NODE_ENV=production or omit=dev would skip it.
set "NODE_ENV="
rem loglevel=error: the "npm warn deprecated" lines (glob, tar, inflight, boolean, lodash.isequal) come from inside
rem electron / electron-builder / electron-updater and are harmless - they made users think the install failed.
call npm ci --include=dev --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo [ERROR] npm ci failed - read the npm error above. Usual causes: no internet or a proxy, or an old Node.js - install the current LTS.
  pause
  exit /b 1
)
rem Some PCs end npm ci without the electron package at all (an npm config such as omit=dev or production=true).
rem Install exactly the locked version by itself.
rem (Outside a ( ) block: %EV% inside a block would expand before the for sets it.)
if exist "node_modules\electron\package.json" goto haveelectron
echo The electron package was not installed - installing it directly...
set "EV="
for /f %%v in ('node -p "require('./package-lock.json').packages['node_modules/electron'].version"') do set "EV=%%v"
if not defined EV set "EV=30.5.1"
call npm install --no-save --include=dev --no-audit --no-fund --loglevel=error electron@%EV%
:haveelectron
rem package.json allowScripts lets npm 12 run electron's postinstall (downloads electron.exe). If it was still skipped
rem (ignore-scripts=true, an older lock), run it here - keyed on electron.exe, not path.txt.
if not exist "node_modules\electron\dist\electron.exe" if exist "node_modules\electron\install.js" (
  echo Downloading electron.exe ^(about 100MB^)...
  set "ELECTRON_SKIP_BINARY_DOWNLOAD="
  call node node_modules\electron\install.js
)
rem On Node.js v26 install.js unzips only locales\lt.pak and exits 0 - the zip itself is downloaded fine.
rem Unpack the cached zip with Windows' own tar (not Git's GNU tar on PATH - it cannot read zip).
rem path.txt gets no newline: electron's index.js joins it into the exe path untrimmed.
if exist "node_modules\electron\dist\electron.exe" goto haveexe
if not exist "%SystemRoot%\System32\tar.exe" goto haveexe
set "EZIP="
set "EZIPPATH="
for /f "delims=" %%z in ('node -p "'electron-v'+require('./node_modules/electron/package.json').version+'-win32-'+process.arch+'.zip'" 2^>nul') do set "EZIP=%%z"
if not defined EZIP goto haveexe
for /r "%LOCALAPPDATA%\electron\Cache" %%f in (%EZIP%) do if exist "%%f" set "EZIPPATH=%%f"
if not defined EZIPPATH goto haveexe
echo Unpacking electron.exe from the download cache...
"%SystemRoot%\System32\tar.exe" -xf "%EZIPPATH%" -C "node_modules\electron\dist"
if exist "node_modules\electron\dist\electron.exe" call node -e "require('fs').writeFileSync('node_modules/electron/path.txt','electron.exe')"
:haveexe
if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] electron.exe is still missing - read the error above. Usual causes: no internet, a proxy, or antivirus deleting the file.
  echo         Then delete the node_modules folder and run this file again.
  echo --- details for support ---
  call node -v
  call npm -v
  call npm config get omit
  call npm config get ignore-scripts
  if exist "node_modules\electron" (dir /b "node_modules\electron") else (echo node_modules\electron does not exist)
  pause
  exit /b 1
)

:run
echo Servers (admin/AI/coupang) run on the CLOUD - launching app only...
"node_modules\electron\dist\electron.exe" .
if errorlevel 1 pause
