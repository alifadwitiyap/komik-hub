#!/usr/bin/env bash
# Build komiku-server.
#
# Kenapa ada skrip ini: wrapper terminal Hermes menyuntik TMP/TEMP berbentuk
# RELATIF (mis. "C:\d\project\komiku-server\src\.hermes-tmp.8TIVU9"), yang
# di-resolve link.exe dari C:\ dan tidak pernah ada. Akibatnya semua build
# gagal LNK1104 — bukan karena kode.
#
# Solusinya: buat direktori TMP itu lebih dulu, baru jalankan cargo.
set -euo pipefail

cd "$(dirname "$0")/.." 2>/dev/null || cd "$(dirname "$0")"

# --- mirror TMP/TEMP yang disuntik wrapper ke path nyata ---
for v in TMP TEMP; do
  val="${!v:-}"
  [ -z "$val" ] && continue
  # C:\d\project\... -> /c/d/project/...
  msys=$(printf '%s' "$val" | sed -E 's#^([A-Za-z]):#/\L\1#; s#\\#/#g')
  if [ -n "$msys" ] && [ "$msys" != "/" ]; then
    mkdir -p "$msys" 2>/dev/null || true
  fi
done

export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(pwd)/target}"

echo "[build] TMP=${TMP:-<kosong>}  CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
cargo build "$@"
echo "[build] selesai"
