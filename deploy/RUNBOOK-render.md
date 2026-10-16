# Deploy Komik Hub → Render Free (tanpa kartu)

**Status:** paket siap & terverifikasi lokal. Yang tersisa: 3 langkah klik di browser (bagian 2).
Repo: https://github.com/alifadwitiyap/komik-hub (private)

## Fakta Render Free (terverifikasi 2026-10-16)

| Aspek | Nilai | Konsekuensi untuk Komik Hub |
|---|---|---|
| Kartu kredit | **Tidak perlu** | syarat utama terpenuhi |
| RAM/CPU | 512 MB / 0.1 CPU | server idle ~3 MB — cukup |
| Jam | 750 jam/instance/bln | 1 service 24/7 = ~744 jam — pas |
| Tidur | 15 mnt tanpa trafik, bangun ~1 mnt | **mitigasi: pinger 10-menitan** (bagian 3) |
| Disk | **ephemeral** — hilang saat sleep/redeploy | seed /data dipulihkan saat boot; favorit di-push dari localStorage; PDF bisa di-generate ulang |
| Bandwidth | 5 GB/bln (turun dari 100 GB, Apr 2026) | gambar komik lewat `/img` proxy — pantau pemakaian |
| Build | 500 menit/bln, timeout default longgar | build Rust+LTO ~6-12 mnt → aman |
| Region | **Singapore** (dipilih di render.yaml) | ~20-50 ms dari Indonesia |
| Notif job | mati saat service tidur | `useNotifications` poll 60 dtk saat app dibuka + `GET /list` memicu check — self-healing |

## 1. Yang sudah dilakukan (jangan diulang)

- `deploy/Dockerfile` + `deploy/Caddyfile` + `deploy/entrypoint.sh` — satu image same-origin (Caddy basic-auth → axum → SPA)
- `deploy/seed/` — state.json + downloads/*.json (baseline notif)
- `render.yaml` — Blueprint: dockerfilePath ./deploy/Dockerfile, context root, healthcheck /healthz, region singapore
- Repo private `komik-hub` sudah di-push (branch main)
- **Password basic auth (SIMPAN DI PASSWORD MANAGER):**
  - user: `alif`
  - password: `komik-m31LUI6u`
  - hash (untuk env `BASIC_AUTH_HASH`):
    `$2a$14$F9fNnGPvSzQpTYVT2RdmGOo5K4ejBAOv006FlWkvCx2o8JHZ7kEKa`

## 2. Langkahmu di browser (≈5 menit)

1. **Daftar Render**: https://dashboard.render.com/register → pilih **"Sign up with GitHub"** → authorize `alifadwitiyap`.
   - Jika diminta kartu → STOP, lapor (harusnya tidak; docs resmi: "No credit card is required").
2. **Apply Blueprint**: Dashboard → **New +** → **Blueprint** → pilih repo **komik-hub** → **Apply**.
   - Render membaca `render.yaml`, membuat service `komik-hub` (region singapore, plan free).
3. **Set BASIC_AUTH_HASH**: setelah service dibuat → service → **Environment** → Edit → tambah:
   - Key: `BASIC_AUTH_HASH`
   - Value: (hash di bagian 1 — copy persis termasuk `$2a$14$...`)
   - Save → Render redeploy otomatis.
4. Tunggu build selesai (6–12 menit pertama). Logs terlihat di tab **Logs**.

> Alternatif tanpa Blueprint: New + → Web Service → repo komik-hub → Runtime **Docker** → Dockerfile path `./deploy/Dockerfile` → region Singapore → plan Free → env yang sama.

## 3. Setelah live

URL-mu: `https://komik-hub-<suffix>.onrender.com` (lihat di dashboard, atau `onrender.com` di halaman service).

**Verifikasi (kirim hasilnya ke aku kalau ada yang merah):**

```bash
BASE=https://komik-hub-XXXX.onrender.com
curl -s -o /dev/null -w "healthz %{http_code}\n" $BASE/healthz                    # 200
curl -s -o /dev/null -w "root-noauth %{http_code}\n" $BASE/                        # 401
curl -s -u alif:komik-m31LUI6u $BASE/api/health                                    # {"ok":true,...}
curl -s -u alif:komik-m31LUI6u "$BASE/api/unified/search?q=solo" | head -c 120    # ada "items"
```

Lalu buka di browser HP: login → baca 1 chapter → gambar harus termuat.

**Pinger anti-tidur** (opsional tapi disarankan): https://cron-job.org (gratis, tanpa kartu) →
- URL: `https://komik-hub-XXXX.onrender.com/healthz`
- Jadwal: tiap **10 menit**, jam 06:00–24:00 WIB (hemat: service tetap tidur malam, bangun cepat karena seed ringan)
- /healthz sengaja tanpa auth supaya pinger tidak perlu kredensial.

## 4. Batas jujur Render Free (yang harus kamu tahu)

1. **Notif tidak real-time saat app tidak dibuka** — job mati saat tidur; bangun + poll saat ada yang membuka app. Dulu di laptop selalu hidup; ini kompromi.
2. **PDF unduhan hilang saat sleep/redeploy** — di-generate ulang saat diminta; index.json ikut ter-seed ulang.
3. **5 GB egress/bulan** — kalau temanmu maraton, `/img` proxy ikut lewat kuota ini. Kalau sering kena: kurangi kualitas proxy atau pindah ke HAX (nanti).
4. **Cold start ~1 menit** setelah tidur.
5. Build ulang penuh tiap push (tidak ada cache BuildKit antar-build di Free) — ~6–12 mnt per deploy.

## 5. Rollback

- Render: service → Settings → **Suspend** (atau Delete). Tidak ada tagihan apa pun tanpa kartu.
- Lokal 8780 tidak tersentuh — stack Docker di laptop masih jalan.

## 6. Jalur lain yang sudah dieliminasi (kenapa bukan mereka)

| Kandidat | Alasan gugur |
|---|---|
| Railway | akun trial expired, wajib pilih plan → terblokir |
| Cloudflare Workers | Rust axum tidak jalan di V8 isolates |
| Cloudflare Containers | butuh Workers Paid $5/bln (kartu) |
| Cloudflare Pages | frontend saja — memecah same-origin, SW offline rusak |
| alwaysdata Free | ToS melarang program 24/7 tanpa interaksi (fitur itu plan Small €5) |
| Modal Starter | billing wajib metode pembayaran |
| Back4app Free | container dihancurkan 60 mnt setelah deploy (laporan resmi Okt 2026) |
| Koyeb | tidur 1 jam + tanpa volume + hold $29 kartu |
| serv00 | FreeBSD — binary Linux tidak jalan, harus build ulang + registrasi sering penuh |
| HAX/Woiden | NAT IPv6 + renew manual 7-harian + laporan data hilang; cadangan berikutnya kalau Render tidak cukup |
