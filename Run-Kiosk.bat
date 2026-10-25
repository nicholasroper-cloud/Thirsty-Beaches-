@echo off
title Thirsty Beaches Kiosk
cd /d "%~dp0"

echo.
echo   ============================================
echo     THIRSTY BEACHES - starting the kiosk...
echo   ============================================
echo.

REM --- Start the bundled Node server (no install needed). Runs minimized. ---
start "Thirsty Beaches Server" /min "%~dp0node.exe" --env-file=kiosk-config.env clover-menu-server.js

REM --- Wait until the server is answering (up to ~20s) ---
echo   Warming up the menu server...
set /a tries=0
:waitloop
set /a tries+=1
powershell -NoProfile -Command "try{ Invoke-WebRequest -UseBasicParsing http://localhost:8137/health -TimeoutSec 2 > $null; exit 0 }catch{ exit 1 }"
if %errorlevel%==0 goto ready
if %tries% geq 20 goto ready
timeout /t 1 /nobreak >nul
goto waitloop

:ready
echo   Launching the kiosk display...

REM --- Open Microsoft Edge fullscreen kiosk mode. ---
REM   --use-fake-ui-for-media-stream auto-allows the camera (for "Match My Vibe")
REM   using the REAL camera, with no permission popup.
where msedge >nul 2>nul
if %errorlevel%==0 (
  start "" msedge --kiosk "http://localhost:8137/" --edge-kiosk-type=fullscreen --no-first-run --use-fake-ui-for-media-stream
) else (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --kiosk "http://localhost:8137/" --edge-kiosk-type=fullscreen --no-first-run --use-fake-ui-for-media-stream
)

REM Close this launcher window (the server keeps running, minimized).
exit
