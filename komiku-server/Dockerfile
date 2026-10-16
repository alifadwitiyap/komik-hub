# syntax=docker/dockerfile:1

# ============================================================================
# Komik Hub — Rust server image (multi-stage).
#
# Build context MUST be D:/project (parent dir): komiku-server path-depends on
# ../komik/core, so the context needs BOTH komiku-server/ and komik/.
#   docker build -f D:/project/komiku-server/Dockerfile -t komiku-server:latest D:/project
#
# Debian (not alpine): reqwest default-tls -> openssl-sys needs libssl-dev +
# pkg-config at build time; on Debian those are one apt line, on alpine it's
# build-base + perl + openssl-dev + pkgconfig (and vendored-feature wrangling).
# ============================================================================

# NOTE: must be >= 1.85 — a transitive dep in the lock (kage, via image 0.25.10)
# is edition2024. Matches the host toolchain (rustc 1.99.0) that generated
# Cargo.lock, so --locked resolution is guaranteed consistent.
ARG RUST_IMAGE=rust:1.99-bookworm

# ---------------------------------------------------------------- stage 1: build
FROM ${RUST_IMAGE} AS build

# libssl-dev + pkg-config: openssl-sys (reqwest default-tls) build deps.
# ca-certificates: needed for cargo to fetch crates over TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Whole tree is small after .dockerignore strips **/target/ (~2.1G) and the
# heavy sibling projects. Layout keeps ../komik/core valid for the path dep.
WORKDIR /build
COPY komiku-server/ ./komiku-server/
COPY komik/ ./komik/

# .cargo/config.toml in komiku-server only sets a linker for
# x86_64-pc-windows-msvc — ignored on this linux target.

WORKDIR /build/komiku-server
# Cargo.lock is committed -> --locked for reproducible builds.
RUN cargo build --release --locked

# ---------------------------------------------------------------- stage 2: runtime
FROM debian:bookworm-slim

# libssl3: runtime counterpart of libssl-dev (native-tls loads libssl at runtime).
# ca-certificates: TLS trust for upstream manga sources + crates.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /build/komiku-server/target/release/komiku-server /usr/local/bin/komiku-server

# /data = persistent state (bind-mount or named volume from host):
#   /data/downloads/  PDF unduhan + index.json/settings.json/evictions.json
#   /data/state.json  state notifikasi favorit
RUN mkdir -p /data/downloads && chmod 777 /data /data/downloads

ENV PORT=8788 \
    RUST_LOG=info \
    KOMIKU_DOWNLOADS_DIR=/data/downloads \
    KOMIKU_NOTIF_DIR=/data

VOLUME ["/data"]
EXPOSE 8788

WORKDIR /app
ENTRYPOINT ["komiku-server"]
