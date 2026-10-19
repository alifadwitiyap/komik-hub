"""E2E sheet "Pilih Chapter" pada flow LEGACY komiku (route /baca/<id angka>).

Flow unified (/baca/handle/nomor) adalah jalur utama. Flow legacy
(/baca/6427) memakai sumber data & bentuk chapter BERBEDA (id numerik,
bukan handle), jadi sheet pemilih chapter harus benar-benar diuji di
kedua jalur — kalau hanya yang unified, bug legacy lolos.
"""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\chapter_picker_legacy"
os.makedirs(SHOTS, exist_ok=True)

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def legacy_chapters():
    d = json.load(urllib.request.urlopen(f"{BASE}/api/series/6426", timeout=90))
    return [{"id": str(c.get("id")), "name": c.get("name") or ""} for c in (d.get("chapters") or [])]


def wait_ready(page):
    deadline = time.time() + 60
    while time.time() < deadline:
        ok = page.evaluate(
            "() => !!document.querySelector('[data-reader-chrome=toolbar]')"
            " && document.querySelectorAll('img[data-page]').length > 0"
        )
        if ok:
            return True
        page.wait_for_timeout(300)
    return False


CH = legacy_chapters()
# chapter yang punya gambar & bukan yang pertama (numik id dari API)
TARGET = CH[3]
MID = f"/baca/{TARGET['id']}"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, locale="id-ID")
    ctx.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked by e2e"))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + MID, wait_until="domcontentloaded")
    check("legacy: reader termuat + gambar ter-render", wait_ready(page), page.url)

    pick_btn = page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]')
    check("legacy: tombol 'Pilih Chapter' ada", pick_btn.count() == 1, f"{pick_btn.count()}")
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
    check("legacy: sheet terbuka", sheet.count() == 1, f"{sheet.count()}")

    rows = sheet.locator("ul li a")
    deadline = time.time() + 40
    while time.time() < deadline:
        if rows.count() > 0:
            break
        page.wait_for_timeout(300)
    check("legacy: daftar chapter termuat", rows.count() > 0, f"{rows.count()} baris")
    check(
        "legacy: jumlah baris sesuai API",
        rows.count() == len(CH),
        f"UI={rows.count()} API={len(CH)}",
    )

    marked = sheet.locator('a[aria-current="true"]')
    check("legacy: chapter aktif ditandai", marked.count() == 1, f"{marked.count()}")

    # klik chapter lain → navigasi ke /baca/<id>
    other = CH[5]
    link = sheet.locator(f'ul li a[href="/baca/{other["id"]}"]')
    check("legacy: link chapter pakai /baca/<id>", link.count() >= 1, f"{link.count()}")
    if link.count() >= 1:
        link.first.click()
        deadline = time.time() + 25
        ok = False
        while time.time() < deadline:
            if f"/baca/{other['id']}" in page.url:
                ok = True
                break
            page.wait_for_timeout(250)
        check(f"legacy: klik chapter {other['id']} → navigasi", ok, page.url)
        check("legacy: sheet tertutup", page.locator("[data-chapter-picker]").count() == 0)
        check("legacy: chapter baru termuat", wait_ready(page), page.url)
    page.screenshot(path=SHOTS + "/legacy.png")

    check("legacy: tanpa pageerror", not errors, "; ".join(errors[:3]))
    ctx.close()
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
sys.exit(1 if failed else 0)
