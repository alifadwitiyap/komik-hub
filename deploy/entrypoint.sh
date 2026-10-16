#!/bin/sh
# Komik Hub entrypoint: seed /data sekali, start axum, jalankan Caddy di depan.
# Dijalankan sebagai PID 1 di container (Caddy exec'd).
set -eu

mkdir -p /data/downloads

# Boot pertama di volume fresh: pulihkan baseline notifikasi + metadata unduhan
# dari /seed supaya favorit tidak re-baseline (dan tidak ada burst notifikasi).
if [ ! -f /data/.seeded ]; then
    if [ -f /seed/state.json ]; then
        cp /seed/state.json /data/state.json || true
    fi
    if [ -d /seed/downloads ]; then
        cp -a /seed/downloads/. /data/downloads/ || true
    fi
    touch /data/.seeded
    echo "[entrypoint] seeded /data dari /seed"
fi

export RUST_LOG="${RUST_LOG:-info}"
export KOMIKU_DOWNLOADS_DIR="${KOMIKU_DOWNLOADS_DIR:-/data/downloads}"
export KOMIKU_NOTIF_DIR="${KOMIKU_NOTIF_DIR:-/data}"

# SITE_ADDR: alamat listen Caddy.
#   - belum di-set (Railway/Render) -> ":<PORT>" (edge platform yang pegang TLS)
#   - di-set hostname (VM Oracle)   -> Caddy auto-HTTPS + Let's Encrypt
if [ -z "${SITE_ADDR:-}" ]; then
    export SITE_ADDR=":${PORT:-8080}"
fi

# Caddy dirs: sertifikat disimpan di /data supaya persist lintas restart
# (VM Oracle: /data = bind-mount host yang persisten).
export XDG_DATA_HOME="${XDG_DATA_HOME:-/data/caddy/data}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/tmp/caddy/config}"

# Backend di port internal tetap; Caddy pemilik $PORT publik.
PORT=8788 /app/komiku-server/komiku-server &
AXUM_PID=$!

# Watchdog: kalau axum mati, hentikan container supaya Railway restart bersih.
(
    while kill -0 "$AXUM_PID" 2>/dev/null; do sleep 5; done
    echo "[entrypoint] axum berhenti; menghentikan container" >&2
    kill -TERM 1 2>/dev/null || true
) &

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
