"""E2E sheet "Pilih Chapter" di reader.

Kontrak yang dibuktikan:
  1. Baris komentar ("Tambahkan komentar…") dan baris reaksi (ikon sosial)
     TIDAK ADA lagi di footer reader — digantikan tombol "Pilih Chapter".
  2. Tombol "Sebelumnya" / "Berikutnya" TETAP ada (tidak ikut dihapus).
  3. Klik "Pilih Chapter" → sheet terbuka, daftar chapter series termuat.
  4. Chapter yang sedang dibaca ditandai "Dip baca".
  5. Kotak pencarian menyaring daftar (nomor ATAU judul).
  6. Klik chapter di daftar → navigasi ke chapter itu (URL berubah).
  7. Escape / tombol tutup menutup sheet.

Data uji = konten LIVE (komiku:1284 Reincarnator). Nomor chapter yang
dibandingkan TIDAK di-hardcode — diambil dari API, karena sumber terbit
chapter baru kapan saja.
"""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\chapter_picker_e2e"
os.makedirs(SHOTS, exist_ok=True)

SERIES = "komiku:1284"
MID = f"/baca/{SERIES}/121"

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def series_chapters():
    """Daftar chapter dari API — bukan angka yang di-hardcode."""
    d = json.load(urllib.request.urlopen(f"{BASE}/api/unified/series/{SERIES}", timeout=60))
    chs = d.get("chapters") or []
    return [{"number": str(c.get("number")), "title": c.get("title") or ""} for c in chs]


def first_chapter_url() -> str:
    """Chapter PERTAMA series — dicari dari API, bukan di-hardcode.

    Sumber menerbitkan chapter baru kapan saja (dan beberapa chapter
    cuma ada di sumber lain lewat fallback lintas-sumber). Anchoring
    "chapter pertama" ke nomor tetap bikin assertion gagal palsu begitu
    sumber menambah chapter di bawahnya — persis yang terjadi: `00.1`
    dulu jadi yang pertama, sekarang ada chapter `0`.
    """
    chs = series_chapters()
    if not chs:
        raise RuntimeError("series seed tanpa chapter — ubah series seed E2E")

    def num(c):
        try:
            return float(c["number"])
        except (TypeError, ValueError):
            return float("inf")

    lowest = min(chs, key=num)
    return f"/baca/{SERIES}/{lowest['number']}"


def wait_ready(page):
    deadline = time.time() + 40
    while time.time() < deadline:
        ok = page.evaluate(
            "() => !!document.querySelector('[data-reader-chrome=toolbar]')"
            " && document.querySelectorAll('img[data-page]').length > 0"
        )
        if ok:
            return True
        page.wait_for_timeout(250)
    return False


