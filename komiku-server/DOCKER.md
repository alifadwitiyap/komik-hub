# Komiku-server — Docker runbook

Image Rust untuk backend Komik Hub (axum). Build context = **D:/project** (bukan
D:/project/komiku-server) karena path dependency `komik-core = { path = "../komik/core" }`.

## Build

```bash
docker build -f D:/project/komiku-server/Dockerfile -t komiku-server:latest D:/project
```

- Multi-stage: `rust:1.83-bookworm` (build, butuh `libssl-dev`+`pkg-config` untuk
  openssl-sys di belakang reqwest default-tls) → `debian:bookworm-slim` (runtime,
  `ca-certificates`+`libssl3`).
- `cargo build --release --locked` (Cargo.lock committed). Profile release sudah
  `lto=true, strip=true` — binary ramping.
- `.dockerignore` di D:/project memangkas context dari ~6 GB ke puluhan MB
  (`**/target/` = 5 GB, sibling projects, node_modules).

## Run

Port host **8788 dipakai server native (jangan tabrak)** — untuk test pakai 18788:

```bash
docker run -d --name komiku-server \
  -p 18788:8788 \
  -v D:/project/komiku-server/downloads:/data/downloads \
  -v D:/project/komiku-server/data:/data \
  komiku-server:latest
```

State persisten (bind-mount, bukan volume anonim):
- `/data/downloads` — PDF + index.json/settings.json/evictions.json
- `/data` — state.json (notifikasi favorit)

Env yang bisa di-override:

| Env | Default | Arti |
|---|---|---|
| `PORT` | 8788 | Port listen (binds 0.0.0.0) |
| `RUST_LOG` | info | Level log tracing |
| `KOMIKU_DOWNLOADS_DIR` | /data/downloads | Direktori unduhan PDF |
| `KOMIKU_NOTIF_DIR` | /data | Direktori state notifikasi |
| `NOTIF_INTERVAL_SECS` | 1800 | Interval background checker notif |

## Smoke test

```bash
curl http://127.0.0.1:18788/api/health   # {"ok":true,"service":"komiku-server"}
docker logs komiku-server                 # cek "komiku-server di http://localhost:8788"
```

Frontend (`komiku-web/dist`) TIDAK ada di image ini (dibuild terpisah oleh image
web). Server jalan API-only — cocok untuk dideploy di belakang web image/nginx.

## Catatan

- Bind-mount Windows (`-v D:/project/...`) butuh path native; container melihat-nya
  sebagai `/data/...`. Hak akses: direktori /data dibuat `chmod 777` di image supaya
  user root container (Docker Desktop default) bisa menulis ke mount host.
- Build ulang setelah ubah source: `docker build ... --no-cache` tidak perlu; layer
  COPY source akan invalidate otomatis.
