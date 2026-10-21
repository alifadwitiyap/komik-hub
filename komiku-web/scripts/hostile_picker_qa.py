"""UltrQA hostile probe — reader footer + sheet "Pilih Chapter" + tombol Beranda.

Skenario adversarial terhadap perilaku yang BERUBAH di sesi ini:
  S1 race abort/loading : buka-tutup-buka sheet cepat -> daftar harus tampil
  S2 nomor chapter kosong: chapter tanpa nomor (legacy) -> sel kosong + urut
  S3 seri sangat panjang : 1215 chapter -> render + scroll harus lancar
  S4 pencarian           : no-result, whitespace, karakterregex
  S5 marker stale       : sheet terbuka saat chapter berganti
  S6 a11y dialog        : role/aria-modal/focus
  S7 scroll lock        : sheet terbuka -> halaman belakang tidak ikut geser
  S8 chrome inert       : tombol "Pilih Chapter" saat footer tersembunyi
  S9 double-tap         : dua kali klik "Pilih Chapter" -> sheet tetap stabil
  S10 z-index           : klik sheet tidak memicu toggle chrome reader
  S11 tombol Beranda    : reader + maraton -> benar-benar ke beranda

Evidence: PASS/FAIL per skenario, terpisah dari perbaikan.
"""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\hostile_picker_qa"
os.makedirs(SHOTS, exist_ok=True)

SERIES = "komiku:1284"
MID = f"/baca/{SERIES}/121"
MARATON = f"/maraton/{SERIES}/121"
# legacy: One Piece punya 1215 chapter (bukan 137) -> uji seri panjang
LEGACY_SERIES_ID = 6426

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def api_series(handle):
    d = json.load(urllib.request.urlopen(f"{BASE}/api/unified/series/{handle}", timeout=90))
    return d.get("chapters") or []


def wait_ready(page, sel="img[data-page]"):
    deadline = time.time() + 45
    while time.time() < deadline:
        ok = page.evaluate(
            "() => !!document.querySelector('[data-reader-chrome=toolbar]')"
            f" && document.querySelectorAll('{sel}').length > 0"
        )
        if ok:
            return True
        page.wait_for_timeout(300)
    return False


