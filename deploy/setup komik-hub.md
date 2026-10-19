# Setup Komik Hub — PC Server (Windows, Docker langsung)

> **Inti:** PC server cuma butuh **Docker** + **image Komik Hub** — nggak ada dependensi lain.
> Tanpa Cloudflare pun app langsung jalan (diakses dari WiFi rumah). Cloudflare (bagian 6)
> hanya untuk akses dari luar rumah dan bisa dikerjakan belakangan.
>
> File ini bisa dibaca manual, atau di-paste ke Hermes di PC server untuk dieksekusi.

## Fakta penting

- **Image:** `ghcr.io/alifadwitiyap/komik-hub:latest` (tag cadangan: `:2026-10-20`)
- **Digest:** `sha256:e05ea71c0480b7cf8d3eea7e5e9eb0179ec2f6b3aee5531e079e6bac481b82ab`
- **Arsitektur:** linux/amd64 (PC server x64 — cocok). Isi: Caddy (basic auth) → API Rust → web app.
- **Basic auth:** user `alif` / password `komik-m31LUI6u`
- **Env wajib:** `BASIC_AUTH_HASH=$2a$14$F9fNnGPvSzQpTYVT2RdmGOo5K4ejBAOv006FlWkvCx2o8JHZ7kEKa`
- ⚠️ **Kutip shell:** hash mengandung `$`. PowerShell → kutip **tunggal** (`'...$2a$14$...'`),
  CMD → kutip ganda aman, bash → kutip tunggal. Kalau salah, container mati (fail-closed) —
  cek `docker logs komik-hub`.
- **Data persisten:** folder host `D:\komik-hub\data` → `/data` di container
  (state user + PDF unduhan 24 jam).

## 1. Docker Desktop

1. Cek: `docker version`. Kalau "cannot connect" → buka Docker Desktop dulu, tunggu "Engine running".
2. Belum terinstal? `winget install --id Docker.DockerDesktop -e` (butuh WSL2; installer memandu).
3. **Settings → General → centang "Start Docker Desktop when you sign in"** (biar otomatis setelah nyala).
4. Kalau data di drive non-C: **Settings → Resources → File Sharing** → pastikan drive tercentang.

## 2. Ambil image (pilih salah satu)

### Cara A — Pull dari GHCR

Sekali saja: package perlu di-**Public**-kan (Alif klik:
`https://github.com/users/alifadwitiyap/packages/container/komik-hub` →
Package settings → Danger Zone → Change visibility → Public).

```powershell
docker pull ghcr.io/alifadwitiyap/komik-hub:latest
```

### Cara B — Dari file (tanpa registry / tanpa GitHub)

1. Copy file `D:\komik-hub-image-2026-10-20.tar` (±144 MB, dari PC Alif) ke PC ini.
2. Load:

```powershell
docker load -i C:\lokasi\komik-hub-image-2026-10-20.tar
```

Hasilnya sama: image `ghcr.io/alifadwitiyap/komik-hub:latest` siap dipakai → lanjut langkah 3.
(File tar boleh dihapus setelah load.)

## 3. Jalankan container

**PowerShell** (satu baris; perhatikan kutip tunggal pada hash):

```powershell
docker run -d --name komik-hub --restart unless-stopped -p 8080:8080 -e 'SITE_ADDR=:8080' -e 'BASIC_AUTH_USER=alif' -e 'BASIC_AUTH_HASH=$2a$14$F9fNnGPvSzQpTYVT2RdmGOo5K4ejBAOv006FlWkvCx2o8JHZ7kEKa' -e 'RUST_LOG=info' -v 'D:\komik-hub\data:/data' ghcr.io/alifadwitiyap/komik-hub:latest
```

**CMD** (alternatif; kutip ganda aman):

```cmd
docker run -d --name komik-hub --restart unless-stopped -p 8080:8080 -e "SITE_ADDR=:8080" -e "BASIC_AUTH_USER=alif" -e "BASIC_AUTH_HASH=$2a$14$F9fNnGPvSzQpTYVT2RdmGOo5K4ejBAOv006FlWkvCx2o8JHZ7kEKa" -e "RUST_LOG=info" -v "D:\komik-hub\data:/data" ghcr.io/alifadwitiyap/komik-hub:latest
```

