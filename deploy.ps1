# Antigravity Safe Deploy - Sadece dist klasorunu degistirir
# Orijinal app.asar yedekten geri yuklenir, dist guncellenir, tekrar paketlenir
# Bu scripti YENI bir PowerShell terminalinden calistirin!

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Antigravity Safe Deploy Script" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan

# 1. Antigravity'yi kapat
Write-Host ""
Write-Host "[1/7] Antigravity kapatiliyor..." -ForegroundColor Yellow
Stop-Process -Name "Antigravity" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "language_server" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Write-Host "   OK" -ForegroundColor Green

# 2. Yollari tanimla
# P2-10: Use script's own directory instead of hardcoded developer path
$ProjectDir = $PSScriptRoot
$AsarPath = "$env:LOCALAPPDATA\Programs\antigravity\resources\app.asar"
$BackupAsar = "$AsarPath.backup"
$TempDir = Join-Path $env:TEMP "antigravity_safe_deploy"

# 3. Yedek kontrol - yoksa mevcut asar'i yedekle
$AsarUnpacked = "$AsarPath.unpacked"
$BackupAsarUnpacked = "$BackupAsar.unpacked"

if (Test-Path $BackupAsar) {
    Write-Host "[2/7] Yedek bulundu: $BackupAsar" -ForegroundColor Green
    if ((Test-Path $AsarUnpacked) -and -not (Test-Path $BackupAsarUnpacked)) {
        Write-Host "   Yedek unpacked klasoru olusturuluyor..." -ForegroundColor Yellow
        Copy-Item $AsarUnpacked $BackupAsarUnpacked -Recurse -Force
        Write-Host "   Yedek unpacked klasoru olusturuldu." -ForegroundColor Green
    }
} elseif (Test-Path $AsarPath) {
    Write-Host "[2/7] Yedek yok - mevcut asar yedekleniyor..." -ForegroundColor Yellow
    Copy-Item $AsarPath $BackupAsar -Force
    if (Test-Path $AsarUnpacked) {
        Copy-Item $AsarUnpacked $BackupAsarUnpacked -Recurse -Force
    }
    Write-Host "   Yedek olusturuldu." -ForegroundColor Green
} else {
    Write-Host "[2/7] HATA: app.asar bulunamadi: $AsarPath" -ForegroundColor Red
    exit 1
}

# 4. Gecici dizine yedek asar'i ac
Write-Host "[3/7] Yedek asar aciliyor..." -ForegroundColor Yellow
if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force }
$env:NODE_OPTIONS = "--max-old-space-size=4096"
npx -y @electron/asar extract $BackupAsar $TempDir

if ($LASTEXITCODE -ne 0) {
    Write-Host "   HATA: asar extract basarisiz!" -ForegroundColor Red
    exit 1
}
Write-Host "   OK - Gecici dizin: $TempDir" -ForegroundColor Green

# 5. Sadece dist klasorunu projeden kopyala ve gereksizleri sil
Write-Host "[4/7] dist klasoru guncelleniyor ve gereksiz dosyalar temizleniyor..." -ForegroundColor Yellow

# Temizleme
if (Test-Path (Join-Path $TempDir ".git")) { Remove-Item (Join-Path $TempDir ".git") -Recurse -Force }
if (Test-Path (Join-Path $TempDir "scratch")) { Remove-Item (Join-Path $TempDir "scratch") -Recurse -Force }

$srcDist = Join-Path $ProjectDir "dist"
$destDist = Join-Path $TempDir "dist"

if (Test-Path $destDist) { Remove-Item $destDist -Recurse -Force }
Copy-Item $srcDist $destDist -Recurse -Force
Write-Host "   OK - dist kopyalandi." -ForegroundColor Green

# repack.ps1 de kopyala (guncel versiyonu)
$srcRepack = Join-Path $ProjectDir "repack.ps1"
if (Test-Path $srcRepack) {
    Copy-Item $srcRepack (Join-Path $TempDir "repack.ps1") -Force
}

# 6. Tekrar paketle
Write-Host "[5/7] app.asar paketleniyor..." -ForegroundColor Yellow

