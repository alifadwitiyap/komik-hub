#!/usr/bin/env python3
"""Ultraperf evaluator for komik-hub reader (server + web).

Measures, in order:
  1. /img cold vs warm: 900 px page, 480 px reader width, 96 px LQIP.
     Cold = encoded cache entry deleted (raw upstream cache kept, so this is
     encode/decode cost, not network).
  2. Reader page load (cold then warm) via Playwright/Chromium:
     load, first image ready, LCP, CLS, long tasks, /img requests.
  3. Bundle bytes (raw + gzip) from dist/assets.
  4. Server RSS/VSZ + imgcache size.

Usage: python3 evaluator.py [url]
"""
import gzip, hashlib, json, os, shutil, subprocess, sys, tempfile, time
import urllib.parse, urllib.request

URL = sys.argv[1] if len(sys.argv) > 1 else (
    "http://localhost:8788/baca/shinigami:e1d19a82-31f2-47c3-8937-0de79bc1bec3/60"
)
IMG0 = ("https://assets.shngm.id/chapter/manga_e1d19a82-31f2-47c3-8937-0de79bc1bec3/"
        "chapter_0ba46d8c-4135-4dd8-b412-ba3248799102/01-86dacc.jpg")
IMG1 = ("https://assets.shngm.id/chapter/manga_e1d19a82-31f2-47c3-8937-0de79bc1bec3/"
        "chapter_0ba46d8c-4135-4dd8-b412-ba3248799102/02-585603.jpg")
BASE = "http://localhost:8788"
SERVER_DIR = "/home/tresna/work/komik-hub/komiku-server"
CACHE = os.path.join(SERVER_DIR, "data", "imgcache")
DIST = "/home/tresna/work/komik-hub/komiku-web/dist/assets"

res = {}


def cache_path(u, w, fmt):
    """Path persis yang dipakai server: sha1("<u>|<w>|<fmt>") + shard + ext."""
    key = hashlib.sha1(f"{u}|{w}|{fmt}".encode()).hexdigest()
    return os.path.join(CACHE, key[:2], f"{key}.{fmt}")


def clear(u, w, fmt):
    p = cache_path(u, w, fmt)
    if os.path.exists(p):
        os.unlink(p)


def fetch(u, w, accept=None, timeout=180):
    url = f"{BASE}/img?u={urllib.parse.quote(u, safe='')}&w={w}"
    headers = {"Accept": accept} if accept else {}
    t = time.time()
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as r:
        body = r.read()
        return round(time.time() - t, 3), len(body), r.headers.get("content-type"), r.headers.get("x-img-cache")


def bench(tag, u, w, accept=None):
    # clear both formats so the measurement is truly cold for whatever the
    # server negotiates (before fix: avif for w<=320; after: webp for w=96).
    for fmt in ("webp", "avif"):
        clear(u, w, fmt)
    cold = fetch(u, w, accept)
    warm = fetch(u, w, accept)
    res[f"{tag}_cold_s"] = cold[0]
    res[f"{tag}_warm_s"] = warm[0]
    res[f"{tag}_bytes"] = cold[1]
    res[f"{tag}_type"] = cold[2]
    res[f"{tag}_cache"] = cold[3]


AVIF_ACCEPT = "image/avif,image/webp,*/*"
bench("img0_900", IMG0, 900)
bench("img0_480", IMG0, 480)
bench("img0_96_lqip", IMG0, 96, AVIF_ACCEPT)
bench("img1_96_lqip", IMG1, 96, AVIF_ACCEPT)

# --- reader page metrics via Node/Playwright ---------------------------------
NODE_JS = r'''
const { chromium } = require('playwright');
const PAGE_URL = process.argv[2];
const EXE = process.argv[3] || undefined;
(async () => {
  const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('requestfailed', r => errors.push(r.url().slice(0, 120) + ' ' + (r.failure() || {}).errorText));
  await p.addInitScript(() => {
    window.__lt = []; window.__cls = 0; window.__lcp = 0;
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); })
      .observe({ type: 'longtask', buffered: true });
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver(l => { const e = l.getEntries(); if (e.length) window.__lcp = e[e.length - 1].startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  });
  const t0 = Date.now();
  await p.goto(PAGE_URL, { waitUntil: 'load', timeout: 120000 });
  const load = Date.now() - t0;
  let first = null;
  for (let i = 0; i < 300; i++) {
    if (await p.evaluate(() => { const im = document.querySelector('img[data-page="0"]'); return !!(im && im.complete && im.naturalWidth > 0); })) {
      first = Date.now() - t0; break;
    }
    await p.waitForTimeout(100);
  }
  await p.waitForTimeout(4000);
  const m = await p.evaluate(() => ({
    lt: window.__lt, cls: window.__cls, lcp: window.__lcp,
    heap: performance.memory ? performance.memory.usedJSHeapSize : null,
    imgs: performance.getEntriesByType('resource').filter(e => e.name.includes('/img?')).map(e => {
      const u = new URL(e.name);
      return { w: u.searchParams.get('w'), f: (u.searchParams.get('u') || '').split('/').pop(), dur: Math.round(e.duration), start: Math.round(e.startTime) };
    }),
    mounted: [...document.querySelectorAll('img[data-page]')].filter(i => i.dataset.mounted === '1').length,
  }));
  const sh = await p.evaluate(() => document.documentElement.scrollHeight);
  const vh = await p.evaluate(() => window.innerHeight);
  for (let i = 1; i <= 8; i++) {
    await p.evaluate(y => window.scrollTo(0, y), Math.round((sh - vh) * i / 8));
    await p.waitForTimeout(250);
  }
  await p.waitForTimeout(1500);
  const after = await p.evaluate(() => ({ cls: window.__cls, mounted: [...document.querySelectorAll('img[data-page]')].filter(i => i.dataset.mounted === '1').length }));
  console.log(JSON.stringify({
    load_s: +(load / 1000).toFixed(2), first_img_s: first === null ? null : +(first / 1000).toFixed(2),
    cls: +m.cls.toFixed(4), lcp: +(m.lcp / 1000).toFixed(2), heap: m.heap,
    longtasks: m.lt, imgs: m.imgs, mounted: m.mounted,
    cls_after_scroll: +after.cls.toFixed(4), mounted_after_scroll: after.mounted, errors,
  }));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
'''