Catatan: `SITE_ADDR=:8080` = HTTP polos (HTTPS nanti dari Cloudflare, kalau dipakai).
Basic auth tetap aktif dari Caddy.

## 4. Verifikasi

```powershell
curl.exe -s -o NUL -w "%{http_code}" http://localhost:8080/healthz    # harus 200
curl.exe -s -o NUL -w "%{http_code}" http://localhost:8080/           # harus 401 (tanpa auth)
curl.exe -s -u alif:komik-m31LUI6u http://localhost:8080/api/health   # harus {"ok":true,...}
```

- `docker ps` → `komik-hub` status **Up**
- `docker logs komik-hub` → ada `[entrypoint] seeded /data dari /seed` (boot pertama)

## 5. Pakai dari HP (WiFi rumah)

- Cari IP PC server: `ipconfig` (mis. `192.168.1.50`)
- Buka `http://192.168.1.50:8080` di HP → login basic auth (`alif` / `komik-m31LUI6u`) → app terbuka
- Tiap orang tinggal ketik username-nya di halaman **/akun** (favorit/notif/progress terpisah per orang)

## 6. (Opsional, fase 2) Akses dari luar rumah — Cloudflare Named Tunnel

Tujuan: `https://komik.<domain>` → `localhost:8080`, permanen + HTTPS.
Prasyarat: domain aktif di Cloudflare (nameserver mengarah ke CF). Belum punya domain?
Beli dulu (mis. `.my.id` di registrar lokal), lalu Add site di Cloudflare.

1. Buka `one.dash.cloudflare.com` (Zero Trust — pilih nama team gratis kalau diminta).
2. **Networks → Tunnels → Create a tunnel → Cloudflared** → nama `komik-hub` → Save.
3. Pilih environment **Windows** → copy perintah `cloudflared service install <TOKEN>`.
4. `winget install --id Cloudflare.cloudflared -e` (kalau belum ada), lalu jalankan perintah
   tadi di **PowerShell as Administrator** → service terpasang (auto-start).
5. Dashboard → tunnel `komik-hub` → **Public Hostname → Add**: subdomain `komik`,
   domain `<domain>`, Service **HTTP** → `localhost:8080` → Save.
6. Verifikasi: `curl.exe -s -o NUL -w "%{http_code}" https://komik.<domain>/healthz` → 200,
   lalu buka dari HP.

*(Alternatif tanpa dashboard — tunnel dikelola lokal: `cloudflared tunnel login` → `create` →
`route dns` → config.yml → `service install`. Detail lengkap ada di file
`PROMPT-hermes-server-pc.md`.)*

## 7. Operasional

| Aksi | Perintah |
|---|---|
| Log | `docker logs --tail 100 -f komik-hub` |
| Restart | `docker restart komik-hub` |
| Update versi | `docker pull ghcr.io/alifadwitiyap/komik-hub:latest` → `docker rm -f komik-hub` → jalankan ulang perintah run (data di `D:\komik-hub\data` aman) |
| Rollback | pakai tag `:2026-10-20` |
| Backup | copy folder `D:\komik-hub\data` |
| Stop | `docker stop komik-hub` |

## 8. Kalau ada masalah

- **pull denied/unauthorized** → package belum Public (lihat Cara A), atau pakai **Cara B** (file tar).
- **port 8080 dipakai** → `netstat -ano | findstr :8080`; ganti sisi kiri `-p 8090:8080`
  (+ tunnel → `localhost:8090`).
- **error permission saat tulis /data** → drive belum di-share: Settings → Resources → File Sharing.
- **container langsung mati** → `docker logs komik-hub` (paling sering: hash ke-expand shell —
  lihat peringatan kutip di atas).
- **Cloudflare 502** → origin mati: cek `docker ps` + `Get-Service cloudflared`.
- **gambar tidak muncul** → normal butuh internet (hotlink CDN langsung, tanpa cache offline).
