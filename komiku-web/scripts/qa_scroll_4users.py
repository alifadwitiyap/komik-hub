#!/usr/bin/env python
"""QA scroll 4 user bersamaan — versi RAM-hemat.

Kenapa versi ini ada: 4 browser headless sekaligus membuat Chromium crash
(`fatal exception 0xe0000008`, network service crashed) di mesin uji ini.
Itu batas MESIN UJI, bukan produk. Versi ini memakai SATU Chromium dengan 4
context terpisah + memblokir byte gambar (route abort) supaya yang diukur
adalah kerja UI/JS/scroll (jank, blank, waktu render) tanpa 4x memori gambar.

Dua mode:
  --images block  (default) : byte gambar diblokir -> ukur jank/blank/JS murni
  --images allow            : gambar ikut dimuat (butuh mesin lebih kuat)
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import threading
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
TARGETS = [
    ("komiku-one-piece",    "/baca/komiku:6426/1196"),
    ("komiku-sololeveling", "/baca/komiku:1308/180"),
    ("kiryuu-tog",          "/baca/kiryuu:tower-of-god-2/652"),
    ("kiryuu-opa",          "/baca/kiryuu:one-piece-academy/2"),
]

JANK_PROBE = """
() => {
  window.__jt = []; window.__jl = performance.now(); window.__js = false;
  const tick = () => {
    const n = performance.now();
    window.__jt.push(n - window.__jl);
    window.__jl = n;
    if (!window.__js) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
}
"""
JANK_STOP = """() => { window.__js = true; return window.__jt; }"""

STATE = """() => {
  const vh = window.innerHeight;
  const imgs = [...document.querySelectorAll('img[data-page]')];
  const loaded = imgs.filter(i => i.naturalWidth > 0).length;
  const visible = imgs.filter(im => {
    const r = im.getBoundingClientRect();
    return r.bottom > 0 && r.top < vh && r.height > 10
      && im.naturalWidth > 0 && getComputedStyle(im).opacity === '1';
  }).length;
  return {total: imgs.length, loaded, visible,
          scrollY: Math.round(window.scrollY),
          docH: Math.round(document.documentElement.scrollHeight)};
}"""


def one_user(pw_unused, name, path, steps, mode, lock, out):
    rec = {"user": name, "path": path, "mode": mode}
    t0 = time.time()
    ctx = None
    try:
        # PENTING: sync_playwright() TIDAK boleh dipakai lintas thread
        # ("Cannot switch to a different thread"). Tiap thread wajib punya
        # instance Playwright sendiri.
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=[
                "--disable-dev-shm-usage", "--disable-gpu",
                "--js-flags=--max-old-space-size=256",
            ])
            ctx = browser.new_context(viewport={"width": 390, "height": 844})
            page = ctx.new_page()
            errs = []
            page.on("pageerror", lambda e: errs.append(str(e)[:120]))
            if mode == "block":
                # hentikan byte gambar: cukup HTML/CSS/JS -> ukur kerja UI
                page.route("**/img?*", lambda r: r.abort())
                page.route("https://*.komiku.org/**", lambda r: r.abort())
                page.route("https://*.shngm.id/**", lambda r: r.abort())
                page.route("https://*.kiryuu.io/**", lambda r: r.abort())

            page.goto(BASE + path, wait_until="domcontentloaded", timeout=90_000)
            page.wait_for_selector("img[data-page]", timeout=90_000)
            rec["elements_ms"] = round((time.time() - t0) * 1000, 1)

            page.evaluate(JANK_PROBE)
            blanks = 0
            t_s = time.time()
            for _ in range(steps):
                page.evaluate("window.scrollBy(0, 760)")
                page.wait_for_timeout(350)
                st = page.evaluate(STATE)
                if mode == "allow" and st["visible"] == 0:
                    blanks += 1
            rec["scroll_ms"] = round((time.time() - t_s) * 1000, 1)
            rec["blank"] = blanks if mode == "allow" else None
            rec["final"] = page.evaluate(STATE)

            frames = [f for f in page.evaluate(JANK_STOP) if f > 0]
            if frames:
                rec["jank_pct"] = round(100 * sum(1 for f in frames if f > 50) / len(frames), 1)
                rec["frame_med"] = round(statistics.median(frames), 1)
                rec["frame_p95"] = round(sorted(frames)[int(len(frames) * 0.95) - 1], 1)
            else:
                rec["jank_pct"] = rec["frame_med"] = rec["frame_p95"] = None
            rec["err"] = errs[:2]
            rec["elapsed_s"] = round(time.time() - t0, 1)
            browser.close()
    except Exception as e:
        rec["fatal"] = f"{type(e).__name__}: {str(e)[:150]}"
    finally:
        with lock:
            out.append(rec)
            print(f"  [ok] {name}: el={rec.get('elements_ms')}ms scroll={rec.get('scroll_ms')}ms "
                  f"jank={rec.get('jank_pct')}% p95={rec.get('frame_p95')}ms "
                  f"blank={rec.get('blank')} fatal={rec.get('fatal')}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--images", choices=["block", "allow"], default="block")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()

    try:
        urllib.request.urlopen(BASE + "/", timeout=10).read(1)
    except Exception as e:
        print(f"FATAL: server mati di {BASE}: {e}", file=sys.stderr)
        return 2

    print(f"== QA scroll 4 user bersamaan (mode gambar: {a.images}) ==")
    out: list[dict] = []
    lock = threading.Lock()
    t0 = time.time()

    # Tiap thread membuat Playwright SENDIRI (lihat one_user); jangan pakai
    # satu instance lintas thread — Playwright sync menolak itu.
    threads = []
    for i, (n, p) in enumerate(TARGETS):
        t = threading.Thread(target=one_user, args=(None, n, p, a.steps, a.images, lock, out))
        threads.append(t)
        t.start()
        time.sleep(1.5)  # stagger: hindari 4 launch serentak (RAM)
    for t in threads:
        t.join()

    total = time.time() - t0
    print(f"\n== HASIL ({total:.1f}s) ==")
    hdr = f"{'user':22s} {'elemen':>8s} {'scroll':>8s} {'jank%':>7s} {'p95ms':>7s} {'blank':>6s} {'loaded':>8s}"
    print(hdr); print("-" * len(hdr))
    for r in sorted(out, key=lambda x: x["user"]):
        f = r.get("final") or {}
        print(f"{r['user']:22s} {str(r.get('elements_ms')):>8s} {str(r.get('scroll_ms')):>8s} "
              f"{str(r.get('jank_pct')):>7s} {str(r.get('frame_p95')):>7s} "
              f"{str(r.get('blank')):>6s} {str(f.get('loaded'))+'/'+str(f.get('total')):>8s}")

    jk = [r["jank_pct"] for r in out if r.get("jank_pct") is not None]
    el = [r["elements_ms"] for r in out if r.get("elements_ms")]
    if jk: print(f"\njank%: median={statistics.median(jk):.1f} max={max(jk):.1f}")
    if el: print(f"elemen_ms: median={statistics.median(el):.0f} max={max(el):.0f}")
    fatal = [r for r in out if r.get("fatal")]
    print(f"user gagal: {len(fatal)}/{len(out)}")

    if a.json:
        json.dump({"mode": a.images, "total_s": round(total, 1), "results": out},
                  open(a.json, "w"), indent=2)
        print(f"json -> {a.json}")
    return 1 if fatal else 0


if __name__ == "__main__":
    sys.exit(main())
