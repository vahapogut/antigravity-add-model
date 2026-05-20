# Antigravity Model Support Patch Repack & Deploy Script

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "Stopping all running Antigravity processes..." -ForegroundColor Yellow
Write-Host "==============================================" -ForegroundColor Cyan

# Terminate running app and language server processes
Stop-Process -Name "Antigravity" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "language_server" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "Repacking app.asar package..." -ForegroundColor Yellow
Write-Host "==============================================" -ForegroundColor Cyan

# Define source and destination paths (portable — uses LOCALAPPDATA)
$SourceDir = $PSScriptRoot
$DestAsar = "$env:LOCALAPPDATA\Programs\antigravity\resources\app.asar"

if (-not (Test-Path $SourceDir)) {
    Write-Host "==============================================" -ForegroundColor Red
    Write-Host "Error: Source directory not found at $SourceDir" -ForegroundColor Red
    Write-Host "==============================================" -ForegroundColor Red
    exit 1
}

# Repack using @electron/asar
npx -y @electron/asar pack $SourceDir $DestAsar

if ($LASTEXITCODE -eq 0) {
    Write-Host "==============================================" -ForegroundColor Cyan
    Write-Host "Success! app.asar repacked successfully." -ForegroundColor Green
    Write-Host "Restarting Antigravity..." -ForegroundColor Yellow
    Write-Host "==============================================" -ForegroundColor Cyan

    $ExePath = "$env:LOCALAPPDATA\Programs\antigravity\Antigravity.exe"
    if (Test-Path $ExePath) {
        Start-Process -FilePath $ExePath
    } else {
        Write-Host "Warning: Antigravity.exe not found at $ExePath" -ForegroundColor Yellow
        Write-Host "Please restart Antigravity manually." -ForegroundColor Yellow
    }
} else {
    Write-Host "==============================================" -ForegroundColor Red
    Write-Host "Error: Repacking failed!" -ForegroundColor Red
    Write-Host "==============================================" -ForegroundColor Red
    exit 1
}
