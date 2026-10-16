#!/bin/sh
# vm-setup.sh — bootstrap VM Oracle A1 (Ubuntu 22.04/24.04 ARM) untuk Komik Hub.
# Jalankan DI VM, sebagai user dengan sudo:
#   scp deploy/vm-setup.sh ubuntu@<IP>:~
#   ssh ubuntu@<IP> 'SITE_HOST=1.2.3.4.sslip.io BASIC_AUTH_USER=alif BASIC_AUTH_HASH=<hash> sh vm-setup.sh'
#
# Env:
#   SITE_HOST        hostname publik (wajib). Tanpa domain: pakai "<IP>.sslip.io".
#   BASIC_AUTH_USER  default: alif
#   BASIC_AUTH_HASH  hash caddy (wajib; buat via deploy/make-auth-hash.sh)
#   IMAGE            default: ghcr.io/alifadwitiyap/komik-hub:latest
set -eu

: "${SITE_HOST:?SITE_HOST wajib di-set (mis. 1.2.3.4.sslip.io)}"
: "${BASIC_AUTH_HASH:?BASIC_AUTH_HASH wajib di-set}"
BASIC_AUTH_USER="${BASIC_AUTH_USER:-alif}"
IMAGE="${IMAGE:-ghcr.io/alifadwitiyap/komik-hub:latest}"

echo "==> [1/6] Paket dasar"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl ufw >/dev/null

echo "==> [2/6] Docker (get.docker.com — resmi)"
if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sudo sh >/dev/null
    sudo usermod -aG docker "$USER" || true
fi

echo "==> [3/6] Firewall (80/443 + SSH)"
sudo ufw allow OpenSSH >/dev/null 2>&1 || sudo ufw allow 22/tcp >/dev/null 2>&1 || true
sudo ufw allow 80/tcp >/dev/null 2>&1 || true
sudo ufw allow 443/tcp >/dev/null 2>&1 || true
sudo ufw --force enable >/dev/null 2>&1 || true

echo "==> [4/6] Data dir"
sudo mkdir -p /srv/komik-hub/data
sudo chown -R "$USER":"$USER" /srv/komik-hub

echo "==> [5/6] Keepalive anti-reclaim (Oracle menandai VM idle bila CPU/net/mem <15% selama 7 hari)"
# stress-ng 1 core di-nice (rendah prioritas), mem 20% dari total selama 6 menit
# tiap 30 menit. Terukur aman untuk A1 2 OCPU/12 GB dan tidak mengganggu app.
if ! command -v stress-ng >/dev/null 2>&1; then
    sudo apt-get install -y -qq stress-ng >/dev/null
fi
sudo tee /etc/systemd/system/komik-keepalive.service >/dev/null <<'EOF'
[Unit]
Description=Komik Hub keepalive (anti idle-reclaim Oracle)
After=network.target

[Service]
Type=oneshot
# CPU: 1 core nice 19 selama 6 menit; MEM: 20% (2.4 GB) selama 6 menit.
ExecStart=/usr/bin/stress-ng --cpu 1 --cpu-load 35 --vm 1 --vm-bytes 20% --vm-keep --timeout 360s
Nice=19
EOF
sudo tee /etc/systemd/system/komik-keepalive.timer >/dev/null <<'EOF'
[Unit]
Description=Jalankan keepalive tiap 30 menit

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now komik-keepalive.timer >/dev/null 2>&1

echo "==> [6/6] Jalankan Komik Hub"
sudo docker pull "$IMAGE"
sudo docker rm -f komik-hub >/dev/null 2>&1 || true
sudo docker run -d --name komik-hub \
    --restart unless-stopped \
    -p 80:80 -p 443:443 -p 443:443/udp \
    -e SITE_ADDR="$SITE_HOST" \
    -e BASIC_AUTH_USER="$BASIC_AUTH_USER" \
    -e BASIC_AUTH_HASH="$BASIC_AUTH_HASH" \
    -e RUST_LOG=info \
    -v /srv/komik-hub/data:/data \
    "$IMAGE"

echo
echo "==> Selesai. Tunggu ~15 detik, lalu:"
echo "    curl -s -o /dev/null -w '%{http_code}\\n' https://$SITE_HOST/healthz   # 200"
echo "    Buka https://$SITE_HOST  -> login basic auth"
echo
echo "Catatan: bila HTTPS gagal, cek 'sudo docker logs komik-hub' (Let's Encrypt"
echo "butuh port 80/443 terbuka di Security List Oracle DAN ufw)."
