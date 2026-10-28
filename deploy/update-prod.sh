#!/usr/bin/env bash
# update-prod.sh — tarik image terbaru dari GHCR lalu ganti container prod.
#
# Kenapa ada: build-image CI hanya build+push ke GHCR. TIDAK ada langkah deploy,
# jadi container di VPS tetap versi lama sampai seseorang menjalankan pull.
#
# Pakai:
#   sudo BASIC_AUTH_HASH='<hash>' SITE_ADDR='komik.komikhub.tech' ./deploy/update-prod.sh
#   sudo IMAGE_TAG=<sha> ./deploy/update-prod.sh          # pin / rollback
#
# Variabel WAJIB (Caddyfile fail-closed: kosong -> container exit):
#   BASIC_AUTH_HASH  hash caddy, buat via deploy/make-auth-hash.sh
#   SITE_ADDR        hostname publik (mis. komik.komikhub.tech) atau ":8080"
#   BASIC_AUTH_USER  default: alif
#
# Kalau variabel wajib tidak ada, skrip BERHENTI SEBELUM menyentuh container
# yang sedang jalan — lebih baik tidak update daripada mematikan prod.
set -euo pipefail

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/alifadwitiyap/komik-hub}"
TAG="${IMAGE_TAG:-latest}"
IMAGE="${IMAGE_REPO}:${TAG}"
NAME="${CONTAINER_NAME:-komik-hub}"
DATA_DIR="${DATA_DIR:-/opt/komik-hub}"

say() { printf '\n==> %s\n' "$*"; }

# --- Validasi SEBELUM menyentuh apa pun -------------------------------------
missing=0
if [ -z "${BASIC_AUTH_HASH:-}" ]; then
    echo "GAGAL: BASIC_AUTH_HASH kosong. Caddy fail-closed -> container akan exit." >&2
    echo "       Buat hash: ./deploy/make-auth-hash.sh 'password'" >&2
    missing=1
fi
if [ -z "${SITE_ADDR:-}" ]; then
    echo "GAGAL: SITE_ADDR kosong (mis. komik.komikhub.tech)." >&2
    missing=1
fi
[ "$missing" -eq 0 ] || exit 2

BASIC_AUTH_USER="${BASIC_AUTH_USER:-alif}"

say "1/6 pull ${IMAGE}"
sudo docker pull "$IMAGE"

# Simpan image lama sebagai :previous untuk rollback cepat tanpa pull ulang.
if sudo docker container inspect "$NAME" >/dev/null 2>&1; then
    old_id=$(sudo docker inspect -f '{{.Image}}' "$NAME")
    sudo docker tag "$old_id" "${IMAGE_REPO}:previous" 2>/dev/null || true
    echo "image lama disimpan sebagai ${IMAGE_REPO}:previous"
fi

say "2/6 siapkan direktori data"
sudo mkdir -p "$DATA_DIR/downloads" "$DATA_DIR/imgcache" "$DATA_DIR/caddy"
sudo chown -R 1000:1000 "$DATA_DIR" 2>/dev/null || true

say "3/6 hentikan container lama"
sudo docker rm -f "$NAME" 2>/dev/null || true

say "4/6 jalankan versi baru"
# Port: PORT = port PUBLIK Caddy di dalam image; backend Rust selalu 8788
# internal (deploy/entrypoint.sh). SITE_ADDR menentukan mode TLS:
# hostname -> Caddy auto-HTTPS (butuh 80+443), ":8080" -> HTTP polos.
sudo docker run -d --name "$NAME" \
    --restart unless-stopped \
    --memory 512m \
    -p "${APP_BIND:-0.0.0.0}:80:80" \
    -p "${APP_BIND:-0.0.0.0}:443:443" \
    -e PORT=8080 \
    -e SITE_ADDR="$SITE_ADDR" \
    -e BASIC_AUTH_USER="$BASIC_AUTH_USER" \
    -e BASIC_AUTH_HASH="$BASIC_AUTH_HASH" \
    -e RUST_LOG=info \
    -e KOMIKU_DOWNLOADS_DIR=/data/downloads \
    -e KOMIKU_NOTIF_DIR=/data \
    -e KOMIKU_IMGCACHE_DIR=/data/imgcache \
    -v "$DATA_DIR/downloads:/data/downloads" \
    -v "$DATA_DIR:/data" \
    "$IMAGE"

say "5/6 tunggu health"
ok=0
for i in $(seq 1 45); do
    if curl -fsSk -m 3 "https://127.0.0.1/healthz" >/dev/null 2>&1 \
       || curl -fsS -m 3 "http://127.0.0.1/healthz" >/dev/null 2>&1; then
        ok=1
        echo "OK: health hidup setelah ${i}x coba"
        break
    fi
    if ! sudo docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
        echo "GAGAL: container tidak berjalan. Log:" >&2
        sudo docker logs --tail 60 "$NAME" >&2 || true
        exit 1
    fi
    sleep 2
done

if [ "$ok" -ne 1 ]; then
    echo "GAGAL: health tidak hidup dalam ~90s. Log:" >&2
    sudo docker logs --tail 60 "$NAME" >&2 || true
    echo "Rollback: sudo IMAGE_TAG=previous BASIC_AUTH_HASH=... SITE_ADDR=... $0" >&2
    exit 1
fi

say "6/6 verifikasi versi"
sudo docker inspect -f 'image: {{.Config.Image}}' "$NAME"
echo "Versi terpasang: ${IMAGE}"
