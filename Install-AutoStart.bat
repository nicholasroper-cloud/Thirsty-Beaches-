@echo off
title Thirsty Beaches - turn on auto start
cd /d "%~dp0"
REM Makes the kiosk start by itself every time Windows signs in, by putting a shortcut to
REM Run-Kiosk.bat (in THIS folder) into this user's Startup folder. No admin needed.
REM To turn it off again: run Remove-AutoStart.bat, or delete "Thirsty Beaches Kiosk" from
REM   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
if not exist "%~dp0Run-Kiosk.bat" (
  echo.
  echo   Run-Kiosk.bat isn't in this folder. Put this file in the kiosk folder and run it there.
  pause & exit /b 1
)
if /i not "%~d0"=="C:" (
  echo.
  echo   This is running from %~d0, not the C: drive. If that's the USB stick, copy everything
  echo   into the kiosk folder on the PC first and run Install-AutoStart.bat from there.
  echo.
  choice /m "  Turn on auto start from %~dp0 anyway"
  if errorlevel 2 exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Thirsty Beaches Kiosk.lnk');" ^
  "$s.TargetPath='%~dp0Run-Kiosk.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='Starts the Thirsty Beaches kiosk'; $s.Save()"
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Thirsty Beaches Kiosk.lnk" (
  echo.
  echo   Done. The kiosk now starts by itself every time this PC turns on and signs in.
  echo   For it to come up with nobody touching the PC, Windows must sign in by itself
  echo   (no password at start up), or use the Appliance mode in kiosk-lockdown.
) else (
  echo.
  echo   That didn't work. Take a photo of this window and send it over.
)
echo.
pause
