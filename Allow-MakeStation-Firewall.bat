@echo off
title Allow Make Station through Windows Firewall
cd /d "%~dp0"
echo.
echo   This adds ONE inbound rule so devices on the same Wi-Fi can open the
echo   Make Station screen (TCP port 8140). Nothing else is opened.
echo   Right-click this file and choose "Run as administrator" if it fails.
echo.
netsh advfirewall firewall delete rule name="Thirsty Beaches Make Station" >nul 2>nul
netsh advfirewall firewall add rule name="Thirsty Beaches Make Station" dir=in action=allow protocol=TCP localport=8140 profile=private,domain
if %errorlevel%==0 (echo   Done. Port 8140 is allowed on private networks.) else (echo   FAILED. Run this file as administrator.)
echo.
pause
