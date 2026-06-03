# Eka Automation - Windows Startup Script (PowerShell)
# Run this to start the application on Windows

$ErrorActionPreference = "Stop"

# Get current script directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Starting Eka Automation on Windows..." -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# Check if main.py exists
if (-not (Test-Path "main.py")) {
    Write-Error "❌ main.py not found! Run this script from the application root directory."
    exit 1
}

# Check if virtual environment exists
if (-not (Test-Path "venv")) {
    Write-Host "⚠️  Virtual environment (venv) not found." -ForegroundColor Yellow
    Write-Host "   Creating virtual environment..." -ForegroundColor Yellow
    Start-Process python -ArgumentList "-m venv venv" -Wait
}

# Activate venv and install/verify dependencies
Write-Host "🔄 Verifying dependencies in requirements.txt..." -ForegroundColor Yellow

# Filter out uvloop as it is not supported on Windows
$Reqs = Get-Content requirements.txt
$FilteredReqs = $Reqs | Where-Object { $_ -notmatch "uvloop" }
$TempReqs = [System.IO.Path]::GetTempFileName()
$FilteredReqs | Out-File $TempReqs -Encoding UTF8

# Install dependencies using venv pip
& .\venv\Scripts\pip.exe install -r $TempReqs
Remove-Item $TempReqs

# Run migrations
Write-Host "🔄 Running database migrations..." -ForegroundColor Yellow
& .\venv\Scripts\python.exe run_migrations.py

# Check if port 8000 is in use
$PortInUse = Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue
if ($PortInUse) {
    Write-Host "⚠️  Port 8000 is already in use by process PID: $($PortInUse[0].OwningProcess)" -ForegroundColor Yellow
    Write-Host "   Please free up port 8000 and try again."
    exit 1
}

# Start uvicorn server in a separate process window
Write-Host "🚀 Starting Uvicorn server on http://localhost:8000 ..." -ForegroundColor Green
Start-Process .\venv\Scripts\uvicorn.exe -ArgumentList "main:app --host 0.0.0.0 --port 8000" -WindowStyle Minimized

# Wait and test health endpoint
Write-Host "   Waiting for server to start..."
Start-Sleep -Seconds 3

$MaxRetries = 10
$RetryCount = 0
$Success = $false

while ($RetryCount -lt $MaxRetries) {
    try {
        $Response = Invoke-RestMethod -Uri "http://localhost:8000/health" -Method Get -TimeoutSec 2
        $Success = $true
        break
    } catch {
        $RetryCount++
        Start-Sleep -Seconds 1
    }
}

if ($Success) {
    Write-Host ""
    Write-Host "✅ Eka Automation started successfully on Windows!" -ForegroundColor Green
    Write-Host ""
    Write-Host "   Dashboard:  http://localhost:8000" -ForegroundColor Green
    Write-Host "   API Docs:   http://localhost:8000/docs" -ForegroundColor Green
    Write-Host "   Health:     http://localhost:8000/health" -ForegroundColor Green
    Write-Host ""
    Write-Host "   Note: Uvicorn is running in a minimized window."
    Write-Host "==========================================" -ForegroundColor Cyan
} else {
    Write-Error "❌ Server started, but health check failed after ${MaxRetries}s."
}
