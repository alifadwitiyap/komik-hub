#!/usr/bin/env bash
# update-prod.sh — tarik image terbaru dari GHCR lalu ganti container prod.
#
# Kenapa ada: build-image CI hanya build+push ke GHCR. TIDAK ada langkah deploy,
# jadi container di VPS tetap versi lama sampai seseorang menjalankan pull.
# Skrip ini satu perintah untuk itu (idempoten, aman diulang).
#
# Pakai:
#   sudo ./deploy/update-prod.sh              # ikuti :latest
#   sudo IMAGE_TAG=<sha> ./deploy/update-prod.sh   # pin/rollback ke commit
#
# Yang TIDAK dilakukan: menyentuh /data (unduhan + state notif) — bind-mount
# tetap, jadi PDF lama masih kebaca setelah image diganti.
set -euo pipefail

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/alifadwitiyap/komik-hub}"
TAG="${IMAGE_TAG:-latest}"
IMAGE="${IMAGE_REPO}:${TAG}"
NAME="${CONTAINER_NAME:-komik-hub}"
DATA_DIR="${DATA_DIR:-/opt/komik-hub}"
APP_PORT="${APP_PORT:-8080}"

say() { printf '\n==> %s\n' "$*"; }

say "1/5 pull ${IMAGE}"
sudo docker pull "$IMAGE"

# Image lama disimpan sebagai :previous supaya rollback cepat tanpa pull ulang.
if sudo docker image inspect "${IMAGE_REPO}:previous" >/dev/null 2>&1; then
    sudo docker image rm "${IMAGE_REPO}:previous" >/dev/null 2>&1 || true
fi
if sudo docker container inspect "$NAME" >/dev/null 2>&1; then
    old_id=$(sudo docker inspect -f '{{.Image}}' "$NAME")
    sudo docker tag "$old_id" "${IMAGE_REPO}:previous" 2>/dev/null || true
fi

say "2/5 siapkan direktori data"
sudo mkdir -p "$DATA_DIR/downloads" "$DATA_DIR/imgcache"
# Container jalan sebagai non-root; pastikan bisa tulis.
sudo chown -R 1000:1000 "$DATA_DIR" 2>/dev/null || true

say "3/5 hentikan container lama"
sudo docker rm -f "$NAME" 2>/dev/null || true

say "4/5 jalankan versi baru"
sudo docker run -d --name "$NAME" \
    --restart unless-stopped \
    --memory 512m \
    -p "127.0.0.1:${APP_PORT}:8080" \
    -e PORT=8080 \
    -e RUST_LOG=info \
    -e KOMIKU_DOWNLOADS_DIR=/data/downloads \
    -e KOMIKU_NOTIF_DIR=/data \
    -e KOMIKU_IMGCACHE_DIR=/data/imgcache \
    -v "$DATA_DIR/downloads:/data/downloads" \
    -v "$DATA_DIR:/data" \
    "$IMAGE"

say "5/5 verifikasi"
for i in $(seq 1 30); do
    if curl -fsS -m 3 "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
        echo "OK: /api/health hidup setelah ${i}x coba"
        curl -sS -m 5 "http://127.0.0.1:${APP_PORT}/api/health"; echo
        echo "Versi terpasang: ${IMAGE}"
        exit 0
    fi
    sleep 2
done

echo "GAGAL: /api/health tidak hidup. Cek: sudo docker logs --tail 80 ${NAME}" >&2
echo "Rollback: sudo IMAGE_TAG=previous $0" >&2
exit 1
