<#  ============================================================================
    THIRSTY BEACHES — KIOSK APPLIANCE SETUP  (Windows 10/11 Pro)
    ----------------------------------------------------------------------------
    Turns this PC into a single-purpose kiosk:
      * a dedicated, locked-down kiosk user
      * the Node server running as an auto-start, auto-RESTARTING background task
      * Windows hardened: no sleep, no lock screen, no USB autorun, no surprise
        Windows Update reboots, camera pre-allowed for the kiosk
      * Edge first-run / clutter suppressed

    The final "single-app lock" (Assigned Access) is a 1-screen wizard in
    Settings — see READ-ME-APPLIANCE.txt. This script does everything around it.

    RUN ONCE:  right-click this file > "Run with PowerShell"  (as Administrator).
    Everything here is reversible with Uninstall-Appliance.ps1.
    ============================================================================ #>

[CmdletBinding()]
param(
  [string]$KioskUser = "ThirstyKiosk",
  [int]$Port = 8137
)

$ErrorActionPreference = "Stop"

function Say($m){ Write-Host "  $m" -ForegroundColor Cyan }
function OK($m){ Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "  [!] $m" -ForegroundColor Yellow }

# --- must be admin ---
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) { Warn "Right-click this file and choose 'Run as administrator', then re-run."; pause; exit 1 }

# --- locate the kiosk folder (this script lives in <drive>\kiosk-lockdown\) ---
$Root = Split-Path $PSScriptRoot -Parent
$NodeExe = Join-Path $Root "node.exe"
$Server  = Join-Path $Root "clover-menu-server.js"
$EnvFile = Join-Path $Root "kiosk-config.env"
if (-not (Test-Path $NodeExe)) { Warn "node.exe not found next to the kiosk app at $Root"; pause; exit 1 }
if (-not (Test-Path $Server))  { Warn "clover-menu-server.js not found at $Root"; pause; exit 1 }

Write-Host ""
Write-Host "THIRSTY BEACHES — building appliance mode" -ForegroundColor White
Write-Host "  kiosk folder : $Root"
Write-Host "  kiosk user   : $KioskUser"
Write-Host "  kiosk url    : http://localhost:$Port"
Write-Host ""

# ============================================================
# 1. Dedicated, password-less STANDARD kiosk account
#    (Assigned Access auto-logs this account in at boot.)
# ============================================================
Say "1/5  Creating the dedicated kiosk account..."
if (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue) {
  OK "Account '$KioskUser' already exists."
} else {
  New-LocalUser -Name $KioskUser -NoPassword -AccountNeverExpires `
    -UserMayNotChangePassword -FullName "Thirsty Beaches Kiosk" `
    -Description "Locked-down kiosk account" | Out-Null
  OK "Created standard account '$KioskUser' (no password, non-admin)."
}
# make sure it is a STANDARD user, never an admin
try { Remove-LocalGroupMember -Group "Administrators" -Member $KioskUser -ErrorAction SilentlyContinue } catch {}
try { Add-LocalGroupMember -Group "Users" -Member $KioskUser -ErrorAction SilentlyContinue } catch {}

# ============================================================
# 2. Server as an auto-start, auto-RESTART scheduled task (SYSTEM, at boot)
# ============================================================
Say "2/5  Installing the always-on server task..."
$TaskName = "ThirstyBeachesServer"
$argLine  = "--env-file=`"$EnvFile`" `"$Server`""
$action   = New-ScheduledTaskAction -Execute $NodeExe -Argument $argLine -WorkingDirectory $Root
$trigger  = New-ScheduledTaskTrigger -AtStartup
$principal= New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
              -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description "Thirsty Beaches kiosk server (auto-restart)" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
OK "Server task installed and started (restarts itself within 1 min if it ever dies)."

# ============================================================
# 3. Windows hardening — never sleep, no lock screen, no autorun
# ============================================================
Say "3/5  Hardening Windows for unattended use..."
# never sleep / never turn the screen off (plugged in)
powercfg /change standby-timeout-ac 0   | Out-Null
powercfg /change monitor-timeout-ac 0   | Out-Null
powercfg /change disk-timeout-ac 0      | Out-Null
powercfg /hibernate off                 2>$null | Out-Null
# disable lock screen + screensaver
$pers = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization"
New-Item -Path $pers -Force | Out-Null
Set-ItemProperty -Path $pers -Name "NoLockScreen" -Value 1 -Type DWord
# no USB autorun (no random program runs off a stick)
$exp = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer"
New-Item -Path $exp -Force | Out-Null
Set-ItemProperty -Path $exp -Name "NoDriveTypeAutoRun" -Value 255 -Type DWord
# don't auto-reboot for Windows Update while someone's using it
$wu = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU"
New-Item -Path $wu -Force | Out-Null
Set-ItemProperty -Path $wu -Name "NoAutoRebootWithLoggedOnUsers" -Value 1 -Type DWord
OK "Sleep, lock screen, USB autorun, and surprise reboots are off."

# ============================================================
# 4. Edge policies — clean first run + camera pre-allowed for the kiosk
# ============================================================
Say "4/5  Configuring Microsoft Edge for kiosk use..."
$edge = "HKLM:\SOFTWARE\Policies\Microsoft\Edge"
New-Item -Path $edge -Force | Out-Null
Set-ItemProperty -Path $edge -Name "HideFirstRunExperience" -Value 1 -Type DWord
Set-ItemProperty -Path $edge -Name "PasswordManagerEnabled"  -Value 0 -Type DWord
Set-ItemProperty -Path $edge -Name "VideoCaptureAllowed"     -Value 1 -Type DWord   # camera for Match My Vibe
# allow the camera specifically for the kiosk origin (no popup)
$camUrls = "HKLM:\SOFTWARE\Policies\Microsoft\Edge\VideoCaptureAllowedUrls"
New-Item -Path $camUrls -Force | Out-Null
Set-ItemProperty -Path $camUrls -Name "1" -Value "http://localhost:$Port" -Type String
OK "Edge first-run hidden; camera pre-allowed for http://localhost:$Port."

# ============================================================
# 5. Done — point to the one manual step (Assigned Access wizard)
# ============================================================
Say "5/5  Almost there."
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor White
Write-Host "  ONE STEP LEFT (1 screen) — the single-app LOCK:" -ForegroundColor White
Write-Host "    Settings > Accounts > Other users > 'Set up a kiosk'" -ForegroundColor White
Write-Host "    - Choose the existing account:  $KioskUser" -ForegroundColor White
Write-Host "    - Choose app:                   Microsoft Edge" -ForegroundColor White
Write-Host "    - 'As a digital sign or interactive display'" -ForegroundColor White
Write-Host "    - URL:                          http://localhost:$Port" -ForegroundColor White
Write-Host "    - Restart timer:                5 minutes (optional)" -ForegroundColor White
Write-Host "  ============================================================" -ForegroundColor White
Write-Host ""
OK "Appliance groundwork complete. Do the wizard above, then reboot to test."
Write-Host ""
Write-Host "  To get back in for maintenance: at the kiosk press Ctrl+Alt+Del >" -ForegroundColor Gray
Write-Host "  Sign out, then sign in with YOUR admin account." -ForegroundColor Gray
Write-Host "  To undo everything: run Uninstall-Appliance.ps1 as administrator." -ForegroundColor Gray
Write-Host ""
pause
