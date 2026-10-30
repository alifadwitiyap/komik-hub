#!/usr/bin/env bash
# A/B bergantian (ABAB) antara dua binary server, supaya drift jaringan
# tidak bias ke satu sisi. Tiap run = server baru = cache kosong (dingin).
set -uo pipefail
PORT=8788
IDS="4301 4302 4303 4304 4305 4306 4307 4308"
ROUNDS="${1:-2}"

start_server() {
  local bin="$1" log="$2"
  pkill -f "target/debug/komiku-server" 2>/dev/null
  pkill -f "/tmp/srv_" 2>/dev/null
  sleep 2
  ( "$bin" >"$log" 2>&1 & ) 
  for _ in $(seq 1 50); do
    c=$(curl -sS -m 2 -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/health" 2>/dev/null || echo 000)
    [ "$c" = "200" ] && return 0
    sleep 0.4
  done
  echo "FATAL: server $bin tidak siap" >&2
  return 1
}

run_one() {
  local label="$1" bin="$2" out="$3"
  start_server "$bin" "/tmp/ab_${label}.log" || return 1
  : > "$out"
  for id in $IDS; do
    read -r code t < <(curl -sS -m 60 -H "X-Komik-User: ab_${label}_$id" \
      -o "/tmp/ab_${label}_$id.json" -w '%{http_code} %{time_total}' \
      "http://localhost:$PORT/api/unified/series/komiku:$id" 2>/dev/null || echo "000 0")
    ms=$(awk -v s="$t" 'BEGIN{printf "%d", s*1000}')
    ch=$(python3 -c "import json;d=json.load(open('/tmp/ab_${label}_$id.json'));print(len(d.get('chapters') or []))" 2>/dev/null || echo -1)
    if [ "$code" = "200" ] && [ "${ch:-0}" -gt 0 ]; then
      echo "$ms" >> "$out"
    else
      echo "INVALID id=$id code=$code ch=$ch" >&2
    fi
  done
}

rm -f /tmp/ab_base_*.txt /tmp/ab_opt_*.txt
for r in $(seq 1 "$ROUNDS"); do
  echo "--- ronde $r: baseline ---"
  run_one "base" /tmp/srv_base /tmp/ab_base_$r.txt
  echo "--- ronde $r: optimized ---"
  run_one "opt"  /tmp/srv_opt  /tmp/ab_opt_$r.txt
done

pkill -f "/tmp/srv_" 2>/dev/null

python3 - <<'PY'
import glob, statistics as st
def load(p):
    v=[]
    for f in glob.glob(p):
        v += [int(x) for x in open(f).read().split()]
    return v
b, o = load('/tmp/ab_base_*.txt'), load('/tmp/ab_opt_*.txt')
if not b or not o:
    print("FATAL: data kosong"); raise SystemExit(1)
print(f"baseline  n={len(b):2d}  median={st.median(b):.0f}ms  mean={st.mean(b):.0f}ms  min={min(b)}  max={max(b)}")
print(f"optimized n={len(o):2d}  median={st.median(o):.0f}ms  mean={st.mean(o):.0f}ms  min={min(o)}  max={max(o)}")
d = (st.median(o)-st.median(b))/st.median(b)*100
print(f"delta median = {d:+.1f}%")
PY