# Mevcut unpacked klasorunu sil ki temiz olussun
if (Test-Path $AsarUnpacked) { Remove-Item $AsarUnpacked -Recurse -Force }

npx -y @electron/asar pack $TempDir $AsarPath --unpack-dir "node_modules"

if ($LASTEXITCODE -ne 0) {
    Write-Host "   HATA: Paketleme basarisiz! Yedek geri yukleniyor..." -ForegroundColor Red
    Copy-Item $BackupAsar $AsarPath -Force
    if (Test-Path $BackupAsarUnpacked) {
        if (Test-Path $AsarUnpacked) { Remove-Item $AsarUnpacked -Recurse -Force }
        Copy-Item $BackupAsarUnpacked $AsarUnpacked -Recurse -Force
    }
    Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "   OK" -ForegroundColor Green

# Temizlik
Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue

# 6.5 Binary patch: Language Server'a hardcoded Google URL'yi local proxy ile degistir
Write-Host "[6/7] Language Server binary patch uygulaniyor..." -ForegroundColor Yellow
$LsBinary = "$env:LOCALAPPDATA\Programs\antigravity\resources\bin\language_server.exe"
$OriginalUrl = "https://daily-cloudcode-pa.googleapis.com"
$PatchedUrl = "http://localhost:50999/v1internal/xxxxxxx"

if (Test-Path $LsBinary) {
    # Backup original binary if not already backed up
    $LsBackup = "$LsBinary.bak"
    if (-not (Test-Path $LsBackup)) {
        Copy-Item $LsBinary $LsBackup -Force
        Write-Host "   Binary yedeklendi: $LsBackup" -ForegroundColor Gray
    }

    # Find and replace the hardcoded URL
    $bytes = [System.IO.File]::ReadAllBytes($LsBinary)
    $searchBytes = [System.Text.Encoding]::ASCII.GetBytes($OriginalUrl)
    $replaceBytes = [System.Text.Encoding]::ASCII.GetBytes($PatchedUrl)

    # Find the offset
    $offset = -1
    for ($i = 0; $i -lt $bytes.Length - $searchBytes.Length; $i++) {
        $match = $true
        for ($j = 0; $j -lt $searchBytes.Length; $j++) {
            if ($bytes[$i + $j] -ne $searchBytes[$j]) { $match = $false; break }
        }
        if ($match) { $offset = $i; break }
    }

    if ($offset -ge 0) {
        [System.Array]::Copy($replaceBytes, 0, $bytes, $offset, $replaceBytes.Length)
        [System.IO.File]::WriteAllBytes($LsBinary, $bytes)
        Write-Host "   OK - Binary patch uygulandi (offset: $offset)" -ForegroundColor Green
    } else {
        # Check if already patched
        $alreadyPatched = [System.Text.Encoding]::ASCII.GetString($bytes) -match [regex]::Escape($PatchedUrl)
        if ($alreadyPatched) {
            Write-Host "   OK - Binary zaten patch'li" -ForegroundColor Green
        } else {
            Write-Host "   UYARI: Hardcoded URL bulunamadi! Binary patch atlandi." -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "   UYARI: language_server.exe bulunamadi, binary patch atlandi." -ForegroundColor Yellow
}

# 7. Antigravity'yi baslat
Write-Host "[7/7] Antigravity baslatiliyor..." -ForegroundColor Yellow
$ExePath = "$env:LOCALAPPDATA\Programs\antigravity\Antigravity.exe"
if (Test-Path $ExePath) {
    Start-Process -FilePath $ExePath
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  BASARILI! Antigravity yeniden basladi." -ForegroundColor Green
    Write-Host "  Degisiklikler:" -ForegroundColor Gray
    Write-Host "    - Model placeholder ID'leri (M400-M599) uyumlu hale getirildi" -ForegroundColor Gray
    Write-Host "    - deploy.ps1 PowerShell derleme hatasi giderildi" -ForegroundColor Gray
    Write-Host "============================================" -ForegroundColor Cyan
} else {
    Write-Host "  Uyari: Antigravity.exe bulunamadi. Manuel baslatin." -ForegroundColor Yellow
}
