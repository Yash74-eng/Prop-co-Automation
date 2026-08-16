@echo off
rem ===================================================================
rem  PropCo Outreach Automation - one-click start for Windows.
rem
rem  Double-click this file. It installs what it needs the first time,
rem  then opens the app in your browser. Nothing to type.
rem
rem  NOTE ON THE FILE NAME: this must not begin with the word "start".
rem  cmd.exe reads a leading "start" as its own built-in command and
rem  opens a blank prompt instead of running the file.
rem ===================================================================

rem Re-entry: the second copy waits for the server, then opens the browser.
if "%~1"=="--openbrowser" goto openbrowser

setlocal enabledelayedexpansion
title PropCo Outreach Automation
cd /d "%~dp0"

set "APPURL=http://localhost:5173"

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
call :isup
if not errorlevel 1 (
  echo   The app is already running. Opening it in your browser...
  start "" "%APPURL%"
  echo.
  echo   If nothing opened, type this into your browser yourself:
  echo       %APPURL%
  echo.
  echo   To restart it, close the other PropCo window first.
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
echo   Starting up. Your browser opens by itself once it is ready.
echo.
echo   ------------------------------------------------------------
echo    KEEP THIS BLACK WINDOW OPEN while you use the app.
echo    Closing it shuts the app down. That is how you stop it.
echo.
echo    If your browser does not open, type this address yourself:
echo        %APPURL%
echo   ------------------------------------------------------------
echo.

start "" /min "%~f0" --openbrowser
call npm start

echo.
echo   The app has stopped.
pause
exit /b 0

rem ---------------------------------------------------------- readiness check
rem Returns 0 when the app answers, 1 when it does not.
rem The pipe must NOT be written as ^| here: inside double quotes cmd treats ^ as a
rem literal character, so PowerShell would receive "^|" and fail to parse, making a
rem running app look stopped.
:isup
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{$null=Invoke-WebRequest -Uri 'http://localhost:5173/api/health' -UseBasicParsing -TimeoutSec 3; exit 0}catch{exit 1}" >nul 2>&1
exit /b %errorlevel%

rem ------------------------------------------------------------------ browser
rem Waits for the server to actually answer before opening the browser. A fixed
rem delay guesses wrong on a slow machine and lands the user on a dead page.
:openbrowser
set TRIES=0
:waitloop
set /a TRIES+=1
call :isup
if not errorlevel 1 goto browserready
if %TRIES% GEQ 45 goto browsergiveup
timeout /t 2 /nobreak >nul
goto waitloop

:browserready
start "" "http://localhost:5173"
exit /b 0

:browsergiveup
rem 90 seconds with no response. Opening anyway would show an error page, so
rem leave the main window's instructions to speak for themselves.
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
