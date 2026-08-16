@echo off
rem ===================================================================
rem  PropCo Outreach Automation - one-click start for Windows.
rem
rem  Double-click this file. It installs what it needs the first time,
rem  then opens the app in your browser. Nothing to type.
rem ===================================================================

rem Re-entry used to open the browser a few seconds after the server starts.
if "%~1"=="--openbrowser" goto openbrowser

setlocal enabledelayedexpansion
title PropCo Outreach Automation
cd /d "%~dp0"

echo.
echo   ==========================================
echo    PropCo Outreach Automation
echo   ==========================================
echo.

rem ---------------------------------------------------------------- Node check
where node >nul 2>&1
if errorlevel 1 goto nonode

for /f "tokens=1 delims=." %%v in ('node -v') do set NODEVER=%%v
set NODEVER=!NODEVER:v=!
if !NODEVER! LSS 20 goto oldnode

echo   Node.js !NODEVER! found. Good.
echo.

rem ------------------------------------------------------ already running?
netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo   The app is already running.
  echo   Opening it in your browser...
  start "" http://localhost:5173
  echo.
  echo   Close the other PropCo window first if you want to restart it.
  echo.
  pause
  exit /b 0
)

rem ------------------------------------------------------------- settings file
if not exist ".env" (
  echo   First run: creating your settings file...
  copy ".env.example" ".env" >nul
  echo   Done. The app works as-is.
  echo   To switch on the optional Claude check later, put your key in the .env file.
  echo.
)

rem ------------------------------------------------------------- dependencies
if not exist "node_modules" (
  echo   First run: installing components. This takes a few minutes.
  echo   You only ever wait for this once.
  echo.
  call npm install
  if errorlevel 1 goto installfail
  echo.
)

if not exist "web\node_modules" (
  echo   Installing the screen components...
  echo.
  call npm --prefix web install
  if errorlevel 1 goto installfail
  echo.
)

if not exist "web\dist\index.html" (
  echo   Preparing the app screens...
  echo.
  call npm run web:build
  if errorlevel 1 goto buildfail
  echo.
)

rem ------------------------------------------------------------------- launch
echo   Starting. Your browser will open in a few seconds.
echo.
echo   ------------------------------------------------------------
echo    KEEP THIS BLACK WINDOW OPEN while you use the app.
echo    Closing it shuts the app down. That is how you stop it.
echo   ------------------------------------------------------------
echo.

start "" /min "%~f0" --openbrowser
call npm start

echo.
echo   The app has stopped.
pause
exit /b 0

rem ------------------------------------------------------------------ browser
:openbrowser
timeout /t 6 /nobreak >nul
start "" http://localhost:5173
exit /b 0

rem ------------------------------------------------------------------- errors
:nonode
echo   Node.js is not installed on this computer.
echo.
echo   It is free and takes about two minutes to install:
echo.
echo     1. Your browser will open nodejs.org
echo     2. Download the big green button marked LTS
echo     3. Run the installer, clicking Next until it finishes
echo     4. Double-click this file again
echo.
start "" https://nodejs.org/en/download
pause
exit /b 1

:oldnode
echo   Node.js is installed but too old. This app needs version 20 or newer.
echo   You have version !NODEVER!.
echo.
echo   Your browser will open nodejs.org. Download the LTS version,
echo   install it over the top of the old one, then run this file again.
echo.
start "" https://nodejs.org/en/download
pause
exit /b 1

:installfail
echo.
echo   Something went wrong while installing.
echo.
echo   The usual cause is no internet connection, or a company firewall
echo   blocking the download. Check your connection and try again.
echo.
echo   If it keeps failing, send whoever set this up a photo of this window.
echo.
pause
exit /b 1

:buildfail
echo.
echo   Something went wrong while preparing the app screens.
echo.
echo   Send whoever set this up a photo of this window.
echo.
pause
exit /b 1
