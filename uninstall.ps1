# Lester uninstaller - Windows (PowerShell). NEVER deletes user data (db\,
# backups, keys, .env) without an explicit confirmation.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

Write-Host "-- Lester uninstaller (Windows) -----------------" -ForegroundColor Green

Remove-Item "$env:LOCALAPPDATA\Programs\lester" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\Desktop\Lester.lnk" -Force -ErrorAction SilentlyContinue
Write-Host ". Launcher and shortcut removed."

$reply = Read-Host "Delete all Lester data (database, backups, keys) in .\db? [y/N]"
if ($reply -match "^[Yy]$") {
  if (Test-Path "db") { Remove-Item "db" -Recurse -Force }
  Write-Host ". Data deleted."
} else {
  Write-Host ". Data kept in $PWD\db"
}

Write-Host "OK Uninstalled. The source tree remains at $PWD - delete it if you wish." -ForegroundColor Green