def server_pid():
    """PID server yang benar (bukan shell/parent): RSS terbesar."""
    rows = subprocess.run(
        ["ps", "-C", "komiku-server", "-o", "pid=,rss=,vsz=,nlwp="],
        capture_output=True, text=True,
    ).stdout.strip().splitlines()
    best = None
    for row in rows:
        parts = row.split()
        if len(parts) >= 4:
            rss = int(parts[1])
            if best is None or rss > best[1]:
                best = (int(parts[0]), rss, int(parts[2]), int(parts[3]))
    return best


def cpu_ticks(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            parts = f.read().split()
        return int(parts[13]) + int(parts[14])
    except Exception:
        return None


def wait_idle(timeout=120.0):
    """Tunggu sampai server tidak lagi memanggang encode (mis. request yang
    dibatalkan browser tetap jalan di blocking pool). Tanpa ini run 'warm'
    bisa mengukur sisa kerja run 'cold'."""
    pid = server_pid()
    if not pid:
        return
    pid = pid[0]
    end = time.time() + timeout
    while time.time() < end:
        a = cpu_ticks(pid)
        time.sleep(0.5)
        b = cpu_ticks(pid)
        if a is not None and b is not None and (b - a) <= 0.05 * os.sysconf("SC_CLK_TCK"):
            return


def page_metrics():
    out = {}
    node = shutil.which("node")
    if not node:
        return {"page_load_error": "node tidak ditemukan"}
    env = dict(os.environ)
    env.setdefault("NODE_PATH", "/home/tresna/projects/playwright/packages")
    exe = "/home/tresna/.cache/ms-playwright/chromium_headless_shell-1249/chrome-headless-shell-linux64/chrome-headless-shell"
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(NODE_JS)
        js = f.name
    try:
        # cold: pastikan halaman pertama + LQIP-nya belum ada di cache
        clear(IMG0, 480, "webp")
        clear(IMG0, 96, "webp")
        clear(IMG0, 96, "avif")
        for tag in ("cold", "warm"):
            wait_idle()
            r = subprocess.run([node, js, URL, exe], capture_output=True, text=True, env=env, timeout=180)
            if r.returncode == 0 and r.stdout.strip():
                d = json.loads(r.stdout.strip().splitlines()[-1])
                out[f"page_load_{tag}_s"] = d["load_s"]
                out[f"first_img_{tag}_s"] = d["first_img_s"]
                out[f"cls_{tag}"] = d["cls"]
                out[f"cls_after_scroll_{tag}"] = d["cls_after_scroll"]
                out[f"lcp_{tag}_s"] = d["lcp"]
                out[f"longtasks_{tag}"] = d["longtasks"]
                out[f"lqip_requests_{tag}"] = [x for x in d["imgs"] if x["w"] == "96"]
                out[f"mounted_after_scroll_{tag}"] = d["mounted_after_scroll"]
                out[f"errors_{tag}"] = d["errors"]
            else:
                out[f"page_load_error_{tag}"] = (r.stderr or r.stdout).strip()[-200:]
    finally:
        os.unlink(js)
    return out


res.update(page_metrics())

# --- bundle size -------------------------------------------------------------
try:
    raw = gz = 0
    for f in os.listdir(DIST):
        if f.endswith(".js"):
            p = os.path.join(DIST, f)
            raw += os.path.getsize(p)
            with open(p, "rb") as fh:
                gz += len(gzip.compress(fh.read(), 9))
    res["dist_js_bytes"] = raw
    res["dist_js_gzip_bytes"] = gz
except Exception as e:
    res["dist_error"] = str(e)[:120]

# --- server memory + cache ---------------------------------------------------
try:
    info = server_pid()
    if info:
        res["server_pid"] = info[0]
        res["server_rss_kb"] = info[1]
        res["server_vsz_kb"] = info[2]
        res["server_threads"] = info[3]
except Exception:
    pass
try:
    files = [os.path.join(dp, f) for dp, _, fs in os.walk(CACHE) for f in fs]
    res["imgcache_bytes"] = sum(os.path.getsize(f) for f in files)
    res["imgcache_files"] = len(files)
except Exception:
    pass

# Budget: LQIP 96px cold ≤ 64s (baseline 32s ×2 tol). RSS server < 500MB
# (baseline AS 1.1GB). Wajib lolos sebelum claim perf fix.
GATE = {
    "lqip_cold_s_le": 64.0,
    "server_rss_kb_lt": 500_000,
}
fails = []
if "img0_96_lqip_cold_s" in res and res["img0_96_lqip_cold_s"] > GATE["lqip_cold_s_le"]:
    fails.append(f"LQIP cold {res['img0_96_lqip_cold_s']}s > {GATE['lqip_cold_s_le']}s")
if res.get("server_rss_kb", 0) >= GATE["server_rss_kb_lt"]:
    fails.append(f"RSS {res.get('server_rss_kb')}KB >= {GATE['server_rss_kb_lt']}KB")
res["gate"] = GATE
res["gate_pass"] = not fails
res["gate_fails"] = fails

print(json.dumps(res, indent=1))
