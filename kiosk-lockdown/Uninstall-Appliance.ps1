<#  ============================================================================
    THIRSTY BEACHES — UNDO APPLIANCE MODE
    Reverts everything Setup-Appliance.ps1 changed. Run as administrator.
    (Does NOT delete the kiosk user by default — pass -RemoveUser to delete it.)
    ============================================================================ #>
[CmdletBinding()]
param(
  [string]$KioskUser = "ThirstyKiosk",
  [switch]$RemoveUser
)
$ErrorActionPreference = "Continue"
function OK($m){ Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "  [!] $m" -ForegroundColor Yellow }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) { Warn "Run as administrator."; pause; exit 1 }

Write-Host "Reverting Thirsty Beaches appliance mode..." -ForegroundColor White

# 1. clear Assigned Access (single-app lock) if present
try {
  Clear-AssignedAccess -ErrorAction SilentlyContinue
  OK "Cleared single-app kiosk lock (Assigned Access)."
} catch { Warn "If a kiosk is still set, remove it in Settings > Accounts > 'Set up a kiosk' > Remove." }

# 2. remove the server task
try { Unregister-ScheduledTask -TaskName "ThirstyBeachesServer" -Confirm:$false -ErrorAction Stop; OK "Removed server auto-start task." }
catch { Warn "Server task not found (already removed)." }

# 3. restore Windows settings
powercfg /change standby-timeout-ac 30 | Out-Null
powercfg /change monitor-timeout-ac 15 | Out-Null
Remove-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization" -Name "NoLockScreen" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer" -Name "NoDriveTypeAutoRun" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" -Name "NoAutoRebootWithLoggedOnUsers" -ErrorAction SilentlyContinue
OK "Restored sleep / lock screen / autorun / update defaults."

# 4. remove Edge kiosk policies
Remove-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge\VideoCaptureAllowedUrls" -Recurse -ErrorAction SilentlyContinue
foreach ($p in "HideFirstRunExperience","PasswordManagerEnabled","VideoCaptureAllowed") {
  Remove-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge" -Name $p -ErrorAction SilentlyContinue
}
OK "Removed Edge kiosk policies."

# 5. optionally delete the kiosk user
if ($RemoveUser) {
  try { Remove-LocalUser -Name $KioskUser -ErrorAction Stop; OK "Deleted kiosk account '$KioskUser'." }
  catch { Warn "Could not delete '$KioskUser' (may not exist)." }
} else {
  Write-Host "  (Kept the '$KioskUser' account. Re-run with -RemoveUser to delete it.)" -ForegroundColor Gray
}

Write-Host "Done. Reboot to return to a normal PC." -ForegroundColor White
pause
