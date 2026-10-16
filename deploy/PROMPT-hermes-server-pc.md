# Prompt untuk Hermes di PC Server — Setup Komik Hub (Windows)

> **Cara pakai:** tempel seluruh isi file ini ke Hermes di PC server. Hermes akan mengeksekusi
> langkah-langkahnya, memverifikasi, dan melapor balik.

---

## Misi

Pasang dan jalankan **Komik Hub** (reader manga self-hosted untuk ~10 orang) di PC ini lewat
Docker, lalu sambungkan ke internet via **Cloudflare Named Tunnel** supaya bisa dibuka dari HP
di mana saja (`https://komik.<domain>`).

Kamu (Hermes) berjalan di **PC server milik Alif, Windows, x64**. Jalankan langkah demi langkah,
jangan skip verifikasi. Kalau ada yang butuh aksi manusia (browser), minta Alif melakukannya.

## Fakta penting (jangan menebak)

- **Image:** `ghcr.io/alifadwitiyap/komik-hub:latest` — satu image berisi Caddy (pintu depan +
  basic auth) → axum (API) → SPA. Arsitektur linux/amd64 (PC ini x64 — cocok).
- **Auth berlapis:**
  1. **Basic auth** (gerbang masuk, di Caddy): user `alif`, password `komik-m31LUI6u`.
  2. **Username Komik Hub** (per-orang, di dalam app): favorit/notif/progress terpisah per username.
- **Data persisten:** folder host `D:\komik-hub\data` → `/data` di container. Install fresh —
  boot pertama, image menyemai baseline sendiri (tidak ada burst notifikasi).
- **Env wajib:** `BASIC_AUTH_HASH=$2a$14$F9fNnGPvSzQpTYVT2RdmGOo5K4ejBAOv006FlWkvCx2o8JHZ7kEKa`
- ⚠️ **PERINGATAN SHELL (penting!):** hash di atas mengandung `$`. Di **PowerShell** pakai kutip
  **tunggal** (`'...$2a$14$...'`). Di **CMD** kutip ganda aman. Di **bash** kutip tunggal.
  Kalau shell meng-expand `$2a$14$...`, auth rusak dan container mati (fail-closed) — cek
  `docker logs komik-hub`.

---

## Langkah 1 — Docker Desktop

1. Cek: `docker version` (PowerShell/CMD). Kalau "cannot connect" → Docker Desktop belum jalan, buka dulu.
2. Kalau belum terinstal: `winget install --id Docker.DockerDesktop -e`
   (butuh WSL2 — installer memandu; restart kalau diminta). Setelah itu buka Docker Desktop dan
   tunggu sampai "Engine running".
3. **Settings → General → centang "Start Docker Desktop when you sign in"** (wajib — biar hidup
   otomatis setelah PC nyala).
4. Kalau folder data nanti di drive non-C (mis. D:), cek **Settings → Resources → File Sharing**
   memuat drive itu.

## Langkah 2 — Pull image

```powershell
docker pull ghcr.io/alifadwitiyap/komik-hub:latest
```

Kalau gagal `denied`/`unauthorized` → lihat bagian **Masalah umum** (package GHCR perlu dibuat
Public sekali — Alif yang klik di browser).

## Langkah 3 — Siapkan folder data

```powershell
mkdir D:\komik-hub\data
```

(Sesuaikan drive dengan yang paling lapang. Isi: state user + PDF unduhan 24 jam — kecil tapi tumbuh.)

## Langkah 4 — Jalankan container

**PowerShell** (satu baris; perhatikan kutip tunggal pada hash):

```powershell
docker run -d --name komik-hub --restart unless-stopped -p 8080:8080 -e 'SITE_ADDR=:8080' -e 'BASIC_AUTH_USER=alif' -e 'BASIC_AUTH_HASH=$2a$14$F9fNnGPvSzQpTYVT2RdmGOo5K4ejBAOv006FlWkvCx2o8JHZ7kEKa' -e 'RUST_LOG=info' -v 'D:\komik-hub\data:/data' ghcr.io/alifadwitiyap/komik-hub:latest
```

**CMD** (alternatif; kutip ganda aman di CMD):

```cmd
docker run -d --name komik-hub --restart unless-stopped -p 8080:8080 -e "SITE_ADDR=:8080" -e "BASIC_AUTH_USER=alif" -e "BASIC_AUTH_HASH=$2a$14$F9fNnGPvSzQpTYVT2RdmGOo5K4ejBAOv006FlWkvCx2o8JHZ7kEKa" -e "RUST_LOG=info" -v "D:\komik-hub\data:/data" ghcr.io/alifadwitiyap/komik-hub:latest
```

Catatan: `SITE_ADDR=:8080` = mode HTTP polos — HTTPS ditangani Cloudflare (langkah 6).
Basic auth tetap aktif dari Caddy. Container juga bisa diakses dari WiFi rumah:
`http://<IP-PC-ini>:8080`.

## Langkah 5 — Verifikasi lokal

```powershell
curl.exe -s -o NUL -w "%{http_code}" http://localhost:8080/healthz    # harus 200
curl.exe -s -o NUL -w "%{http_code}" http://localhost:8080/           # harus 401 (tanpa auth)
curl.exe -s -u alif:komik-m31LUI6u http://localhost:8080/api/health   # harus {"ok":true,...}
```

