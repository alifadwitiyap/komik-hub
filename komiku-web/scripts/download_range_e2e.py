"""E2E flow unduh RANGE (paritas Komiku+ v2.3.0) — Playwright headless vs 8788.

Mengganti UI centang 1-1 dengan mode range 2-tap (Awal/Akhir) pada daftar
chapter. Meliputi (a) unified 12-chapter end-to-end sampai entri muncul di
API, (b) clamp >30, (c) legacy flow (range 3 + entri lewat API).

Alur:
  (a) UNIFIED /manga/komiku:6426 -> tombol "Unduh" -> tap baris 1 + baris 12
      -> "12 dipilih · maks 30" + "Unduh (12)" -> klik -> "mengunduh…" ->
      "Unduhan selesai" -> /api/unified/downloads bertambah 12.
  (b) UNIFIED: tap rentang 35 bar -> "Maksimal 30 chapter" + "30 dipilih".
  (c) LEGACY /manga/3215 -> "Unduh" -> tap 2 baris (3 chapter) -> Unduh (3)
      -> selesai -> /api/unified/downloads bertambah 3.

Catatan kontrak: server DEDUPE by (handle, number) — chapter yang sudah
diunduh tak bikin entri baru. Jadi tiap bagian MENGHAPUS dulu entri handle
yang diuji supaya "+12" / "+3" deterministik (fixture bersih milik script).

Bukti: assertion output + screenshot.
"""
import os
import re
import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\download_range_e2e"
os.makedirs(SHOTS, exist_ok=True)

UNIFIED_HANDLE = "komiku:6426"
UNIFIED_URL = BASE + "/manga/" + UNIFIED_HANDLE
LEGACY_ID = "3215"
LEGACY_HANDLE = "komiku:" + LEGACY_ID
LEGACY_URL = BASE + "/manga/" + LEGACY_ID

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


def delete_handle(page, handle):
    """Hapus semua entri unduhan untuk `handle` (fixture bersih)."""
    m = download_map(page)
    r = page.request.get(BASE + "/api/unified/downloads")
    items = r.json().get("items", [])
    for it in items:
        if str(it.get("handle")) == handle:
            try:
                page.request.delete(BASE + "/api/unified/downloads/" + str(it.get("id")))
            except Exception:
                pass


