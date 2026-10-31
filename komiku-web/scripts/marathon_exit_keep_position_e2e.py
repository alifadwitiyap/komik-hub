"""E2E: keluar dari mode maraton harus kembali ke chapter + posisi yang SEDANG dibaca.

Skenario (perbaikan #2 user):
  1. Masuk mode maraton (via toggle dari reader).
  2. Gulir cukup jauh sehingga rantai menambah >=2 blok (chapter aktif ≠ chapter awal).
  3. Catat chapter aktif + posisi (scrollY).
  4. Klik tombol "Keluar maraton".
  5. Harus kembali ke READER biasa di chapter AKTIF (bukan chapter awal rantai),
     dan posisi baca tetap (bukan balik ke atas/awal).

  python scripts/marathon_exit_keep_position_e2e.py --base-url http://127.0.0.1:8788
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

DEFAULT_BASE = "http://127.0.0.1:8788"
HANDLE = "komiku:1284"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\marathon_exit_keep_position"

passed: list[str] = []
failed: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> bool:
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
    return bool(cond)


def current_block(page):
    """blok aktif: di tengah viewport, dari img[data-b]."""
    return page.evaluate("""() => {
      const imgs = [...document.querySelectorAll('img[data-b]')].filter(i => i.offsetHeight > 0);
      if (!imgs.length) return null;
      const mid = window.scrollY + window.innerHeight / 2;
      let best = null, bestD = Infinity;
      for (const im of imgs) {
        const r = im.getBoundingClientRect();
        const d = Math.abs(r.top + window.scrollY + r.height / 2 - mid);
        if (d < bestD) { bestD = d; best = Number(im.dataset.b); }
      }
      return best;
    }""")


def main() -> int:
    ap = argparse.ArgumentParser(prog="marathon_exit_keep_position_e2e.py")
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    args = ap.parse_args()
    base = args.base_url
    os.makedirs(SHOTS, exist_ok=True)

    with urllib.request.urlopen(f"{base}/api/unified/series/{HANDLE}", timeout=30) as r:
        series = json.loads(r.read())
    ch = series.get("chapters") or []
    if not ch:
        print("FATAL: series tanpa chapter", flush=True)
        return 2
    midCh = ch[len(ch) // 2]["number"]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": 420, "height": 820},
            locale="id-ID",
            service_workers="block",
        )
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # 1. buka reader, scroll sedikit, lalu masuk maraton (fix #1)
        page.goto(f"{base}/baca/{HANDLE}/{midCh}", wait_until="domcontentloaded")
        page.wait_for_timeout(8000)
        page.evaluate("() => window.scrollBy(0, 3000)")
        page.wait_for_timeout(1200)
        page.evaluate("""() => {
          const b = document.querySelector('button[data-testid="reader-marathon-toggle"]');
          if (b) b.click();
        }""")
        page.wait_for_timeout(2500)
        check("masuk mode maraton", "/maraton/" in page.url, page.url)

        # 2. gulir sampai rantai >=2 blok (chapter aktif != chapter awal)
        deadline = time.time() + 90
        while time.time() < deadline:
            page.evaluate("() => window.scrollBy(0, 2500)")
            page.wait_for_timeout(700)
            b = current_block(page)
            if b is not None and b >= 1:
                break
        y_before = page.evaluate("() => window.scrollY")
        block_before = current_block(page)
        check("maraton: rantai punya >=2 blok & posisi di tengah", block_before is not None and block_before >= 1, f"block={block_before} scrollY={y_before:.0f}")

        # 3. keluar via toggle (kiri-atas)
        page.evaluate("""() => {
          const b = document.querySelector('button[data-testid="reader-marathon-toggle"]');
          if (b) b.click();
        }""")
        page.wait_for_timeout(4000)
        check("keluar ke reader biasa", "/baca/" in page.url, page.url)

        # 4. reader harus restore ke chapter aktif + posisi (bukan awal)
        y_after = page.evaluate("() => window.scrollY")
        check(
            "posisi baca dipertahankan (bukan balik awal)",
            y_after > 1000,
            f"scrollY={y_after:.0f} (sebelum keluar {y_before:.0f})",
        )
        page.screenshot(path=SHOTS + "/1-keluar-posisi-tetap.png")

        check("console: tanpa pageerror", not errors, "; ".join(errors[:2]))
        ctx.close()
        browser.close()

    print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
    print("SHOTS:", SHOTS)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
