# Myto Clean Reinstall Script
$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "=== Myto Clean Reinstall ===" -ForegroundColor Cyan
Write-Host "This will remove ALL Myto data (and any legacy Sylor install) and reinstall fresh."
Write-Host ""

# Step 1: Stop all Myto processes (and any legacy Sylor process)
Write-Host "[1/6] Stopping Myto processes..." -ForegroundColor Yellow
$appProcs = Get-Process -Name "Myto", "Sylor" -ErrorAction SilentlyContinue
if ($appProcs) {
    $appProcs | Stop-Process -Force
    Start-Sleep -Seconds 2
    Write-Host "  Stopped process(es)" -ForegroundColor Green
} else {
    Write-Host "  No Myto processes running" -ForegroundColor Green
}

# Step 2: Uninstall (elevated) - the new Myto and any legacy Sylor install
Write-Host ""
Write-Host "[2/6] Uninstalling Myto..." -ForegroundColor Yellow
$uninstallers = @(
    "C:\Program Files\Myto\Uninstall Myto.exe",
    "C:\Program Files\Sylor\Uninstall Sylor.exe"
)
$ranUninstaller = $false
foreach ($uninstallerPath in $uninstallers) {
    if (Test-Path $uninstallerPath) {
        $uninstallCmd = "& '$uninstallerPath' /allusers /S"
        Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -Command `"$uninstallCmd`"" -Wait
        Start-Sleep -Seconds 3
        Write-Host "  Uninstaller completed: $uninstallerPath" -ForegroundColor Green
        $ranUninstaller = $true
    }
}
if (-not $ranUninstaller) {
    Write-Host "  Uninstaller not found" -ForegroundColor Yellow
}

# Step 3: Delete all data locations - new Myto paths plus any legacy Sylor paths
Write-Host ""
Write-Host "[3/6] Deleting all Myto data (and any legacy Sylor data)..." -ForegroundColor Yellow

$locations = @(
    # New Myto install + data
    "$env:LOCALAPPDATA\Programs\Myto",
    "$env:APPDATA\Myto",
    "$env:LOCALAPPDATA\myto-updater",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Myto.lnk",
    "C:\Program Files\Myto",
    # Legacy Sylor install + data (kept so a machine upgrading from Sylor is fully cleaned)
    "$env:LOCALAPPDATA\Programs\Sylor",
    "$env:APPDATA\Sylor",
    "$env:LOCALAPPDATA\sylor-updater",
    "$env:APPDATA\sylor-ai-gateway",
    "$env:LOCALAPPDATA\sylor-ai-gateway-updater",
    "$env:LOCALAPPDATA\sylor-dist",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Sylor.lnk",
    "C:\Program Files\Sylor"
)

foreach ($loc in $locations) {
    if (Test-Path $loc) {
        Write-Host "  Deleting: $loc" -ForegroundColor Gray
        Remove-Item -Path $loc -Recurse -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        if (Test-Path $loc) {
            Remove-Item -Path $loc -Recurse -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
        if (-not (Test-Path $loc)) {
            Write-Host "    Deleted" -ForegroundColor Green
        } else {
            Write-Host "    Could not delete" -ForegroundColor Yellow
        }
    }
}

Write-Host "  Cleaning temp directories..." -ForegroundColor Gray
foreach ($tempFilter in @("myto-*", "sylor-*")) {
    Get-ChildItem -Path $env:TEMP -Filter $tempFilter -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Write-Host "  Temp directories cleaned" -ForegroundColor Green

# Step 4: Build new installer
Write-Host ""
Write-Host "[4/6] Building fresh installer..." -ForegroundColor Yellow
Set-Location "C:\Users\ARAFAT\OneDrive\Desktop\Sylor\app"
npm run dist:win
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Build completed" -ForegroundColor Green
} else {
    Write-Host "  Build failed!" -ForegroundColor Red
    exit 1
}

# Step 5: Install fresh
Write-Host ""
Write-Host "[5/6] Installing Myto..." -ForegroundColor Yellow
$installerPath = "C:\Users\ARAFAT\OneDrive\Desktop\Sylor\app\release\Myto-Setup.exe"
if (Test-Path $installerPath) {
    Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait
    Start-Sleep -Seconds 2
    Write-Host "  Installation completed" -ForegroundColor Green
} else {
    Write-Host "  Installer not found" -ForegroundColor Red
    exit 1
}

# Step 6: Verify installation
Write-Host ""
Write-Host "[6/6] Verifying installation..." -ForegroundColor Yellow
$installedPath = "$env:LOCALAPPDATA\Programs\Myto\Myto.exe"
$installedPathMachine = "C:\Program Files\Myto\Myto.exe"

if (Test-Path $installedPath) {
    Write-Host "  Myto installed at: $installedPath" -ForegroundColor Green
    Write-Host ""
    Write-Host "=== Clean Reinstall Complete! ===" -ForegroundColor Cyan
    Write-Host "You can now launch Myto from the Start Menu." -ForegroundColor Green
} elseif (Test-Path $installedPathMachine) {
    Write-Host "  Myto installed at: $installedPathMachine" -ForegroundColor Green
    Write-Host ""
    Write-Host "=== Clean Reinstall Complete! ===" -ForegroundColor Cyan
    Write-Host "You can now launch Myto from the Start Menu." -ForegroundColor Green
} else {
    Write-Host "  Installation path not found" -ForegroundColor Yellow
}
