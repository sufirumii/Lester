# Lester installer — Windows (PowerShell). Options:
#   -Offline    skip downloading Bun (expects bun on PATH or packaging\vendor\bun.exe)
param([switch]$Offline)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "-- Lester installer (Windows) -------------------" -ForegroundColor Green

# 1. Bun runtime
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  if ($Offline) {
    if (Test-Path "packaging\vendor\bun.exe") {
      Copy-Item "packaging\vendor\bun.exe" "$env:LOCALAPPDATA\Programs\bun\bun.exe" -Force
      $env:PATH = "$env:LOCALAPPDATA\Programs\bun;$env:PATH"
    } else {
      Write-Host "x -Offline set but bun not found on PATH nor in packaging\vendor." -ForegroundColor Red
      exit 1
    }
  } else {
    Write-Host ". Installing Bun (the only download this installer makes)..."
    powershell -c "irm bun.sh/install.ps1 | iex"
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
  }
}
Write-Host ". Bun $(bun --version)"

# 2. Dependencies
Write-Host ". Installing dependencies..."
bun install --frozen-lockfile

# 3. Database schema — real migrations, never destructive
Write-Host ". Preparing the database (migrations; existing data is preserved)..."
bun run migrate

# 4. Launcher
$launcher = "$env:LOCALAPPDATA\Programs\lester\lester.cmd"
New-Item -ItemType Directory -Force -Path (Split-Path $launcher) | Out-Null
@"
@echo off
cd /d "$PWD"
bun run start:prod
"@ | Set-Content $launcher
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut("$env:USERPROFILE\Desktop\Lester.lnk")
$shortcut.TargetPath = $launcher
$shortcut.IconLocation = "$PWD\public\icons\icon-512.png"
$shortcut.Save()

Write-Host ""
Write-Host "OK Installed. Start with:" -ForegroundColor Green
Write-Host "    lester.cmd  (desktop shortcut)  or:  bun run start:prod"
Write-Host "  then open http://localhost:8090"
Write-Host "  Uninstall anytime: .\uninstall.ps1"
