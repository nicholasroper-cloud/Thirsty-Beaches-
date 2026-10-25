@echo off
title Thirsty Beaches - turn off auto start
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Thirsty Beaches Kiosk.lnk" 2>nul
echo.
echo   Auto start is off. The kiosk won't start by itself any more (Run-Kiosk.bat still works).
echo.
pause
