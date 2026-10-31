"""E2E posisi baca MODE MARATON.

Membuktikan dua hal yang diminta user:

  1. Meninggalkan maraton TIDAK menghapus posisi: membuka maraton lagi
     (klik "Maraton"/"Lanjut baca") mengembalikan pembaca ke halaman yang
     sama, bukan ke awal rantai.
  2. Restore itu PRESISI (halaman + kedalaman posisi mata), bukan sekadar
     "ke atas chapter terakhir".

Cara kerja: buka maraton, gulir cukup jauh sampai rantai punya >1 blok,
catat posisi (scrollY, pageId di tengah viewport, blok aktif), lalu muat
ulang halaman (simulasi keluar-masuk) dan bandingkan.

  python scripts/marathon_resume_e2e.py [--base-url http://127.0.0.1:8796]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

DEFAULT_BASE = "http://127.0.0.1:8788"
HANDLE = "komiku:1284"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\marathon_resume_e2e"

passed: list[str] = []
failed: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> bool:
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
    return bool(cond)


# posisi yang benar-benar terlihat: gambar mana yang ada di tengah viewport
POS_JS = """() => {
  const imgs = [...document.querySelectorAll('img[data-b]')].filter(i => i.offsetHeight > 0);
  const mid = window.scrollY + window.innerHeight / 2;
  let best = null, bestD = Infinity;
  for (const im of imgs) {
    const r = im.getBoundingClientRect();
    const top = r.top + window.scrollY;
    const d = Math.abs(top + r.height / 2 - mid);
    if (d < bestD) {
      bestD = d;
      best = { src: im.getAttribute('src'), top, height: r.height, block: Number(im.dataset.b ?? 0) };
    }
  }
  const blocks = [...new Set([...document.querySelectorAll('img[data-b]')].map(i => Number(i.dataset.b)))];
  return JSON.stringify({
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    mid,
    page: best,
    blocks: blocks.length,
    stored: localStorage.getItem('komiku.web.marathon.v1'),
  });
}"""


def pos(page):
    return json.loads(page.evaluate(POS_JS))


def same_place(a, b, tol_px: int = 60) -> bool:
    """Sama kalau halaman yang ditatap sama dan posisi matanya dekat."""
    if not a.get("page") or not b.get("page"):
        return False
    if a["page"]["src"] != b["page"]["src"]:
        return False
    return abs(a["mid"] - b["mid"]) <= tol_px


def main() -> int:
    ap = argparse.ArgumentParser(prog="marathon_resume_e2e.py")
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    args = ap.parse_args()
    base = args.base_url
    os.makedirs(SHOTS, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # service worker ikut menyajikan /img → blokir supaya route terlihat
        ctx = browser.new_context(
            viewport={"width": 420, "height": 820},
            locale="id-ID",
            service_workers="block",
        )
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # chapter pertama dari API (jangan hardcode nomor chapter)
        import urllib.request
        with urllib.request.urlopen(f"{base}/api/unified/series/{HANDLE}", timeout=30) as r:
            series = json.loads(r.read())
        chapters = series.get("chapters") or []
        if not chapters:
            print("FATAL: series tidak punya chapter", flush=True)
            return 2
        first = chapters[-1]["number"]  # urutan API: terbaru -> terlama

        page.goto(f"{base}/maraton/{HANDLE}/{first}", wait_until="domcontentloaded")
        deadline = time.time() + 45
        st = pos(page)
        while time.time() < deadline and not st.get("page"):
            page.wait_for_timeout(400)
            st = pos(page)
        if not check("PRASYARAT: maraton termuat", bool(st.get("page")), f"page={st.get('page') and 'ada'}"):
            browser.close()
            print("\nGAGAL PRASYARAT: maraton tak termuat (masalah lingkungan).")
            return 2

        # gulir cukup jauh supaya rantai menambah blok berikutnya
        deadline = time.time() + 90
        while time.time() < deadline and st["blocks"] < 2:
            page.evaluate("() => window.scrollBy(0, 2500)")
            page.wait_for_timeout(700)
            st = pos(page)
        check("setup: rantai punya >= 2 blok", st["blocks"] >= 2, f"blocks={st['blocks']}")

        # gulir lagi supaya posisinya jelas di TENGAH rantai (bukan di awal)
        page.evaluate("() => window.scrollBy(0, 3000)")
        page.wait_for_timeout(1200)
        before = pos(page)
        stored_before = json.loads(before["stored"]) if before.get("stored") else []
        check("posisi maraton TERSIMPAN saat scroll", bool(stored_before), f"{len(stored_before)} entri")
        page.screenshot(path=SHOTS + "/1-sebelum-keluar.png")

        # ---- keluar-masuk: reload = sesi baru, posisi harus dipulihkan ----
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        deadline = time.time() + 60
        after = pos(page)
        while time.time() < deadline and not same_place(before, after):
            page.wait_for_timeout(500)
            after = pos(page)

        check(
            "buka ulang: kembali ke HALAMAN yang sama",
            same_place(before, after),
            f"sebelum={before['page']['src'][-24:] if before.get('page') else None} "
            f"sesudah={after['page']['src'][-24:] if after.get('page') else None}",
        )
        check(
            "buka ulang: kedalaman posisi (bukan ke atas halaman)",
            after.get("page") is not None and abs(before["mid"] - after["mid"]) <= 60,
            f"selisih={abs(before['mid'] - after['mid']):.0f}px",
        )
        check(
            "buka ulang: BUKAN mulai dari awal rantai",
            after["scrollY"] > 500,
            f"scrollY={after['scrollY']:.0f}",
        )
        page.screenshot(path=SHOTS + "/2-sesudah-masuk-lagi.png")

        check("console: tanpa pageerror", not errors, "; ".join(errors[:2]))
        ctx.close()
        browser.close()

    print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
    print("SHOTS:", SHOTS)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
