"""E2E toggle tombol fullscreen manual: klik 1x masuk, klik 2x keluar.

Headless menolak native Fullscreen API → hook fallback ke "immersive"
(menyembunyikan chrome). Verifikasi toggle lewat perubahan aria-label tombol:
  - mula-mula: "Masuk fullscreen"
  - setelah klik 1: "Keluar fullscreen" (fullscreen aktif)
  - setelah klik 2: "Masuk fullscreen" lagi (keluar)
"""
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
CHAPTER_URL = "/baca/komiku:1284/77"

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

    page.goto(BASE + CHAPTER_URL, wait_until="networkidle")
    page.wait_for_timeout(4000)

    enter = page.locator('button[aria-label="Masuk fullscreen"]')
    check("mula: tombol 'Masuk fullscreen' ada", enter.count() > 0)

    # klik 1 → masuk
    enter.first.click()
    page.wait_for_timeout(800)
    out = page.locator('button[aria-label="Keluar fullscreen"]')
    check("klik 1: masuk fullscreen ('Keluar fullscreen' muncul)", out.count() > 0)

    # klik 2 → keluar
    out.first.click()
    page.wait_for_timeout(800)
    enter2 = page.locator('button[aria-label="Masuk fullscreen"]')
    check("klik 2: keluar fullscreen ('Masuk fullscreen' muncul lagi)", enter2.count() > 0)

    check("console: tanpa pageerror", not errors, "; ".join(errors)[:120])
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
raise SystemExit(1 if failed else 0)
