#!/usr/bin/env python
"""QA BEBAN: 4 user bersamaan scroll reader, ukur apakah MELAMBAT.

Yang diukur per user (Chromium nyata, jaringan nyata, satu proses):
  page1_ms   : waktu halaman 1 reader TERLIHAT (naturalWidth>0 & opacity 1)
  scroll_ms  : waktu total menyelesaikan N langkah scroll
  jank_pct   : % frame > 50ms selama scroll (proxy "patah-patah")
  blank      : jumlah posisi scroll di mana TIDAK ada gambar terlihat (area kosong)
  imgs_ok    : gambar yang termuat / total
  err        : error console / pageerror

Mode:
  --parallel 4   : semua user jalan BERSAMAAN (uji rebutan resource)
  --parallel 1   : baseline satu-per-satu (pembanding)

Pemakaian:
  python scripts/qa_scroll_load.py --parallel 4
  python scripts/qa_scroll_load.py --parallel 1     # baseline
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import threading
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"

# 4 target nyata (chapter pertama per seri) — sudah diverifikasi http 200
TARGETS = [
    ("komiku-one-piece",   "/baca/komiku:6426/1196"),
    ("komiku-sololeveling", "/baca/komiku:1308/180"),
    ("kiryuu-tog",         "/baca/kiryuu:tower-of-god-2/652"),
    ("kiryuu-opa",         "/baca/kiryuu:one-piece-academy/2"),
]

JANK_PROBE = """
() => new Promise(res => {
  const times = [];
  let last = performance.now();
  let stop = false;
  const tick = () => {
    const now = performance.now();
    times.push(now - last);
    last = now;
    if (!stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__stopJank = () => { stop = true; res(times); };
})
"""


def run_user(name, path, steps, out, lock, results):
    rec = {"user": name, "path": path}
    t0 = time.time()
    ctx = None
    browser = None
    try:
        # SATU browser per user: 4 tab di satu Chromium membuat renderer
        # crash ("Target crashed") karena tiap tab reader memuat belasan
        # gambar full-res. Browser terpisah = tiap user punya proses sendiri,
        # dan crash satu user tidak menjatuhkan yang lain.
        browser = sync_playwright().start().chromium.launch(
            headless=True, args=["--disable-dev-shm-usage"]
        )
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        page.on("console", lambda m: errs.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

        print(f"  [{name}] goto...", flush=True)
        page.goto(BASE + path, wait_until="domcontentloaded", timeout=90_000)
        print(f"  [{name}] dom siap, tunggu img[data-page]...", flush=True)
        try:
            page.wait_for_selector("img[data-page]", timeout=60_000)
            n = page.evaluate("() => document.querySelectorAll('img[data-page]').length")
            print(f"  [{name}] {n} elemen gambar terpasang", flush=True)
        except Exception as e:
            body = page.evaluate("() => document.body.innerText.slice(0,200)")
            print(f"  [{name}] TIDAK ADA img[data-page]: {type(e).__name__} | body={body[:120]!r}", flush=True)

        # --- page1 terlihat ---
        # Pakai wait_for_timeout (Playwright-native) + evaluate; JANGAN
        # time.sleep di thread ini (memblokir event loop Playwright) dan jangan
        # wait_for_function tanpa argumen (rawan menggantung di halaman reader
        # yang terus memuat gambar).
        rec["page1_ms"] = None
        for _ in range(30):  # ~15s
            ok = page.evaluate("""() => {
              const imgs = [...document.querySelectorAll('img[data-page]')];
              return imgs.some(i => i.naturalWidth > 0 && getComputedStyle(i).opacity === '1');
            }""")
            if ok:
                rec["page1_ms"] = round((time.time() - t0) * 1000, 1)
                break
            page.wait_for_timeout(500)

        # --- mulai ukur jank ---
        page.evaluate(JANK_PROBE)
        t_s = time.time()
        blanks = 0
        for i in range(steps):
            page.evaluate(f"window.scrollBy(0, {int(844 * 0.9)})")
            # wait_for_timeout = Playwright-native (tidak memblokir event loop)
            page.wait_for_timeout(400)
            # area kosong: tidak ada img terlihat di viewport
            vis = page.evaluate("""() => {
              const vh = window.innerHeight;
              const imgs = [...document.querySelectorAll('img[data-page]')];
              return imgs.some(im => {
                const r = im.getBoundingClientRect();
                return r.bottom > 0 && r.top < vh && r.height > 10
                  && im.naturalWidth > 0 && getComputedStyle(im).opacity === '1';
              });
            }""")
            if not vis:
                blanks += 1
        rec["scroll_ms"] = round((time.time() - t_s) * 1000, 1)
        rec["blank"] = blanks

        frames = page.evaluate("() => window.__stopJank()")
        frames = [f for f in frames if f > 0]
        if frames:
            long_frames = [f for f in frames if f > 50]
            rec["jank_pct"] = round(100 * len(long_frames) / len(frames), 1)
            rec["frame_med_ms"] = round(statistics.median(frames), 1)
        else:
            rec["jank_pct"] = None
            rec["frame_med_ms"] = None

        rec["imgs_ok"] = page.evaluate("""() => {
          const imgs = [...document.querySelectorAll('img[data-page]')];
          return [imgs.filter(i => i.naturalWidth > 0).length, imgs.length];
        }""")
        rec["err"] = errs[:3]
        rec["elapsed_s"] = round(time.time() - t0, 1)
    except Exception as e:
        import traceback
        rec["fatal"] = f"{type(e).__name__}: {e}"
        rec["trace"] = traceback.format_exc()[-600:]
    finally:
        if ctx:
            try:
                ctx.close()
            except Exception:
                pass
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        with lock:
            results.append(rec)
            print(f"  [selesai] {name}: page1={rec.get('page1_ms')}ms jank={rec.get('jank_pct')}% "
                  f"blank={rec.get('blank')} err={len(rec.get('err') or [])}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parallel", type=int, default=4, help="berapa user bersamaan (1=baseline serial)")
    ap.add_argument("--steps", type=int, default=12, help="langkah scroll per user")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    # cek server hidup
    import urllib.request
    try:
        urllib.request.urlopen(BASE + "/", timeout=10).read(1)
    except Exception as e:
        print(f"FATAL: server tidak merespons di {BASE}: {e}", file=sys.stderr)
        return 2

    print(f"== QA beban: {args.parallel} user bersamaan, {args.steps} langkah scroll ==")
    results: list[dict] = []
    lock = threading.Lock()
    t_start = time.time()

    if args.parallel >= len(TARGETS):
        threads = [
            threading.Thread(target=run_user, args=(n, p, args.steps, None, lock, results))
            for n, p in TARGETS
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    else:
        # serial: satu per satu (baseline)
        for n, p in TARGETS:
            run_user(n, p, args.steps, None, lock, results)

    total = time.time() - t_start
    print(f"\n== HASIL ({args.parallel} user, total {total:.1f}s) ==")
    hdr = f"{'user':22s} {'page1':>9s} {'scroll':>9s} {'jank%':>7s} {'blank':>6s} {'imgs':>10s} {'err':>4s}"
    print(hdr); print("-" * len(hdr))
    for r in sorted(results, key=lambda x: x["user"]):
        imgs = r.get("imgs_ok") or [0, 0]
        print(f"{r['user']:22s} {str(r.get('page1_ms')):>9s} {str(r.get('scroll_ms')):>9s} "
              f"{str(r.get('jank_pct')):>7s} {str(r.get('blank')):>6s} "
              f"{str(imgs[0])+'/'+str(imgs[1]):>10s} {len(r.get('err') or []):>4d}")

    # ringkas
    p1 = [r["page1_ms"] for r in results if r.get("page1_ms")]
    jk = [r["jank_pct"] for r in results if r.get("jank_pct") is not None]
    if p1:
        print(f"\npage1_ms: median={statistics.median(p1):.0f} max={max(p1):.0f}")
    if jk:
        print(f"jank%:    median={statistics.median(jk):.1f} max={max(jk):.1f}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"parallel": args.parallel, "total_s": round(total, 1), "results": results}, f, indent=2)
        print(f"json -> {args.json}")

    # exit non-zero kalau ada user fatal / gambar gagal / area kosong parah
    bad = [r for r in results if r.get("fatal") or r.get("blank", 0) > 2
           or (r.get("imgs_ok") and r["imgs_ok"][0] == 0)]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