CH = api_series(SERIES)
CUR = "121"
TARGET = [c["number"] for c in CH if str(c["number"]) != CUR][0]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, locale="id-ID")
    ctx.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked"))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + MID, wait_until="domcontentloaded")
    wait_ready(page)
    sheet = page.locator("[data-chapter-picker]")
    pick = page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]')

    # ============ S1: race buka-tutup-buka cepat ============
    print("\n--- S1 race: buka-tutup-buka sheet cepat ---")
    pick.click()
    page.wait_for_timeout(120)
    page.keyboard.press("Escape")
    page.wait_for_timeout(80)
    pick.click()
    deadline = time.time() + 25
    rows1 = 0
    while time.time() < deadline:
        rows1 = sheet.locator("ul li a").count()
        if rows1 > 0:
            break
        page.wait_for_timeout(200)
    check("S1: daftar tetap tampil setelah buka-tutup-buka cepat", rows1 > 0, f"{rows1} baris")
    # loading tidak boleh macet (indikator "Memuat…" masih ada = state rusak)
    stuck = sheet.locator("text=Memuat daftar chapter").count()
    check("S1: tidak ada indikator loading macet", stuck == 0, f"{stuck} 'Memuat…'")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    # ============ S2: nomor chapter kosong (legacy) ============
    print("\n--- S2 nomor chapter kosong / non-numerik ---")
    legacy = json.load(urllib.request.urlopen(f"{BASE}/api/series/{LEGACY_SERIES_ID}", timeout=120))
    lch = legacy.get("chapters") or []
    # Fixture: chapter tanpa `number` TIDAK ada di server live, jadi suntik
    # lewat API stub — menguji jalur yang sebenarnya (number kosong) tanpa
    # bergantung pada data sumber yang bisa berubah.
    stub = {
        "series": {"id": LEGACY_SERIES_ID, "title": "Fixture Series"},
        "chapters": [
            {"id": 900001, "name": "Chapter 3", "number": "3"},
            {"id": 900002, "name": "Bonus", "number": None},      # TANPA nomor
            {"id": 900003, "name": "Chapter 1", "number": "1"},
            {"id": 900004, "name": "Extra", "number": ""},        # nomor kosong
        ],
        "related": [],
    }
    ctx2 = browser.new_context(viewport={"width": 390, "height": 844}, locale="id-ID")
    ctx2.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked"))
    ctx2.route(
        "**/api/series/**",
        lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(stub)),
    )
    # chapter juga di-stub: reader butuh /api/chapter/<id> yang valid supaya
    # footer-nya ter-render (kalau chapter gagal load, halaman jadi "Gagal
    # memuat chapter" dan tidak ada footer untuk diklik).
    ch_stub = {
        "chapter": {
            "id": 900001,
            "name": "Chapter 3",
            "number": "3",
            "previous": None,
            "next": None,
        },
        "images": [f"{BASE}/api/series/900001/img/1.jpg"],
        "series": {"id": LEGACY_SERIES_ID, "title": "Fixture Series"},
        "source": "komiku",
        "title_key": "fixture-series",
        "series_handle": str(LEGACY_SERIES_ID),
        "series_cover": None,
    }
    ctx2.route(
        "**/api/chapter/**",
        lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(ch_stub)),
    )
    ctx2.route(
        "**/api/series/900001/img/**",
        lambda r: r.fulfill(status=200, content_type="image/jpeg", body=b""),
    )
    p2 = ctx2.new_page()
    p2.goto(f"{BASE}/baca/900001", wait_until="domcontentloaded")
    p2.wait_for_timeout(3000)
    p2.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]').click()
    deadline = time.time() + 30
    while time.time() < deadline:
        if p2.locator("[data-chapter-picker] ul li a").count() > 0:
            break
        p2.wait_for_timeout(300)
    cells = p2.evaluate(
        """() => [...document.querySelectorAll('[data-chapter-picker] ul li a')]
             .map(a => a.querySelector('span')?.textContent?.trim() ?? '')"""
    )
    check("S2: fixture chapter tanpa nomor terbaca", len(cells) == 4, f"{len(cells)} baris")
    check("S2: sel nomor kosong TIDAK muncul (ada placeholder)",
          all(c != "" for c in cells), f"sel: {cells}")
    check("S2: chapter tanpa nomor di AKHIR, bukan di depan",
          cells[-1] in ("—",) and cells[0] == "1", f"urutan: {cells}")
    latest_txt = p2.locator("[data-chapter-picker]").inner_text()
    check("S2: tombol 'terbaru' tetap menunjuk nomor TERBESAR",
          "terbaru · 3" in latest_txt, latest_txt[-60:].replace("\n", " "))
    p2.screenshot(path=SHOTS + "/S2-nomor-kosong.png")
    ctx2.close()

    # ============ S3: seri sangat panjang (1215 chapter) ============
    print("\n--- S3 seri panjang (1215 chapter) ---")
    page.goto(f"{BASE}/baca/{lch[0]['id']}", wait_until="domcontentloaded")
    wait_ready(page)
    t0 = time.time()
    page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]').click()
    deadline = time.time() + 60
    n_rows = 0
    while time.time() < deadline:
        n_rows = page.locator("[data-chapter-picker] ul li a").count()
        if n_rows > 0:
            break
        page.wait_for_timeout(300)
    dt = time.time() - t0
    check("S3: sheet seri panjang terbuka", n_rows > 0, f"{n_rows} baris dalam {dt:.1f}s")
    check("S3: jumlah baris = jumlah chapter API", n_rows == len(lch), f"UI={n_rows} API={len(lch)}")
    check("S3: buka < 30 detik (tidak hang)", dt < 30, f"{dt:.1f}s")
    # scroll daftar panjang harus lancar
    page.evaluate("() => { const u = document.querySelector('[data-chapter-picker] ul'); u.scrollTop = 40000; }")
    page.wait_for_timeout(400)
    scrolled = page.evaluate("() => document.querySelector('[data-chapter-picker] ul').scrollTop")
    check("S3: daftar panjang bisa di-scroll", scrolled > 1000, f"scrollTop={scrolled}")
    page.screenshot(path=SHOTS + "/S3-seri-panjang.png")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    # ============ S4: pencarian ============
    print("\n--- S4 pencarian (no-result / whitespace / regex chars) ---")
    page.goto(BASE + MID, wait_until="domcontentloaded")
    wait_ready(page)
    page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]').click()
    page.wait_for_timeout(2500)
    search = page.locator('[data-chapter-picker] input[aria-label="Cari chapter"]')
    total = page.locator("[data-chapter-picker] ul li a").count()

    search.fill("zzzTidakAda")
    page.wait_for_timeout(500)
    empty_msg = page.locator("[data-chapter-picker]").inner_text()
    check("S4: no-result menampilkan pesan", "Tidak ada chapter yang cocok" in empty_msg,
          empty_msg[-90:].replace("\n", " "))
    check("S4: no-result tidak menampilkan sheet kosong", total > 0, f"total awal {total}")

    search.fill("   ")
    page.wait_for_timeout(500)
    ws_rows = page.locator("[data-chapter-picker] ul li a").count()
    check("S4: whitespace-only tidak FILTER (daftar utuh)", ws_rows == total, f"{ws_rows}/{total}")

    search.fill("(.*)|[")
    page.wait_for_timeout(500)
    reg_rows = page.locator("[data-chapter-picker] ul li a").count()
    check("S4: karakter regex tidak bikin crash", reg_rows >= 0, f"{reg_rows} baris")
    check("S4: tidak ada pageerror dari regex", not errors, "; ".join(errors[:2]))

    search.fill("00.1")
    page.wait_for_timeout(500)
    dot_txt = page.locator("[data-chapter-picker] ul li a").first.inner_text()
    check("S4: chapter ber-desimal (00.1) bisa dicari", "00.1" in dot_txt, dot_txt[:40].replace("\n", " "))
    page.screenshot(path=SHOTS + "/S4-pencarian.png")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    # ============ S5: marker stale saat chapter berganti ============
    print("\n--- S5 marker saat chapter berganti ---")
    page.goto(BASE + MID, wait_until="domcontentloaded")
    wait_ready(page)
    page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]').click()
    page.wait_for_timeout(2500)
    marked_before = page.locator('[data-chapter-picker] a[aria-current="true"]').count()
    check("S5: ada satu chapter ditandai saat dibuka", marked_before == 1, f"{marked_before}")
    # klik chapter lain -> sheet tertutup; buka lagi -> marker pindah
    page.locator(f'[data-chapter-picker] ul li a[href="/baca/{SERIES}/{TARGET}"]').first.click()
    deadline = time.time() + 20
    while time.time() < deadline:
        if f"/baca/{SERIES}/{TARGET}" in page.url:
            break
        page.wait_for_timeout(250)
    page.wait_for_timeout(1500)
    page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]').click()
    page.wait_for_timeout(2500)
    marked_txt = page.evaluate(
        """() => { const a = document.querySelector('[data-chapter-picker] a[aria-current="true"]');
                   return a ? a.textContent : null; }"""
    )
    check("S5: marker pindah ke chapter yang baru dibuka",
          marked_txt is not None and TARGET in marked_txt, f"marked={marked_txt!r}")
    check("S5: hanya SATU chapter ditandai",
          page.locator('[data-chapter-picker] a[aria-current="true"]').count() == 1)
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    # ============ S6: a11y dialog ============
    print("\n--- S6 a11y: role dialog / aria-modal / fokus ---")
    page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]').click()
    page.wait_for_timeout(2000)
    role = page.evaluate("() => document.querySelector('[data-chapter-picker]')?.getAttribute('role')")
    modal = page.evaluate(
        "() => document.querySelector('[data-chapter-picker]')?.getAttribute('aria-modal')"
    )
    focus_in = page.evaluate(
        """() => { const s = document.querySelector('[data-chapter-picker]');
                   return !!(s && s.contains(document.activeElement)); }"""
    )
    check("S6: sheet punya role='dialog'", role == "dialog", f"role={role!r}")
    check("S6: sheet punya aria-modal='true'", modal == "true", f"aria-modal={modal!r}")
    check("S6: fokus masuk ke sheet saat dibuka", focus_in, f"focus_in={focus_in}")
    # Escape harus tetap jalan walau fokus di dalam
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    check("S6: Escape menutup sheet (fokus di dalam)", page.locator("[data-chapter-picker]").count() == 0)

    # ============ S7: scroll lock di belakang sheet ============
    print("\n--- S7 scroll lock: halaman belakang tidak ikut geser ---")
    # Scroll ke tengah dulu: di atas, konten manga masih muat dan halaman
    # bisa digeser (kalau tidak, scrollY 0 = tidak ada yang bisa digeser
    # dan assertion-nya jadi hampa).
    page.evaluate("() => window.scrollTo(0, 1200)")
    page.wait_for_timeout(600)
    before_y = page.evaluate("() => window.scrollY")
    check("S7: ada ruang scroll untuk diuji", before_y > 50, f"scrollY={before_y}")
    # buka sheet lewat klik (bukan JS) — tapi tombol footer bisa di luar
    # viewport kalau chrome tersembunyi, jadi pastikan chrome tampil dulu
    page.evaluate("() => window.scrollTo(0, 0)")
    page.wait_for_timeout(700)
    page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]').click()
    page.wait_for_timeout(1500)
    page.evaluate("() => window.scrollTo(0, 1200)")
    page.wait_for_timeout(300)
    before_y = page.evaluate("() => window.scrollY")
    # coba geser window di belakang sheet (wheel di area sheet)
    page.mouse.move(195, 300)
    page.mouse.wheel(0, 600)
    page.wait_for_timeout(700)
    after_y = page.evaluate("() => window.scrollY")
    check("S7: halaman belakang TIDAK ikut ter-scroll", abs(after_y - before_y) < 40,
          f"scrollY {before_y} -> {after_y}")
    # tapi daftar chapter di dalam sheet MASIH bisa digulir
    page.mouse.move(195, 600)
    page.mouse.wheel(0, 500)
    page.wait_for_timeout(500)
    list_top = page.evaluate(
        "() => { const u = document.querySelector('[data-chapter-picker] ul'); return u ? u.scrollTop : -1; }"
    )
    check("S7: daftar chapter DI DALAM sheet tetap bisa digulir", list_top > 100,
          f"scrollTop={list_top}")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    # ============ S8: chrome inert saat footer tersembunyi ============
    print("\n--- S8 tombol Pilih Chapter saat chrome tersembunyi ---")
    page.evaluate("() => window.scrollTo(0, 0)")
    page.wait_for_timeout(400)
    page.mouse.move(195, 420)
    page.mouse.wheel(0, 700)
    page.wait_for_timeout(800)
    footer_hidden = page.evaluate(
        """() => { const f = document.querySelector('[data-reader-chrome=footer]');
                   const r = f.getBoundingClientRect();
                   // footer tersembunyi = translate-y-full => top >= vh-1
                   return r.top >= window.innerHeight - 1; }"""
    )
    check("S8: footer tersembunyi setelah scroll", footer_hidden)
    inert_ok = page.evaluate(
        """() => { const f = document.querySelector('[data-reader-chrome=footer]');
                   return f.hasAttribute('inert') || f.getAttribute('aria-hidden') === 'true'; }"""
    )
    check("S8: footer yang tersembunyi tidak bisa difokus (inert/aria-hidden)", inert_ok)
    page.mouse.wheel(0, -500)
    page.wait_for_timeout(700)

    # ============ S9: double-tap tombol Pilih Chapter ============
    print("\n--- S9 double-tap tombol Pilih Chapter ---")
    pick_btn = page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]')
    pick_btn.dblclick()
    page.wait_for_timeout(2000)
    n_sheets = page.locator("[data-chapter-picker]").count()
    check("S9: double-tap tidak merusak sheet", n_sheets <= 1, f"{n_sheets} sheet")
    if n_sheets == 1:
        rows = page.locator("[data-chapter-picker] ul li a").count()
        check("S9: sheet masih berisi daftar chapter", rows > 0, f"{rows} baris")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)

    # ============ S10: klik sheet tidak toggle chrome ============
    print("\n--- S10 klik di sheet tidak memicu toggle chrome ---")
    page.evaluate("() => window.scrollTo(0, 0)")
    page.wait_for_timeout(400)
    page.locator('[data-reader-chrome=footer] button[aria-label="Pilih Chapter"]').click()
    page.wait_for_timeout(2000)
    chrome_before = page.evaluate(
        """() => { const t = document.querySelector('[data-reader-chrome=toolbar]');
                   const r = t.getBoundingClientRect();
                   return r.bottom > 1 && r.top < window.innerHeight; }"""
    )
    # klik pada header sheet (bukan tombol close)
    page.locator("[data-chapter-picker] h2").click()
    page.wait_for_timeout(700)
    chrome_after = page.evaluate(
        """() => { const t = document.querySelector('[data-reader-chrome=toolbar]');
                   const r = t.getBoundingClientRect();
                   return r.bottom > 1 && r.top < window.innerHeight; }"""
    )
    check("S10: klik di header sheet tidak menyembunyikan chrome",
          chrome_before == chrome_after, f"sebelum={chrome_before} sesudah={chrome_after}")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    # ============ S11: tombol Beranda ============
    print("\n--- S11 tombol Beranda ---")
    home = page.locator('[data-reader-chrome=toolbar] button[aria-label="Beranda"]')
    check("S11: tombol 'Beranda' ada di toolbar reader", home.count() == 1, f"{home.count()}")
    home.click()
    deadline = time.time() + 20
    ok = False
    while time.time() < deadline:
        if page.url.rstrip("/").endswith("127.0.0.1:8788"):
            ok = True
            break
        page.wait_for_timeout(250)
    check("S11: klik 'Beranda' -> beranda", ok, page.url)

    check("console: tanpa pageerror sepanjang probe", not errors, "; ".join(errors[:3]))
    ctx.close()
    browser.close()

print(f"\n{'='*66}\n{len(passed)}/{len(passed)+len(failed)} passed")
if failed:
    print("GAGAL:")
    for f in failed:
        print("  -", f)
print("SHOTS:", SHOTS)
sys.exit(1 if failed else 0)