CH = series_chapters()
CUR = "121"
# chapter lain yang pasti ada (dipilih dari API, bukan tebakan)
OTHERS = [c["number"] for c in CH if c["number"] != CUR]
TARGET = OTHERS[0] if OTHERS else None

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    ctx.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked by e2e"))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + MID, wait_until="domcontentloaded")
    check("setup: reader termuat + gambar ter-render", wait_ready(page))

    footer = page.locator('[data-reader-chrome=footer]')
    body_text = footer.inner_text()

    # ---- 1. fitur lama harus HILANG ----
    check("komentar: tidak ada lagi di footer", "komentar" not in body_text.lower(), body_text[:80])
    zero_btns = footer.locator("button:has-text('0')")
    check(
        "reaksi: tidak ada lagi di footer",
        zero_btns.count() == 0,
        f"{zero_btns.count()} tombol angka 0",
    )

    # ---- 2. navigasi sebelumnya/berikutnya TETAP ----
    prev_link = page.locator('[data-reader-chrome=footer] a[aria-label^="Chapter Sebelumnya"]')
    next_link = page.locator('[data-reader-chrome=footer] a[aria-label^="Baca Chapter Berikutnya"]')
    check("nav: tombol 'Sebelumnya' tetap ada", prev_link.count() == 1, f"{prev_link.count()}")
    check("nav: tombol 'Berikutnya' tetap ada", next_link.count() == 1, f"{next_link.count()}")

    # ---- 3. tombol Pilih Chapter + sheet terbuka ----
    pick_btn = page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]')
    check("picker: tombol 'Pilih Chapter' ada di footer", pick_btn.count() == 1, f"{pick_btn.count()}")
    if pick_btn.count() != 1:
        ctx.close()
        browser.close()
        print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
        sys.exit(1)

    pick_btn.click()
    sheet = page.locator("[data-chapter-picker]")
    deadline = time.time() + 20
    while time.time() < deadline:
        if sheet.count() == 1:
            break
        page.wait_for_timeout(200)
    check("picker: sheet terbuka setelah klik", sheet.count() == 1, f"{sheet.count()}")

    # daftar chapter termuat (polling, bukan sleep)
    rows = sheet.locator("ul li a")
    deadline = time.time() + 25
    while time.time() < deadline:
        if rows.count() > 0:
            break
        page.wait_for_timeout(250)
    check("picker: daftar chapter termuat", rows.count() > 0, f"{rows.count()} baris")
    check(
        "picker: jumlah baris sesuai daftar API",
        rows.count() == len(CH),
        f"UI={rows.count()} API={len(CH)}",
    )

    # ---- 4. chapter aktif ditandai ----
    marked = sheet.locator('a[aria-current="true"]')
    check("picker: chapter aktif ditandai", marked.count() == 1, f"{marked.count()} ditandai")
    if marked.count() == 1:
        txt = marked.first.inner_text()
        check("picker: penanda menyertakan nomor chapter aktif", CUR in txt, txt[:60])
        check("picker: badge 'Dip baca' tampil", "Dip baca" in txt, txt[:60])
    page.screenshot(path=SHOTS + "/1-sheet-terbuka.png")

    # ---- 5. pencarian menyaring daftar ----
    search = sheet.locator('input[aria-label="Cari chapter"]')
    check("picker: kotak pencarian ada", search.count() == 1, f"{search.count()}")
    if search.count() == 1:
        search.fill(TARGET)
        page.wait_for_timeout(500)
        check(
            "picker: pencarian menyaring daftar",
            rows.count() < len(CH) and rows.count() >= 1,
            f"{rows.count()} baris setelah cari '{TARGET}'",
        )
        found = rows.first.inner_text()
        check("picker: hasil filter memuat nomor yang dicari", TARGET in found, found[:60])
        # bersihkan filter lagi
        search.fill("")
        page.wait_for_timeout(400)
        check("picker: filter kosong mengembalikan daftar penuh", rows.count() == len(CH), f"{rows.count()}")
    page.screenshot(path=SHOTS + "/2-pencarian.png")

    # ---- 6. klik chapter → navigasi ----
    if TARGET:
        # klik baris yang nomornya = TARGET (bukan baris pertama, supaya
        # benar-benarAssert target-nya, bukan kebetulan)
        link = sheet.locator(f'ul li a:has-text("{TARGET}")').first
        link.click()
        deadline = time.time() + 20
        ok = False
        while time.time() < deadline:
            if f"/baca/{SERIES}/{TARGET}" in page.url:
                ok = True
                break
            page.wait_for_timeout(250)
        check(f"picker: klik chapter {TARGET} → navigasi", ok, page.url)
        check("picker: sheet tertutup setelah memilih", sheet.count() == 0, f"{sheet.count()}")
        check("picker: chapter baru termuat", wait_ready(page), page.url)
        page.screenshot(path=SHOTS + "/3-setelah-pilih.png")

    # ---- 7. Escape menutup sheet ----
    page.goto(BASE + MID, wait_until="domcontentloaded")
    wait_ready(page)
    page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]').click()
    page.wait_for_timeout(600)
    check("picker: sheet terbuka lagi", page.locator("[data-chapter-picker]").count() == 1)
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    check("picker: Escape menutup sheet", page.locator("[data-chapter-picker]").count() == 0)

    check("console: tanpa pageerror", not errors, "; ".join(errors[:3]))

    ctx.close()
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
sys.exit(1 if failed else 0)
