"""E2E favorit flow Komiku LAMA (kartu id angka, /manga/<id>, reader legacy).

Sebelum fix ini tombol ♥ hanya muncul di kartu/series unified (ber-handle);
kartu Komiku lama tidak punya title_key sehingga gate di web tak pernah
buka. Server kini menyuntik title_key (normalisasi di Rust) ke slim(),
series, dan chapter — script ini mengunci perilaku baru.

  python scripts/legacy_fav_e2e.py
Bukti: assertion output + screenshot.
"""
import os
import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\legacy_fav_e2e"
os.makedirs(SHOTS, exist_ok=True)

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # 1. Beranda: kartu Komiku lama (id angka) punya overlay ♥
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(3000)
    hearts = page.locator('button[aria-label*="favorit" i]')
    check("home: tombol ♥ ada di kartu Komiku lama", hearts.count() > 0, f"{hearts.count()} tombol")
    page.screenshot(path=SHOTS + "/1-home.png")

    # 2. Series legacy (id angka): pil Favorit berlabel + toggle bekerja
    page.goto(BASE + "/manga/3215", wait_until="networkidle")
    page.wait_for_timeout(4000)
    labeled = page.locator('button:has-text("Favorit"), button:has-text("Difavoritkan")')
    check("series legacy: pil Favorit ada", labeled.count() > 0, f"{labeled.count()} pil")
    if labeled.count() > 0:
        aria0 = labeled.first.get_attribute("aria-pressed")
        labeled.first.click()
        page.wait_for_timeout(600)
        aria1 = labeled.first.get_attribute("aria-pressed")
        check("series legacy: klik ♥ menoggle state", aria0 != aria1, f"{aria0} -> {aria1}")
        ls = page.evaluate("() => localStorage.getItem('komik-rak-v1')")
        check(
            "series legacy: favorit tersimpan di rak",
            bool(ls) and '"favorites"' in ls,
            (ls or "")[:80],
        )
    page.screenshot(path=SHOTS + "/2-series-legacy.png")

    # 3. Rak: klik tab Favorit -> entri yang baru di-love muncul
    page.goto(BASE + "/rak", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.locator('button:text-is("Favorit")').first.click()
    page.wait_for_timeout(1000)
    body = page.inner_text("body")
    check("rak: judul yang di-favoritkan muncul", "Class de 2 Banme" in body, body[:80])
    fav_link = page.locator('a[href^="/manga/"]')
    check("rak favorit: kartu menaut ke /manga/<id legacy>", fav_link.count() > 0, f"{fav_link.count()} kartu")
    page.screenshot(path=SHOTS + "/3-rak-favorit.png")

    # 4. Reader legacy: toolbar ♥ hadir (gate title_key+series_handle dari server)
    page.goto(BASE + "/baca/581246", wait_until="networkidle")
    page.wait_for_timeout(5000)
    rheart = page.locator('button[aria-label*="favorit" i]')
    check("reader legacy: tombol ♥ di toolbar", rheart.count() > 0, f"{rheart.count()} tombol")
    check("console: tanpa pageerror", not errors, "; ".join(errors)[:120])
    page.screenshot(path=SHOTS + "/4-reader-legacy.png")

    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
raise SystemExit(1 if failed else 0)
