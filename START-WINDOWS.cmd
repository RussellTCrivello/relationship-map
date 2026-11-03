@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Relationship Map
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Attempting to install Node.js LTS with winget...
  where winget >nul 2>nul
  if errorlevel 1 goto installhelp
  winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  where node >nul 2>nul
  if errorlevel 1 goto installhelp
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 20 or later is required. Update Node.js from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 goto installhelp
if not exist "node_modules\express\package.json" (
  echo Installing dependencies. An internet connection is needed for the first run...
  call npm ci --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
set "DB_ENGINE=file"
set "DATA_FILE=%LOCALAPPDATA%\RelationshipMap\data.json"
set "HOST=127.0.0.1"
set "PORT=3000"
set "OPEN_BROWSER=1"
echo.
echo The browser should open when the server starts. If it does not, open http://127.0.0.1:3000.
echo On first use, the initial administrator login appears in this window. Save it securely.
echo Keep this window open while using the program. Press Ctrl+C to stop it.
echo.
call npm start
if errorlevel 1 echo The program stopped with an error. Check the message above.
pause
exit /b 0
:installhelp
echo Install Node.js LTS from https://nodejs.org/ then run this file again.
pause
exit /b 1
