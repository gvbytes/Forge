<#
.SYNOPSIS
  Agent IDE Master Launcher for Windows (PowerShell)
  Spawns Agent Engine (:4100), Router (:4098), and Web IDE (:4444).
#>

param(
  [string]$Workspace = $PWD.Path
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== Agent IDE Windows Launcher ===" -ForegroundColor Cyan
Write-Host "Script directory: $ScriptDir"
Write-Host "Target workspace: $Workspace"

# Resolve Bun
$BunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $BunCmd) {
  $PossibleBun = "$env:USERPROFILE\.bun\bin\bun.exe"
  if (Test-Path $PossibleBun) {
    $Bun = $PossibleBun
  } else {
    Write-Host "ERROR: Bun is not found on PATH or $PossibleBun" -ForegroundColor Red
    Write-Host "Please install Bun: powershell -c `"irm bun.sh/install.ps1 | iex`"" -ForegroundColor Yellow
    exit 1
  }
} else {
  $Bun = $BunCmd.Source
}

Write-Host "Using Bun: $Bun" -ForegroundColor Green

# Install dependencies if node_modules missing
if (-not (Test-Path "$ScriptDir\node_modules") -or -not (Test-Path "$ScriptDir\web\node_modules") -or -not (Test-Path "$ScriptDir\engine\node_modules")) {
  Write-Host "=== Installing dependencies via bun install... ===" -ForegroundColor Yellow
  Push-Location $ScriptDir
  & $Bun install
  Pop-Location
}

if (Test-Path "C:\mingw64\bin") {
  $env:PATH = "C:\mingw64\bin;$env:PATH"
}

$env:DEFAULT_PROJECT_ROOT = $Workspace
$env:PROJECT_ROOT = $Workspace
$env:ENGINE_PORT = "4100"
$env:ROUTER_PORT = "4098"
$env:WEB_PORT = "4444"
$env:ENGINE_ROUTER_BASE = "http://127.0.0.1:4098/v1"
$env:ENGINE_URL = "http://127.0.0.1:4100"

Write-Host "Starting Engine on port 4100..." -ForegroundColor Cyan
$engineProcess = Start-Process -FilePath $Bun -ArgumentList "run src/index.ts" -WorkingDirectory "$ScriptDir\engine" -PassThru

Start-Sleep -Seconds 2

Write-Host "Starting Router on port 4098..." -ForegroundColor Cyan
$routerProcess = Start-Process -FilePath $Bun -ArgumentList "run src/index.ts" -WorkingDirectory "$ScriptDir\router" -PassThru

Start-Sleep -Seconds 1

Write-Host "Starting Web IDE on port 4444..." -ForegroundColor Cyan
$webProcess = Start-Process -FilePath $Bun -ArgumentList "run dev" -WorkingDirectory "$ScriptDir\web" -PassThru

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host " Agent IDE is running!" -ForegroundColor Green
Write-Host " Open your browser at: http://localhost:4444" -ForegroundColor Yellow
Write-Host " Press Ctrl+C in this window to stop all services." -ForegroundColor White
Write-Host "========================================================`n" -ForegroundColor Green

try {
  while ($true) {
    Start-Sleep -Seconds 1
    if ($engineProcess.HasExited -or $routerProcess.HasExited -or $webProcess.HasExited) {
      break
    }
  }
} finally {
  Write-Host "`nStopping Agent IDE services..." -ForegroundColor Yellow
  if ($engineProcess -and -not $engineProcess.HasExited) { Stop-Process -Id $engineProcess.Id -Force -ErrorAction SilentlyContinue }
  if ($routerProcess -and -not $routerProcess.HasExited) { Stop-Process -Id $routerProcess.Id -Force -ErrorAction SilentlyContinue }
  if ($webProcess -and -not $webProcess.HasExited) { Stop-Process -Id $webProcess.Id -Force -ErrorAction SilentlyContinue }
  Write-Host "All services stopped." -ForegroundColor Green
}
