# syntax=docker/dockerfile:1
###############################################################################
# Komik Hub — single-image deploy untuk Railway Free (tanpa kartu).
#
# Isi image (layout DIJAGA supaya path dep ../komiku-web/dist tetap valid):
#   /app/komiku-server/komiku-server   ← binary Rust (axum)
#   /app/komiku-web/dist/              ← SPA hasil build
#   /etc/caddy/Caddyfile               ← basic auth + reverse proxy
#   /seed/                             ← data awal untuk volume /data
#
# Proses di container:
#   Caddy (publik, listen $PORT, basic auth) → axum (127.0.0.1:8788)
#
# Build context WAJIB root repo (D:/project) karena path dep komik-core.
#   docker build -f deploy/Dockerfile -t komik-hub:railway .
###############################################################################

# ---------- Stage 1: SPA build ------------------------------------------------
FROM node:22-alpine AS web

WORKDIR /build/komiku-web
# Deps dulu untuk layer caching: perubahan lockfile saja hanya re-run layer ini.
COPY komiku-web/package.json komiku-web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY komiku-web/ ./
RUN npm run build

# ---------- Stage 2: server build ----------------------------------------------
FROM rust:1.99-bookworm AS server

# libssl-dev + pkg-config: build deps openssl-sys (reqwest default-tls).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY komiku-server/ ./komiku-server/
COPY komik/ ./komik/

WORKDIR /build/komiku-server
# Cargo.lock committed -> --locked untuk build reprodusibel.
# (Instruksi dipertahankan terpisah agar cache BuildKit dari build server lama
# masih bisa dipakai; `cp` dipisah agar tidak mengubah cache-key RUN di atas.)
RUN cargo build --release --locked
RUN cp target/release/komiku-server /komiku-server

# ---------- Stage 3: caddy binary (dipisah agar kompatibel builder lama) --------
FROM caddy:2-alpine AS caddy-src

# ---------- Stage 4: runtime ----------------------------------------------------
FROM debian:bookworm-slim

# libssl3: counterpart runtime openssl-sys. ca-certificates: TLS ke upstream.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Binary Go statis dari image Caddy resmi — jalan apa adanya di Debian.
COPY --from=caddy-src /usr/bin/caddy /usr/local/bin/caddy

COPY --from=server /komiku-server /app/komiku-server/komiku-server
COPY --from=web /build/komiku-web/dist /app/komiku-web/dist
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/entrypoint.sh /app/deploy/entrypoint.sh
COPY deploy/seed/ /seed/
RUN chmod +x /app/deploy/entrypoint.sh

ENV RUST_LOG=info \
    KOMIKU_DOWNLOADS_DIR=/data/downloads \
    KOMIKU_NOTIF_DIR=/data

# CWD penting: main.rs mencari ../komiku-web/dist relatif CWD.
WORKDIR /app/komiku-server
EXPOSE 8080
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
