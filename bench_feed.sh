#!/usr/bin/env bash
# Ukur cold start latest/popular feed.
# Usage: bench_feed.sh <server_cmd> <port>
# Writes per-request times, computes median/mean/min/max, validates 200 + item count.
set -o pipefail
PORT="${2:-8799}"
OUT=/tmp/feed_bench.json

run_server() {
    "$@" > /tmp/feed_server.log 2>&1 &
    SRV_PID=$!
    # wait for health
    for i in $(seq 1 60); do
        if curl -s -o /dev/null "http://localhost:$PORT/api/health"; then return 0; fi
        sleep 0.5
    done
    echo "!!! server tidak naik" >&2
    return 1
}

measure() {
    local endpoint="$1"; shift
    local n=$1; shift
    local times=()
    local codes=()
    for i in $(seq 1 "$n"); do
        local s=$(date +%s.%N)
        local code=$(curl -s -o "$OUT" -w "%{http_code}" "http://localhost:$PORT/api/unified/$endpoint?page=1&page_size=20")
        local e=$(date +%s.%N)
        local dt=$(echo "$e - $s" | bc)
        times+=("$dt")
        codes+=("$code")
    done
    # stats
    python3 - "$n" "$endpoint" "${times[@]}" "${codes[@]}" <<'PY'
import sys, json
n, ep = int(sys.argv[1]), sys.argv[2]
t = [float(x) for x in sys.argv[3:3+n]]
c = sys.argv[3+n:]
t.sort()
median = t[n//2] if n%2 else (t[n//2-1]+t[n//2])/2
mean = sum(t)/n
non200 = sum(1 for x in c if x != "200")
items = 0
try:
    items = len(json.load(open("/tmp/feed_bench.json")).get("items", []))
except Exception:
    pass
print(f"{ep}: n={n} median={median:.3f}s mean={mean:.3f}s min={t[0]:.3f}s max={t[-1]:.3f}s non200={non200} items={items}")
PY
}

main() {
    local server_bin="$1"
    local port="$2"
    [ -x "$server_bin" ] || { echo "binary tidak ada: $server_bin"; exit 1; }
    # cold: no disk cache, fresh server
    rm -rf /tmp/feed_cache_test
    export KOMIKU_USERS_DIR=/tmp/feed_cache_test
    export PORT=$port
    run_server "$server_bin"
    echo "== COLD =="
    measure latest 3
    measure popular 3
    kill $SRV_PID 2>/dev/null; wait $SRV_PID 2>/dev/null
    # warm: same disk cache, start again
    run_server "$server_bin"
    echo "== WARM (disk cache) =="
    measure latest 3
    measure popular 3
    kill $SRV_PID 2>/dev/null; wait $SRV_PID 2>/dev/null
}
main "$@"
