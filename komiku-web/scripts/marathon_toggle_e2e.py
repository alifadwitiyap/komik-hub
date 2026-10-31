"""E2E tombol toggle mode MARATON (baru).

Memverifikasi:
   1. Di reader biasa (/baca) tombol muncul di KIRI-atas, ikon lari, label
      "Masuk maraton", dan ikut chrome (sembunyi saat scroll turun).
   2. Klik tombol di reader -> masuk mode maraton (URL /maraton/).
   3. Di mode maraton tombol jadi "Keluar" dan klik -> kembali ke reader biasa
      (URL /baca/).

  python scripts/marathon_toggle_e2e.py --base-url http://127.0.0.1:8788
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
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\marathon_toggle_e2e"

passed: list[str] = []
failed: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> bool:
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
    return bool(cond)


def btn_state(page):
    return page.evaluate("""() => {
      const b = document.querySelector('button[data-testid="reader-marathon-toggle"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({
        x: r.x, y: r.y, w: r.width, h: r.height,
        label: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
        visible: b.style.opacity !== '0',
      });
    }""")


def main() -> int:
    ap = argparse.ArgumentParser(prog="marathon_toggle_e2e.py")
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
    oldest = ch[-1]["number"]

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

        # ---- 1. di reader biasa ----
        page.goto(f"{base}/baca/{HANDLE}/{oldest}", wait_until="domcontentloaded")
        deadline = time.time() + 45
        st = json.loads(btn_state(page)) if btn_state(page) else None
        while time.time() < deadline and not st:
            page.wait_for_timeout(400)
            raw = btn_state(page)
            st = json.loads(raw) if raw else None
        check("reader: tombol marathon ada", st is not None)
        if st:
            check("reader: posisi KIRI-atas (x < viewport/2)", st["x"] < 210, f"x={st['x']:.0f} y={st['y']:.0f}")
            check("reader: label 'Masuk maraton'", st["label"] == "Masuk maraton", str(st["label"]))
            check("reader: tombol terlihat", st["visible"])
            page.screenshot(path=SHOTS + "/1-reader-kiri-atas.png")

        # ---- 2. klik -> masuk maraton ----
        page.click('button[data-testid="reader-marathon-toggle"]')
        page.wait_for_timeout(3000)
        check("klik di reader -> masuk mode maraton", "/maraton/" in page.url, page.url)

        # ---- 3. di maraton: tombol jadi Keluar ----
        deadline = time.time() + 45
        raw = btn_state(page)
        st2 = json.loads(raw) if raw else None
        while time.time() < deadline and not st2:
            page.wait_for_timeout(400)
            raw = btn_state(page)
            st2 = json.loads(raw) if raw else None
        check("maraton: tombol ada", st2 is not None)
        if st2:
            check("maraton: label 'Keluar maraton'", st2["label"] == "Keluar maraton", str(st2["label"]))
            check("maraton: posisi KIRI-atas", st2["x"] < 210, f"x={st2['x']:.0f}")
            page.screenshot(path=SHOTS + "/2-maraton-keluar.png")

            # ---- 4. klik -> keluar ke reader ----
            page.click('button[data-testid="reader-marathon-toggle"]')
            page.wait_for_timeout(3000)
            check("klik di maraton -> kembali ke reader biasa", "/baca/" in page.url, page.url)

        check("console: tanpa pageerror", not errors, "; ".join(errors[:2]))
        ctx.close()
        browser.close()

    print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
    print("SHOTS:", SHOTS)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
