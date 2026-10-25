@echo off
title Thirsty Beaches - Fix and Run
cd /d "%~dp0"

echo.
echo   =================================================
echo     THIRSTY BEACHES - starting the kiosk
echo   =================================================
echo.

REM --- 1) Remove the Windows "downloaded file" block ---
echo   Unblocking files...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0.' -Recurse -File | Unblock-File -ErrorAction SilentlyContinue"

REM --- 2) Sanity checks ---
if not exist "%~dp0node.exe" ( echo   [X] node.exe is MISSING - copy the WHOLE folder again. & pause & exit )
if not exist "%~dp0kiosk-config.env" ( echo   [X] kiosk-config.env is MISSING - copy the WHOLE folder again. & pause & exit )

REM --- 3) Kill any leftover server, then start ONE fresh one ---
echo   Clearing old server instances...
taskkill /im node.exe /f >nul 2>nul
timeout /t 1 /nobreak >nul
echo   Starting the menu server...
start "Thirsty Beaches Server" /min "%~dp0node.exe" --env-file=kiosk-config.env clover-menu-server.js

REM --- 4) Give it a few seconds to come up (no proxy-dependent health check) ---
echo   Warming up...
timeout /t 5 /nobreak >nul

REM --- 5) Open Edge fullscreen. --no-proxy-server makes localhost work even if
REM        the PC has a proxy set. --use-fake-ui-for-media-stream auto-allows the
REM        camera for "Match My Vibe" (real camera, nothing saved). ---
echo   Launching the kiosk display...
set EDGEFLAGS=--kiosk "http://localhost:8137/" --edge-kiosk-type=fullscreen --no-first-run --no-proxy-server --use-fake-ui-for-media-stream
where msedge >nul 2>nul
if %errorlevel%==0 (
  start "" msedge %EDGEFLAGS%
) else (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" %EDGEFLAGS%
)
exit
