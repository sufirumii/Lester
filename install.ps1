# Lester installer - Windows (PowerShell). Options:
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
if ($LASTEXITCODE -ne 0) { Write-Host "x bun install failed - see the error above." -ForegroundColor Red; exit 1 }

# 2b. Repository hygiene files (v1.0.4): the release ZIP ships no dotfiles
#     (GitHub's web uploader skips OS-hidden files), so recreate them here.
if (-not (Test-Path .gitignore)) {
  Set-Content .gitignore @'
# Lester .gitignore - env.example MUST be committed; runtime data, keys,
# logs and release artifacts must NOT be.

node_modules
/.next/
/out/
next-env.d.ts
*.tsbuildinfo
/coverage
/build

/db/
*.db
*.db-wal
*.db-shm
/dev-data/

.env
.env.*

*.pem
*.key
db/keys/

*.log
dev.log
server.log

*.zip
SHA256SUMS
SHA256SUMS.txt
lester-offline-bundle-*.tar.gz

.DS_Store
Thumbs.db

.vercel
.pnpm-debug.log*
'@
  Write-Host ". Created .gitignore"
}
if (-not (Test-Path .dockerignore)) {
  Set-Content .dockerignore @'
node_modules
.next
.git
staging
dist
db
*.db
*.db-wal
*.db-shm
.env
.env.*
*.log
*.zip
SHA256SUMS
.DS_Store
lester-offline-bundle-*.tar.gz
'@
  Write-Host ". Created .dockerignore"
}

# 3. Database schema - real migrations, never destructive
Write-Host ". Preparing the database (migrations; existing data is preserved)..."
bun run migrate
if ($LASTEXITCODE -ne 0) { Write-Host "x database migration failed - see the error above." -ForegroundColor Red; exit 1 }

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
Write-Host "  Your data (database, backups, keys) lives in: $PWD\db"

# Friendly, non-fatal hint: Lester needs a local engine to answer prompts.
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 2 | Out-Null
} catch {
  Write-Host ""
  Write-Host ". No Ollama detected on 127.0.0.1:11434. Lester needs a local engine to chat:"
  Write-Host "    install it from https://ollama.com/download , then run:  ollama pull llama3.2:1b"
  Write-Host "  (LM Studio, llama.cpp and vLLM also work - see docs\guide.md.)"
}
Write-Host ""
Write-Host "  Uninstall anytime: .\uninstall.ps1"
