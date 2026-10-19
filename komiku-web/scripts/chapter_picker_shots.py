"""Screenshot sheet Pilih Chapter di viewport mobile + light theme.

Tujuan: cek tampilan sheet di layar HP (tujuan utama reader) dan saat
tema app TERANG — sheet harus tetap terbaca (footer reader selalu gelap).
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\chapter_picker_shots"
os.makedirs(SHOTS, exist_ok=True)

MID = "/baca/komiku:1284/121"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for theme, label in (("dark", "gelap"), ("light", "terang")):
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, locale="id-ID")
        ctx.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked by e2e"))
        page = ctx.new_page()
        page.goto(BASE + MID, wait_until="domcontentloaded")
        # set tema sebelum app boot → localStorage
        page.evaluate(
            """(t) => { localStorage.setItem('komik.theme', t); }""",
            theme,
        )
        page.reload(wait_until="domcontentloaded")
        deadline = time.time() + 40
        while time.time() < deadline:
            ok = page.evaluate(
                "() => !!document.querySelector('[data-reader-chrome=toolbar]')"
                " && document.querySelectorAll('img[data-page]').length > 0"
            )
            if ok:
                break
            page.wait_for_timeout(250)
        page.wait_for_timeout(1200)
        page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]').click()
        page.wait_for_timeout(1500)
        page.screenshot(path=f"{SHOTS}/sheet-{label}.png")
        # versi sheet tertutup (footer) buat lihat tombolnya
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        page.screenshot(path=f"{SHOTS}/footer-{label}.png")
        print(f"shot {label}: {SHOTS}/sheet-{label}.png")
        ctx.close()
    browser.close()
print("OK")
