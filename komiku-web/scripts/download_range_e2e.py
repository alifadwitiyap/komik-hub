"""E2E flow unduh RANGE → CACHE OFFLINE (seri) — Playwright headless vs 8788.

Mengganti flow unduh PDF (startRun → POST /api/unified/download-pdf) dengan
mode cache offline (startRunCache → service worker). Tombol "Unduh" di
halaman Series kini menyimpan chapter ke cache browser untuk baca offline,
BUKAN membuat PDF.

Alur yang diuji:
  1. /manga/komiku:6426 -> tombol "Unduh" (data-range-toggle) -> mode range
     2-tap -> pilih 2 chapter -> klik "Unduh (2)".
  2. Tunggu pesan selesai "tersimpan offline".
  3. Assert flow ini TIDAK menambah entri di /api/unified/downloads (tidak
     ada PDF baru dibuat).
  4. Matikan jaringan (context.set_offline) -> buka salah satu chapter yang
     diunduh (/baca/komiku:6426/<number>) -> halaman tetap render dari cache
     service worker (img[data-page] dengan naturalWidth>0).

Pola offline: sama seperti chapter_offline_e2e.py — request /img dilayani
service worker (cache-first), jadi service worker jalan normal, tidak di-block.

Catatan kontrak: cache offline hidup sepenuhnya di browser (Cache Storage SW),
tidak menyentuh rak unduhan server. Karena itu /api/unified/downloads TIDAK
boleh bertambah — itu bukti tidak ada PDF yang dibuat.
"""
import os
import re
import sys
import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
for i, a in enumerate(sys.argv[1:]):
    if a == "--base-url" and i + 1 < len(sys.argv[1:]):
        BASE = sys.argv[i + 2]

SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\download_range_e2e_cached"
os.makedirs(SHOTS, exist_ok=True)

HANDLE = "komiku:6426"
SERIES_URL = BASE + "/manga/" + HANDLE
RANGE_N = 2  # range 2 chapter

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def download_map(page):
    """{handle: set(number)} dari rak unduhan server."""
    r = page.request.get(BASE + "/api/unified/downloads")
    d = r.json()
    items = d.get("items", d if isinstance(d, list) else [])
    out = {}
    for it in items:
        out.setdefault(str(it.get("handle")), set()).add(str(it.get("number")))
    return out


def chapter_numbers_from(labels):
    out = []
    for lbl in labels:
        m = re.search(r"([0-9]+(?:\.[0-9]+)?)", lbl)
        if m:
            out.append(m.group(1))
    return out


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    print("== (a) UNIFIED: range 2 chapter → cache offline, bukan PDF ==")
    page.goto(SERIES_URL, wait_until="networkidle")
    page.wait_for_selector('section[data-series-list] li', timeout=20000)
    page.wait_for_timeout(1800)

    toggle = page.locator("button[data-range-toggle]")
    check("seri: tombol Unduh (toggle range) ada", toggle.count() > 0)
    toggle.first.click()
    page.wait_for_timeout(400)
    check("seri: mode range aktif (aria-pressed)",
          toggle.first.get_attribute("aria-pressed") == "true")

    prows = page.locator("section[data-series-list] li > button")
    check("seri: baris jadi tombol saat pick mode", prows.count() >= RANGE_N,
          f"{prows.count()} baris")

    labels = [prows.nth(i).inner_text().split("\n")[0].strip() for i in range(RANGE_N)]
    want_numbers = chapter_numbers_from(labels)
    check(f"seri: {RANGE_N} nomor chapter terbaca dari baris",
          len(want_numbers) == RANGE_N, ",".join(want_numbers))
    if len(want_numbers) != RANGE_N:
        want_numbers = [str(i + 1) for i in range(RANGE_N)]

    # fixture: snapshot state unduhan server SEBELUM (bukti "tidak ada PDF baru")
    dl_before = download_map(page).get(HANDLE, set())

    prows.nth(0).click()   # anchor Awal
    page.wait_for_timeout(300)
    body1 = page.inner_text("body")
    check("seri: setelah tap Awal, hint 'Pilih chapter akhir'",
          "Pilih chapter akhir" in body1)
    prows.nth(RANGE_N - 1).click()   # anchor Akhir → RANGE_N terpilih
    page.wait_for_timeout(450)
    body2 = page.inner_text("body")
    check(f"seri: info '{RANGE_N} dipilih'", f"{RANGE_N} dipilih" in body2, body2[:100])
    check(f"seri: tombol 'Unduh ({RANGE_N})' tampil",
          f"Unduh ({RANGE_N})" in body2)

    unduh_btn = page.locator(f"button:has-text('Unduh ({RANGE_N})')").first
    check(f"seri: Unduh ({RANGE_N}) enabled", unduh_btn.is_enabled())
    page.screenshot(path=SHOTS + "/1-range-selected.png")
    unduh_btn.click()

    # tunggu pesan selesai "tersimpan offline" (cache, bukan PDF)
    saw_done = False
    for _ in range(300):
        page.wait_for_timeout(1000)
        try:
            if "tersimpan offline" in page.inner_text("body").lower():
                saw_done = True
                break
        except Exception:
            pass
    check("seri: pesan 'tersimpan offline' muncul", saw_done)
    page.screenshot(path=SHOTS + "/2-cache-done.png")

    # bukti tidak ada PDF: /api/unified/downloads tidak bertambah utk handle ini
    time.sleep(5)
    dl_after = download_map(page).get(HANDLE, set())
    check("seri: /api/unified/downloads TIDAK bertambah (tak ada PDF baru)",
          dl_after == dl_before, f"{len(dl_before)}→{len(dl_after)} entri")

    # offline: buka salah satu chapter yang diunduh, pastikan render dari cache
    dl_ch = want_numbers[0]
    chapter_url = f"/baca/{HANDLE}/{dl_ch}"
    ctx.set_offline(True)
    page.goto(BASE + chapter_url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(6000)

    loaded = {"ok": 0, "total": 0}
    for _ in range(15):
        loaded = page.evaluate("""() => {
          const imgs = Array.from(document.querySelectorAll('img[data-page]'))
          let ok = 0
          let total = 0
          for (const im of imgs) {
            total++
            if (im.complete && im.naturalWidth > 0) ok++
          }
          return { ok, total }
        }""")
        if loaded["ok"] > 0:
            break
        page.wait_for_timeout(2000)
    check("offline: chapter terunduh render dari cache (naturalWidth>0)",
          loaded["ok"] > 0, f"{loaded['ok']}/{loaded['total']} halaman")
    page.screenshot(path=SHOTS + "/3-offline-render.png")

    ctx.set_offline(False)
    check("console: tanpa pageerror", not errors, "; ".join(errors[:2]))
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
if failed:
    print("FAILED:", "; ".join(failed))
print("SHOTS:", SHOTS)
raise SystemExit(1 if failed else 0)
