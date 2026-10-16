# Deploy Komik Hub → Railway Free (tanpa kartu)

Runbook ini ditulis 2026-10-16. Semua artefak sudah terverifikasi lokal
(build hijau, healthz 200, basic auth aktif, API asli jalan, seed volume jalan).

## 0. Yang sudah disiapkan (jangan diubah tanpa alasan)

| File | Peran |
|---|---|
| `deploy/Dockerfile` | 4 stage: build SPA → build Rust → ambil binary Caddy → runtime Debian |
| `deploy/Caddyfile` | listener `$PORT`, basic auth, `/healthz` tanpa auth → `/api/health` |
| `deploy/entrypoint.sh` | seed `/data` sekali, start axum, Caddy di depan, watchdog |
| `deploy/seed/` | state.json + downloads/*.json (baseline notif & metadata, ~19 KB) |
| `railway.json` | builder DOCKERFILE + `dockerfilePath: deploy/Dockerfile` + healthcheck `/healthz` |
| `.github/workflows/build-image.yml` | FALLBACK: build di Actions → GHCR (kalau build Railway timeout 10 menit) |

Layout penting: image menyimpan frontend di `/app/komiku-web/dist` dan CWD
backend di `/app/komiku-server` — `main.rs` mencari `../komiku-web/dist`
relatif CWD, jadi jangan ubah `WORKDIR`.

## 1. Login (tanpa kartu)

```bash
railway login          # browser terbuka; login pakai GitHub alifadwitiyap
```

Kalau Railway meminta kartu saat signup → STOP, lapor; jalur itu menyimpang
dari riset (halaman resmi: "No credit card required"). Fallback: `hax.co.id`.

## 2. Inisialisasi project

```bash
cd D:/project            # root repo = build context (butuh komiku-server/, komik/, komiku-web/, deploy/)
railway init             # pilih "Empty Project", beri nama: komik-hub
```

Catatan: `D:/project` bukan git repo. Untuk deploy dari CLI (`railway up`)
tidak perlu git. Untuk GitHub auto-deploy, push dulu (lihat §6).

## 3. Volume persisten

Railway dashboard → service → **Variables → Volumes** (atau Settings → Volumes)
→ **New Volume** → mount path: `/data`.

Tanpa ini: state notif & PDF hilang tiap redeploy (container filesystem ephemeral).

## 4. Variables

Dashboard → service → Variables (RAW editor):

| Variable | Nilai | Catatan |
|---|---|---|
| `BASIC_AUTH_USER` | `alif` | ganti kalau mau |
| `BASIC_AUTH_HASH` | *(lihat cara di bawah)* | **wajib** — kosong = container gagal start (fail-closed by design) |
| `RUST_LOG` | `info` | opsional |
| `NOTIF_INTERVAL_SECS` | `1800` | opsional, default sudah ini |

Buat hash (password TIDAK pernah masuk repo):

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'PASSWORD_PILIHANMU'
```

Copy output `$2a$14$...` apa adanya ke `BASIC_AUTH_HASH`.
⚠️ Di shell PowerShell/CMD, tanda `$` aman; kalau set lewat bash pakai single
quote supaya tidak di-expand.

## 5. Deploy

```bash
railway up               # dari D:/project
```

Tunggu build. **Free plan: build timeout 10 menit.** Build lokal kita dengan
cache = 1m31s; dari nol di builder Railway diperkirakan 6–12 menit. Kalau
timeout → pakai jalur GHCR (§7).

Setelah live:
1. `railway domain` (atau dashboard → Settings → Networking → Generate Domain).
2. Buka `https://<domain>/healthz` → harus `{"ok":true,"service":"komiku-server"}` (tanpa auth).
3. Buka `https://<domain>/` → prompt login browser → masuk dengan `alif` + password.
4. Cek `https://<domain>/api/health` (setelah login) → `{"ok":true,...}`.

## 6. Verifikasi akhir (bukti, bukan klaim)

```bash
BASE=https://<domain>
curl -s -o /dev/null -w "healthz %{http_code}\n" $BASE/healthz                      # 200
curl -s -o /dev/null -w "root-noauth %{http_code}\n" $BASE/                          # 401
curl -s -u alif:PASSWORD $BASE/api/notif/list | head -c 200                          # JSON item
curl -s -u alif:PASSWORD "$BASE/api/unified/search?q=solo" | head -c 200             # ada "items"
curl -s -o /dev/null -w "img %{http_code} %{content_type}\n" -u alif:PASSWORD \
  "$BASE/img?u=https%3A%2F%2Fassets.shngm.id%2Fthumbnail%2Fcover%2Fbanner_1771052268526_kne4py.jpg"  # 200 image/jpeg
```

Terakhir: buka di browser HP → baca 1 chapter → cek gambar termuat (bukti SW
same-origin utuh). Notifikasi: buka panel notif → harus ada item lama (bukan
re-baseline) karena `/data` di-seed dari `deploy/seed/`.

## 7. Fallback: build timeout → GHCR

1. Push repo ke GitHub (private boleh): lihat §8.
2. Workflow `.github/workflows/build-image.yml` jalan otomatis → image di
   `ghcr.io/alifadwitiyap/komik-hub:latest`.
3. GitHub → Packages → package → Settings → **Change visibility: Public**
   (Railway free pull tanpa kredensial).
4. Railway → **New → Deploy from Docker Image** → `ghcr.io/alifadwitiyap/komik-hub:latest`
   → set volume `/data` + variables yang sama → Deploy.

## 8. (Opsional) Push ke GitHub

Repo ini belum ada di git. Buat repo baru **private** `komik-hub` di GitHub,
lalu:

```bash
cd D:/project
git init
git add .gitignore railway.json deploy/ komiku-server/ komik/ komiku-web/ .github/
git commit -m "deploy: single-image Railway Free (caddy + axum + spa, basic auth)"
git remote add origin https://github.com/alifadwitiyap/komik-hub.git
git push -u origin main
```

`.gitignore` root sudah mengecualikan target/, node_modules/, dist/, data/,
downloads/, logs, dan semua sibling project. **Jangan** `git add .` tanpa
memeriksa `git status` — `D:/project` berisi banyak project lain.

## 9. Batas yang diketahui (jujur)

- **Kredit $1/bulan**: pemakaian tipikal (RAM ~50–80 MB terpakai + egress
  kecil) ≈ $0.4–0.9/bln → cukup. Kalau habis → service **pause** sampai bulan
  depan (tanpa tagihan, karena tanpa kartu di file).
- **Region**: plan Free kemungkinan US → latensi ~200 ms dari Indonesia.
  Jujur: halaman tetap terbaca, tapi bukan pengalaman "lokal".
- **Build timeout 10 menit** (Free) — kalau kena, §7.
- **Egress free plan** kecil; kalau temanmu maraton nonton banyak chapter,
  pantau pemakaian di dashboard (ada metrik network).
- **Tidak ada backup** (keputusan kita): volume `/data` kecil dan PDF bisa
  di-generate ulang. Kalau nanti PDF menumpuk, aktifkan backup rclone.
- Railway pernah membatasi deploy free pada jam sibuk region — kalau `railway up`
  ditolak, coba lagi di luar jam itu.

## 10. Rollback / matikan

- `railway down` (hapus deployment) atau pause service di dashboard.
- Stack lokal 8780 tidak tersentuh — masih jalan seperti sebelumnya.
