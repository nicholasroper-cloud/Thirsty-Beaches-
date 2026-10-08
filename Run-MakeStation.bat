@echo off
title Thirsty Beaches Make Station
cd /d "%~dp0"

echo.
echo   ============================================
echo     THIRSTY BEACHES - starting the Make Station
echo   ============================================
echo.
echo   This is the drink-making screen for the Echo Show (or any tablet)
echo   on the trailer Wi-Fi. It reads orders from Clover and never changes them.
echo.

REM --- Start the make-station server (bundled Node, no install). Runs minimized. ---
start "Thirsty Beaches Make Station" /min "%~dp0node.exe" --env-file=kiosk-config.env make-station-server.js

REM --- Wait until it answers (up to ~20s) ---
set /a tries=0
:waitloop
set /a tries+=1
powershell -NoProfile -Command "try{ Invoke-WebRequest -UseBasicParsing http://localhost:8140/health -TimeoutSec 2 > $null; exit 0 }catch{ exit 1 }"
if %errorlevel%==0 goto ready
if %tries% geq 20 goto ready
timeout /t 1 /nobreak >nul
goto waitloop

:ready
echo.
echo   Make Station is running.
echo.
echo   On the Echo Show, open the Silk browser and go to ONE of these:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo       http://%%a:8140/
echo.
echo   (If the Show cannot connect, run Allow-MakeStation-Firewall.bat once as admin.)
echo.
echo   You can close this window. The server keeps running minimized.
pause
exit
