@echo off
title Thirsty Beaches - DEBUG
cd /d "%~dp0"
echo ============================================================
echo   DEBUG MODE - this runs the server in THIS window so you
echo   can read any error. Leave it open and visit the kiosk at
echo   http://localhost:8137 in a browser to test.
echo ============================================================
echo.
if not exist "%~dp0node.exe" echo  [X] node.exe is MISSING from this folder!
if not exist "%~dp0kiosk-config.env" echo  [X] kiosk-config.env is MISSING from this folder!
echo.
"%~dp0node.exe" --env-file=kiosk-config.env clover-menu-server.js
echo.
echo ============================================================
echo   The server stopped or failed. Read the message(s) above.
echo ============================================================
pause
