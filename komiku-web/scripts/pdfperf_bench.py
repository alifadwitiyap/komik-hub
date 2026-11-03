#!/usr/bin/env python3
"""PDF/download perf bench for komik-hub. Measures:
- idle RSS
- peak RSS during download-pdf generation
- wall time
- resulting PDF size
Usage: pdfperf_bench.py <user> <handle> <numbers...> [--runs N]
"""
import json, os, subprocess, sys, time
import urllib.request

BASE = "http://localhost:8788"
HANDLE = sys.argv[2] if len(sys.argv) > 2 else "shinigami:e1d19a82-31f2-47c3-8937-0de79bc1bec3"
NUMBERS = sys.argv[3:]
RUNS = 1
if "--runs" in NUMBERS:
    i = NUMBERS.index("--runs")
    RUNS = int(NUMBERS[i+1]); NUMBERS = NUMBERS[:i]

def server_pid():
    rows = subprocess.run(
        ["ps", "-C", "komiku-server", "-o", "pid=,rss=,vsz=,nlwp="],
        capture_output=True, text=True).stdout.strip().splitlines()
    best = None
    for r in rows:
        p = r.split()
        if len(p) >= 4:
            rss = int(p[1])
            if best is None or rss > best[1]:
                best = (int(p[0]), rss, int(p[2]), int(p[3]))
    return best

def rss_kb(pid):
    try:
        for line in open(f"/proc/{pid}/status"):
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except Exception:
        return None
    return None

def download(username, handle, number):
    body = json.dumps({"handle": handle, "number": number}).encode()
    req = urllib.request.Request(
        f"{BASE}/api/unified/download-pdf",
        data=body,
        headers={"Content-Type": "application/json", "X-Komik-User": username},
        method="POST")
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=130) as r:
        d = json.loads(r.read())
    return time.time() - t0, d

info = server_pid()
if not info:
    print(json.dumps({"error": "server not running"})); sys.exit(1)
pid, idle_rss, vsz, threads = info
print(json.dumps({"idle_rss_kb": idle_rss, "pid": pid, "vsz_kb": vsz, "threads": threads}))

username = sys.argv[1]
out = {"handle": HANDLE, "idle_rss_kb": idle_rss, "runs": {}}
for num in NUMBERS:
    samples = []
    for _ in range(RUNS):
        # sample RSS while request in-flight
        stop = False
        peaks = []
        import threading
        def sampler():
            while not stop:
                peaks.append(rss_kb(pid))
                time.sleep(0.02)
        th = threading.Thread(target=sampler); th.start()
        try:
            dt, d = download(username, HANDLE, num)
        finally:
            stop = True; th.join()
        peak = max([r for r in peaks if r], default=0)
        samples.append({
            "number": num, "wall_s": round(dt, 3),
            "peak_rss_kb": peak, "size_bytes": d.get("size_bytes"),
            "id": d.get("id"), "delta_rss_kb": peak - idle_rss,
        })
    out["runs"][num] = samples
    for s in samples:
        print(json.dumps(s))
