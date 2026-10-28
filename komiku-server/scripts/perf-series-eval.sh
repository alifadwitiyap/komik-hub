#!/usr/bin/env bash
# Evaluator performa /api/unified/series/{handle} — re-runnable, dipakai CI/perf.
# Mengukur: single-shot latency (cold & warm) + koncurrency burst (pemicu 502).
# Baseline & budget di sini, bukan di chat.
#
# Pemakaian:
#   BASE_URL=http://127.0.0.1:8788 HANDLE=komiku:1160 ./perf-series-eval.sh
#   BASE_URL=https://komik.komikhub.tech HANDLE=komiku:1160 AUTH='-u alif:...' ./perf-series-eval.sh
set -u

BASE_URL="${BASE_URL:-http://127.0.0.1:8788}"
HANDLE="${HANDLE:-komiku:1160}"
AUTH="${AUTH:-}"
N="${N:-12}"          # jumlah request paralel untuk burst
COLD_BUDGET="${COLD_BUDGET:-6}"   # detik (single shot)
WARM_TOL="${WARM_TOL:-2}"         # warm budget = cold x (1+tol)
BURST_BUDGET="${BURST_BUDGET:-10}" # detik per request pada burst (batas 502)

url="${BASE_URL}/api/unified/series/${HANDLE}"
echo "== Perf series =="
echo "env: BASE_URL=${BASE_URL} HANDLE=${HANDLE} N=${N}"
echo "budget: cold<=${COLD_BUDGET}s warm<=$(awk -v c="$COLD_BUDGET" -v t="$WARM_TOL" 'BEGIN{printf "%.1f", c*(1+t)}')s burst<=${BURST_BUDGET}s/req"

# 1. Cold (belum panas) — sekali
echo "--- [1] cold (1 request) ---"
C0=$(curl -s -o /dev/null -w "%{time_total}" -m 60 $AUTH "$url")
echo "cold=${C0}s"

# 2. Warm — 5x
echo "--- [2] warm (5x) ---"
W=()
for i in 1 2 3 4 5; do
  T=$(curl -s -o /dev/null -w "%{time_total}" -m 60 $AUTH "$url")
  W+=("$T")
done
echo "warm=${W[*]} (s)"

# 3. Burst paralel — pemicu 502
echo "--- [3] burst ${N}x paralel ---"
RESULT_FILE=$(mktemp)
for i in $(seq 1 "$N"); do
  ( curl -s -o /dev/null -w "%{http_code}|%{time_total}" -m 60 $AUTH "$url" > "$RESULT_FILE.$i" ) &
done
wait
FAIL=0; MAXT=0
for i in $(seq 1 "$N"); do
  R=$(cat "$RESULT_FILE.$i"); rm -f "$RESULT_FILE.$i"
  CODE="${R%%|*}"; T="${R##*|}"
  if [ "$CODE" != "200" ]; then FAIL=$((FAIL+1)); fi
  MAXT=$(awk -v a="$MAXT" -v b="$T" 'BEGIN{print (a>b?a:b)}')
done
rm -f "$RESULT_FILE"
echo "burst: ${FAIL}/${N} non-200, max_latency=${MAXT}s (budget ${BURST_BUDGET}s/req)"

echo "== verdict =="
awk "BEGIN{ if ($C0 > $COLD_BUDGET) print \"COLD FAIL (${C0}s>${COLD_BUDGET}s)\"; else print \"cold OK\" }"
awk "BEGIN{ if ($FAIL > 0) print \"BURST FAIL (${FAIL}/${N} non-200)\"; else print \"burst OK\" }"
