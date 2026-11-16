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
powershell -NoProfile -Command "try{ Invoke-WebRequest -UseBasicParsing http://localhost:8140/health -TimeoutSec 2 > $null; exit 0 }catch{ exit 1 }"
if not %errorlevel%==0 (
  echo.
  echo   The Make Station did NOT start.
  echo   Most likely kiosk-config.env has MAKE_BIND=0.0.0.0 with no STATION_KEY (the station refuses that). It needs a key to share the tickets on the Wi-Fi: add a line  STATION_KEY=some-long-random-secret
  echo   to kiosk-config.env, run this again, then open the Show once with  http://ADDRESS:8140/?k=some-long-random-secret
  echo   Or set MAKE_BIND to this PC's own Wi-Fi address. See README-MAKE-STATION.txt.
  pause
  exit
)
set BINDADDR=
set KEYREQ=
for /f "delims=" %%b in ('powershell -NoProfile -Command "try{(Invoke-RestMethod http://localhost:8140/health -TimeoutSec 2).bind}catch{''}"') do set BINDADDR=%%b
for /f "delims=" %%k in ('powershell -NoProfile -Command "try{(Invoke-RestMethod http://localhost:8140/health -TimeoutSec 2).keyRequired}catch{''}"') do set KEYREQ=%%k
echo.
if "%BINDADDR%"=="127.0.0.1" (
  echo   WARNING: the Make Station is listening on THIS PC ONLY, so the Echo Show cannot reach it.
  echo   Fix: put  STATION_KEY=some-long-random-secret  in kiosk-config.env  (or MAKE_BIND=this-PC's-Wi-Fi-address),
  echo   then run this again. Do NOT set MAKE_BIND=0.0.0.0 without a STATION_KEY: the station refuses that.
  echo.
  echo   This PC:   http://localhost:8140/
) else (
  echo   Make Station is running.
  echo.
  echo   On the Echo Show, open the Silk browser and go to ONE of these:
  if "%KEYREQ%"=="True" (
    for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo       http://%%a:8140/?k=YOUR_STATION_KEY
    echo   and the pickup board at  http://ADDRESS:8140/board?k=YOUR_STATION_KEY   (YOUR_STATION_KEY = the STATION_KEY line in kiosk-config.env; open once, the page remembers it)
  ) else (
    for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo       http://%%a:8140/
  )
)
echo.
echo   (If the Show cannot connect, run Allow-MakeStation-Firewall.bat once as admin.)
echo.
echo   You can close this window. The server keeps running minimized.
pause
exit
