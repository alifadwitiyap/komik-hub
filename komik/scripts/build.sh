#!/usr/bin/env bash
# Build/test workspace komik.
#
# Kenapa ada skrip ini: wrapper terminal Hermes menyuntik TMP/TEMP berbentuk
# POSIX (mis. "/d/project/komik/src/.hermes-tmp.XXXX") ke SETIAP child process,
# nilai acak per-exec. Program Win32 (link.exe) resolve jadi "C:\d\project\..."
# yang tidak pernah ada -> LNK1104 untuk semua build script. Bukan bug kode.
#
# Solusi: lepaskan TMP/TEMP/TMPDIR dari env yang diwarisi child pakai `env -u`,
# lalu set absolut C:\rusttmp. Jangan hapus skrip ini; pakai untuk build & test.
set -euo pipefail

cd "$(dirname "$0")/.." 2>/dev/null || cd "$(dirname "$0")"

mkdir -p /c/rusttmp

export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(pwd)/target}"

echo "[build] TMP/TEMP di-unset utk child; pakai C:\rusttmp"
env -u TMP -u TEMP -u TMPDIR -u tmp -u temp -u tmpdir \
    TMP='C:\rusttmp' TEMP='C:\rusttmp' \
    cargo "$@"
echo "[build] selesai"