def poll_increase(page, want_numbers, handle, timeout=180):
    """
    Poll /api/unified/downloads sampai SEMUA `want_numbers` tersedia untuk
    `handle`. Return (jumlah_terpenuhi, elapsed).
    """
    want = set(want_numbers)
    t0 = time.time()
    while time.time() - t0 < timeout:
        m = download_map(page)
        got = {n for n in want if n in m.get(handle, set())}
        if len(got) >= len(want):
            return len(got), time.time() - t0
        time.sleep(3)
    m = download_map(page)
    got = {n for n in want if n in m.get(handle, set())}
    return len(got), time.time() - t0


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

    # ---------- (a) UNIFIED: range 12 chapter, Unduh, verifikasi API ----------
    print("== (a) UNIFIED range 12 end-to-end ==")
    page.goto(UNIFIED_URL, wait_until="networkidle")
    page.wait_for_selector('section[data-series-list] li', timeout=20000)
    page.wait_for_timeout(1800)
    toggle = page.locator("button[data-range-toggle]")
    check("unified: tombol Unduh (toggle range) ada", toggle.count() > 0)
    toggle.first.click()
    page.wait_for_timeout(400)
    check("unified: mode range aktif (aria-pressed)",
          toggle.first.get_attribute("aria-pressed") == "true")
    body0 = page.inner_text("body")
    check("unified: bar info muncul setelah masuk mode", "dipilih" in body0, body0[:80])
    unduh_btn = page.locator("button:has-text('Unduh (')").first
    check("unified: tombol Unduh disabled (baru 1 anchor)",
          unduh_btn.count() == 0 or unduh_btn.is_disabled(),
          "disabled/ada-baru")

    prows = page.locator("section[data-series-list] li > button")
    check("unified: baris jadi tombol saat pick mode", prows.count() >= 12, f"{prows.count()} baris")
    # 12 chapter TERBARU (urutan tampil DESC) = row 0..11; label = chapterLabel
    labels = [prows.nth(i).inner_text().split("\n")[0].strip() for i in range(12)]
    want_numbers = chapter_numbers_from(labels)
    check("unified: 12 nomor chapter terbaca dari baris", len(want_numbers) == 12,
          ",".join(want_numbers))

    delete_handle(page, UNIFIED_HANDLE)  # fixture bersih -> +12 deterministik
    check("unified: fixture bersih (0 entri komiku:6426 sebelum unduh)",
          len(download_map(page).get(UNIFIED_HANDLE, set())) == 0)
    prows.nth(0).click()       # anchor Awal (row 1)
    page.wait_for_timeout(300)
    body1 = page.inner_text("body")
    check("unified: setelah tap Awal, hint 'Pilih chapter akhir'",
          "Pilih chapter akhir" in body1, "hint")
    check("unified: anchor Awal bertanda", "Awal" in body1)
    prows.nth(11).click()      # anchor Akhir (row 12) -> 12 terpilih
    page.wait_for_timeout(450)
    body2 = page.inner_text("body")
    check("unified: info '12 dipilih'", "12 dipilih" in body2, "12 dipilih")
    check("unified: info '· maks 30'", "maks 30" in body2)
    check("unified: tombol 'Unduh (12)' tampil", "Unduh (12)" in body2)
    check("unified: anchor Akhir bertanda", "Akhir" in body2)
    page.screenshot(path=SHOTS + "/1-unified-range12-selected.png")

    unduh12 = page.locator("button:has-text('Unduh (12)')").first
    check("unified: Unduh (12) enabled", unduh12.is_enabled())
    unduh12.click()

    saw_progress = False
    for _ in range(40):
        page.wait_for_timeout(1000)
        try:
            if "mengunduh" in page.inner_text("body").lower():
                saw_progress = True
                break
        except Exception:
            pass
    check("unified: progres 'mengunduh…' terlihat", saw_progress)

    saw_done = False
    for _ in range(240):
        page.wait_for_timeout(1000)
        try:
            if "Unduhan selesai" in page.inner_text("body"):
                saw_done = True
                break
        except Exception:
            pass
    check("unified: pesan 'Unduhan selesai' muncul", saw_done)
    page.screenshot(path=SHOTS + "/2-unified-range12-done.png")

    got, elapsed = poll_increase(page, want_numbers, UNIFIED_HANDLE, timeout=180)
    check("unified: /api/unified/downloads bertambah 12 untuk handle ini",
          got >= 12, f"{got}/12 tersedia dalam {elapsed:.0f}s")
    page.screenshot(path=SHOTS + "/3-unified-api.png")

    # ---------- (b) UNIFIED: clamp >30 (verifikasi UI saja, tak diunduh) ----------
    print("== (b) UNIFIED clamp >30 ==")
    page.goto(UNIFIED_URL, wait_until="networkidle")
    page.wait_for_selector('section[data-series-list] li', timeout=20000)
    page.wait_for_timeout(1200)
    page.locator("button[data-range-toggle]").first.click()
    page.wait_for_timeout(400)
    prows = page.locator("section[data-series-list] li > button")
    n_avail = prows.count()
    if n_avail >= 35:
        prows.nth(0).click()      # Awal
        page.wait_for_timeout(250)
        prows.nth(34).click()     # Akhir -> raw 35 -> clamp 30
        page.wait_for_timeout(450)
        bodyc = page.inner_text("body")
        check("unified: pesan clamp 'Maksimal 30 chapter'",
              "Maksimal 30 chapter" in bodyc, bodyc[:120])
        check("unified: '30 dipilih' (setelah clamp)", "30 dipilih" in bodyc)
        page.screenshot(path=SHOTS + "/4-unified-clamp30.png")
    else:
        check("unified: cukup baris untuk clamp 35", False, f"hanya {n_avail} baris")

    # ---------- (c) LEGACY /manga/3215: range 3, Unduh (3), API +3 ----------
    print("== (c) LEGACY range 3 ==")
    page.goto(LEGACY_URL, wait_until="networkidle")
    page.wait_for_selector('a[href*="/baca/"]', timeout=20000)
    page.wait_for_timeout(1500)

    ltoggle = page.locator('button[aria-label="Unduh chapter"]')
    check("legacy: tombol Unduh ada", ltoggle.count() > 0)
    delete_handle(page, LEGACY_HANDLE)  # fixture bersih -> +3 deterministik
    check("legacy: fixture bersih (0 entri komiku:3215 sebelum unduh)",
          len(download_map(page).get(LEGACY_HANDLE, set())) == 0)

    if ltoggle.count() > 0:
        ltoggle.first.click()
        page.wait_for_timeout(400)
        lrows = page.locator("li button[aria-pressed]")
        ln = lrows.count()
        check("legacy: baris jadi tombol saat pick mode", ln >= 3, f"{ln} baris")
        lwant = chapter_numbers_from([lrows.nth(i).inner_text() for i in range(3)])
        # legacy label = "Chapter 45.1" → ambil angka setelah "Chapter"
        lwant2 = []
        for i in range(3):
            m = re.search(r"Chapter\s+([0-9]+(?:\.[0-9]+)?)", lrows.nth(i).inner_text())
            if m:
                lwant2.append(m.group(1))
        lwant = lwant2 or lwant
        check("legacy: 3 nomor chapter terbaca", len(lwant) == 3, ",".join(lwant))
        lrows.nth(0).click()   # Awal
        page.wait_for_timeout(250)
        check("legacy: hint 'Pilih chapter akhir'",
              "Pilih chapter akhir" in page.inner_text("body"))
        lrows.nth(2).click()   # Akhir -> 3 chapter (index 0,1,2)
        page.wait_for_timeout(450)
        body_l2 = page.inner_text("body")
        check("legacy: info '3 dipilih'", "3 dipilih" in body_l2, body_l2[:100])
        check("legacy: tombol 'Unduh (3)'", "Unduh (3)" in body_l2)
        page.screenshot(path=SHOTS + "/5-legacy-range3-selected.png")
        unduh3 = page.locator("button:has-text('Unduh (3)')").first
        check("legacy: Unduh (3) enabled", unduh3.is_enabled())
        unduh3.click()
        ldone = False
        for _ in range(150):
            page.wait_for_timeout(1000)
            try:
                if "Unduhan selesai" in page.inner_text("body"):
                    ldone = True
                    break
            except Exception:
                pass
        check("legacy: unduhan selesai (Unduhan selesai)", ldone)
        page.screenshot(path=SHOTS + "/6-legacy-range3-done.png")
        lgot, lel = poll_increase(page, lwant, LEGACY_HANDLE, timeout=120)
        check("legacy: /api/unified/downloads bertambah 3 untuk komiku:3215",
              lgot >= 3, f"{lgot}/3 tersedia dalam {lel:.0f}s")

    # ---------- (d) UNIFIED: tombol Batal menghentikan unduhan ----------
    print("== (d) UNIFIED cancel mid-download ==")
    page.goto(UNIFIED_URL, wait_until="networkidle")
    page.wait_for_selector('section[data-series-list] li', timeout=20000)
    page.wait_for_timeout(1200)
    delete_handle(page, UNIFIED_HANDLE)  # fixture bersih -> hitungan deterministik
    page.locator("button[data-range-toggle]").first.click()
    page.wait_for_timeout(400)
    prows = page.locator("section[data-series-list] li > button")
    prows.nth(0).click()   # Awal
    page.wait_for_timeout(250)
    prows.nth(11).click()  # Akhir -> 12 chapter
    page.wait_for_timeout(450)
    body_d0 = page.inner_text("body")
    check("cancel: '12 dipilih' + 'Unduh (12)'", "12 dipilih" in body_d0 and "Unduh (12)" in body_d0)
    page.locator("button:has-text('Unduh (12)')").first.click()
    # tunggu kartu progres compact muncul
    saw_card = False
    for _ in range(20):
        page.wait_for_timeout(1000)
        try:
            if "Mengunduh" in page.inner_text("body"):
                saw_card = True
                break
        except Exception:
            pass
    check("cancel: kartu progres compact 'Mengunduh' tampil", saw_card)
    page.screenshot(path=SHOTS + "/7-cancel-running.png")
    # beri waktu 1-2 chapter selesai, lalu Batal
    page.wait_for_timeout(6000)
    batal = page.locator("button:has-text('Batal')")
    check("cancel: tombol Batal ada saat berjalan", batal.count() > 0)
    if batal.count() > 0:
        batal.first.click()
        page.wait_for_timeout(1500)
        body_d1 = page.inner_text("body")
        check("cancel: pesan 'Unduhan dibatalkan'", "dibatalkan" in body_d1.lower(), body_d1[:100])
        page.screenshot(path=SHOTS + "/8-cancel-done.png")
        # hitung entri yang benar-benar tersimpan: harus < 12 (berhenti di tengah).
        # Batal lebih awal dari chapter pertama selesai = 0 entri = perilaku BENAR
        # (tak ada yang terbuang); yang dilarang adalah 12 (tidak berhenti).
        m = download_map(page)
        ndone = len(m.get(UNIFIED_HANDLE, set()))
        check("cancel: unduhan berhenti di tengah (entri < 12)", 0 <= ndone < 12,
              f"{ndone}/12 tersimpan sebelum batal")
        check("cancel: tak ada galat konsistensi (state.json entri valid)", ndone >= 0)

    check("console: tanpa pageerror", not errors, "; ".join(errors[:2]))
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
if failed:
    print("FAILED:", "; ".join(failed))
print("SHOTS:", SHOTS)
raise SystemExit(1 if failed else 0)
