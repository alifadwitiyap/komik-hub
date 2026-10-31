"""E2E: masuk mode maraton dari READER harus mewarisi posisi baca (bukan balik awal).

Skenario (perbaikan #1 user):
  1. Buka reader biasa di sebuah chapter, scroll cukup jauh (posisi baca di
     tengah).
  2. Klik tombol "Masuk maraton" (kiri-atas).
  3. Harus masuk MODE MARATON di chapter yang SAMA dan tetap di posisi baca
     (scrollY > 0, bukan kembali ke atas/awal).

  python scripts/marathon_resume_from_reader_e2e.py --base-url http://127.0.0.1:8788
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
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\marathon_resume_from_reader"

passed: list[str] = []
failed: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> bool:
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
    return bool(cond)


def main() -> int:
    ap = argparse.ArgumentParser(prog="marathon_resume_from_reader_e2e.py")
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
    mid = ch[len(ch) // 2]["number"]

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

        # 1. buka reader biasa, scroll jauh
        page.goto(f"{base}/baca/{HANDLE}/{mid}", wait_until="domcontentloaded")
        deadline = time.time() + 45
        while time.time() < deadline and page.evaluate("() => window.scrollY") < 100:
            page.wait_for_timeout(400)
        page.wait_for_timeout(8000)
        page.evaluate("() => window.scrollBy(0, 5000)")
        page.wait_for_timeout(1500)
        y_reader = page.evaluate("() => window.scrollY")
        check("reader: sudah scroll (posisi baca ada)", y_reader > 500, f"scrollY={y_reader:.0f}")

        # 2. klik tombol masuk maraton (kiri-atas). Klik via JS supaya tidak
        #    scroll ulang (chrome bisa tersembunyi saat scroll).
        got_btn = page.evaluate("""() => {
          const b = document.querySelector('button[data-testid="reader-marathon-toggle"]');
          if (b && b.style.opacity !== '0') { b.click(); return true; }
          return false;
        }""")
        check("reader: tombol masuk maraton bisa diklik", got_btn)
        page.wait_for_timeout(4000)

        # 3. harus masuk maraton, chapter sama, posisi baca tetap
        check("masuk ke mode maraton", "/maraton/" in page.url, page.url)
        y_marathon = page.evaluate("() => window.scrollY")
        check(
            "posisi baca dipertahankan (bukan balik awal)",
            y_marathon > 500,
            f"scrollY={y_marathon:.0f} (reader {y_reader:.0f})",
        )
        page.screenshot(path=SHOTS + "/1-masuk-maraton-posisi-tetap.png")

        check("console: tanpa pageerror", not errors, "; ".join(errors[:2]))
        ctx.close()
        browser.close()

    print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
    print("SHOTS:", SHOTS)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
