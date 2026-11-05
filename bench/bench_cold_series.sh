#!/usr/bin/env bash
# Benchmark cold-series latency. GAGAL KERAS kalau ada respons non-200,
# karena median 0ms dari koneksi ditolak bukanlah "cepat".
set -uo pipefail
N="${1:-8}"
BASE="${2:-3000}"
URL="${3:-http://localhost:8788}"
USER_HDR="X-Komik-User: bench_$(date +%s)_$$"

# Precondition: server harus hidup. Tanpa ini, semua angka tidak bermakna.
pre=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$URL/api/health" 2>/dev/null || echo 000)
if [ "$pre" != "200" ]; then
  echo "FATAL: health check gagal (code=$pre) di $URL — server tidak siap. Benchmark dibatalkan." >&2
  exit 2
fi

times=()
bad=()
for i in $(seq 1 "$N"); do
  id=$((BASE + i))
  out=$(curl -sS -m 60 -H "$USER_HDR" \
        -o /tmp/bench_$id.json -w '%{http_code} %{time_total}' \
        "$URL/api/unified/series/komiku:$id" 2>/dev/null || echo "000 0")
  code=${out%% *}
  t=${out##* }
  ms=$(awk -v s="$t" 'BEGIN{printf "%d", s*1000}')
  if [ "$code" = "200" ]; then
    # pastikan payload benar-benar berisi chapter, bukan error JSON
    ch=$(python3 -c "import json,sys
try:
    d=json.load(open('/tmp/bench_$id.json'))
    print(len(d.get('chapters') or []))
except Exception:
    print(-1)" 2>/dev/null)
    if [ "${ch:-0}" -gt 0 ]; then
      times+=("$ms")
      printf '  id=%d code=%s %dms chapters=%s\n' "$id" "$code" "$ms" "$ch"
    else
      bad+=("$id:$code:no-chapters")
      printf '  id=%d code=%s chapters=%s INVALID\n' "$id" "$code" "$ch"
    fi
  else
    bad+=("$id:$code")
    printf '  id=%d code=%s INVALID\n' "$id" "$code"
  fi
done

if [ ${#times[@]} -eq 0 ]; then
  echo "FATAL: tidak ada satu pun respons valid (bad=${bad[*]:-none}). Tidak ada angka untuk dilaporkan." >&2
  exit 3
fi

printf '%s\n' "${times[@]}" | sort -n | awk -v n="${#times[@]}" -v bad="${#bad[@]}" '
{a[NR]=$1; s+=$1}
END{
  med = (n%2)? a[(n+1)/2] : (a[n/2]+a[n/2+1])/2
  p95 = a[int(n*0.95)==0?1:int(n*0.95)]
  printf "valid=%d invalid=%d  median=%dms  min=%dms  max=%dms  p95=%dms\n", n, bad, med, a[1], a[n], p95
  if (bad>0) printf "PERINGATAN: %d request tidak valid — angka di atas hanya dari yang valid\n", bad
}'
