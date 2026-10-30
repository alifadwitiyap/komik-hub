# update-prod.ps1 — update container prod komik-hub ke image GHCR terbaru.
#
# Jalankan di PC SERVER (Windows), dari root repo komik-hub:
#     powershell -ExecutionPolicy Bypass -File deploy\update-prod.ps1
#
# Kenapa skrip ini ada: `docker compose pull` di docker-compose.yml TIDAK
# mengambil image baru, karena file itu memakai `build:` + tag lokal
# (`komiku-server:latest`). File prod yang benar adalah docker-compose.prod.yml,
# yang memakai image GHCR. Tanpa file itu, host tetap menjalankan versi lama
# selamanya meski CI sudah hijau.
#
# Yang dilakukan:
#   1. Cek docker hidup.
#   2. Catat digest image yang sedang dipakai (untuk rollback).
#   3. Pull image :latest.
#   4. Bandingkan digest — kalau sama, berhenti tanpa restart (tidak ada
#      gunanya memutus koneksi user kalau tidak ada perubahan).
#   5. Recreate container, tunggu health, verifikasi versi SW yang disajikan.
#
# Rollback kalau ada apa-apa:
#     $env:IMAGE_TAG="<sha-lama>"; docker compose -f docker-compose.prod.yml up -d

$ErrorActionPreference = 'Stop'
$Compose = 'docker-compose.prod.yml'
$Image   = 'ghcr.io/alifadwitiyap/komik-hub:latest'
$Health  = 'http://localhost:8080/api/health'

function Fail($msg) {
    Write-Host ""
    Write-Host "GAGAL: $msg" -ForegroundColor Red
    exit 1
}

# --- 1. docker hidup? -------------------------------------------------------
Write-Host "== 1/5 cek docker ==" -ForegroundColor Cyan
docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "docker tidak jalan. Nyalakan Docker Desktop lalu ulangi." }

if (-not (Test-Path $Compose)) { Fail "$Compose tidak ada. Jalankan skrip ini dari root repo komik-hub." }

# --- 2. digest lama ---------------------------------------------------------
Write-Host "== 2/5 catat versi sekarang ==" -ForegroundColor Cyan
$oldDigest = (docker inspect --format '{{index .RepoDigests 0}}' $Image 2>$null)
if ($LASTEXITCODE -ne 0) { $oldDigest = '(belum ada image lokal)' }
Write-Host "   digest lama: $oldDigest"

# Versi SW yang sedang disajikan — penanda build mana yang aktif.
$oldShell = $null
try {
    $sw = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "$Health" -ErrorAction Stop)
} catch { }
try {
    $swText = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 'http://localhost:8080/sw.js' -ErrorAction Stop).Content
    if ($swText -match "SHELL\s*=\s*'([^']+)'") { $oldShell = $Matches[1] }
} catch { }
Write-Host "   cache shell sekarang: $(if ($oldShell) { $oldShell } else { '(tidak terbaca)' })"

# --- 3. pull ----------------------------------------------------------------
Write-Host "== 3/5 pull image ==" -ForegroundColor Cyan
docker compose -f $Compose pull
if ($LASTEXITCODE -ne 0) { Fail "pull gagal. Cek koneksi + login GHCR (docker login ghcr.io)." }

# --- 4. ada perubahan? ------------------------------------------------------
Write-Host "== 4/5 bandingkan digest ==" -ForegroundColor Cyan
$newDigest = (docker inspect --format '{{index .RepoDigests 0}}' $Image 2>$null)
Write-Host "   digest baru: $newDigest"
if ($oldDigest -eq $newDigest -and $oldDigest -ne '(belum ada image lokal)') {
    Write-Host ""
    Write-Host "Tidak ada perubahan — image sudah yang terbaru. Container TIDAK di-restart." -ForegroundColor Yellow
    Write-Host "Kalau kamu yakin ada versi baru, cek: gh run list --workflow=build-image.yml"
    exit 0
}

# --- 5. recreate + verifikasi ----------------------------------------------
Write-Host "== 5/5 recreate container ==" -ForegroundColor Cyan
docker compose -f $Compose up -d
if ($LASTEXITCODE -ne 0) { Fail "recreate gagal. Rollback: `$env:IMAGE_TAG='<sha-lama>'; docker compose -f $Compose up -d" }

Write-Host "   menunggu health..."
$ok = $false
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 $Health -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
}
if (-not $ok) {
    Write-Host ""
    Fail "container tidak sehat setelah 90 detik. Lihat: docker logs komik-hub-app-1 --tail 50"
}

Write-Host "   health OK" -ForegroundColor Green

# Verifikasi penanda build: SW harus naik versi.
$newShell = $null
try {
    $swText = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 'http://localhost:8080/sw.js' -ErrorAction Stop).Content
    if ($swText -match "SHELL\s*=\s*'([^']+)'") { $newShell = $Matches[1] }
} catch { }

Write-Host ""
Write-Host "== selesai ==" -ForegroundColor Green
Write-Host "   cache shell: $(if ($oldShell) { $oldShell } else { '?' }) -> $(if ($newShell) { $newShell } else { '?' })"
if ($oldShell -and $newShell -and $oldShell -eq $newShell) {
    Write-Host ""
    Write-Host "PERHATIAN: versi SW tidak berubah. Kemungkinan image yang di-pull masih lama," -ForegroundColor Yellow
    Write-Host "atau container memakai IMAGE_TAG yang di-pin. Cek: docker inspect komik-hub-app-1 --format '{{.Config.Image}}'"
}
Write-Host ""
Write-Host "Langkah terakhir (manual): user perlu reload penuh SEKALI di browser" -ForegroundColor Cyan
Write-Host "supaya service worker v3 mengambil alih. Setelah itu navigasi normal."
Write-Host ""
Write-Host "Kalau cloudflared mati: Get-Service cloudflared | Start-Service cloudflared"
