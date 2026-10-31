"""E2E "Lanjut baca" setelah maraton + aksi "Mulai dari awal".

Dua permintaan user yang diuji di sini:

  1. Setelah membaca di mode MARATON, titik masuk "Lanjut baca" (FAB Home /
     kartu "Lanjut membaca") harus membuka MODE MARATON di posisi terakhir —
     bukan reader satu chapter yang memutus rantai.
  2. Ada jalan eksplisit kembali ke AWAL: aksi "Mulai maraton dari awal" di
     sheet Preferensi menghapus posisi tersimpan dan memulai dari blok pertama.

  python scripts/marathon_entry_e2e.py [--base-url http://127.0.0.1:8796]
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
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\marathon_entry_e2e"

passed: list[str] = []
failed: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> bool:
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
    return bool(cond)


STORE = "komiku.web.marathon.v1"


def stored(page) -> list:
    raw = page.evaluate("(k) => localStorage.getItem(k)", STORE)
    return json.loads(raw) if raw else []


def mid_page(page):
    """halaman yang sedang ditatap (di tengah viewport) + posisinya"""
    return json.loads(page.evaluate("""() => {
      const imgs = [...document.querySelectorAll('img[data-b]')].filter(i => i.offsetHeight > 0);
      const mid = window.scrollY + window.innerHeight / 2;
      let best = null, bestD = Infinity;
      for (const im of imgs) {
        const r = im.getBoundingClientRect();
        const d = Math.abs(r.top + window.scrollY + r.height / 2 - mid);
        if (d < bestD) { bestD = d; best = { b: im.dataset.b, p: im.dataset.page }; }
      }
      return JSON.stringify({ scrollY: window.scrollY, mid, page: best });
    }"""))


def main() -> int:
    ap = argparse.ArgumentParser(prog="marathon_entry_e2e.py")
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    args = ap.parse_args()
    base = args.base_url
    os.makedirs(SHOTS, exist_ok=True)

    with urllib.request.urlopen(f"{base}/api/unified/series/{HANDLE}", timeout=30) as r:
        series = json.loads(r.read())
    chapters = series.get("chapters") or []
    if not chapters:
        print("FATAL: series tak punya chapter", flush=True)
        return 2
    first = chapters[-1]["number"]

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

        # ---- 1. baca di maraton, gulir cukup jauh -------------------------
        page.goto(f"{base}/maraton/{HANDLE}/{first}", wait_until="domcontentloaded")
        deadline = time.time() + 45
        while time.time() < deadline and not mid_page(page).get("page"):
            page.wait_for_timeout(400)
        check("setup: maraton termuat", bool(mid_page(page).get("page")))

        page.evaluate("() => window.scrollBy(0, 6000)")
        page.wait_for_timeout(1500)
        pos = mid_page(page)
        entries = stored(page)
        check("posisi maraton tersimpan", bool(entries), f"{len(entries)} entri")
        if not entries:
            browser.close()
            return 1
        saved_key = entries[0]["chapterKey"]
        check(
            "entri menyimpan identitas SERIES",
            entries[0].get("seriesKey") == HANDLE,
            str(entries[0].get("seriesKey")),
        )

        # ---- 2. Home: titik masuk "Lanjut baca" harus ke /maraton ----------
        page.goto(base + "/", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        fab = page.query_selector('a[aria-label="Lanjut baca"]')
        check("FAB 'Lanjut baca' ada di Home", fab is not None)
        if fab:
            href = fab.get_attribute("href") or ""
            check("FAB menuju MODE MARATON (bukan reader)", href.startswith("/maraton/"), href)
            check("FAB menuju sesi maraton tersimpan", saved_key.split(":")[-1] in href, href)
            fab.click()
            page.wait_for_timeout(2500)
            check(
                "klik FAB benar-benar membuka maraton",
                "/maraton/" in page.url,
                page.url,
            )
            # dan langsung di posisi terakhir, bukan di awal
            deadline = time.time() + 45
            got = mid_page(page)
            while time.time() < deadline and not got.get("page"):
                page.wait_for_timeout(400)
                got = mid_page(page)
            check(
                "dibuka di posisi terakhir (bukan awal)",
                got["scrollY"] > 500,
                f"scrollY={got['scrollY']:.0f}",
            )
            page.screenshot(path=SHOTS + "/1-lanjut-baca-maraton.png")

        # ---- 3. "Mulai maraton dari awal" ---------------------------------
        # Chrome (toolbar) mengikuti arah scroll dan sedang tersembunyi karena
        # pembaca baru menggulir turun. Scroll ke atas dulu supaya toolbar
        # tampil — persis yang dilakukan pembaca sungguhan.
        page.evaluate("() => window.scrollTo(0, 0)")
        page.wait_for_timeout(1200)
        more = page.query_selector('header button[aria-label="Menu"]')
        check("tombol menu reader tersedia", more is not None)
        if more:
            # klik lewat JS: toolbar fixed bisa berada di luar viewport hit-test
            page.evaluate("""() => {
              const b = document.querySelector('header button[aria-label="Menu"]');
              if (b) b.click();
            }""")
            page.wait_for_timeout(900)
            pref = page.query_selector('button:has-text("Preferensi")')
            check("menu punya 'Preferensi'", pref is not None)
            if pref:
                page.evaluate("""() => {
                  const btns = [...document.querySelectorAll('button')];
                  const b = btns.find(x => (x.textContent || '').includes('Preferensi'));
                  if (b) b.click();
                }""")
                page.wait_for_timeout(900)
                restart = page.query_selector('text="Mulai maraton dari awal"')
                check("sheet punya aksi 'Mulai maraton dari awal'", restart is not None)
                if restart:
                    page.evaluate("""() => {
                      const els = [...document.querySelectorAll('div[role="button"], button')];
                      const b = els.find(x => (x.textContent || '').includes('Mulai maraton dari awal'));
                      if (b) b.click();
                    }""")
                    page.wait_for_timeout(3000)
                    after = stored(page)
                    check(
                        "aksi restart MENGHAPUS posisi tersimpan",
                        not after,
                        f"sisa {len(after)} entri",
                    )
                    check(
                        "aksi restart kembali ke atas rantai",
                        mid_page(page)["scrollY"] < 300,
                        f"scrollY={mid_page(page)['scrollY']:.0f}",
                    )
                    page.screenshot(path=SHOTS + "/2-mulai-dari-awal.png")

        check("console: tanpa pageerror", not errors, "; ".join(errors[:2]))
        ctx.close()
        browser.close()

    print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
    print("SHOTS:", SHOTS)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
