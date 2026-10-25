@echo off
title Stop Thirsty Beaches Kiosk
echo.
echo   Stopping the Thirsty Beaches kiosk...
REM Close the full-screen Edge kiosk and the local server.
REM (On a dedicated kiosk PC this safely closes all Edge + Node.)
taskkill /im msedge.exe /f >nul 2>nul
taskkill /im node.exe  /f >nul 2>nul
echo   Done. You can close this window.
timeout /t 2 /nobreak >nul
exit
