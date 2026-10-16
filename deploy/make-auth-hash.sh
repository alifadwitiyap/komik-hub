#!/bin/sh
# Buat hash password basic auth Caddy untuk Railway (BASIC_AUTH_HASH).
# Pemakaian:  sh deploy/make-auth-hash.sh 'password-pilihanmu'
# Tidak pernah menulis password ke disk/repo.
set -eu
if [ $# -ne 1 ]; then
    echo "usage: $0 'password'" >&2
    exit 2
fi
docker run --rm caddy:2-alpine caddy hash-password --plaintext "$1"
