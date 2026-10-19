"""E2E sheet "Pilih Chapter" di mode MARATON.

Maraton punya kontrak sendiri: footer menunjuk chapter HEAD (sebelum) dan
TAIL (sesudah) dari rantai, dan rantainya bisa menyeberang sumber. Sheet
pemilih chapter di maraton harus:
  - tetap terbuka dan menampilkan daftar chapter series,
  - menandai chapter yang SEDANG dibaca (bukan chapter pertama),
  - bisa melompat ke chapter lain dalam mode maraton (URL /maraton/...).
"""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\chapter_picker_marathon"
os.makedirs(SHOTS, exist_ok=True)

SERIES = "komiku:1284"
MARATON = f"/maraton/{SERIES}/121"

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def series_chapters():
    d = json.load(urllib.request.urlopen(f"{BASE}/api/unified/series/{SERIES}", timeout=60))
    return [str(c.get("number")) for c in (d.get("chapters") or [])]


def wait_ready(page):
    deadline = time.time() + 60
    while time.time() < deadline:
        ok = page.evaluate(
            "() => !!document.querySelector('[data-reader-chrome=toolbar]')"
            " && document.querySelectorAll('img[data-b]').length > 0"
        )
        if ok:
            return True
        page.wait_for_timeout(300)
    return False


CH = series_chapters()
TARGET = [n for n in CH if n != "121"][0]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, locale="id-ID")
    ctx.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked by e2e"))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + MARATON, wait_until="domcontentloaded")
    check("maraton: channel termuat", wait_ready(page), page.url)

    pick_btn = page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]')
    check("maraton: tombol 'Pilih Chapter' ada", pick_btn.count() == 1, f"{pick_btn.count()}")
    if pick_btn.count() != 1:
        ctx.close()
        browser.close()
        print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
        sys.exit(1)

    pick_btn.click()
    sheet = page.locator("[data-chapter-picker]")
    deadline = time.time() + 25
    while time.time() < deadline:
        if sheet.count() == 1:
            break
        page.wait_for_timeout(250)
    check("maraton: sheet terbuka", sheet.count() == 1, f"{sheet.count()}")

    rows = sheet.locator("ul li a")
    deadline = time.time() + 40
    while time.time() < deadline:
        if rows.count() > 0:
            break
        page.wait_for_timeout(300)
    check("maraton: daftar chapter termuat", rows.count() > 0, f"{rows.count()} baris")

    marked = sheet.locator('a[aria-current="true"]')
    check("maraton: chapter aktif ditandai", marked.count() == 1, f"{marked.count()}")

    # link di maraton harus ke /maraton/... (bukan /baca/...)
    m_links = sheet.locator('ul li a[href^="/maraton/"]')
    r_links = sheet.locator('ul li a[href^="/baca/"]')
    check("maraton: link chapter menuju /maraton/", m_links.count() > 0, f"{m_links.count()}")
    check("maraton: tidak ada link /baca/ di sheet", r_links.count() == 0, f"{r_links.count()}")

    link = sheet.locator(f'ul li a[href="/maraton/{SERIES}/{TARGET}"]')
    check(f"maraton: chapter {TARGET} punya link", link.count() >= 1, f"{link.count()}")
    if link.count() >= 1:
        link.first.click()
        deadline = time.time() + 30
        ok = False
        while time.time() < deadline:
            if f"/maraton/{SERIES}/{TARGET}" in page.url:
                ok = True
                break
            page.wait_for_timeout(250)
        check(f"maraton: klik chapter {TARGET} → navigasi maraton", ok, page.url)
        check("maraton: sheet tertutup", page.locator("[data-chapter-picker]").count() == 0)
        check("maraton: chapter baru termuat", wait_ready(page), page.url)
    page.screenshot(path=SHOTS + "/marathon.png")

    check("maraton: tanpa pageerror", not errors, "; ".join(errors[:3]))
    ctx.close()
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
sys.exit(1 if failed else 0)
