#!/usr/bin/env python3
"""Cold-boot startup benchmark for komiku-server.

Measures, per cold start (fresh users dir, no disk cache):
  - time from process spawn until /api/unified/health returns 200
  - first-request latency for latest / popular / series (after health 200)

Usage: python3 bench_startup.py <server_bin> [port]
"""
import json, os, shutil, subprocess, sys, time, urllib.request

BIN = sys.argv[1]
PORT = sys.argv[2] if len(sys.argv) > 2 else "8799"
BASE = f"http://localhost:{PORT}"
USERS = "/tmp/kh_cold"
SERIES_HANDLE = "shinigami:e1d19a82-31f2-47c3-8937-0de79bc1bec3"

def shutil_rm(p):
    shutil.rmtree(p, ignore_errors=True)

shutil_rm(USERS)
os.makedirs(USERS)

env = dict(os.environ)
env["KOMIKU_USERS_DIR"] = USERS
env["PORT"] = PORT
env["RUST_LOG"] = "komiku_server=info"

t0 = time.time()
srv = subprocess.Popen([BIN], env=env, stdout=open("/tmp/kh_srv.log", "w"), stderr=subprocess.STDOUT)

def http_get(path, label):
    t = time.time()
    code = None
    try:
        with urllib.request.urlopen(BASE + path, timeout=30) as r:
            code = r.status
            body = r.read()[:80]
    except Exception as e:
        body = str(e)[:80]
    return round(time.time() - t, 3), code, body

# 1. time-to-health-200
t_health = None
deadline = time.time() + 30
while time.time() < deadline:
    dt, code, body = http_get("/api/unified/health", "health")
    if code == 200:
        t_health = round(time.time() - t0, 3)
        break
    time.sleep(0.1)
if t_health is None:
    print("HEALTH_NEVER_200", file=sys.stderr)
    sys.exit(1)

# 2. first requests (in order, no delay between)
lat = {}
for lbl, path in [
    ("latest", "/api/unified/latest?page=1"),
    ("popular", "/api/unified/popular?page=1"),
    ("series", f"/api/unified/series/{SERIES_HANDLE}"),
]:
    dt, code, body = http_get(path, lbl)
    lat[lbl] = {"s": dt, "code": code, "body": body.decode(errors="ignore")[:60]}

srv.terminate()
try:
    srv.wait(timeout=10)
except subprocess.TimeoutExpired:
    srv.kill()

res = {"time_to_health_200_s": t_health, "first_requests": lat}
print(json.dumps(res, indent=1))
