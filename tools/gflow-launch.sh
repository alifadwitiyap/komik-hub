#!/usr/bin/env bash
# gflow-launch.sh — restore Chrome debug port 9222 (junction profile) + buka Google Flow.
# Dipakai oleh CLI gflow (attach CDP). Jalankan setelah reboot/Chrome restart.
set -euo pipefail

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
JUNCTION="$HOME/.chrome-flow-debug-profile"
TARGET="$LOCALAPPDATA/Google/Chrome/User Data"
PORT=9222
FLOW="https://flow.google.com/"

# 1. Pastikan junction ada (Chrome tolak debug port di data dir default).
if [ ! -L "$JUNCTION" ]; then
  echo "[gflow-launch] buat junction $JUNCTION -> $TARGET"
  powershell -NoProfile -Command "New-Item -ItemType Junction -Path '$JUNCTION' -Target '$TARGET' | Out-Null"
fi

# 2. Launch Chrome via junction + debug port.
echo "[gflow-launch] launch Chrome --remote-debugging-port=$PORT (junction profile)"
"$CHROME" \
  --remote-debugging-port="$PORT" \
  --remote-allow-origins=* \
  --user-data-dir="C:/Users/LENOVO LEGION/.chrome-flow-debug-profile" \
  --no-first-run \
  --restore-last-session=false \
  "$FLOW" >/dev/null 2>&1 &

# 3. Tunggu port CDP up.
echo -n "[gflow-launch] menunggu CDP $PORT "
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "OK"
    echo "[gflow-launch] siap: http://127.0.0.1:$PORT (gflow status)"
    exit 0
  fi
  sleep 1
done
echo "GAGAL (timeout 30s)"
exit 1