(Di PowerShell, `curl` adalah alias; pakai `curl.exe` eksplisit seperti di atas.)

Cek juga:
- `docker ps` → `komik-hub` status **Up**.
- `docker logs komik-hub` → ada `[entrypoint] seeded /data dari /seed` (boot pertama) dan log
  server/Caddy. Kalau container mati → baca log-nya (paling sering: hash ke-expand shell).

## Langkah 6 — Cloudflare Named Tunnel (akses dari luar rumah)

Tujuan: `https://komik.<domain>` → `http://localhost:8080` di PC ini, permanen + HTTPS.

**Prasyarat:** domain yang sudah aktif di Cloudflare (nameserver mengarah ke Cloudflare).
- Kalau **belum punya domain** → minta Alif beli dulu (mis. `.my.id` di registrar lokal) dan
  tambahkan ke Cloudflare (Add site → ikuti instruksi nameserver). Berhenti di sini sampai ada.
- Kalau **belum punya akun Cloudflare** → daftar gratis di cloudflare.com (tanpa kartu).

**Cara termudah (tunnel dikelola dashboard):**

1. Buka **one.dash.cloudflare.com** (Zero Trust — pilih nama team gratis kalau diminta).
2. **Networks → Tunnels → Create a tunnel → Cloudflared** → nama: `komik-hub` → Save.
3. Pilih environment **Windows** → copy perintah `cloudflared service install <TOKEN>` yang
   ditampilkan.
4. Kalau `cloudflared` belum ada: `winget install --id Cloudflare.cloudflared -e` dulu.
5. Jalankan perintah itu di **PowerShell sebagai Administrator** → cloudflared terpasang sebagai
   Windows service (auto-start).
6. Kembali ke dashboard → tunnel `komik-hub` → tab **Public Hostname → Add**:
   - Subdomain: `komik` · Domain: `<domain Alif>` · Path: kosong
   - Service: **HTTP** → URL: `localhost:8080`
   - Save.
7. Verifikasi: `curl.exe -s -o NUL -w "%{http_code}" https://komik.<domain>/healthz` → 200.
8. Buka `https://komik.<domain>` di browser HP → prompt basic auth (`alif` / `komik-m31LUI6u`) →
   app terbuka. Tes baca 1 chapter.

**Alternatif (tunnel dikelola lokal, kalau tidak mau dashboard):** `cloudflared tunnel login`
(browser, pilih domain) → `cloudflared tunnel create komik-hub` → `cloudflared tunnel route dns
komik-hub komik.<domain>` → buat `%USERPROFILE%\.cloudflared\config.yml` (tunnel: <ID>,
credentials-file: <ID>.json, ingress hostname `komik.<domain>` → `http://localhost:8080`, fallback
`http_status:404`) → `cloudflared service install`. Catatan Windows: service jalan sebagai SYSTEM
dan membaca config dari `C:\Windows\System32\config\systemprofile\.cloudflared\` — salin
`config.yml` + file `<ID>.json` ke sana.

## Langkah 7 — Autostart & operasional

- Docker Desktop auto-start: ON (langkah 1) · container `--restart unless-stopped` ·
  cloudflared: Windows service. → **Tes reboot:** restart PC, tunggu 1–2 menit, buka
  `https://komik.<domain>/healthz` → 200.

| Aksi | Perintah (PowerShell) |
|---|---|
| Lihat log | `docker logs --tail 100 -f komik-hub` |
| Restart | `docker restart komik-hub` |
| Update versi | `docker pull ghcr.io/alifadwitiyap/komik-hub:latest` lalu `docker rm -f komik-hub` lalu jalankan ulang perintah run (data di `D:\komik-hub\data` aman) |
| Rollback | pakai tag bertanggal, mis. `ghcr.io/alifadwitiyap/komik-hub:2026-10-16` |
| Backup | copy folder `D:\komik-hub\data` (state user + PDF) |
| Stop | `docker stop komik-hub` |

## Masalah umum

- **`docker pull` denied/unauthorized** → package GHCR belum Public. Alif: buka
  `https://github.com/users/alifadwitiyap/packages/container/komik-hub` → Package settings →
  Danger Zone → Change visibility → **Public**. (Isi image bukan rahasia: auth di-inject runtime.)
  Alternatif: `docker login ghcr.io -u alifadwitiyap` dengan token ber-scope `read:packages`.
- **Port 8080 dipakai** → `netstat -ano | findstr :8080`; ganti sisi kiri `-p 8090:8080`, dan
  Public Hostname di Cloudflare diubah ke `localhost:8090`.
- **Error permission saat tulis /data** → drive belum di-share ke Docker Desktop:
  **Settings → Resources → File Sharing** → tambah drive data (mis. D:).
- **Container langsung mati** → `docker logs komik-hub`. Pesan Caddy soal `BASIC_AUTH_HASH`
  = hash ke-expand shell → jalankan ulang dengan kutip yang benar.
- **Cloudflare 502** → origin mati: cek `docker ps` dan service cloudflared (`Get-Service cloudflared`).
- **Gambar tidak muncul** → normal butuh internet: gambar hotlink langsung dari CDN sumber
  (by design; tidak ada cache offline).

## Lapor balik

Setelah selesai, laporkan ke Alif: output `docker ps` (komik-hub Up), 3 hasil curl verifikasi
lokal, status tunnel (Healthy + public hostname), dan hasil tes buka dari HP.
